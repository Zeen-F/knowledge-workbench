import {
  createNoteResolver,
  localLinkTarget,
  PARENT_NOTE_LABEL,
  type LinkStyle,
} from "../shared/note-links";
import { noteBodyLinks } from "../shared/markdown-links";
import { noteOutline } from "../shared/note-outline";
import { NoteTree } from "./NoteTree";
import { NoteOptimization } from "./NoteOptimization";
import { NoteColorMenu } from "./NoteColorMenu";
import {
  NewNoteDialog,
  type NewNoteInput,
  type NewNoteType,
} from "./NewNoteDialog";
import { matchesNoteSection } from "./note-navigation";
import { RecentNotes } from "./RecentNotes";
import { useSidebarLayout } from "./SidebarLayout";
import { shelfPreview, ShelfJump, ShelfPreferences } from "./ShelfPreview";
import { primaryModifier } from "./platform";
import { useEffect, useMemo, useRef, useState } from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
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
  ChildNoteResult,
  DeletedNote,
  Job,
  Note,
  NoteSummary,
  Proposal,
} from "../shared/contracts";
import { MANAGED } from "../shared/contracts";
import {
  api,
  fileData,
  openExternal,
  openResolvedExternal,
  shortDate,
  nativeAction,
} from "./client";
import { Editor, type ChildNoteAnchor, type EditorHandle } from "./Editor";
import { CollectionInbox } from "./CollectionInbox";
import { Diff, Modal, Review, Settings } from "./Panels";
import { assetUrl } from "./markdown";

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
type MovePreview = {
  changes: { path: string; before: string; after: string }[];
};
type NoteCreation = {
  type: NewNoteType;
  parent?: ChildNoteAnchor & { path: string; requestId: string };
};
type ResolvedLink = { path?: string | null; outside?: boolean };
type View = "all" | "concept" | "learning-log" | "inbox" | "review";

function editorLink(href: string): { target: string; style: LinkStyle } {
  if (href.startsWith("kb:")) {
    try {
      return { target: decodeURIComponent(href.slice(3)), style: "wiki" };
    } catch {
      return { target: href, style: "wiki" };
    }
  }
  return { target: href, style: "markdown" };
}

export default function App() {
  const sidebar = useSidebarLayout();
  useEffect(() => {
    if (!shelfPreview) return;
    const search = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !document.querySelector('dialog[open], [aria-modal="true"]')
      ) {
        event.preventDefault();
        if (sidebar.collapsed) sidebar.toggle();
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(".search-box input")
            ?.focus(),
        );
      }
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, [sidebar.collapsed, sidebar.toggle]);
  const [status, setStatus] = useState<any>(null),
    [notes, setNotes] = useState<NoteSummary[]>([]),
    [captures, setCaptures] = useState<Capture[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [view, setView] = useState<View>("all"),
    [scope, setScope] = useState<"workbench" | "vault">("workbench"),
    [active, setActive] = useState(""),
    [tabOrder, setTabOrder] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<NoteSummary[] | null>(null),
    [source, setSource] = useState(false),
    [right, setRight] = useState(true),
    [settings, setSettings] = useState(false),
    [creation, setCreation] = useState<NoteCreation | null>(null);
  const resolveIndexedLink = useMemo(
    () =>
      createNoteResolver(
        notes.filter((note) => !note.missing).map((note) => note.path),
      ),
    [notes],
  );
  const [toast, setToast] = useState<{
      text: string;
      error: boolean;
      undo?: DeletedNote;
    } | null>(null),
    [history, setHistory] = useState<any[] | null>(null),
    [historyItem, setHistoryItem] = useState<any>(null),
    [conflict, setConflict] = useState(false),
    [moving, setMoving] = useState<NoteSummary | null>(null),
    [movePath, setMovePath] = useState(""),
    [movePreview, setMovePreview] = useState<
      (MovePreview & { hash: string }) | null
    >(null),
    [relations, setRelations] = useState<any>(null);
  const [titleEdit, setTitleEdit] = useState<{
    note: NoteSummary;
    value: string;
  } | null>(null);
  const [noteActionPending, setNoteActionPending] = useState(false);
  const [deleting, setDeleting] = useState<NoteSummary | null>(null);
  const [optimizing, setOptimizing] = useState<NoteSummary | null>(null);
  const [manualLink, setManualLink] = useState("");
  const [attachment, setAttachment] = useState<any>(null);
  const [, draw] = useState(0),
    tabs = useRef<Record<string, Tab>>({}),
    saves = useRef<Partial<Record<string, Promise<void>>>>({}),
    draftWrites = useRef<Partial<Record<string, Promise<void>>>>({}),
    timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}),
    editor = useRef<EditorHandle>(null),
    imageInput = useRef<HTMLInputElement>(null),
    activeRef = useRef(active),
    viewRef = useRef(view),
    statusRef = useRef(status),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openGeneration = useRef(0),
    refreshGeneration = useRef(0);
  const [referenceJump, setReferenceJump] = useState<{
    path: string;
    offset: number;
  } | null>(null);
  useEffect(() => {
    if (referenceJump?.path !== active || !editor.current) return;
    editor.current.goTo(referenceJump.offset, true);
    setReferenceJump(null);
  }, [referenceJump, active]);
  const [collectionEntry, setCollectionEntry] = useState(0);
  const inboxLeave = useRef<(() => Promise<boolean>) | null>(null);
  async function navigate(next: View) {
    if (inboxLeave.current && !(await inboxLeave.current())) return false;
    openGeneration.current++;
    if (next === "inbox") setCollectionEntry((n) => n + 1);
    setView(next);
    return true;
  }
  useEffect(
    () =>
      window.workbench?.onCollectionRequested?.(() => {
        setView("inbox");
      }),
    [],
  );
  activeRef.current = active;
  viewRef.current = view;
  statusRef.current = status;
  const render = () => draw((n) => n + 1);
  const notify = (text: string, error = false, undo?: DeletedNote) => {
    setToast({ text, error, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(
      () => setToast(null),
      undo ? 15000 : error ? 10000 : 4500,
    );
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
    const generation = ++refreshGeneration.current;
    const next = await api("GET", "/status");
    if (generation !== refreshGeneration.current) return;
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
    if (generation !== refreshGeneration.current) return;
    setNotes((previous) =>
      JSON.stringify(previous) === JSON.stringify(n) ? previous : n,
    );
    setCaptures(c);
    setJobs(j);
    setProposals(p);
    for (const path of Object.keys(tabs.current)) {
      const tab = tabs.current[path],
        latest = n.find((x) => x.path === path);
      if (!latest || latest.hash === tab.hash || saves.current[path]) continue;
      try {
        const version = tab.generation,
          hash = tab.hash;
        const remote = await api<Note>(
          "GET",
          "/note?path=" + encodeURIComponent(path),
        );
        if (
          generation !== refreshGeneration.current ||
          tabs.current[path] !== tab ||
          tab.generation !== version ||
          tab.hash !== hash ||
          saves.current[path]
        )
          continue;
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
  async function openNote(path: string, childPath?: string) {
    if (inboxLeave.current && !(await inboxLeave.current())) return;
    const generation = ++openGeneration.current;
    try {
      if (!tabs.current[path]) {
        const note = await api<Note>(
            "GET",
            "/note?path=" + encodeURIComponent(path),
          ),
          original =
            note.owner === "paperdesk" ? note.body || "" : note.content;
        if (generation !== openGeneration.current) return;
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
      if (childPath) {
        const references = noteBodyLinks(tabs.current[path].content).filter(
          ({ target, style }) =>
            localLinkTarget(target, path, style) === childPath ||
            resolveIndexedLink(target, path, style) === childPath,
        );
        const reference =
          references.find(({ style }) => style === "markdown") || references[0];
        if (reference) setReferenceJump({ path, offset: reference.from });
        else notify("已打开父笔记，正文里暂时找不到这条子笔记链接。");
      }
      setActive(path);
      if (!path.startsWith(`${MANAGED}/`)) setScope("vault");
      setView("all");
      setQuery("");
      setResults(null);
      render();
    } catch (e) {
      if (generation === openGeneration.current)
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
        if (!document.querySelector('[aria-modal="true"]')) startCreate();
      }
    };
    let resuming = false;
    const resume = () => {
      if (
        resuming ||
        document.visibilityState === "hidden" ||
        !statusRef.current?.vault
      )
        return;
      resuming = true;
      void api("POST", "/refresh")
        .then(() => refresh())
        .catch((error) => notify(error.message, true))
        .finally(() => {
          resuming = false;
        });
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("beforeunload", before);
    window.addEventListener("keydown", key);
    return () => {
      clearInterval(timer);
      unregister?.();
      captureOff?.();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("keydown", key);
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setResults(null);
    const timer = setTimeout(() => {
      if (query.trim())
        void api<NoteSummary[]>(
          "GET",
          "/notes?q=" +
            encodeURIComponent(query) +
            "&scope=" +
            (status?.vault?.scopePath ? "vault" : scope),
        )
          .then((r) => {
            if (current) setResults(r);
          })
          .catch((e) => {
            if (current) notify(e.message, true);
          });
      else setResults(null);
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, scope, status?.vault?.scopePath, notes]);
  useEffect(() => {
    let current = true;
    setRelations(null);
    if (active)
      void api("GET", "/relations?path=" + encodeURIComponent(active))
        .then((r) => {
          if (current) setRelations(r);
        })
        .catch(() => {
          if (current) setRelations(null);
        });
    return () => {
      current = false;
    };
  }, [active, notes]);
  function startCreate(noteType?: NewNoteType) {
    if (!statusRef.current?.vault) return;
    setCreation({
      type:
        noteType ??
        (viewRef.current === "learning-log" ? "learning-log" : "concept"),
    });
  }
  function startCreateChild(path: string, anchor: ChildNoteAnchor) {
    const tab = tabs.current[path];
    if (!tab || tab.note.owner === "paperdesk") return;
    setCreation({
      type: tab.note.noteType === "learning-log" ? "learning-log" : "concept",
      parent: { ...anchor, path, requestId: crypto.randomUUID() },
    });
  }
  async function addNote(input: NewNoteInput) {
    const parent = creation?.parent;
    let note: Note;
    if (parent) {
      const { path, content, offset, placement, requestId } = parent;
      const tab = tabs.current[path];
      const checkPosition = () => {
        if (!tab || tabs.current[path] !== tab || tab.content !== content)
          throw new Error("父笔记已修改，请重新在正文选择插入位置。");
      };
      checkPosition();
      await flushPath(path);
      checkPosition();
      const result = await api<ChildNoteResult>("POST", "/notes", {
        ...input,
        parent: { path, offset, placement, requestId, expectedHash: tab.hash },
      });
      note = result.child;
      if (tabs.current[path] === tab && tab.content === content) {
        if (activeRef.current === path && result.insertion)
          editor.current?.applySavedInsertion(content, result.insertion);
        tab.note = result.parent;
        tab.hash = result.parent.hash;
        tab.content = result.parent.content;
        tab.status = "saved";
        tab.generation++;
      }
    } else {
      note = await api<Note>("POST", "/notes", input);
      setScope("workbench");
    }
    setCreation(null);
    void refresh().catch((e) => notify(e.message, true));
    await openNote(note.path);
  }
  function removeTab(path: string) {
    delete tabs.current[path];
    setTabOrder((prev) => {
      const next = prev.filter((p) => p !== path);
      if (activeRef.current === path) setActive(next.at(-1) || "");
      return next;
    });
  }
  async function closeTab(path: string) {
    try {
      await flushPath(path);
      removeTab(path);
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
  async function resolveEditorLink(
    target: string,
    style: LinkStyle,
    from: string,
  ): Promise<ResolvedLink> {
    if (!localLinkTarget(target, from, style)) return {};
    if (statusRef.current?.vault?.scopePath)
      return api<ResolvedLink>(
        "GET",
        "/resolve-link?" + new URLSearchParams({ path: from, target, style }),
      );
    return { path: resolveIndexedLink(target, from, style) };
  }
  async function loadLinkPreview(href: string) {
    const { target, style } = editorLink(href);
    const from = active;
    const { path } = await resolveEditorLink(target, style, from);
    if (path && activeRef.current === from)
      return api<Note>("GET", "/note?path=" + encodeURIComponent(path));
  }
  async function followLink(href: string, label: string) {
    const { target, style } = editorLink(href);
    if (/^https?:/.test(target)) {
      void openExternal(target);
      return;
    }
    const from = active;
    const generation = ++openGeneration.current;
    try {
      const result = await resolveEditorLink(target, style, from);
      if (activeRef.current !== from || openGeneration.current !== generation)
        return;
      if (result.outside)
        notify("此链接指向其他目录，请打开整个知识库后查看。");
      else if (result.path)
        await openNote(
          result.path,
          label === PARENT_NOTE_LABEL ? from : undefined,
        );
      else {
        setQuery(target.split("#")[0]);
        notify("未找到唯一匹配的笔记，已按链接内容查找。");
      }
    } catch (error) {
      notify((error as Error).message, true);
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
  async function flushNoteAction(path: string) {
    if (!tabs.current[path]) {
      let draft: string | null = null;
      try {
        draft = localStorage.getItem(localKey(path));
      } catch {
        // The embedded panel uses the recovery draft checked by the service.
      }
      if (draft) throw new Error("请先打开这篇笔记，处理未保存的草稿。");
    }
    await flushPath(path);
  }
  async function copyNoteLink(note: NoteSummary) {
    const stem = note.path.replace(/\.md$/i, "");
    const link = /[#\[\]]/.test(stem)
      ? `[笔记](/${note.path.split("/").map(encodeURIComponent).join("/")})`
      : `[[${stem}]]`;
    try {
      await navigator.clipboard.writeText(link);
      notify("笔记链接已复制");
    } catch {
      setManualLink(link);
    }
  }
  async function trashNote() {
    if (!deleting || noteActionPending) return;
    const { path, hash } = deleting;
    const dirty = tabs.current[path]?.dirty;
    setNoteActionPending(true);
    try {
      await flushNoteAction(path);
      const receipt = await api<DeletedNote>("POST", "/note/trash", {
        path,
        expectedHash: dirty ? (tabs.current[path]?.hash ?? hash) : hash,
      });
      openGeneration.current++;
      removeTab(path);
      setNotes((prev) => prev.filter((note) => note.path !== path));
      setResults((prev) => prev?.filter((note) => note.path !== path) ?? null);
      setDeleting(null);
      notify("笔记已移到知识库回收站", false, receipt);
      void refresh().catch(() => {});
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setNoteActionPending(false);
    }
  }
  async function restoreNote(receipt: DeletedNote) {
    if (noteActionPending) return;
    setNoteActionPending(true);
    try {
      await api<Note>("POST", "/note/restore", receipt);
      notify("笔记已恢复到原位置");
      void refresh().catch((e) => notify(e.message, true));
    } catch (error) {
      notify((error as Error).message, true, receipt);
    } finally {
      setNoteActionPending(false);
    }
  }
  async function saveTitle() {
    if (!titleEdit || noteActionPending) return;
    const { note, value } = titleEdit;
    const { path } = note;
    const title = value.trim();
    if (!title || title === note.title) return;
    setNoteActionPending(true);
    try {
      await flushNoteAction(path);
      const tab = tabs.current[path];
      if (tab && tab.note.title !== note.title)
        throw new Error("笔记标题已有变化，请重新打开标题窗口后再试。");
      const saved = await api<Note>("POST", "/note/title", {
        path,
        title,
        expectedHash: tab?.hash ?? note.hash,
      });
      if (tab) {
        tab.note = saved;
        tab.content = saved.content;
        tab.hash = saved.hash;
      }
      setTitleEdit(null);
      notify("标题已保存");
      void refresh().catch((e) => notify(e.message, true));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setNoteActionPending(false);
    }
  }

  function startMove(note: NoteSummary) {
    setMoving(note);
    setMovePath(note.path);
    setMovePreview(null);
  }

  async function move(apply: boolean) {
    if (!moving || noteActionPending) return;
    const from = moving.path;
    const to = movePath;
    setNoteActionPending(true);
    try {
      await flushNoteAction(from);
      const tab = tabs.current[from];
      const hash = tab?.hash ?? moving.hash;
      if (!apply) {
        const preview = await api<MovePreview>("POST", "/note/move", {
          from,
          to,
          expectedHash: hash,
          apply: false,
        });
        setMovePreview({ ...preview, hash });
        return;
      }
      if (movePreview?.hash !== hash) {
        setMovePreview(null);
        throw new Error("笔记版本已有变化，请重新预览链接更新。");
      }
      const { note } = await api<{ note: Note }>("POST", "/note/move", {
        from,
        to,
        expectedHash: hash,
        apply: true,
      });
      if (tab) {
        delete tabs.current[from];
        tabs.current[note.path] = {
          note,
          content: note.content,
          hash: note.hash,
          dirty: false,
          generation: 0,
          status: "saved",
        };
        setTabOrder((order) => order.map((p) => (p === from ? note.path : p)));
      }
      if (activeRef.current === from) {
        setActive(note.path);
        if (!note.path.startsWith(`${MANAGED}/`)) setScope("vault");
      }
      setMoving(null);
      notify("笔记已移动，引用链接已更新。");
      void refresh().catch((e) => notify(e.message, true));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setNoteActionPending(false);
    }
  }
  const t = tabs.current[active],
    pending = proposals.filter(
      (p) => p.status === "pending" && !p.supersededBy,
    ).length;
  const outline = useMemo(
    () => noteOutline(t?.content || "").filter((item) => item.level > 1),
    [t?.content],
  );
  const effectiveScope = status?.vault?.scopePath ? "vault" : scope;
  const scopedNotes = useMemo(
    () =>
      notes.filter(
        (n) => effectiveScope === "vault" || n.path.startsWith(`${MANAGED}/`),
      ),
    [notes, effectiveScope],
  );
  const visible = useMemo(
    () => (results || scopedNotes).filter((n) => matchesNoteSection(n, view)),
    [results, scopedNotes, view],
  );
  const sections = [
    {
      key: "all",
      label: "全部笔记",
      icon: BookOpen,
      count: scopedNotes.filter((n) => matchesNoteSection(n, "all")).length,
    },
    {
      key: "concept",
      label: "知识卡",
      icon: FilePenLine,
      count: scopedNotes.filter((n) => matchesNoteSection(n, "concept")).length,
    },
    {
      key: "learning-log",
      label: "学习记录",
      icon: Clock3,
      count: scopedNotes.filter((n) => matchesNoteSection(n, "learning-log"))
        .length,
    },
    { key: "inbox", label: "收集箱", icon: InboxIcon, count: captures.length },
    { key: "review", label: "待审稿", icon: Sparkles, count: pending },
  ];
  return (
    <div
      className={`app-shell${sidebar.collapsed ? " sidebar-collapsed" : ""}${sidebar.dragging ? " sidebar-dragging" : ""}`}
    >
      <aside
        id="navigation-sidebar"
        className="sidebar"
        style={{ width: sidebar.width }}
      >
        <div className="brand">
          <div className="brand-mark">
            <NotebookPen size={25} strokeWidth={1.4} />
          </div>
          <div>
            <strong>知识工作台</strong>
            <span>KNOWLEDGE WORKBENCH</span>
          </div>
          {shelfPreview && (
            <ShelfJump
              noun="笔记"
              items={scopedNotes
                .filter((note) => matchesNoteSection(note, "all"))
                .map((note) => ({
                  id: note.path,
                  title: note.title,
                  detail: note.path,
                }))}
              onOpen={openNote}
            />
          )}
        </div>
        <button
          className="vault-switch"
          disabled={!status?.capabilities?.chooseVault}
          title={
            status?.capabilities?.chooseVault
              ? `选择知识库或子文件夹${status?.vault ? `\n所属知识库：${status.vault.root}\n当前目录：${status.vault.scope || status.vault.root}` : ""}`
              : "此浏览器服务已固定知识库，请在桌面应用选库"
          }
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
        {status?.vault?.scopePath && (
          <p className="vault-scope" title={status.vault.scope}>
            子目录 · {status.vault.scopePath}
          </p>
        )}
        {status?.vault && !status.vault.scopePath && (
          <label className="note-scope">
            <span>笔记范围</span>
            <select
              aria-label="笔记范围"
              title={`专属位置：${MANAGED}`}
              value={scope}
              onChange={(event) => {
                const next = event.target.value as "workbench" | "vault";
                void flushAll()
                  .then(async () => {
                    if (!(await navigate("all"))) return;
                    setActive("");
                    setQuery("");
                    setResults(null);
                    setScope(next);
                  })
                  .catch((error) => notify(error.message, true));
              }}
            >
              <option value="workbench">我的知识库</option>
              <option value="vault">整个 Obsidian 仓库</option>
            </select>
            <small title={`${status.vault.root}/${MANAGED}`}>
              专属位置：{MANAGED}
            </small>
          </label>
        )}
        <button
          className="new-note"
          onClick={() => startCreate()}
          disabled={!status?.vault}
        >
          <Plus size={16} />
          写一篇笔记<kbd>{primaryModifier} N</kbd>
        </button>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索知识库"
            placeholder={
              status?.vault?.scopePath
                ? "搜索当前子目录"
                : scope === "workbench"
                  ? "搜索我的知识库"
                  : "搜索整个仓库"
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              openGeneration.current++;
              if (["inbox", "review"].includes(view)) navigate("all");
            }}
          />
          <kbd>{shelfPreview ? `${primaryModifier} K` : "⌕"}</kbd>
        </label>
        <nav aria-label="工作区分类">
          {sections.map((s) => (
            <button
              key={s.key}
              className={view === s.key ? "active" : ""}
              onClick={async () => {
                if (await navigate(s.key as View)) setQuery("");
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
            basePath={
              status?.vault?.scopePath || (scope === "workbench" ? MANAGED : "")
            }
            active={["inbox", "review"].includes(view) ? "" : active}
            dirty={(p) => Boolean(tabs.current[p]?.dirty)}
            canOptimize={Boolean(status?.capabilities?.noteOptimization)}
            onOpen={(p) => void openNote(p)}
            onAction={(action, note) => {
              if (action === "title") setTitleEdit({ note, value: note.title });
              else if (action === "move") startMove(note);
              else if (action === "copy-link") void copyNoteLink(note);
              else if (action === "optimize")
                setOptimizing(tabs.current[note.path]?.note ?? note);
              else setDeleting(tabs.current[note.path]?.note ?? note);
            }}
          />
          {!visible.length && (
            <p className="sidebar-empty">
              {query ? "没有找到匹配笔记" : "从第一篇笔记开始"}
            </p>
          )}
        </div>
        {shelfPreview && <ShelfPreferences />}
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
        {sidebar.separator}
      </aside>
      <main className="main-workspace">
        <header className="app-header">
          <button
            className="icon sidebar-toggle"
            aria-label={sidebar.collapsed ? "展开导航侧栏" : "收起导航侧栏"}
            title={sidebar.collapsed ? "展开导航侧栏" : "收起导航侧栏"}
            aria-expanded={!sidebar.collapsed}
            aria-controls="navigation-sidebar"
            onClick={sidebar.toggle}
          >
            {sidebar.collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
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
            <small>
              可以选择整个 Obsidian 知识库，也可以只打开其中的资料子文件夹。
            </small>
          </div>
        ) : view === "inbox" ? (
          <CollectionInbox
            registerLeave={(guard) => {
              inboxLeave.current = guard;
            }}
            onCancel={() => {
              setView("all");
            }}
            key={status.vault.id + ":" + collectionEntry}
            vaultId={status.vault.id}
            capabilities={status.capabilities || {}}
            captures={captures}
            notes={notes}
            jobs={jobs}
            onOpen={(p) => void openNote(p)}
            refresh={refresh}
            notify={notify}
          />
        ) : view === "review" ? (
          <Review
            key={status.vault.id}
            vaultId={status.vault.id}
            proposals={proposals}
            jobs={jobs}
            onOpen={openNote}
            saveTarget={flushNoteAction}
            refresh={refresh}
            notify={notify}
          />
        ) : (
          <>
            <div className="tab-strip">
              {tabOrder
                .filter(
                  (p) =>
                    effectiveScope === "vault" || p.startsWith(`${MANAGED}/`),
                )
                .map((p) => (
                  <div key={p} className={active === p ? "active" : ""}>
                    <button
                      onClick={() => {
                        openGeneration.current++;
                        setActive(p);
                      }}
                    >
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
                onClick={() => startCreate()}
              >
                <Plus size={15} />
              </button>
            </div>
            {!t ? (
              <div className="start-page">
                <span className="eyebrow">YOUR THINKING, IN PROGRESS</span>
                <h1>今天，想弄清什么？</h1>
                <p>
                  {status?.vault?.scopePath
                    ? `正在浏览 ${status.vault.scopePath}，新记录保存在当前子目录内。`
                    : scope === "workbench"
                      ? `这里是你的专属学习空间，笔记保存在 Obsidian 的 ${MANAGED} 文件夹。`
                      : "正在浏览整个 Obsidian 仓库，也可以切回“我的知识库”专注记录。"}
                </p>
                <div className="start-actions">
                  <button onClick={() => startCreate("concept")}>
                    <FilePenLine size={25} strokeWidth={1.4} />
                    <strong>写一篇知识笔记</strong>
                    <span>把理解和条件写清楚</span>
                    <ArrowUpRight size={17} />
                  </button>
                  <button onClick={() => navigate("inbox")}>
                    <InboxIcon size={25} strokeWidth={1.4} />
                    <strong>整理手边的材料</strong>
                    <span>先收集，再连接</span>
                    <ArrowUpRight size={17} />
                  </button>
                </div>
                <RecentNotes
                  notes={visible}
                  onOpen={(path) => void openNote(path)}
                />
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
                      <NoteColorMenu
                        onSelect={(color) => {
                          if (!editor.current?.setTextColor(color))
                            notify("请选中要设置颜色的正文。", true);
                        }}
                      />
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
                      <button
                        title="插入笔记目录"
                        onClick={() => {
                          const existing = t.content.match(
                            /^[ \t]*\[TOC\][ \t]*$/m,
                          );
                          if (existing?.index !== undefined)
                            editor.current?.goTo(existing.index);
                          else editor.current?.wrap("\n\n[TOC]\n\n", "");
                        }}
                      >
                        <ListTree size={15} />
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
                        onClick={() => startMove(t.note)}
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
                    loadLinkPreview={loadLinkPreview}
                    onCreateChild={
                      t.note.owner === "paperdesk"
                        ? undefined
                        : (anchor) => startCreateChild(active, anchor)
                    }
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
                        {primaryModifier} S
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
                      {outline.map(({ title, level, offset }) => (
                        <button
                          className="outline-link"
                          key={offset}
                          style={{ paddingLeft: (level - 2) * 10 }}
                          onClick={() => {
                            editor.current?.goTo(offset);
                          }}
                        >
                          {title}
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
                              title={
                                link.sha256
                                  ? `SHA-256: ${link.sha256}`
                                  : link.to_ref
                              }
                              onClick={() =>
                                link.kind === "asset"
                                  ? setAttachment(link)
                                  : link.resolved
                                    ? void openNote(link.to_ref)
                                    : (setQuery(link.to_ref),
                                      notify("已按链接内容查找笔记"))
                              }
                            >
                              <Link2 size={12} />
                              {link.label || link.to_ref}
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
          {toast.undo && (
            <button
              className="secondary"
              disabled={noteActionPending}
              onClick={() => {
                if (toast.undo) void restoreNote(toast.undo);
              }}
            >
              撤销删除
            </button>
          )}
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
          capabilities={status?.capabilities || {}}
          onClose={() => setSettings(false)}
          refresh={refresh}
          notify={notify}
        />
      )}
      {attachment && (
        <Modal title={attachment.label} onClose={() => setAttachment(null)}>
          <img
            src={assetUrl(attachment.assetPath)}
            alt={attachment.label}
            style={{ maxWidth: "100%" }}
          />
          <p style={{ overflowWrap: "anywhere" }}>
            SHA-256: {attachment.sha256}
          </p>
        </Modal>
      )}
      {creation && (
        <NewNoteDialog
          initialType={creation.type}
          initialTitle={creation.parent?.title}
          child={Boolean(creation.parent)}
          onCreate={addNote}
          onClose={() => setCreation(null)}
        />
      )}
      {optimizing && (
        <NoteOptimization
          note={optimizing}
          notes={scopedNotes}
          scope={effectiveScope}
          saveSelected={async (paths) => {
            await Promise.all(paths.map(flushNoteAction));
          }}
          onClose={() => setOptimizing(null)}
          onStarted={(job) => {
            setOptimizing(null);
            setJobs((current) => [
              job,
              ...current.filter((item) => item.id !== job.id),
            ]);
            notify("已提交笔记优化，可在「待审稿」查看进度。");
            void navigate("review");
            void refresh().catch((e) => notify(e.message, true));
          }}
        />
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
      {manualLink && (
        <Modal
          title="复制笔记链接"
          initialFocus='input[name="note-link"]'
          onClose={() => setManualLink("")}
        >
          <label>
            笔记链接
            <input
              name="note-link"
              value={manualLink}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除笔记"
          onClose={() => {
            if (!noteActionPending) setDeleting(null);
          }}
        >
          <p className="note-delete-description">
            将「{deleting.title}」移到知识库回收站？你可以撤销删除。
          </p>
          <p className="muted note-delete-description">{deleting.path}</p>
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={noteActionPending}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              className="primary note-delete-confirm"
              disabled={noteActionPending}
              onClick={() => void trashNote()}
            >
              {noteActionPending ? "正在移到回收站…" : "移到回收站"}
            </button>
          </footer>
        </Modal>
      )}
      {titleEdit && (
        <Modal
          title="修改笔记标题"
          initialFocus='input[name="note-title"]'
          onClose={() => {
            if (!noteActionPending) setTitleEdit(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <label>
              新标题
              <input
                name="note-title"
                value={titleEdit.value}
                maxLength={200}
                required
                readOnly={noteActionPending}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) =>
                  setTitleEdit({ ...titleEdit, value: e.target.value })
                }
              />
            </label>
            <footer className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={noteActionPending}
                onClick={() => setTitleEdit(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={
                  noteActionPending ||
                  !titleEdit.value.trim() ||
                  titleEdit.value.trim() === titleEdit.note.title
                }
              >
                {noteActionPending ? "正在保存…" : "保存标题"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {moving && (
        <Modal
          title="重命名或移动笔记"
          wide
          onClose={() => {
            if (!noteActionPending) setMoving(null);
          }}
        >
          {status?.vault?.scopePath && (
            <p className="muted">
              当前只更新所选子文件夹内的链接。如需同时更新其他目录的引用，请先打开整个知识库。
            </p>
          )}
          <label>
            知识库内的新位置
            <input
              value={movePath}
              readOnly={noteActionPending}
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
              {movePreview.changes.map((c) => (
                <details key={c.path}>
                  <summary>{c.path}</summary>
                  <Diff before={c.before} after={c.after} />
                </details>
              ))}
            </div>
          )}
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={noteActionPending}
              onClick={() => setMoving(null)}
            >
              返回
            </button>
            <button
              className="primary"
              disabled={
                noteActionPending ||
                !movePath.trim() ||
                movePath === moving.path
              }
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
