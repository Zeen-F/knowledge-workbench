import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Clipboard,
  FilePlus2,
  ImagePlus,
  Layers3,
  Play,
  RefreshCw,
  ScanLine,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { diffLines } from "diff";
import type { Capture, Job, NoteSummary, Proposal } from "../shared/contracts";
import {
  api,
  fileData,
  openExternal,
  prettyState,
  shortDate,
  nativeAction,
} from "./client";
import { assetUrl, renderMarkdown } from "./markdown";
import { Editor } from "./Editor";
import {
  recoveryKey,
  readRecovery,
  writeRecovery,
  clearRecovery,
  flushRecovery,
} from "./recovery";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current
      ?.querySelector<HTMLElement>("input,textarea,select,button")
      ?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const all = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,textarea,select,[tabindex="0"]',
            ) || []),
          ];
          const first = all[0],
            last = all.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        ref={panel}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭窗口" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {diffLines(before, after).map((part, i) => (
        <span
          key={i}
          className={part.added ? "added" : part.removed ? "removed" : ""}
        >
          {part.value}
        </span>
      ))}
    </pre>
  );
}
type Common = {
  notify: (text: string, error?: boolean) => void;
  refresh: () => Promise<void>;
};

export function Inbox({
  vaultId,
  capabilities,
  captures,
  notes,
  jobs,
  onOpen,
  notify,
  refresh,
}: {
  vaultId: string;
  capabilities: Record<string, boolean>;
  captures: Capture[];
  notes: NoteSummary[];
  jobs: Job[];
  onOpen: (path: string) => void;
} & Common) {
  type Input = { title: string; thought: string; requestId: string };
  const key = recoveryKey(vaultId, "inbox");
  const initial = readRecovery<Input>(key);
  const [selected, setSelected] = useState<string[]>([]),
    [thought, setThought] = useState(initial?.thought || ""),
    [title, setTitle] = useState(initial?.title || ""),
    [inputState, setInputState] = useState(
      initial ? "已恢复本机草稿，尚未写入知识库" : "原始想法会随材料保留。",
    ),
    [batch, setBatch] = useState(false),
    [executor, setExecutor] = useState<"api" | "codex">(
      window.workbench?.panel ? "codex" : "api",
    ),
    [instruction, setInstruction] = useState(""),
    [references, setReferences] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [deliveries, setDeliveries] = useState<Record<string, string>>({});
  const sending = useRef(new Set<string>());
  const batchPrompt = (id: string) =>
    `请使用知识工作台插件处理共享批次 ${id}。读取指定批次和其中图片，保持材料顺序；整理为主题知识卡与学习记录，保留来源、适用条件、原始想法和待核对项。通过提交草稿工具返回结果，正式笔记由我在软件中审核。`;
  async function sendBatch(id: string) {
    if (sending.current.has(id) || !window.workbench?.sendToCodex) return;
    sending.current.add(id);
    setDeliveries((s) => ({ ...s, [id]: "发送中…" }));
    try {
      await window.workbench.sendToCodex(batchPrompt(id));
      setDeliveries((s) => ({ ...s, [id]: "已发送" }));
      notify("整理请求已发送到当前对话，结果将返回待审稿");
    } catch (e) {
      setDeliveries((s) => ({ ...s, [id]: "请核对对话" }));
      notify(
        (e as Error).message + " 请先核对对话是否收到；未收到时可复制指令。",
        true,
      );
    }
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<Input>(
    initial || { title: "", thought: "", requestId: crypto.randomUUID() },
  );
  const inputBusy = useRef(false);
  function changeInput(field: "title" | "thought", value: string) {
    input.current = {
      ...input.current,
      [field]: value,
      requestId: crypto.randomUUID(),
    };
    setTitle(input.current.title);
    setThought(input.current.thought);
    saveInputRecovery();
  }
  function saveInputRecovery() {
    const durable = writeRecovery(key, input.current);
    setInputState(
      durable === "pending"
        ? "正在保存本机恢复草稿…"
        : durable
          ? "已保留本机恢复草稿，尚未写入知识库"
          : "恢复空间不可用，请保存后再关闭窗口",
    );
    if (durable === "pending") {
      const requestId = input.current.requestId;
      void flushRecovery(key)
        .then(() => {
          if (input.current.requestId === requestId)
            setInputState("已保留本机恢复草稿，尚未写入知识库");
        })
        .catch((e) => {
          if (input.current.requestId === requestId)
            setInputState("恢复草稿未保存，请保留面板并重试：" + e.message);
        });
    }
  }
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (input.current.title || input.current.thought) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const importFiles = async (files: File[]) => {
    setBusy(true);
    try {
      for (const f of files) {
        await api("POST", "/captures", {
          title: f.name.replace(/\.[^.]+$/, ""),
          image: await fileData(f),
          text: "",
        });
      }
      await refresh();
      notify(`已收集 ${files.length} 张图片`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const createThought = async () => {
    if (!input.current.thought.trim() || inputBusy.current) return;
    inputBusy.current = true;
    const sent = { ...input.current };
    setBusy(true);
    setInputState("正在保存到知识库…");
    try {
      await api("POST", "/captures", {
        title:
          sent.title.trim() || sent.thought.trim().split("\n")[0].slice(0, 35),
        text: sent.thought,
        requestId: sent.requestId,
      });
      if (
        input.current.requestId === sent.requestId &&
        (!readRecovery(key) || (await clearRecovery(key, sent)))
      ) {
        input.current = {
          title: "",
          thought: "",
          requestId: crypto.randomUUID(),
        };
        setThought("");
        setTitle("");
        setInputState("想法已写入知识库");
      } else setInputState("上次输入已保存，新增输入保留为本机草稿");
      await refresh();
      notify("想法已保存");
    } catch (e) {
      setInputState("保存失败，输入已保留；可重试");
      notify((e as Error).message, true);
    } finally {
      inputBusy.current = false;
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((i) => i !== id) : [...s, id],
    );
  const reorder = (id: string, offset: number) =>
    setSelected((s) => {
      const next = [...s],
        from = next.indexOf(id),
        to = from + offset;
      if (to < 0 || to >= next.length) return s;
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  const start = async () => {
    setBusy(true);
    try {
      const job = await api<Job>("POST", "/jobs", {
        sourceIds: selected,
        referencePaths: references,
        executor,
        instruction,
      });
      if (executor === "api") await api("POST", `/jobs/${job.id}/run`);
      setBatch(false);
      setSelected([]);
      await refresh();
      notify(
        executor === "api"
          ? "整理任务已启动"
          : "批次已共享，请到 Codex 发起整理",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="collection-page"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void importFiles(
          [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")),
        );
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files].filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length) {
          e.preventDefault();
          void importFiles(files);
        }
      }}
    >
      <div className="page-heading">
        <div>
          <span className="eyebrow">COLLECT FIRST, CONNECT LATER</span>
          <h1>先留下，再慢慢理解。</h1>
          <p>截图、疑问和一闪而过的想法，都可以从这里开始。</p>
        </div>
        <button
          className="primary"
          onClick={() => setBatch(true)}
          disabled={!selected.length}
        >
          <Sparkles size={16} />
          整理所选 {selected.length || ""}
        </button>
      </div>
      <div className="capture-actions">
        <button
          disabled={!capabilities.capture}
          title={
            capabilities.capture
              ? "框选测试或学习内容"
              : "当前浏览器服务不支持系统截图，请在桌面应用截图或导入图片"
          }
          onClick={() => {
            if (window.workbench)
              void window.workbench
                .capture()
                .catch((e) => notify(e.message, true));
            else
              void nativeAction("capture").catch((e) =>
                notify(e.message, true),
              );
          }}
        >
          <ScanLine size={21} />
          <span>
            框选截图
            <small>
              {capabilities.capture
                ? "Ctrl + Alt + S"
                : "需要桌面服务 · 可导入图片"}
            </small>
          </span>
        </button>
        <button onClick={() => fileInput.current?.click()} disabled={busy}>
          <ImagePlus size={21} />
          <span>
            导入图片<small>支持多选 · 也可以直接粘贴</small>
          </span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            void importFiles([...(e.target.files || [])]);
            e.target.value = "";
          }}
        />
      </div>
      <section className="quick-thought">
        <input
          aria-label="想法标题"
          placeholder="给这次想法起个标题（可选）"
          value={title}
          onChange={(e) => changeInput("title", e.target.value)}
        />
        <textarea
          aria-label="快速记录想法"
          placeholder="刚才看到什么？有什么不确定，或者想试着推导一下？"
          value={thought}
          onChange={(e) => changeInput("thought", e.target.value)}
        />
        <footer>
          <span role="status">{inputState}</span>
          {inputState.startsWith("恢复草稿未保存") && (
            <button className="secondary" onClick={saveInputRecovery}>
              重试恢复草稿
            </button>
          )}
          <button
            className="secondary"
            disabled={busy || !thought.trim()}
            onClick={() => void createThought()}
          >
            保存想法
          </button>
        </footer>
      </section>
      <div className="section-label">
        <span>材料收集箱</span>
        <span>{captures.length} 份材料</span>
      </div>
      {!captures.length ? (
        <div className="empty">
          <Layers3 size={38} strokeWidth={1} />
          <h3>把值得回看的内容放进来</h3>
          <p>无需先分类，也不用立即调用 AI。</p>
        </div>
      ) : (
        <div className="capture-grid">
          {captures.map((c) => (
            <article
              key={c.id}
              className={`capture-card ${selected.includes(c.id) ? "selected" : ""}`}
            >
              <label className="capture-select">
                <input
                  type="checkbox"
                  aria-label={`选择 ${c.ref.title}`}
                  checked={selected.includes(c.id)}
                  onChange={() => toggle(c.id)}
                />
                {selected.includes(c.id) && <b>{selected.indexOf(c.id) + 1}</b>}
              </label>
              <button
                className="capture-preview"
                onClick={() => onOpen(c.path)}
              >
                {c.ref.assetPath ? (
                  <img src={assetUrl(c.ref.assetPath)} alt={c.ref.title} />
                ) : (
                  <div className="text-preview">
                    {c.text.split("## 我当时的想法").at(-1)?.slice(0, 120)}
                  </div>
                )}
              </button>
              <div className="capture-info">
                <small>
                  {c.ref.kind === "paperdesk"
                    ? "来自纸间"
                    : c.ref.kind === "image"
                      ? "截图与图片"
                      : "手写想法"}{" "}
                  · {shortDate(c.ref.capturedAt)}
                </small>
                <h3>
                  <button onClick={() => onOpen(c.path)}>{c.ref.title}</button>
                </h3>
                {c.ref.paperdesk && (
                  <span>PDF 第 {c.ref.paperdesk.page} 页</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {jobs.length > 0 && (
        <>
          <div className="section-label">
            <span>整理任务</span>
            <span>完成的分项可继续使用</span>
          </div>
          <div className="jobs">
            {jobs.map((j) => (
              <article key={j.id}>
                <div>
                  <span className={"state state-" + j.state}>
                    {prettyState(j.state)}
                  </span>
                  <strong>
                    {j.snapshot.sources.length} 份材料 ·{" "}
                    {j.executor === "api" ? "模型接口" : "Codex"}
                  </strong>
                  <small>
                    {shortDate(j.createdAt)} ·{" "}
                    {j.items.filter((i) => i.state === "done").length}/
                    {j.items.length} 已提取
                  </small>
                  {j.error && <p className="error-text">{j.error}</p>}
                </div>
                <div className="job-actions">
                  {window.workbench?.sendToCodex &&
                    j.executor === "codex" &&
                    ["shared", "review"].includes(j.state) && (
                      <button
                        className="text-button"
                        disabled={Boolean(deliveries[j.id])}
                        onClick={() => void sendBatch(j.id)}
                      >
                        <Sparkles size={15} />
                        {deliveries[j.id] || "交给当前 Codex 对话"}
                      </button>
                    )}
                  {j.executor === "codex" &&
                    ["shared", "review"].includes(j.state) && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(batchPrompt(j.id))
                            .then(() => notify("Codex 指令已复制"))
                            .catch((e) =>
                              notify("复制失败：" + e.message, true),
                            )
                        }
                      >
                        <Clipboard size={15} />
                        复制指令
                      </button>
                    )}
                  {["running", "shared"].includes(j.state) && (
                    <button
                      className="icon"
                      title="暂停或撤回共享"
                      onClick={() =>
                        void api("POST", `/jobs/${j.id}/pause`)
                          .then(refresh)
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      <Square size={15} />
                    </button>
                  )}
                  {["queued", "failed", "paused"].includes(j.state) && (
                    <button
                      className="secondary"
                      onClick={() =>
                        void api(
                          "POST",
                          `/jobs/${j.id}/${j.executor === "api" ? "run" : "share"}`,
                        )
                          .then(refresh)
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      <Play size={15} />
                      继续
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {batch && (
        <Modal title="整理这一批材料" onClose={() => !busy && setBatch(false)}>
          <p className="muted">
            只有下列材料和你选择的参考笔记会交给模型。调整顺序后再开始。
          </p>
          <div className="ordered-list">
            {selected.map((id, i) => (
              <div key={id}>
                <span>{i + 1}</span>
                <strong>{captures.find((c) => c.id === id)?.ref.title}</strong>
                <button
                  className="icon"
                  aria-label="上移材料"
                  onClick={() => reorder(id, -1)}
                  disabled={!i}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="icon"
                  aria-label="下移材料"
                  onClick={() => reorder(id, 1)}
                  disabled={i === selected.length - 1}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
            ))}
          </div>
          <label>
            执行方式
            <select
              value={executor}
              onChange={(e) => setExecutor(e.target.value as "api" | "codex")}
            >
              <option value="api">软件内调用模型 API</option>
              <option value="codex">在 Codex 对话中发起</option>
            </select>
          </label>
          <label>
            参考笔记（按 Ctrl 多选，可不选）
            <select
              multiple
              size={4}
              value={references}
              onChange={(e) =>
                setReferences([...e.target.selectedOptions].map((o) => o.value))
              }
            >
              {notes
                .filter(
                  (n) =>
                    !n.path.includes("/Drafts/") &&
                    !n.path.includes("/Inbox/") &&
                    !n.missing,
                )
                .map((n) => (
                  <option key={n.path} value={n.path}>
                    {n.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            这次重点关注什么？
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：比较这些推导的适用条件，保留我还不确定的地方。"
            />
          </label>
          <footer className="modal-footer">
            <button
              className="secondary"
              onClick={() => setBatch(false)}
              disabled={busy}
            >
              返回
            </button>
            <button
              className="primary"
              onClick={() => void start()}
              disabled={busy}
            >
              {busy
                ? "正在准备…"
                : executor === "api"
                  ? "生成待审草稿"
                  : "共享给 Codex"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

export function Review({
  vaultId,
  proposals,
  jobs,
  onOpen,
  notify,
  refresh,
}: {
  vaultId: string;
  proposals: Proposal[];
  jobs: Job[];
  onOpen: (path: string) => void;
} & Common) {
  const [id, setId] = useState(""),
    [text, setText] = useState(""),
    [before, setBefore] = useState(""),
    [targetHash, setTargetHash] = useState(""),
    [diff, setDiff] = useState(false),
    [busy, setBusy] = useState(false);
  const editing = useRef<{
      id: string;
      text: string;
      hash: string;
      dirty: boolean;
    } | null>(null),
    saving = useRef<Promise<void> | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locked = useRef(false);
  const reviewKey = (id: string) => recoveryKey(vaultId, "review", id);
  const pending = proposals.filter((p) => p.status === "pending"),
    proposal = pending.find((p) => p.id === id) || pending[0],
    job = jobs.find((j) => j.id === proposal?.jobId);
  async function persist() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (saving.current) return saving.current;
    const work = (async () => {
      const edit = editing.current;
      while (edit?.dirty) {
        const value = edit.text;
        const saved = await api<Proposal>("PUT", `/proposals/${edit.id}`, {
          markdown: value,
          expectedHash: edit.hash,
        });
        edit.hash = saved.draftHash;
        edit.dirty = edit.text !== value;
        if (edit.dirty)
          writeRecovery(reviewKey(edit.id), {
            text: edit.text,
            hash: edit.hash,
          });
        else {
          const stored = readRecovery<{ text: string; hash: string }>(
            reviewKey(edit.id),
          );
          if (stored?.text === value)
            await clearRecovery(reviewKey(edit.id), stored);
        }
      }
    })();
    saving.current = work;
    try {
      await work;
    } finally {
      saving.current = null;
    }
  }
  function changeReview(value: string) {
    if (locked.current) return;
    setText(value);
    if (!editing.current) return;
    editing.current.text = value;
    editing.current.dirty = true;
    const persisted = writeRecovery(reviewKey(editing.current.id), {
      text: value,
      hash: editing.current.hash,
    });
    if (persisted === false)
      notify("审核恢复空间不可用，请保持窗口开启并立即保存。", true);
    if (persisted === "pending")
      void flushRecovery(reviewKey(editing.current.id)).catch((e) =>
        notify("审核恢复草稿未保存，请保留面板：" + e.message, true),
      );
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void persist().catch((e) => notify(e.message, true)),
      500,
    );
  }
  useEffect(() => {
    let current = true;
    const local =
      proposal &&
      readRecovery<{ text: string; hash: string }>(reviewKey(proposal.id));
    const value = local?.text ?? proposal?.recovery ?? proposal?.markdown ?? "";
    setText(value);
    editing.current = proposal
      ? {
          id: proposal.id,
          text: value,
          hash: local?.hash ?? proposal.draftHash,
          dirty: Boolean(local || proposal.recovery),
        }
      : null;
    setDiff(false);
    setBefore("");
    setTargetHash("");
    if (proposal?.targetPath)
      void api("GET", "/note?path=" + encodeURIComponent(proposal.targetPath))
        .then((n) => {
          if (!current) return;
          setBefore(n.owner === "paperdesk" ? n.body : n.content);
          setTargetHash(n.hash);
        })
        .catch((e) => {
          if (current) notify(e.message, true);
        });
    return () => {
      current = false;
    };
  }, [proposal?.id]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (editing.current?.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const unregister = window.workbench?.onFlush(persist);
    return () => {
      unregister?.();
      window.removeEventListener("beforeunload", beforeUnload);
      void persist().catch((e) =>
        notify("审核编辑已保留为本机草稿：" + e.message, true),
      );
    };
  }, []);
  const rebase = async () => {
    if (!proposal || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await persist();
      const result = await api<Proposal>(
        "POST",
        `/proposals/${proposal.id}/rebase`,
        { expectedHash: editing.current?.hash, targetHash },
      );
      if (editing.current) editing.current.hash = result.draftHash;
      await refresh();
      notify("修订基准已更新，请继续核对正文后确认保存。");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const accept = async () => {
    if (!proposal || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await persist();
      const saved = await api("POST", `/proposals/${proposal.id}/accept`, {
        markdown: editing.current?.text,
        expectedHash: editing.current?.hash,
      });
      await refresh();
      notify("已确认并保存笔记");
      onOpen(saved.path);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="review-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">REVIEW WITH THE SOURCE</span>
          <h1>让结论，有据可循。</h1>
          <p>对照原始材料，保留你认可的部分，再放入知识库。</p>
        </div>
        <span className="count-badge">{pending.length} 份待审</span>
      </div>
      {!proposal ? (
        <div className="empty">
          <Check size={38} strokeWidth={1} />
          <h3>目前没有待审草稿</h3>
          <p>API 或 Codex 的整理结果会出现在这里。</p>
        </div>
      ) : (
        <>
          <div className="proposal-tabs">
            {pending.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                aria-pressed={p.id === proposal.id}
                onClick={() => {
                  void persist()
                    .then(() => setId(p.id))
                    .catch((e) => notify(e.message, true));
                }}
              >
                {p.title}
                <small>{p.action === "amend" ? "修订" : "新建"}</small>
              </button>
            ))}
          </div>
          {proposal.unavailable && (
            <p role="alert" className="error-text">
              {proposal.unavailable}
            </p>
          )}
          <div className="review-grid">
            <aside className="source-review">
              <h3>原始材料</h3>
              {job?.snapshot.sources
                .filter((s) => proposal.sourceIds.includes(s.id))
                .map((s) => (
                  <article key={s.id}>
                    <h4>
                      <button onClick={() => onOpen(s.path)}>
                        {s.ref.title}
                        <ArrowUpRight size={13} />
                      </button>
                    </h4>
                    {s.ref.assetPath && (
                      <img src={assetUrl(s.ref.assetPath)} alt={s.ref.title} />
                    )}
                    <div
                      className="markdown-preview"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(s.text, s.path),
                      }}
                    />
                  </article>
                ))}
              {proposal.unresolved.length > 0 && (
                <div className="uncertainties">
                  <strong>待核对</strong>
                  <ul>
                    {proposal.unresolved.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
            <section className="proposal-editor">
              <header>
                <span>{proposal.title}</span>
                {proposal.action === "amend" && (
                  <button
                    className="text-button"
                    onClick={() => setDiff((d) => !d)}
                  >
                    {diff ? "继续编辑" : "查看修改差异"}
                  </button>
                )}
              </header>
              {diff ? (
                <>
                  <Diff before={before} after={text} />
                  {proposal.action === "amend" &&
                    targetHash &&
                    targetHash !== proposal.baseHash && (
                      <button
                        className="secondary"
                        onClick={() => void rebase()}
                      >
                        已核对当前版本，更新修订基准
                      </button>
                    )}
                </>
              ) : (
                <Editor
                  path={proposal.path}
                  content={text}
                  source={false}
                  readOnly={busy || Boolean(proposal.unavailable)}
                  onChange={changeReview}
                />
              )}
              <footer>
                <span>可直接删改，实现部分接受。</span>
                <button
                  className="secondary"
                  disabled={busy || Boolean(proposal.unavailable)}
                  onClick={() => {
                    if (locked.current) return;
                    locked.current = true;
                    setBusy(true);
                    void persist()
                      .then(() =>
                        api("POST", `/proposals/${proposal.id}/reject`),
                      )
                      .then(refresh)
                      .catch((e) => notify(e.message, true))
                      .finally(() => {
                        locked.current = false;
                        setBusy(false);
                      });
                  }}
                >
                  退回
                </button>
                <button
                  className="primary"
                  disabled={busy || Boolean(proposal.unavailable)}
                  onClick={() => void accept()}
                >
                  <Check size={15} />
                  {busy ? "正在保存…" : "确认并保存"}
                </button>
              </footer>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export function Settings({
  capabilities,
  onClose,
  notify,
  refresh,
}: { onClose: () => void; capabilities: Record<string, boolean> } & Common) {
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1"),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [protocol, setProtocol] = useState("responses"),
    [hasKey, setHasKey] = useState(false),
    [paperdesk, setPaperdesk] = useState("http://127.0.0.1:4317"),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(""),
    [plugin, setPlugin] = useState("");
  useEffect(() => {
    void api("GET", "/settings")
      .then((s) => {
        if (s.provider) {
          setBaseUrl(s.provider.baseUrl);
          setModel(s.provider.model);
          setProtocol(s.provider.protocol);
          setHasKey(s.provider.hasKey);
        }
        if (s.paperdesk) setPaperdesk(s.paperdesk.baseUrl);
      })
      .catch((e) => notify(e.message, true));
  }, []);
  const providerAction = async (test: boolean) => {
    setBusy(true);
    setResult("");
    try {
      const result = await api(
        test ? "POST" : "PUT",
        test ? "/settings/provider/test" : "/settings/provider",
        { baseUrl, model, protocol, apiKey: key || undefined },
      );
      if (test) setResult(`${result.output} · ${result.elapsedMs} ms`);
      else {
        setHasKey(true);
        setKey("");
        setResult("配置已加密保存在本机。");
      }
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="工作台设置" onClose={onClose}>
      <section className="settings-section">
        <div className="section-label">界面皮肤</div>
        <div className="theme-choices">
          {[
            ["forest", "森林"],
            ["sand", "暖砂"],
            ["mist", "雾蓝"],
            ["night", "夜读"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={"theme-choice theme-" + value}
              aria-pressed={document.documentElement.dataset.theme === value}
              onClick={() =>
                void api("PUT", "/settings/appearance", { theme: value })
                  .then(() => {
                    document.documentElement.dataset.theme = value;
                    return refresh();
                  })
                  .catch((e) => notify(e.message, true))
              }
            >
              <i />
              {label}
            </button>
          ))}
        </div>
        <p className="muted">偏好保存在本机，重新打开后沿用。</p>
      </section>
      {window.workbench?.panel ? (
        <section className="settings-section">
          <div className="section-label">模型接口</div>
          <p className="muted">
            模型和密钥请在桌面工作台设置。此面板沿用已保存的配置；使用 Codex
            整理无需填写 API 密钥。
          </p>
        </section>
      ) : (
        <section className="settings-section">
          <div className="section-label">
            <Settings2 size={15} />
            模型接口
          </div>
          <p className="muted">
            仅在你开始整理时发送选定材料。测试连接只发送一条固定短句。
          </p>
          {!capabilities.secureCredentials && (
            <p role="status">
              当前入口不支持系统密钥加密，请在桌面应用配置模型。
            </p>
          )}
          <fieldset
            disabled={!capabilities.secureCredentials || busy}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            <label>
              服务地址
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setResult("");
                }}
              />
            </label>
            <div className="form-row">
              <label>
                协议
                <select
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value)}
                >
                  <option value="responses">Responses</option>
                  <option value="chat-completions">Chat Completions</option>
                </select>
              </label>
              <label>
                模型名称
                <input
                  value={model}
                  placeholder="支持图像输入的模型"
                  onChange={(e) => {
                    setModel(e.target.value);
                    setResult("");
                  }}
                />
              </label>
            </div>
            <label>
              API 密钥
              <input
                type="password"
                autoComplete="off"
                value={key}
                placeholder={
                  hasKey
                    ? "已保存；留空沿用现有密钥"
                    : "输入密钥，仅在本机加密保存"
                }
                onChange={(e) => {
                  setKey(e.target.value);
                  setResult("");
                }}
              />
            </label>
            <div className="button-row">
              <button
                className="secondary"
                disabled={busy || !model}
                onClick={() => void providerAction(true)}
              >
                测试连接
              </button>
              <button
                className="primary"
                disabled={busy || !model}
                onClick={() => void providerAction(false)}
              >
                保存配置
              </button>
            </div>
            {result && (
              <p role="status" className="settings-result">
                {result}
              </p>
            )}
          </fieldset>
        </section>
      )}
      <section className="settings-section">
        <div className="section-label">纸间 Paperdesk</div>
        <label>
          本机服务地址
          <input
            value={paperdesk}
            onChange={(e) => setPaperdesk(e.target.value)}
          />
        </label>
        <button
          className="secondary"
          onClick={() =>
            void api("PUT", "/settings/paperdesk", { baseUrl: paperdesk })
              .then(() => notify("纸间资料库已绑定"))
              .catch((e) => notify(e.message, true))
          }
        >
          核对并连接
        </button>
        <p className="muted">
          接收纸间导出的选区，编辑其阅读笔记正文，并按原页回查。
        </p>
      </section>
      <section className="settings-section">
        <div className="section-label">Codex 插件</div>
        {!window.workbench?.panel && !capabilities.plugin && (
          <p className="muted">
            当前入口不能准备本地插件，请在桌面应用完成准备。
          </p>
        )}
        <p className="muted">
          先在收集箱建立共享批次，再在 Codex
          对话中要求整理。插件只读取你共享的材料，返回待审草稿。
        </p>
        {window.workbench?.panel ? (
          <p role="status">
            Codex 原生面板已连接。可直接编辑、收集材料和审核草稿。
          </p>
        ) : (
          <button
            className="secondary"
            disabled={!capabilities.plugin}
            onClick={() => {
              if (window.workbench)
                void window.workbench
                  .invoke("DESKTOP", "/plugin/setup")
                  .then((r) => {
                    setPlugin(r.message);
                    notify("本地插件配置已生成");
                  })
                  .catch((e) => notify(e.message, true));
              else
                void nativeAction("plugin")
                  .then((r) => setPlugin(r.message))
                  .catch((e) => notify(e.message, true));
            }}
          >
            准备本地插件
          </button>
        )}
        {plugin && <pre className="plugin-instructions">{plugin}</pre>}
      </section>
      <footer className="modal-footer">
        <button className="secondary" onClick={onClose}>
          完成
        </button>
      </footer>
    </Modal>
  );
}
