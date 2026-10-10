import { NoteTree } from "./NoteTree";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bold,
  BookOpen,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  FilePenLine,
  FileText,
  FolderOpen,
  History,
  ImagePlus,
  Inbox as InboxIcon,
  Italic,
  Link2,
  ListTree,
  LoaderCircle,
  MoveRight,
  NotebookPen,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sigma,
  Sparkles,
  X,
} from "lucide-react";
import type {
  Capture,
  Job,
  Note,
  NoteSummary,
  Proposal,
} from "../shared/contracts";
import {
  api,
  fileData,
  openExternal,
  openResolvedExternal,
  shortDate,
  nativeAction,
} from "./client";
import { Editor, type EditorHandle } from "./Editor";
import { Diff, Inbox, Modal, Review, Settings } from "./Panels";

type Tab = {
  note: Note;
  content: string;
  hash: string;
  dirty: boolean;
  generation: number;
  status: "saved" | "saving" | "draft" | "error" | "conflict";
  error?: string;
  latest?: Note;
};
type View = "all" | "concept" | "learning-log" | "inbox" | "review";
export default function App() {
  const [status, setStatus] = useState<any>(null),
    [notes, setNotes] = useState<NoteSummary[]>([]),
    [captures, setCaptures] = useState<Capture[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [view, setView] = useState<View>("all"),
    [active, setActive] = useState(""),
    [tabOrder, setTabOrder] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<NoteSummary[] | null>(null),
    [source, setSource] = useState(false),
    [right, setRight] = useState(true),
    [settings, setSettings] = useState(false),
    [create, setCreate] = useState(false),
    [newTitle, setNewTitle] = useState(""),
    [newType, setNewType] = useState<"concept" | "learning-log">("concept");
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
      null,
    ),
    [history, setHistory] = useState<any[] | null>(null),
    [historyItem, setHistoryItem] = useState<any>(null),
    [conflict, setConflict] = useState(false),
    [moving, setMoving] = useState(false),
    [movePath, setMovePath] = useState(""),
    [movePreview, setMovePreview] = useState<any>(null),
    [relations, setRelations] = useState<any>(null);
  const [, draw] = useState(0),
    tabs = useRef<Record<string, Tab>>({}),
    saves = useRef<Partial<Record<string, Promise<void>>>>({}),
    draftWrites = useRef<Partial<Record<string, Promise<void>>>>({}),
    timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}),
    editor = useRef<EditorHandle>(null),
    imageInput = useRef<HTMLInputElement>(null),
    activeRef = useRef(active),
    statusRef = useRef(status),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeRef.current = active;
  statusRef.current = status;
  const render = () => draw((n) => n + 1);
  const notify = (text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 10000 : 4500);
  };
  const localKey = (p: string) =>
    `kwb-draft:${statusRef.current?.vault?.id}:${p}`;
  const recordDraft = (p: string, t: Tab) => {
    if (window.workbench?.panel) {
      // Opaque MCP sandboxes may not provide localStorage. Persist recovery
      // drafts through the local service, in order, before the final save.
      const body = { path: p, content: t.content, expectedHash: t.hash };
      const pending = (draftWrites.current[p] || Promise.resolve())
        .catch(() => {})
        .then(() => api("PUT", "/draft", body))
        .then(() => {});
      draftWrites.current[p] = pending;
      void pending.catch((e) =>
        notify("本机草稿保存失败，请保留此面板：" + e.message, true),
      );
      return;
    }
    try {
      localStorage.setItem(
        localKey(p),
        JSON.stringify({
          content: t.content,
          baseHash: t.hash,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch {
      notify("浏览器草稿空间不可用，请立即保存并保留当前窗口。", true);
    }
  };
  async function refresh() {
    const next = await api("GET", "/status");
    setStatus(next);
    statusRef.current = next;
    document.documentElement.dataset.theme = next.theme || "forest";
    if (!next.vault) return;
    const [n, c, j, p] = await Promise.all([
      api<NoteSummary[]>("GET", "/notes"),
      api<Capture[]>("GET", "/captures"),
      api<Job[]>("GET", "/jobs"),
      api<Proposal[]>("GET", "/proposals"),
    ]);
    setNotes(n);
    setCaptures(c);
    setJobs(j);
    setProposals(p);
    for (const path of Object.keys(tabs.current)) {
      const tab = tabs.current[path],
        latest = n.find((x) => x.path === path);
      if (!latest || latest.hash === tab.hash || saves.current[path]) continue;
      try {
        const remote = await api<Note>(
          "GET",
          "/note?path=" + encodeURIComponent(path),
        );
        if (!tab.dirty) {
          tab.note = remote;
          tab.content =
            remote.owner === "paperdesk" ? remote.body || "" : remote.content;
          tab.hash = remote.hash;
          tab.status = "saved";
        } else {
          tab.latest = remote;
          tab.status = "conflict";
          tab.error = "检测到外部修改，请核对后继续。";
        }
        render();
      } catch {
        /* A temporarily unavailable cloud file is not treated as deleted. */
      }
    }
  }
  async function openNote(path: string) {
    try {
      if (!tabs.current[path]) {
        const note = await api<Note>(
            "GET",
            "/note?path=" + encodeURIComponent(path),
          ),
          original =
            note.owner === "paperdesk" ? note.body || "" : note.content;
        let draft = note.draft;
        try {
          const stored = localStorage.getItem(localKey(path));
          if (stored) {
            const candidate = JSON.parse(stored);
            if (!draft || candidate.savedAt > draft.savedAt) draft = candidate;
          }
        } catch {}
        const recovered = draft && draft.content !== original;
        tabs.current[path] = {
          note,
          content: recovered ? draft!.content : original,
          hash: recovered ? draft!.baseHash : note.hash,
          dirty: Boolean(recovered),
          generation: 0,
          status: recovered
            ? draft!.baseHash === note.hash
              ? "draft"
              : "conflict"
            : "saved",
          ...(recovered && draft!.baseHash !== note.hash
            ? {
                latest: note,
                error: "恢复的草稿与当前文件版本不同，请核对差异。",
              }
            : {}),
        };
        setTabOrder((prev) => (prev.includes(path) ? prev : [...prev, path]));
        if (recovered) notify("已恢复未提交草稿，请核对后保存。");
      }
      setActive(path);
      setView("all");
      setQuery("");
      setResults(null);
      render();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  function change(path: string, content: string) {
    const t = tabs.current[path];
    if (!t || t.content === content) return;
    t.content = content;
    t.dirty = true;
    t.generation++;
    if (t.status !== "conflict") t.status = "draft";
    recordDraft(path, t);
    render();
    clearTimeout(timers.current[path]);
    timers.current[path] = setTimeout(
      () => void flushPath(path).catch(() => {}),
      900,
    );
  }
  async function flushPath(path: string): Promise<void> {
    clearTimeout(timers.current[path]);
    if (saves.current[path]) return saves.current[path];
    const work = (async () => {
      const t = tabs.current[path];
      while (t?.dirty) {
        if (t.status === "conflict") throw new Error("请先处理笔记修改冲突");
        const generation = t.generation,
          content = t.content,
          hash = t.hash;
        t.status = "saving";
        render();
        try {
          await draftWrites.current[path]?.catch(() => {});
          await api("PUT", "/draft", { path, content, expectedHash: hash });
          const saved = await api<Note>("PUT", "/note", {
            path,
            content,
            expectedHash: hash,
          });
          t.note = saved;
          t.hash = saved.hash;
          t.error = undefined;
          if (t.generation === generation) {
            t.dirty = false;
            t.status = "saved";
            try {
              const local = localStorage.getItem(localKey(path));
              if (local && JSON.parse(local).content === content)
                localStorage.removeItem(localKey(path));
            } catch {}
          } else {
            t.status = "draft";
            recordDraft(path, t);
          }
          render();
        } catch (error) {
          const e = error as any;
          t.status = e.code === "VERSION_CONFLICT" ? "conflict" : "error";
          t.error = e.message;
          if (t.status === "conflict")
            try {
              t.latest = await api<Note>(
                "GET",
                "/note?path=" + encodeURIComponent(path),
              );
            } catch {}
          recordDraft(path, t);
          render();
          throw e;
        }
      }
    })();
    saves.current[path] = work;
    try {
      await work;
    } finally {
      delete saves.current[path];
    }
  }
  async function flushAll() {
    const outcomes = await Promise.allSettled(
      Object.keys(tabs.current).map(flushPath),
    );
    const fail = outcomes.find((o) => o.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (fail) throw fail.reason;
  }
  useEffect(() => {
    void refresh().catch((e) => notify(e.message, true));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    const unregister = window.workbench?.onFlush(flushAll);
    const captureOff = window.workbench?.onCapture(() => {
      void refresh();
      notify("截图已进入收集箱");
    });
    const before = (e: BeforeUnloadEvent) => {
      if (Object.values(tabs.current).some((t) => t.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushAll()
          .then(() => notify("已保存"))
          .catch((error) => notify(error.message, true));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewTitle("");
        setCreate(true);
      }
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("keydown", key);
    return () => {
      clearInterval(timer);
      unregister?.();
      captureOff?.();
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("keydown", key);
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim())
        void api<NoteSummary[]>("GET", "/notes?q=" + encodeURIComponent(query))
          .then(setResults)
          .catch((e) => notify(e.message, true));
      else setResults(null);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (active)
      void api("GET", "/relations?path=" + encodeURIComponent(active))
        .then(setRelations)
        .catch(() => setRelations(null));
  }, [active, notes]);
  async function addNote() {
    try {
      const note = await api<Note>("POST", "/notes", {
        title: newTitle.trim() || "未命名笔记",
        noteType: newType,
      });
      setCreate(false);
      setNewTitle("");
      await refresh();
      await openNote(note.path);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function closeTab(path: string) {
    try {
      await flushPath(path);
      delete tabs.current[path];
      setTabOrder((prev) => {
        const next = prev.filter((p) => p !== path);
        if (activeRef.current === path) setActive(next.at(-1) || "");
        return next;
      });
    } catch (e) {
      notify("笔记尚未保存，标签页已保留：" + (e as Error).message, true);
    }
  }
  async function insertImages(files: File[]) {
    try {
      const snippets: string[] = [];
      for (const f of files) {
        const asset = await api("POST", "/assets", { data: await fileData(f) });
        snippets.push(`![[${asset.assetPath}]]`);
      }
      return snippets.join("\n\n");
    } catch (e) {
      notify((e as Error).message, true);
      throw e;
    }
  }
  function followLink(target: string) {
    if (target.startsWith("kb:"))
      try {
        target = decodeURIComponent(target.slice(3));
      } catch {}
    if (/^https?:/.test(target)) {
      void openExternal(target);
      return;
    }
    target = target.split("#")[0];
    const normalized = target.replace(/^\//, "").replace(/\.md$/, "");
    const found =
      notes.find((n) => n.path.replace(/\.md$/, "") === normalized) ||
      notes.find(
        (n) => n.path.split("/").at(-1)?.replace(/\.md$/, "") === normalized,
      );
    if (found) void openNote(found.path);
    else {
      setQuery(normalized);
      notify("已按链接内容查找笔记");
    }
  }
  async function showHistory() {
    if (!active) return;
    try {
      await flushPath(active);
      const list = await api<any[]>(
        "GET",
        "/history?path=" + encodeURIComponent(active),
      );
      setHistory(list);
      setHistoryItem(list[0] || null);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function restoreHistory() {
    if (!historyItem || !active) return;
    try {
      const t = tabs.current[active],
        saved = await api<Note>("POST", "/history/restore", {
          path: active,
          id: historyItem.id,
          expectedHash: t.hash,
        });
      t.note = saved;
      t.hash = saved.hash;
      t.content =
        saved.owner === "paperdesk" ? saved.body || "" : saved.content;
      t.dirty = false;
      t.status = "saved";
      render();
      setHistory(null);
      await refresh();
      notify("已恢复历史版本，恢复前的内容也已保留。");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function startMove() {
    try {
      await flushPath(active);
      setMoving(true);
      setMovePath(active);
      setMovePreview(null);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function move(apply: boolean) {
    try {
      const result = await api("POST", "/note/move", {
        from: active,
        to: movePath,
        expectedHash: tabs.current[active].hash,
        apply,
      });
      if (!apply) {
        setMovePreview(result);
        return;
      }
      const old = active;
      delete tabs.current[old];
      setTabOrder((order) => order.filter((p) => p !== old));
      setMoving(false);
      await refresh();
      await openNote(movePath);
      notify("笔记已移动，引用链接已更新。");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const t = tabs.current[active],
    pending = proposals.filter((p) => p.status === "pending").length;
  const visible = (results || notes).filter(
    (n) =>
      !n.missing &&
      !n.path.includes("/Drafts/") &&
      !n.path.includes("/Inbox/") &&
      (view === "concept"
        ? n.noteType === "concept"
        : view === "learning-log"
          ? n.noteType === "learning-log"
          : true),
  );
  const sections = [
    {
      key: "all",
      label: "全部笔记",
      icon: BookOpen,
      count: notes.filter((n) => !n.missing && !n.path.includes("/Drafts/"))
        .length,
    },
    {
      key: "concept",
      label: "知识卡",
      icon: FilePenLine,
      count: notes.filter((n) => n.noteType === "concept").length,
    },
    {
      key: "learning-log",
      label: "学习记录",
      icon: Clock3,
      count: notes.filter((n) => n.noteType === "learning-log").length,
    },
    { key: "inbox", label: "收集箱", icon: InboxIcon, count: captures.length },
    { key: "review", label: "待审稿", icon: Sparkles, count: pending },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <NotebookPen size={25} strokeWidth={1.4} />
          </div>
          <div>
            <strong>知识工作台</strong>
            <span>KNOWLEDGE WORKBENCH</span>
          </div>
        </div>
        <button
          className="vault-switch"
          onClick={() => {
            if (window.workbench)
              void flushAll()
                .then(() => window.workbench!.chooseVault())
                .catch((e) => notify(e.message, true));
            else notify("切换知识库请使用桌面应用。");
          }}
        >
          <FolderOpen size={16} />
          <span>{status?.vault?.name || "选择知识库"}</span>
          <ChevronDown size={13} />
        </button>
        <button
          className="new-note"
          onClick={() => {
            setNewTitle("");
            setNewType(view === "learning-log" ? "learning-log" : "concept");
            setCreate(true);
          }}
          disabled={!status?.vault}
        >
          <Plus size={16} />
          写一篇笔记<kbd>Ctrl N</kbd>
        </button>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索知识库"
            placeholder="搜索笔记与想法"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (["inbox", "review"].includes(view)) setView("all");
            }}
          />
          <kbd>⌕</kbd>
        </label>
        <nav>
          {sections.map((s) => (
            <button
              key={s.key}
              className={view === s.key ? "active" : ""}
              onClick={() => {
                setView(s.key as View);
                setQuery("");
              }}
            >
              <s.icon size={17} />
              <span>{s.label}</span>
              <small>{s.count || ""}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="notes-heading">
          <span>
            {query
              ? "搜索结果"
              : view === "concept"
                ? "主题知识卡"
                : view === "learning-log"
                  ? "学习记录"
                  : "笔记目录"}
          </span>
          <button
            className="icon small"
            aria-label="刷新知识库"
            onClick={() =>
              void api("POST", "/refresh")
                .then(async (result) => {
                  await refresh();
                  const pending = result.imports?.pending?.length || 0;
                  notify(
                    pending
                      ? `已重新读取知识库；${pending} 份纸间材料等待清单或原图完整同步`
                      : "已重新读取知识库",
                    pending > 0,
                  );
                })
                .catch((e) => notify(e.message, true))
            }
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="note-list">
          <NoteTree
            notes={visible}
            active={["inbox", "review"].includes(view) ? "" : active}
            dirty={(p) => Boolean(tabs.current[p]?.dirty)}
            onOpen={(p) => void openNote(p)}
          />
          {!visible.length && (
            <p className="sidebar-empty">
              {query ? "没有找到匹配笔记" : "从第一篇笔记开始"}
            </p>
          )}
        </div>
        <footer className="sidebar-footer">
          <div>
            <i className={status?.vault ? "connected" : ""} />
            <span>{status?.vault ? "文件保存在知识库" : "尚未打开知识库"}</span>
          </div>
          <button
            className="icon"
            aria-label="设置"
            onClick={() => setSettings(true)}
            disabled={!status?.vault}
          >
            <Settings2 size={17} />
          </button>
        </footer>
      </aside>
      <main className="main-workspace">
        <header className="app-header">
          <div className="breadcrumbs">
            <span>我的学习空间</span>
            <span>/</span>
            <strong>
              {view === "inbox"
                ? "收集箱"
                : view === "review"
                  ? "草稿审核"
                  : t?.note.title || "开始记录"}
            </strong>
          </div>
          <div className="header-meta">
            <span className="local-badge">LOCAL FIRST</span>
            {t && !["inbox", "review"].includes(view) && (
              <button
                className="icon"
                aria-label="切换信息侧栏"
                onClick={() => setRight((v) => !v)}
              >
                <PanelRightClose size={17} />
              </button>
            )}
          </div>
        </header>
        {!status ? (
          <div className="empty full">
            <LoaderCircle className="spin" size={28} />
            <h3>正在打开工作台</h3>
          </div>
        ) : !status.vault ? (
          <div className="welcome">
            <div className="welcome-rule" />
            <span className="eyebrow">A PLACE FOR YOUR THINKING</span>
            <h1>
              让每一次理解，
              <br />
              都留得下来。
            </h1>
            <p>
              在这里写作、收集材料、修订想法。
              <br />
              你的笔记依然是知识库中的普通 Markdown 文件。
            </p>
            <button
              className="primary"
              onClick={() =>
                void (
                  window.workbench
                    ? window.workbench.chooseVault()
                    : nativeAction("choose-vault")
                ).catch((e) => notify(e.message, true))
              }
            >
              <FolderOpen size={17} />
              打开 Obsidian 知识库
            </button>
            <small>选择包含 .obsidian 文件夹的知识库目录。</small>
          </div>
        ) : view === "inbox" ? (
          <Inbox
            captures={captures}
            notes={notes}
            jobs={jobs}
            onOpen={(p) => void openNote(p)}
            refresh={refresh}
            notify={notify}
          />
        ) : view === "review" ? (
          <Review
            proposals={proposals}
            jobs={jobs}
            onOpen={(p) => void openNote(p)}
            refresh={refresh}
            notify={notify}
          />
        ) : (
          <>
            <div className="tab-strip">
              {tabOrder.map((p) => (
                <div key={p} className={active === p ? "active" : ""}>
                  <button onClick={() => setActive(p)}>
                    <FileText size={13} />
                    <span>{tabs.current[p]?.note.title}</span>
                    {tabs.current[p]?.dirty && <b>•</b>}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭 ${tabs.current[p]?.note.title}`}
                    onClick={() => void closeTab(p)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                className="icon"
                aria-label="新建笔记"
                onClick={() => setCreate(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            {!t ? (
              <div className="start-page">
                <span className="eyebrow">YOUR THINKING, IN PROGRESS</span>
                <h1>今天，想弄清什么？</h1>
                <p>从一个问题、一张电路图，或一段还未成形的想法开始。</p>
                <div className="start-actions">
                  <button
                    onClick={() => {
                      setNewTitle("");
                      setNewType("concept");
                      setCreate(true);
                    }}
                  >
                    <FilePenLine size={25} strokeWidth={1.4} />
                    <strong>写一篇知识笔记</strong>
                    <span>把理解和条件写清楚</span>
                    <ArrowUpRight size={17} />
                  </button>
                  <button onClick={() => setView("inbox")}>
                    <InboxIcon size={25} strokeWidth={1.4} />
                    <strong>整理手边的材料</strong>
                    <span>先收集，再连接</span>
                    <ArrowUpRight size={17} />
                  </button>
                </div>
                <div className="section-label">
                  <span>最近编辑</span>
                  <span>{notes.length} 篇笔记</span>
                </div>
                <div className="recent-notes">
                  {visible.slice(0, 7).map((n) => (
                    <button key={n.path} onClick={() => void openNote(n.path)}>
                      <FileText size={16} />
                      <span>{n.title}</span>
                      <small>{shortDate(n.updatedAt)}</small>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="writing-layout">
                <section className="writing-main">
                  <div className="editor-toolbar">
                    <div>
                      <button
                        title="加粗"
                        onClick={() => editor.current?.wrap("**", "**")}
                      >
                        <Bold size={15} />
                      </button>
                      <button
                        title="斜体"
                        onClick={() => editor.current?.wrap("*", "*")}
                      >
                        <Italic size={15} />
                      </button>
                      <span className="toolbar-separator" />
                      <button
                        title="插入公式"
                        onClick={() =>
                          editor.current?.insert("\n$$\n\\frac{g_m}{I_D}\n$$\n")
                        }
                      >
                        <Sigma size={16} />
                      </button>
                      <button
                        title="插入图片"
                        onClick={() => imageInput.current?.click()}
                      >
                        <ImagePlus size={16} />
                      </button>
                      <button
                        title="插入笔记链接"
                        onClick={() => editor.current?.wrap("[[", "]]")}
                      >
                        <Link2 size={15} />
                      </button>
                      <input
                        ref={imageInput}
                        type="file"
                        multiple
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={(e) => {
                          const files = [...(e.target.files || [])],
                            destination = active;
                          void insertImages(files)
                            .then((text) => {
                              if (activeRef.current === destination)
                                editor.current?.insert("\n" + text + "\n");
                              else {
                                const tab = tabs.current[destination];
                                if (tab)
                                  change(
                                    destination,
                                    tab.content + "\n" + text + "\n",
                                  );
                              }
                            })
                            .catch(() => {});
                          e.target.value = "";
                        }}
                      />
                    </div>
                    <div>
                      <button
                        className={source ? "mode-active" : ""}
                        onClick={() => setSource((s) => !s)}
                        aria-pressed={source}
                      >
                        <Code2 size={15} />
                        {source ? "源码" : "即时渲染"}
                      </button>
                      <button
                        title="历史版本"
                        onClick={() => void showHistory()}
                      >
                        <History size={16} />
                      </button>
                      <button
                        title="重命名或移动笔记"
                        onClick={() => void startMove()}
                        disabled={t.note.owner === "paperdesk"}
                      >
                        <MoveRight size={16} />
                      </button>
                    </div>
                  </div>
                  {t.status === "conflict" && (
                    <div className="conflict-banner">
                      <span>
                        {t.error || "文件已有新修改，自动保存已暂停。"}
                      </span>
                      <button onClick={() => setConflict(true)}>
                        核对差异
                      </button>
                    </div>
                  )}
                  {t.status === "error" && (
                    <div className="conflict-banner">
                      <span>{t.error}</span>
                      <button
                        onClick={() =>
                          void flushPath(active).catch((e) =>
                            notify(e.message, true),
                          )
                        }
                      >
                        重试保存
                      </button>
                    </div>
                  )}
                  {t.note.owner === "paperdesk" && (
                    <div className="managed-banner">
                      纸间文献笔记 · 这里只编辑正文，批注与书签在纸间维护
                    </div>
                  )}
                  <Editor
                    ref={editor}
                    key={active}
                    path={active}
                    content={t.content}
                    source={source}
                    onChange={(content) => change(active, content)}
                    onImages={insertImages}
                    onLink={followLink}
                  />
                  <footer className="editor-status">
                    <span>
                      {t.status === "saving" ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : t.status === "saved" ? (
                        <Check size={13} />
                      ) : (
                        <span className="dirty-dot" />
                      )}
                      {
                        {
                          saved: "已保存到知识库",
                          saving: "正在保存…",
                          draft: "本机草稿",
                          conflict: "冲突待核对",
                          error: "保存未完成",
                        }[t.status]
                      }
                    </span>
                    <span>
                      {t.content.replace(/\s/g, "").length.toLocaleString()}{" "}
                      字符<span className="status-divider">·</span>Markdown
                      <span className="status-divider">·</span>
                      <button
                        onClick={() =>
                          void flushPath(active)
                            .then(() => notify("已保存"))
                            .catch((e) => notify(e.message, true))
                        }
                      >
                        Ctrl S
                      </button>
                    </span>
                  </footer>
                </section>
                {right && (
                  <aside className="context-panel">
                    <div className="context-title">
                      <ListTree size={16} />
                      <strong>笔记脉络</strong>
                    </div>
                    <div className="note-properties">
                      <span>
                        {t.note.noteType === "concept"
                          ? "主题知识卡"
                          : t.note.noteType === "learning-log"
                            ? "学习记录"
                            : t.note.owner === "paperdesk"
                              ? "文献阅读笔记"
                              : "笔记"}
                      </span>
                      <span>
                        {t.note.status === "canonical"
                          ? "Canonical"
                          : t.note.status === "working"
                            ? "持续完善"
                            : t.note.status}
                      </span>
                    </div>
                    <section>
                      <h3>目录</h3>
                      {[...t.content.matchAll(/^(#{1,4})\s+(.+)$/gm)]
                        .filter((m) => m[1].length > 1)
                        .map((m, i) => (
                          <button
                            className="outline-link"
                            key={i}
                            style={{ paddingLeft: (m[1].length - 2) * 10 }}
                            onClick={() => {
                              editor.current?.goTo(m.index || 0);
                            }}
                          >
                            {m[2]}
                          </button>
                        ))}
                    </section>
                    <section>
                      <h3>相关笔记</h3>
                      {relations?.outgoing?.length ? (
                        relations.outgoing
                          .slice(0, 10)
                          .map((link: any, i: number) => (
                            <button
                              key={i}
                              className="related-link"
                              onClick={() =>
                                followLink(
                                  link.to_ref.replace(/^\[\[|\]\]$/g, ""),
                                )
                              }
                            >
                              <Link2 size={12} />
                              {link.to_ref.replace(/^\[\[|\]\]$/g, "")}
                            </button>
                          ))
                      ) : (
                        <p>用 [[笔记标题]] 连接已有理解。</p>
                      )}
                    </section>
                    <section>
                      <h3>被哪些笔记引用</h3>
                      {relations?.incoming?.length ? (
                        relations.incoming.map((link: any, i: number) => (
                          <button
                            key={i}
                            className="related-link"
                            onClick={() => void openNote(link.from_path)}
                          >
                            <ArrowLeft size={12} />
                            {notes.find((n) => n.path === link.from_path)
                              ?.title || link.from_path}
                          </button>
                        ))
                      ) : (
                        <p>新的连接会出现在这里。</p>
                      )}
                    </section>
                    {Boolean(t.note.metadata.kb_source) && (
                      <section>
                        <h3>材料来源</h3>
                        <p>
                          {(t.note.metadata.kb_source as any).paperdesk
                            ? `${(t.note.metadata.kb_source as any).paperdesk.title} · PDF 第 ${(t.note.metadata.kb_source as any).paperdesk.page} 页`
                            : String((t.note.metadata.kb_source as any).kind)}
                        </p>
                        {(t.note.metadata.kb_source as any).paperdesk && (
                          <button
                            className="secondary"
                            onClick={() => {
                              const source = t.note.metadata.kb_source as any;
                              void openResolvedExternal(
                                async () =>
                                  (
                                    await api(
                                      "GET",
                                      `/paperdesk/source?sourceId=${encodeURIComponent(source.id)}`,
                                    )
                                  ).url,
                              ).catch((e) => notify(e.message, true));
                            }}
                          >
                            回到纸间原页
                            <ArrowUpRight size={13} />
                          </button>
                        )}
                      </section>
                    )}
                    <div className="context-note">
                      <span>留一点余地，给下一次理解。</span>
                      <p>
                        工作中的笔记可以有疑问。确认过的来源和适用条件，比一份看似完整的结论更有用。
                      </p>
                    </div>
                  </aside>
                )}
              </div>
            )}
          </>
        )}
        {status?.warnings?.length > 0 && (
          <div className="warning-bar" role="status">
            {status.warnings[0]}
            {status.warnings.length > 1
              ? ` · 另有 ${status.warnings.length - 1} 项`
              : ""}
          </div>
        )}
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <span>!</span> : <Check size={16} />}
          <p>{toast.text}</p>
          <button
            className="icon"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {settings && (
        <Settings
          onClose={() => setSettings(false)}
          refresh={refresh}
          notify={notify}
        />
      )}
      {create && (
        <Modal title="写一篇新笔记" onClose={() => setCreate(false)}>
          <label>
            标题
            <input
              autoFocus
              aria-label="新笔记标题"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addNote();
              }}
              placeholder="从一个具体的问题开始"
            />
          </label>
          <label>
            类型
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as any)}
            >
              <option value="concept">主题知识卡</option>
              <option value="learning-log">学习记录</option>
            </select>
          </label>
          <footer className="modal-footer">
            <button className="secondary" onClick={() => setCreate(false)}>
              取消
            </button>
            <button className="primary" onClick={() => void addNote()}>
              开始写作
            </button>
          </footer>
        </Modal>
      )}
      {history && (
        <Modal title="历史版本" wide onClose={() => setHistory(null)}>
          {history.length ? (
            <div className="history-grid">
              <div>
                {history.map((h) => (
                  <button
                    key={h.id}
                    className={h.id === historyItem?.id ? "active" : ""}
                    onClick={() => setHistoryItem(h)}
                  >
                    {shortDate(h.savedAt)}
                    <small>
                      {h.reason === "move"
                        ? "移动前"
                        : h.reason === "paperdesk"
                          ? "纸间正文"
                          : "保存前"}
                    </small>
                  </button>
                ))}
              </div>
              <pre>{historyItem?.content}</pre>
            </div>
          ) : (
            <p className="muted">编辑并保存后，修改前的版本会出现在这里。</p>
          )}
          <footer className="modal-footer">
            <button className="secondary" onClick={() => setHistory(null)}>
              返回
            </button>
            <button
              className="primary"
              disabled={!historyItem}
              onClick={() => void restoreHistory()}
            >
              恢复选中版本
            </button>
          </footer>
        </Modal>
      )}
      {conflict && t && (
        <Modal title="核对两份内容" wide onClose={() => setConflict(false)}>
          <p className="muted">
            绿色为当前草稿新增的部分，红色为当前草稿中删去的外部内容。
          </p>
          <Diff
            before={
              t.latest?.owner === "paperdesk"
                ? t.latest.body || ""
                : t.latest?.content || ""
            }
            after={t.content}
          />
          <footer className="modal-footer">
            <button
              className="secondary"
              onClick={() => {
                if (!t.latest) return;
                const preserved = t.content;
                void api("PUT", "/draft", {
                  path: active,
                  content: preserved,
                  expectedHash: t.hash,
                }).then(() => {
                  t.hash = t.latest!.hash;
                  t.note = t.latest!;
                  t.content =
                    t.latest!.owner === "paperdesk"
                      ? t.latest!.body || ""
                      : t.latest!.content;
                  t.dirty = false;
                  t.status = "saved";
                  render();
                  setConflict(false);
                  notify("已载入外部版本；原草稿仍保留在本机。");
                });
              }}
            >
              载入外部版本
            </button>
            <button
              className="primary"
              onClick={() => {
                if (!t.latest) return;
                t.hash = t.latest.hash;
                t.note = t.latest;
                t.status = "draft";
                t.dirty = true;
                setConflict(false);
                render();
                void flushPath(active)
                  .then(() => notify("已按核对后的版本保存"))
                  .catch((e) => notify(e.message, true));
              }}
            >
              确认用当前草稿保存
            </button>
          </footer>
        </Modal>
      )}
      {moving && t && (
        <Modal title="重命名或移动笔记" wide onClose={() => setMoving(false)}>
          <label>
            知识库内的新位置
            <input
              value={movePath}
              onChange={(e) => {
                setMovePath(e.target.value);
                setMovePreview(null);
              }}
            />
          </label>
          {movePreview && (
            <div className="move-preview">
              <p>
                将更新以下 {movePreview.changes.length} 篇笔记中的可解析链接：
              </p>
              {movePreview.changes.map((c: any) => (
                <details key={c.path}>
                  <summary>{c.path}</summary>
                  <Diff before={c.before} after={c.after} />
                </details>
              ))}
            </div>
          )}
          <footer className="modal-footer">
            <button className="secondary" onClick={() => setMoving(false)}>
              返回
            </button>
            <button
              className="primary"
              disabled={movePath === active}
              onClick={() => void move(Boolean(movePreview))}
            >
              {movePreview ? "确认移动并更新链接" : "预览链接更新"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
