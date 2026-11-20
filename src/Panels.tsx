import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Clipboard,
  FilePlus2,
  ImagePlus,
  Layers3,
  MessageSquare,
  Play,
  RefreshCw,
  ScanLine,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { CaptureTrash } from "./CaptureTrash";
import { CodexConversation, type ReviewMessage } from "./CodexConversation";
import { ReviewDivider } from "./ReviewDivider";
import { CodexOptionsFields, CodexOptionsSummary } from "./CodexOptions";
import {
  defaultCodexOptions,
  type CodexOptions,
  type CodexCatalog,
} from "../shared/codex-options";
import { diffLines } from "diff";
import type {
  BatchExecutor,
  BatchPreview,
  Capture,
  ChildNoteDraft,
  CodexCliStatus,
  CodexReviewAnchor,
  Job,
  NoteSummary,
  Proposal,
} from "../shared/contracts";
import { codexRootJob, maxRevisionComments } from "../shared/contracts";
import {
  GENERAL_PROFILE,
  RESEARCH_FOCUS,
  researchSelectionSchema,
  researchProfileLabel,
  snapshotResearchProfile,
  type ResearchSelection,
} from "../shared/research-profiles";
import { researchChecks } from "../shared/research-checks";
import {
  api,
  type ApiError,
  fileData,
  openExternal,
  prettyState,
  shortDate,
  nativeAction,
} from "./client";
import { assetUrl } from "./markdown";
import { Editor, type EditorHandle } from "./Editor";
import { NoteColorMenu } from "./NoteColorMenu";
import {
  type ReviewFeedback,
  emptyReviewFeedback,
  readReviewFeedback,
  writeReviewFeedback,
  enqueueOpinion,
} from "./review-feedback";
import { noteOutline } from "../shared/note-outline";
import { MaterialContent, SnapshotText } from "./MaterialContent";
import {
  filterMaterials,
  materialKindLabel,
  reviewEvidence,
  type MaterialKind,
} from "./materials";
import { primaryModifier } from "./platform";
import { CaptureShortcutSettings, useCaptureShortcut } from "./CaptureShortcut";
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
  fallbackFocus,
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  fallbackFocus?: () => void;
  initialFocus?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current
      ?.querySelector<HTMLElement>(
        initialFocus || "input,textarea,select,button",
      )
      ?.focus();
    return () => {
      if (
        previous?.isConnected &&
        previous !== document.body &&
        !previous.matches(":disabled")
      )
        previous.focus();
      else fallbackFocus?.();
    };
  }, []);
  // A restored/deleted row may remove the focused button while the dialog
  // stays open. Keep Escape and keyboard navigation inside the dialog.
  useEffect(() => {
    if (document.activeElement === document.body)
      panel.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
        )
        ?.focus();
  });
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

const executorLabels: Record<BatchExecutor, string> = {
  "codex-cli": "本机 Codex CLI",
  api: "模型 API",
  codex: "Codex 对话",
};
export const codexCliLabels: Record<CodexCliStatus | "checking", string> = {
  checking: "正在检查本机 Codex CLI…",
  ready: "已检测到本机 Codex CLI 登录。",
  missing: "未找到本机 Codex CLI。可安装并登录，或改用模型 API。",
  "signed-out": "本机 Codex CLI 尚未登录。可先登录，或改用模型 API。",
  unavailable: "暂时无法确认本机 Codex CLI 登录。可重试，或改用模型 API。",
};
export function useCodexCliStatus(enabled: boolean, includeCatalog = false) {
  const [connection, setConnection] = useState<{
    status: CodexCliStatus | "checking";
    catalog?: CodexCatalog;
    defaults?: CodexOptions;
  }>({ status: "checking" });
  const [check, setCheck] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setConnection((previous) => ({ ...previous, status: "checking" }));
    void api<typeof connection>(
      "GET",
      "/settings/codex-cli" + (includeCatalog ? "?catalog=1" : ""),
    )
      .then((result) => {
        if (current) setConnection(result);
      })
      .catch(() => {
        if (current)
          setConnection((previous) => ({ ...previous, status: "unavailable" }));
      });
    return () => {
      current = false;
    };
  }, [enabled, includeCatalog, check]);
  return {
    state: connection.status,
    catalog: connection.catalog,
    defaults:
      connection.defaults ??
      connection.catalog?.defaults ??
      defaultCodexOptions,
    recheck: () => setCheck((value) => value + 1),
  };
}

export function Inbox({
  taskId,
  registerGuard,
  vaultId,
  capabilities,
  captures,
  notes,
  jobs,
  onOpen,
  notify,
  refresh,
}: {
  taskId: string;
  registerGuard: (guard: () => Promise<boolean>) => void;
  vaultId: string;
  capabilities: Record<string, boolean>;
  captures: Capture[];
  notes: NoteSummary[];
  jobs: Job[];
  onOpen: (path: string) => void;
} & Common) {
  const captureShortcut = useCaptureShortcut();
  type Input = { title: string; thought: string; requestId: string };
  const key = recoveryKey(vaultId, "inbox", taskId === "history" ? "" : taskId);
  const initial = readRecovery<Input>(key);
  const [selected, setSelected] = useState<string[]>([]),
    [thought, setThought] = useState(initial?.thought || ""),
    [title, setTitle] = useState(initial?.title || ""),
    [inputState, setInputState] = useState(
      initial ? "已恢复本机草稿，尚未写入知识库" : "原始想法会随材料保留。",
    ),
    [batch, setBatch] = useState(false),
    [executor, setExecutor] = useState<BatchExecutor>(
      capabilities.codexCli ? "codex-cli" : "codex",
    ),
    [researchSelection, setResearchSelection] =
      useState<ResearchSelection>(GENERAL_PROFILE),
    [preview, setPreview] = useState<BatchPreview | null>(null),
    [instruction, setInstruction] = useState(""),
    [references, setReferences] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<Capture[]>([]);
  const cli = useCodexCliStatus(batch && capabilities.codexCli, true);
  const [pickedCodex, setPickedCodex] = useState<CodexOptions>();
  const codexOptions = pickedCodex ?? cli.defaults;
  useEffect(() => {
    const ids = new Set(captures.map((c) => c.id));
    setSelected((previous) => previous.filter((id) => ids.has(id)));
  }, [captures]);
  const materialSearch = useRef<HTMLInputElement>(null);
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialKind, setMaterialKind] = useState<MaterialKind>("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const visibleMaterials = filterMaterials(
    captures,
    materialQuery,
    materialKind,
    selectedOnly,
    selected,
  );
  const previewMaterial = captures.find((capture) => capture.id === previewId);
  const [deliveries, setDeliveries] = useState<Record<string, string>>({});
  const sending = useRef(new Set<string>());
  const batchBusy = useRef(false);
  const selectionTouched = useRef(false);
  const previewKey = JSON.stringify({
    selected,
    references,
    executor,
    codexOptions: executor === "codex-cli" ? codexOptions : undefined,
    instruction,
    researchSelection,
  });
  const currentPreviewKey = useRef(previewKey);
  currentPreviewKey.current = previewKey;
  useEffect(() => {
    setPreview(null);
  }, [previewKey]);
  useEffect(() => {
    void api("GET", "/settings")
      .then((settings) => {
        if (selectionTouched.current) return;
        const selection = researchSelectionSchema.safeParse(
          settings.researchSelection,
        );
        setResearchSelection(
          selection.success ? selection.data : GENERAL_PROFILE,
        );
      })
      .catch(() => {});
  }, []);
  function selectResearch(selection: ResearchSelection) {
    selectionTouched.current = true;
    setResearchSelection(selection);
  }
  const batchPrompt = (id: string) =>
    `请使用知识工作台插件处理共享批次 ${id}。先读取批次；若含 researchProfile，按该批固定版本和 focus 整理，不改用其他配置。读取指定批次和其中图片，保持材料顺序；保留来源、适用条件、原始想法和待核对项。通过提交草稿工具返回结果，正式笔记由我在软件中审核。`;
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
          taskId,
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
        taskId,
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
      return !input.current.thought && !input.current.title;
    } catch (e) {
      setInputState("保存失败，输入已保留；可重试");
      notify((e as Error).message, true);
    } finally {
      inputBusy.current = false;
      setBusy(false);
    }
  };
  const [leavePrompt, setLeavePrompt] = useState(false);
  const leaveResolve = useRef<((value: boolean) => void) | null>(null);
  const [leaveError, setLeaveError] = useState("");
  registerGuard(async () => {
    if (inputBusy.current || batchBusy.current || busy) {
      notify("请等待当前操作完成", true);
      return false;
    }
    if (!input.current.title && !input.current.thought) return true;
    if (leaveResolve.current) return false;
    setLeavePrompt(true);
    setLeaveError("");
    return new Promise<boolean>((resolve) => {
      leaveResolve.current = resolve;
    });
  });
  function resolveLeave(value: boolean) {
    setLeavePrompt(false);
    const resolve = leaveResolve.current;
    leaveResolve.current = null;
    resolve?.(value);
  }
  async function retainAndLeave() {
    try {
      const durable = writeRecovery(key, input.current);
      if (durable === false) throw new Error("本机恢复空间不可用");
      await flushRecovery(key);
      resolveLeave(true);
    } catch (e) {
      setLeaveError("草稿未保存，请留在当前任务：" + (e as Error).message);
    }
  }
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
  const preparePreview = async () => {
    if (batchBusy.current) return;
    batchBusy.current = true;
    const requestKey = previewKey;
    setBusy(true);
    try {
      const result = await api<BatchPreview>("POST", "/jobs/preview", {
        taskId,
        sourceIds: selected,
        referencePaths: references,
        executor,
        codexOptions: executor === "codex-cli" ? codexOptions : undefined,
        instruction,
        researchSelection,
      });
      if (currentPreviewKey.current === requestKey) setPreview(result);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      batchBusy.current = false;
      setBusy(false);
    }
  };
  const start = async () => {
    if (!preview || batchBusy.current) return;
    batchBusy.current = true;
    setBusy(true);
    try {
      const job = await api<Job>("POST", "/jobs", {
        taskId,
        sourceIds: selected,
        referencePaths: references,
        executor,
        codexOptions: executor === "codex-cli" ? codexOptions : undefined,
        instruction,
        researchSelection,
        expectedPreviewHash: preview.previewHash,
      });
      if (executor !== "codex") await api("POST", `/jobs/${job.id}/run`);
      setBatch(false);
      setSelected([]);
      await refresh();
      notify(
        executor === "codex"
          ? "批次已共享，请到 Codex 发起整理"
          : `已通过${executorLabels[executor]}启动整理`,
      );
    } catch (e) {
      setPreview(null);
      notify((e as Error).message, true);
    } finally {
      batchBusy.current = false;
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
          onClick={() => {
            setExecutor(capabilities.codexCli ? "codex-cli" : "codex");
            setPickedCodex(undefined);
            setBatch(true);
          }}
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
                .capture(taskId)
                .catch((e) => notify(e.message, true));
            else
              void nativeAction("capture", taskId).catch((e) =>
                notify(e.message, true),
              );
          }}
        >
          <ScanLine size={21} />
          <span>
            框选截图
            <small>
              {capabilities.capture
                ? captureShortcut
                  ? `${captureShortcut.label}${captureShortcut.registered ? "" : " · 未注册"}`
                  : "可在桌面设置快捷键"
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
        <button
          className="capture-delete"
          disabled={
            !capabilities.captureTrash ||
            busy ||
            !selected.length ||
            selected.length > 100
          }
          title={selected.length > 100 ? "每次最多删除 100 份材料" : undefined}
          onClick={() =>
            setDeleteTargets(
              selected
                .map((id) => captures.find((c) => c.id === id))
                .filter((c): c is Capture => Boolean(c)),
            )
          }
        >
          删除所选 {selected.length} 份
        </button>
      </div>
      {leavePrompt && (
        <Modal title="保留当前任务的草稿" onClose={() => resolveLeave(false)}>
          <p>切换或离开前，选择保存到当前任务，或保留仅本机可恢复的草稿。</p>
          {leaveError && <p role="alert">{leaveError}</p>}
          <button onClick={() => resolveLeave(false)}>留在当前任务</button>
          <button onClick={() => void retainAndLeave()}>保留草稿并离开</button>
          <button
            disabled={busy || !thought.trim()}
            onClick={() =>
              void createThought().then((saved) => {
                if (saved) resolveLeave(true);
              })
            }
          >
            保存想法并离开
          </button>
        </Modal>
      )}
      <CaptureTrash
        taskId={taskId}
        enabled={Boolean(capabilities.captureTrash)}
        targets={deleteTargets}
        visibleIds={visibleMaterials.map((c) => c.id)}
        onClose={() => setDeleteTargets([])}
        onDeleted={(ids) => {
          setSelected((previous) => previous.filter((id) => !ids.includes(id)));
          if (previewId && ids.includes(previewId)) setPreviewId(null);
        }}
        refresh={refresh}
      />
      <div className="material-tools" role="search" aria-label="筛选材料">
        <input
          type="search"
          ref={materialSearch}
          aria-label="搜索材料"
          placeholder="搜索标题、正文或来源…"
          value={materialQuery}
          onChange={(e) => setMaterialQuery(e.target.value)}
        />
        <select
          aria-label="材料类型"
          value={materialKind}
          onChange={(e) => setMaterialKind(e.target.value as MaterialKind)}
        >
          <option value="all">全部类型</option>
          <option value="paperdesk">来自纸间</option>
          <option value="image">截图与图片</option>
          <option value="text">手写想法</option>
        </select>
        <button
          className="secondary"
          aria-pressed={selectedOnly}
          onClick={() => setSelectedOnly((value) => !value)}
        >
          只看已选 {selected.length}
        </button>
      </div>
      <p className="material-results" role="status">
        显示 {visibleMaterials.length} / {captures.length} 份 · 已选{" "}
        {selected.length} 份，筛选不会改变整理顺序
      </p>
      {!captures.length ? (
        <div className="empty">
          <Layers3 size={38} strokeWidth={1} />
          <h3>把值得回看的内容放进来</h3>
          <p>无需先分类，也不用立即调用 AI。</p>
        </div>
      ) : (
        <div className="capture-grid">
          {visibleMaterials.map((c) => (
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
                aria-label={`预览 ${c.ref.title}`}
                onClick={() => setPreviewId(c.id)}
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
                <button
                  className="capture-delete capture-delete-single"
                  disabled={!capabilities.captureTrash || busy}
                  aria-label={`删除 ${c.ref.title}`}
                  onClick={() => setDeleteTargets([c])}
                >
                  删除
                </button>
                <small>
                  {materialKindLabel(c.ref.kind)} ·{" "}
                  {shortDate(c.ref.capturedAt)}
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
      {captures.length > 0 && visibleMaterials.length === 0 && (
        <div className="empty material-empty">
          <h3>没有符合条件的材料</h3>
          <p>已选材料仍保留，可以清除筛选后继续查看。</p>
          <button
            className="secondary"
            onClick={() => {
              setMaterialQuery("");
              setMaterialKind("all");
              setSelectedOnly(false);
            }}
          >
            清除筛选
          </button>
        </div>
      )}
      {previewMaterial && (
        <Modal
          title={previewMaterial.ref.title}
          fallbackFocus={() => materialSearch.current?.focus()}
          onClose={() => setPreviewId(null)}
          wide
        >
          <div className="material-reader">
            <MaterialContent capture={previewMaterial} />
          </div>
          <footer className="modal-footer">
            <span className="muted">
              只读预览 · 打开笔记后可编辑或回查纸间来源
            </span>
            <button
              className="secondary"
              aria-pressed={selected.includes(previewMaterial.id)}
              onClick={() => toggle(previewMaterial.id)}
            >
              {selected.includes(previewMaterial.id) ? "取消选择" : "加入所选"}
            </button>
            <button
              className="primary"
              onClick={() => {
                setPreviewId(null);
                onOpen(previewMaterial.path);
              }}
            >
              打开材料笔记
            </button>
          </footer>
        </Modal>
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
                    {executorLabels[j.executor]}
                  </strong>
                  <small>
                    {shortDate(j.createdAt)} ·{" "}
                    {j.items.filter((i) => i.state === "done").length}/
                    {j.items.length} 已提取
                  </small>
                  <small>
                    {researchProfileLabel(j.snapshot.researchProfile)}
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
                          `/jobs/${j.id}/${j.executor === "codex" ? "share" : "run"}`,
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
                  disabled={busy || !i}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="icon"
                  aria-label="下移材料"
                  onClick={() => reorder(id, 1)}
                  disabled={busy || i === selected.length - 1}
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
              disabled={busy}
              onChange={(e) => setExecutor(e.target.value as BatchExecutor)}
            >
              {capabilities.codexCli && (
                <option value="codex-cli">本机 Codex CLI（首选）</option>
              )}
              <option value="api">模型 API（备用）</option>
              <option value="codex">在 Codex 对话中发起</option>
            </select>
          </label>
          {executor === "codex-cli" && (
            <>
              <CodexOptionsFields
                catalog={cli.catalog}
                value={codexOptions}
                disabled={busy || cli.state === "checking"}
                onChange={setPickedCodex}
              />
              <div className="executor-status">
                <span role="status">{codexCliLabels[cli.state]}</span>
                {cli.state !== "checking" && cli.state !== "ready" && (
                  <button className="secondary" onClick={cli.recheck}>
                    重新检查
                  </button>
                )}
              </div>
            </>
          )}
          <label>
            整理配置
            <select
              value={researchSelection.id}
              disabled={busy}
              onChange={(e) =>
                selectResearch({
                  id: e.target.value as ResearchSelection["id"],
                  focus: researchSelection.focus,
                })
              }
            >
              <option value="general">通用整理（默认）</option>
              <option value="analog-ic-research">模拟 IC 科研</option>
            </select>
          </label>
          {researchSelection.id === "analog-ic-research" && (
            <>
              <label>
                科研重点
                <select
                  value={researchSelection.focus}
                  disabled={busy}
                  onChange={(e) =>
                    selectResearch({
                      ...researchSelection,
                      focus: e.target.value as ResearchSelection["focus"],
                    })
                  }
                >
                  {Object.entries(RESEARCH_FOCUS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                保留原文、用户假设、AI
                推断、单位与实验条件。配置随本批固定；短笔记不强制填满栏目。上次交付的选择会在本库沿用。
              </p>
              <details className="research-profile-preview">
                <summary>
                  查看科研指令 · v
                  {snapshotResearchProfile(researchSelection)!.version}
                </summary>
                <pre>
                  {snapshotResearchProfile(researchSelection)!.instructions}
                </pre>
              </details>
            </>
          )}
          <label>
            参考笔记（按 {primaryModifier} 多选，可不选）
            <select
              multiple
              disabled={busy}
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
              disabled={busy}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：比较这些推导的适用条件，保留我还不确定的地方。"
            />
          </label>
          {preview && (
            <section className="batch-preview" aria-label="交付预览">
              <h3>核对后再交付</h3>
              <p>
                {researchProfileLabel(preview.researchProfile)} ·{" "}
                {preview.sources.length} 份材料 · {preview.references.length}{" "}
                篇参考笔记
              </p>
              {preview.codexOptions && (
                <CodexOptionsSummary
                  value={preview.codexOptions}
                  catalog={cli.catalog}
                />
              )}
              <p className="muted">
                只交付下方快照和所列图片。预览不会发送给模型；结果仍需你审核。任何输入变化都需重新预览。
              </p>
              {preview.sources
                .filter((source) => source.ref.assetPath)
                .map((source) => (
                  <figure key={source.id}>
                    <img
                      src={assetUrl(source.ref.assetPath!)}
                      alt={source.ref.title}
                    />
                    <figcaption>{source.ref.title}</figcaption>
                  </figure>
                ))}
              <ResearchHints
                profile={preview.researchProfile}
                text={
                  preview.sources.map((source) => source.text).join("\n") +
                  "\n" +
                  preview.references.map((note) => note.content).join("\n")
                }
              />
              <details open>
                <summary>完整交付快照（含科研指令、正文、来源与版本）</summary>
                <pre>{JSON.stringify(preview, null, 2)}</pre>
              </details>
            </section>
          )}
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
              onClick={() => void (preview ? start() : preparePreview())}
              disabled={
                busy || (executor === "codex-cli" && cli.state !== "ready")
              }
            >
              {busy
                ? "正在准备…"
                : !preview
                  ? "预览交付内容"
                  : executor === "codex"
                    ? "确认共享给 Codex"
                    : executor === "codex-cli"
                      ? "交给本机 Codex 整理"
                      : "确认发送并生成草稿"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

function ResearchHints({
  profile,
  text,
}: {
  profile: Job["snapshot"]["researchProfile"];
  text: string;
}) {
  const checks = researchChecks(profile, text);
  if (!profile) return null;
  return (
    <div className="uncertainties research-checks">
      <strong>确定性检查提示</strong>
      <p className="muted">
        仅检查文字中的有限模式，不代表已验证科学结论或模型质量。
      </p>
      {checks.length ? (
        <ul>
          {checks.map((check, index) => (
            <li key={check.code + index}>{check.message}</li>
          ))}
        </ul>
      ) : (
        <p>未触发有限规则，仍需人工核对来源、条件与推断。</p>
      )}
    </div>
  );
}

export function Review({
  vaultId,
  proposals,
  jobs,
  onOpen,
  saveTarget,
  notify,
  refresh,
}: {
  vaultId: string;
  proposals: Proposal[];
  jobs: Job[];
  onOpen: (path: string) => Promise<void>;
  saveTarget: (path: string) => Promise<void>;
} & Common) {
  const [id, setId] = useState(""),
    [text, setText] = useState(""),
    [before, setBefore] = useState(""),
    [targetHash, setTargetHash] = useState(""),
    [diff, setDiff] = useState<"original" | "previous" | null>(null),
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
  const [conversation, setConversation] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [showSources, setShowSources] = useState(false);
  const [narrowChat, setNarrowChat] = useState(false);
  const reviewChatId = useId();
  const [feedbackByDraft, setFeedbackByDraft] = useState<
    Record<string, ReviewFeedback>
  >({});
  const compareOnOpen = useRef("");
  const [childPreview, setChildPreview] = useState<ChildNoteDraft | null>(null);
  const reviewEditor = useRef<EditorHandle>(null);
  const reviewOutline = useMemo(
    () => noteOutline(text).filter((heading) => heading.level > 1),
    [text],
  );
  const reviewKey = (id: string) => recoveryKey(vaultId, "review", id);
  const pending = proposals.filter(
      (p) => p.status === "pending" && !p.supersededBy,
    ),
    proposal =
      proposals.find((p) => p.id === id && p.status === "pending") ||
      pending[0],
    job = jobs.find((j) => j.id === proposal?.jobId);
  const evidence = proposal ? reviewEvidence(proposal, job) : null;
  const revision = job?.snapshot.noteRevision;
  const previous = job?.snapshot.codexFollowUp?.base;
  const inlineChat = job?.executor === "codex-cli";
  const expandedChat = inlineChat && showChat;
  const cli = useCodexCliStatus(expandedChat, true);
  const lockedDraft = Boolean(
    proposal?.unavailable || proposal?.revising || proposal?.supersededBy,
  );
  const canContinue = inlineChat && !lockedDraft;
  const baseChanged = Boolean(
    proposal?.targetPath && targetHash && targetHash !== proposal.baseHash,
  );
  const feedbackKey = proposal
    ? "kwb-codex-feedback:" + vaultId + ":" + proposal.id
    : "";
  const savedFeedback = useMemo(
    () => (feedbackKey ? readReviewFeedback(feedbackKey) : emptyReviewFeedback),
    [feedbackKey],
  );
  const reviewFeedback = feedbackByDraft[feedbackKey] ?? savedFeedback;
  function updateFeedback(value: ReviewFeedback) {
    if (!feedbackKey) return;
    setFeedbackByDraft((previous) => ({ ...previous, [feedbackKey]: value }));
    writeReviewFeedback(feedbackKey, value);
  }
  const optimizationJobs = jobs.filter(
    (item) =>
      item.snapshot.noteRevision &&
      !item.snapshot.codexFollowUp?.mode &&
      ["queued", "running", "paused", "failed"].includes(item.state),
  );
  function describeDraft(draftId: string) {
    const draft = proposals.find(
      (entry) =>
        entry.id === draftId &&
        entry.status === "pending" &&
        !entry.unavailable,
    );
    if (!draft) return;
    let version = 1;
    let ancestor = draft;
    const seen = new Set([draftId]);
    for (;;) {
      const baseId = jobs.find((item) => item.id === ancestor.jobId)?.snapshot
        .codexFollowUp?.proposalId;
      if (!baseId || seen.has(baseId)) break;
      version++;
      const parent = proposals.find((entry) => entry.id === baseId);
      if (!parent) break;
      seen.add(baseId);
      ancestor = parent;
    }
    return draft.title + " · 第 " + version + " 版";
  }
  function openDraft(draftId: string, compare = false) {
    if (locked.current) return;
    void persist()
      .then(() => {
        if (draftId === proposal?.id && compare && previous)
          setDiff("previous");
        else {
          compareOnOpen.current = compare ? draftId : "";
          setId(draftId);
        }
        setNarrowChat(false);
      })
      .catch((e) => notify(e.message, true));
  }
  function quoteDraft(value?: CodexReviewAnchor) {
    if (!proposal || !canContinue || locked.current) return;
    if (!value) {
      notify("请先选中要引用的段落。", true);
      return;
    }
    const current = reviewFeedback.anchor;
    const switching =
      current &&
      (current.offset !== value.offset || current.text !== value.text);
    if (
      switching &&
      reviewFeedback.instruction.trim() &&
      reviewFeedback.editing === undefined
    ) {
      if (reviewFeedback.comments.length >= maxRevisionComments) {
        notify("请先提交已记录的意见，再添加新的引用。", true);
        return;
      }
      updateFeedback({ ...enqueueOpinion(reviewFeedback), anchor: value });
    } else {
      updateFeedback({ ...reviewFeedback, anchor: value });
    }
    setShowChat(true);
    setNarrowChat(true);
  }
  async function openReviewNote(path: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await persist();
      await onOpen(path);
    } catch (e) {
      notify("草稿尚未保存，请留在审核页重试：" + (e as Error).message, true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
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
    if (proposal) setId(proposal.id);
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
    setDiff(
      proposal?.id === compareOnOpen.current && previous ? "previous" : null,
    );
    compareOnOpen.current = "";
    setBefore("");
    setTargetHash("");
    if (proposal?.targetPath)
      void api("GET", "/note?path=" + encodeURIComponent(proposal.targetPath))
        .then((n) => {
          if (!current) return;
          setBefore(
            revision
              ? (n.body || "").replace(/\r\n/g, "\n")
              : n.owner === "paperdesk"
                ? n.body
                : n.content,
          );
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
  async function compareOriginal() {
    if (!proposal?.targetPath) return;
    try {
      const target = await api(
        "GET",
        "/note?path=" + encodeURIComponent(proposal.targetPath),
      );
      if (editing.current?.id !== proposal.id) return;
      setBefore(
        revision
          ? (target.body || "").replace(/\r\n/g, "\n")
          : target.owner === "paperdesk"
            ? target.body
            : target.content,
      );
      setTargetHash(target.hash);
      setDiff("original");
      setNarrowChat(false);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
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
      notify("已确认原笔记的当前版本。");
    } catch (e) {
      notify((e as Error).message, true);
      if ((e as ApiError).code === "VERSION_CONFLICT") await compareOriginal();
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
      if (!proposal.sourceIds.length && proposal.targetPath)
        await saveTarget(proposal.targetPath);
      const saved = await api("POST", `/proposals/${proposal.id}/accept`, {
        markdown: editing.current?.text,
        expectedHash: editing.current?.hash,
      });
      await refresh();
      notify("已确认并保存笔记");
      await onOpen(saved.path);
    } catch (e) {
      notify((e as Error).message, true);
      if (proposal.targetPath && (e as ApiError).code === "VERSION_CONFLICT")
        await compareOriginal();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const continueDraft = async (message: ReviewMessage) => {
    if (!proposal || !canContinue || locked.current)
      throw new Error("当前稿件暂时无法交给 Codex。");
    locked.current = true;
    setBusy(true);
    try {
      await persist();
      await api<Job>("POST", "/proposals/" + proposal.id + "/continue", {
        ...message,
        expectedHash: editing.current?.hash,
      });
      void refresh().catch(() => {});
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
        <div className="review-heading-actions">
          {jobs.some((item) => item.executor === "codex-cli") && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConversation(true)}
            >
              Codex 对话记录
            </button>
          )}
          <span className="count-badge">{pending.length} 份待审</span>
        </div>
      </div>
      {optimizationJobs.length > 0 && (
        <section className="optimization-jobs" aria-label="笔记优化任务">
          <div className="section-label">笔记优化任务</div>
          <div className="jobs">
            {optimizationJobs.map((item) => (
              <article key={item.id}>
                <div>
                  <span className={"state state-" + item.state}>
                    {prettyState(item.state)}
                  </span>
                  <strong>{item.snapshot.noteRevision?.title}</strong>
                  {item.snapshot.codexOptions && (
                    <CodexOptionsSummary value={item.snapshot.codexOptions} />
                  )}
                  {item.error && <p className="error-text">{item.error}</p>}
                </div>
                <button
                  className="secondary"
                  onClick={() => {
                    void api(
                      "POST",
                      `/jobs/${item.id}/${item.state === "running" ? "pause" : "run"}`,
                    )
                      .then(refresh)
                      .catch((e) => notify(e.message, true));
                  }}
                >
                  {item.state === "running" ? "暂停" : "继续优化"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
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
                onClick={() => openDraft(p.id)}
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
          {expandedChat && (
            <div className="review-narrow-tabs" aria-label="审稿视图">
              <button
                className="secondary"
                aria-pressed={!narrowChat}
                onClick={() => setNarrowChat(false)}
              >
                稿件
              </button>
              <button
                className="secondary"
                aria-pressed={narrowChat}
                onClick={() => setNarrowChat(true)}
              >
                Codex 对话
              </button>
            </div>
          )}
          <div
            className={
              "review-grid" +
              (expandedChat ? " review-grid-chat" : "") +
              (narrowChat ? " review-show-chat" : "")
            }
          >
            <aside className="source-review">
              {expandedChat && (
                <button
                  className="text-button review-sources-toggle"
                  type="button"
                  aria-expanded={showSources}
                  onClick={() => setShowSources((value) => !value)}
                >
                  {showSources ? "收起审核依据" : "展开审核依据"}
                </button>
              )}
              <div hidden={expandedChat && !showSources}>
                <p className="muted">
                  {researchProfileLabel(job?.snapshot.researchProfile)}
                </p>
                <div className="review-evidence-summary">
                  <strong>审核依据</strong>
                  {job?.snapshot.codexOptions && (
                    <CodexOptionsSummary value={job.snapshot.codexOptions} />
                  )}
                  <p>
                    {revision
                      ? "原笔记快照"
                      : `${evidence?.sources.length} 份原始材料`}{" "}
                    · {evidence?.references.length} 篇参考笔记 ·{" "}
                    {proposal.unresolved.length} 项待核对
                  </p>
                  <small>
                    以下正文为整理时的固定快照；打开笔记查看当前版本。图片按原附件路径读取。
                  </small>
                </div>
                {Boolean(evidence?.missing.length) && (
                  <p role="alert" className="error-text">
                    有 {evidence?.missing.length}{" "}
                    份来源快照缺失，请先核对来源再接受草稿。
                  </p>
                )}
                {revision ? (
                  <details className="evidence-item">
                    <summary>原笔记 · {revision.title}</summary>
                    <p className="material-path">{revision.path}</p>
                    <SnapshotText
                      text={revision.content}
                      path={revision.path}
                    />
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void openReviewNote(revision.path)}
                    >
                      打开当前笔记 <ArrowUpRight size={13} />
                    </button>
                  </details>
                ) : (
                  <h3>原始材料</h3>
                )}
                {evidence?.sources.map((source, index) => (
                  <details
                    className="evidence-item"
                    key={`${proposal.id}:${source.id}`}
                    open
                  >
                    <summary>
                      <span>
                        {index + 1}. {source.ref.title}
                      </span>
                      <small>{materialKindLabel(source.ref.kind)}</small>
                    </summary>
                    <MaterialContent capture={source} />
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void openReviewNote(source.path)}
                    >
                      打开当前材料笔记 <ArrowUpRight size={13} />
                    </button>
                  </details>
                ))}
                {Boolean(evidence?.references.length) && (
                  <>
                    <h3>参考笔记快照</h3>
                    {evidence?.references.map((reference) => (
                      <details
                        className="evidence-item"
                        key={`${proposal.id}:${reference.path}`}
                      >
                        <summary>{reference.title}</summary>
                        <p className="material-path">{reference.path}</p>
                        <SnapshotText
                          text={reference.content}
                          path={reference.path}
                        />
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void openReviewNote(reference.path)}
                        >
                          打开当前参考笔记 <ArrowUpRight size={13} />
                        </button>
                      </details>
                    ))}
                  </>
                )}
                {revision && Boolean(proposal.annotationResponses?.length) && (
                  <details className="evidence-item" open>
                    <summary>
                      批注回应（{proposal.annotationResponses!.length}）
                    </summary>
                    <ol className="annotation-preview">
                      {proposal.annotationResponses!.map((item) => (
                        <li key={item.line}>
                          <small>
                            正文第 {item.line} 行 ·{" "}
                            {item.state === "answered" ? "已回答" : "需补条件"}
                          </small>
                          <p>
                            {
                              revision.annotations?.find(
                                (annotation) => annotation.line === item.line,
                              )?.text
                            }
                          </p>
                          <SnapshotText
                            text={item.response}
                            path={revision.path}
                          />
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {Boolean(proposal.childNotes?.length) && (
                  <section
                    className="review-child-notes"
                    aria-label="将创建的子笔记"
                  >
                    <h3>将创建的子笔记</h3>
                    <ul>
                      {proposal.childNotes!.map((child) => (
                        <li key={child.key}>
                          <button
                            className="text-button"
                            onClick={() => setChildPreview(child)}
                          >
                            {child.title} <ArrowUpRight size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <small>确认保存时生成独立笔记并连接正文。</small>
                  </section>
                )}
                {!diff && reviewOutline.length > 0 && (
                  <details className="evidence-item">
                    <summary>当前稿目录</summary>
                    {reviewOutline.map(({ title, level, offset }) => (
                      <button
                        key={offset}
                        className="outline-link"
                        style={{ paddingLeft: (level - 2) * 10 }}
                        onClick={() => reviewEditor.current?.goTo(offset)}
                      >
                        {title}
                      </button>
                    ))}
                  </details>
                )}
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
                <ResearchHints
                  profile={job?.snapshot.researchProfile}
                  text={text}
                />
              </div>
            </aside>
            <section className="proposal-editor">
              <header>
                <span>{proposal.title}</span>
                <div className="review-draft-controls">
                  {!diff && !busy && !lockedDraft && (
                    <NoteColorMenu
                      onSelect={(color) => {
                        if (!reviewEditor.current?.setTextColor(color))
                          notify("请选中要设置颜色的正文。", true);
                      }}
                    />
                  )}
                  {proposal.supersededBy && (
                    <button
                      className="text-button"
                      onClick={() => openDraft(proposal.supersededBy!, true)}
                    >
                      查看新版
                    </button>
                  )}
                  {inlineChat && !showChat && (
                    <button
                      className="text-button"
                      onClick={() => setShowChat(true)}
                    >
                      <MessageSquare size={14} /> Codex 对话
                    </button>
                  )}
                  {canContinue && !diff && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        quoteDraft(reviewEditor.current?.getQuote())
                      }
                    >
                      引用选中段落
                    </button>
                  )}
                  {previous && (
                    <button
                      className="text-button"
                      onClick={() =>
                        setDiff(diff === "previous" ? null : "previous")
                      }
                    >
                      {diff === "previous" ? "返回新版正文" : "对照上一版"}
                    </button>
                  )}
                  {proposal.action === "amend" && (
                    <button
                      className="text-button"
                      onClick={() => {
                        if (diff === "original") setDiff(null);
                        else void compareOriginal();
                      }}
                    >
                      {diff === "original" ? "返回正文" : "对照原笔记"}
                    </button>
                  )}
                </div>
              </header>
              {diff ? (
                <>
                  <Diff
                    before={
                      diff === "previous" ? previous?.markdown || "" : before
                    }
                    after={text}
                  />
                  {diff === "original" &&
                    !lockedDraft &&
                    proposal.action === "amend" &&
                    baseChanged && (
                      <div className="review-base-update">
                        <p>
                          请对照原笔记的改动。需要保留的内容可先合入待审稿，再确认更新修订基准。
                        </p>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => void rebase()}
                        >
                          已核对，更新修订基准
                        </button>
                      </div>
                    )}
                </>
              ) : (
                <Editor
                  ref={reviewEditor}
                  path={proposal.path}
                  content={text}
                  source={false}
                  readOnly={busy || lockedDraft}
                  onQuote={canContinue ? quoteDraft : undefined}
                  onChange={changeReview}
                  onLink={(href) => {
                    if (href.startsWith("child-note:")) {
                      const child = proposal.childNotes?.find(
                        (entry) => "child-note:" + entry.key === href,
                      );
                      if (child) setChildPreview(child);
                    }
                  }}
                />
              )}
              <footer>
                <span>
                  {proposal.supersededBy ? "上一版待审稿" : "可直接编辑后确认"}
                </span>
                <button
                  className="secondary"
                  disabled={busy || lockedDraft}
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
                  disabled={busy || lockedDraft}
                  onClick={() => void accept()}
                >
                  <Check size={15} />
                  {busy ? "正在保存…" : "确认并保存"}
                </button>
              </footer>
            </section>
            {expandedChat && (
              <ReviewDivider pane="chat" controls={reviewChatId} />
            )}
            {inlineChat && job && (
              <div
                id={reviewChatId}
                className="review-chat-slot"
                hidden={!expandedChat}
              >
                <CodexConversation
                  key={codexRootJob(job)}
                  jobs={jobs}
                  initialJobId={codexRootJob(job)}
                  refresh={refresh}
                  review={{
                    proposalId: proposal.id,
                    feedback: reviewFeedback,
                    onFeedback: updateFeedback,
                    baseChanged,
                    onCompareOriginal: () => void compareOriginal(),
                    describeDraft,
                    onOpenDraft: (draftId) => openDraft(draftId, true),
                    onSend: continueDraft,
                    onClose: () => setShowChat(false),
                    options: job.snapshot.codexOptions ?? cli.defaults,
                    catalog: cli.catalog,
                    connection: {
                      ready: cli.state === "ready",
                      checking: cli.state === "checking",
                      label: codexCliLabels[cli.state],
                      recheck: cli.recheck,
                    },
                    disabled: !canContinue || busy,
                    path: proposal.targetPath || proposal.path,
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
      {conversation && (
        <Modal
          title="Codex 对话记录"
          wide
          onClose={() => {
            if (!busy) setConversation(false);
          }}
        >
          <CodexConversation jobs={jobs} refresh={refresh} />
        </Modal>
      )}
      {childPreview && (
        <Modal
          title={childPreview.title}
          wide
          onClose={() => setChildPreview(null)}
        >
          <SnapshotText
            text={childPreview.markdown}
            path={proposal?.targetPath || proposal?.path || ""}
          />
        </Modal>
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
  const canSaveDefaults = capabilities.codexCli && !window.workbench?.panel;
  const cli = useCodexCliStatus(capabilities.codexCli, canSaveDefaults);
  const [pickedCodex, setPickedCodex] = useState<CodexOptions>();
  const [savingCodex, setSavingCodex] = useState(false);
  const codexDefaults = pickedCodex ?? cli.defaults;
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
  async function saveCodexDefaults() {
    setSavingCodex(true);
    try {
      await api("PUT", "/settings/codex-cli", codexDefaults);
      setPickedCodex(undefined);
      cli.recheck();
      notify("已保存 Codex CLI 默认配置。");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setSavingCodex(false);
    }
  }
  return (
    <Modal title="工作台设置" onClose={onClose}>
      <CaptureShortcutSettings />
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
      {capabilities.codexCli && (
        <section className="settings-section">
          <div className="section-label">本机 Codex CLI（首选）</div>
          <p className="muted">
            沿用本机 Codex 登录，确认整理后将所选材料交给
            Codex，结果进入待审稿。
          </p>
          <div className="executor-status">
            <span role="status">{codexCliLabels[cli.state]}</span>
            <button
              className="secondary"
              disabled={cli.state === "checking"}
              onClick={cli.recheck}
            >
              重新检查
            </button>
          </div>
          {canSaveDefaults && (
            <>
              <CodexOptionsFields
                catalog={cli.catalog}
                value={codexDefaults}
                disabled={savingCodex || cli.state === "checking"}
                onChange={setPickedCodex}
              />
              <button
                className="secondary"
                disabled={savingCodex || cli.state === "checking"}
                onClick={() => void saveCodexDefaults()}
              >
                {savingCodex ? "正在保存…" : "保存为默认配置"}
              </button>
            </>
          )}
        </section>
      )}
      {window.workbench?.panel ? (
        <section className="settings-section">
          <div className="section-label">模型 API（备用）</div>
          <p className="muted">
            模型和密钥请在桌面工作台设置。此面板沿用已保存的配置；使用 Codex
            整理无需填写 API 密钥。
          </p>
        </section>
      ) : (
        <section className="settings-section">
          <div className="section-label">
            <Settings2 size={15} />
            模型 API（备用）
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
