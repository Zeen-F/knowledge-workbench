import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveVaultSelection } from "../desktop/vault-selection.mjs";
import {
  createNoteResolver,
  localLinkTarget,
  PARENT_NOTE_LABEL,
} from "../shared/note-links.ts";
import {
  MANAGED,
  sourceRefSchema,
  type ChildNoteParent,
  type ChildNoteResult,
  type DeletedNote,
  type Note,
  type NoteSummary,
} from "../shared/contracts.ts";
import {
  AppError,
  atomicWrite,
  digest,
  inside,
  now,
  portable,
  readUtf8,
  safePath,
  slug,
} from "./files.ts";
import {
  createLinkRewriter,
  formatMarkdown,
  markdownLinks,
  noteTitle,
  parseMarkdown,
  paperdeskBody,
  withNoteTitle,
} from "./markdown.ts";

type Row = Record<string, any>;
const LINK_INDEX_VERSION = "3";

export function noteHref(from: string, to: string) {
  return path.posix
    .relative(path.posix.dirname(from), to)
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => "%" + character.charCodeAt(0).toString(16),
      ),
    )
    .join("/");
}
function noteLink(from: string, to: string, label: string) {
  return (
    "[" +
    label.replace(/[\\[\]*_$~<>&]/g, "\\$&") +
    "](" +
    noteHref(from, to) +
    ")"
  );
}

function linksTo(body: string, from: string, to: string) {
  return markdownLinks(body).some(
    (link) =>
      link.style === "markdown" &&
      localLinkTarget(link.target, from, link.style) === to,
  );
}

export class Vault {
  root: string;
  scope: string;
  scopePath: string;
  managed: string;
  dataDir: string;
  db: DatabaseSync;
  warnings: string[] = [];
  private scanSignatures = new Map<string, string>();
  private scanAuditOffset = 0;
  private rebuildRelations: boolean;
  private ftsRows = new Map<string, (number | bigint)[]>();
  private ftsDataVersion = -1;
  private refreshFullTextRows() {
    const version = (this.db.prepare("PRAGMA data_version").get() as Row)
      .data_version;
    if (version === this.ftsDataVersion) return;
    this.ftsRows.clear();
    for (const row of this.db
      .prepare("SELECT rowid,path FROM notes_fts")
      .all() as Row[]) {
      const rows = this.ftsRows.get(row.path) || [];
      rows.push(row.rowid);
      this.ftsRows.set(row.path, rows);
    }
    this.ftsDataVersion = version;
  }
  private clearFullText(relative: string) {
    // Another connection invalidates the row map. The path guard also prevents
    // a recycled rowid from removing an unrelated note's derived search row.
    this.refreshFullTextRows();
    const remove = this.db.prepare(
      "DELETE FROM notes_fts WHERE rowid=? AND path=?",
    );
    for (const rowid of this.ftsRows.get(relative) || [])
      remove.run(rowid, relative);
    this.ftsRows.delete(relative);
  }
  private fileSignature(file: string) {
    const stat = fs.statSync(file, { bigint: true });
    return [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.mode,
    ].join(":");
  }
  constructor(root: string, dataDir: string, db: DatabaseSync) {
    const selection = resolveVaultSelection(root);
    this.root = selection.root;
    this.scope = selection.scope;
    this.scopePath = selection.scopePath;
    this.managed =
      path.basename(this.scope).toLowerCase() === MANAGED.toLowerCase() &&
      this.scopePath
        ? this.scopePath
        : path.posix.join(this.scopePath, MANAGED);
    this.dataDir = path.resolve(dataDir);
    this.db = db;
    this.refreshFullTextRows();
    this.rebuildRelations =
      (
        db
          .prepare("SELECT value FROM settings WHERE key='link-index-version'")
          .get() as Row | undefined
      )?.value !== LINK_INDEX_VERSION;
    fs.mkdirSync(dataDir, { recursive: true });
    if (inside(this.root, fs.realpathSync(dataDir)))
      throw new AppError("应用索引必须保存在知识库之外");
    for (const dir of ["Inbox", "Cards", "Journal", "Drafts", "Assets"])
      fs.mkdirSync(this.absolute(`${this.managed}/${dir}`), {
        recursive: true,
      });
  }
  absolute(relative: string) {
    const file = safePath(this.root, relative);
    if (!inside(this.scope, file))
      throw new AppError(
        "此文件不在当前选定的子文件夹内，请切换目录后打开",
        403,
        "OUTSIDE_SCOPE",
      );
    // Also reject junctions that point at another folder inside the parent vault.
    return safePath(this.scope, portable(path.relative(this.scope, file)));
  }
  linkPaths(): string[] {
    if (!this.scopePath)
      return this.list()
        .filter((note) => !note.missing)
        .map((note) => note.path);
    // A short wiki name keeps the parent vault's meaning. Only enumerate names
    // outside the chosen folder; never read/index their Markdown bodies.
    const paths: string[] = [];
    const ignore = this.ignoredPaths();
    const walk = (directory: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        throw new AppError(
          "部分目录暂不可读，无法确认同名链接，请稍后重试",
          409,
        );
      }
      for (const entry of entries) {
        if (
          entry.name.startsWith(".") ||
          ["node_modules", "_templates"].includes(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const target = path.join(directory, entry.name);
        const relative = portable(path.relative(this.root, target));
        if (
          ignore.some(
            (prefix) =>
              relative === prefix.replace(/\/$/, "") ||
              relative.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"),
          )
        )
          continue;
        if (entry.isDirectory()) walk(target);
        else if (
          entry.isFile() &&
          /\.md$/i.test(entry.name) &&
          entry.name !== "AGENTS.md" &&
          !relative.endsWith("/Library.md")
        )
          paths.push(relative);
      }
    };
    walk(this.root);
    return paths;
  }
  resolveLink(target: string, from: string, style: "wiki" | "markdown") {
    this.absolute(from);
    return createNoteResolver(this.linkPaths())(target, from, style);
  }
  private ignoredPaths(): string[] {
    try {
      const config = JSON.parse(
        readUtf8(path.join(this.root, ".obsidian", "app.json")),
      );
      return [
        "_meta/",
        ...(config.userIgnoreFilters || []).filter(
          (value: unknown) => typeof value === "string",
        ),
      ];
    } catch {
      return ["_meta/"];
    }
  }
  summary(row: Row): NoteSummary {
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      noteType: row.note_type,
      domain: row.domain,
      status: row.status,
      hash: row.hash,
      updatedAt: row.updated_at,
      tags: JSON.parse(row.tags),
      owner: row.owner,
      missing: Boolean(row.missing),
    };
  }
  read(relative: string): Note {
    if (!relative.toLowerCase().endsWith(".md"))
      throw new AppError("仅能编辑 Markdown 笔记");
    const file = this.absolute(relative),
      content = readUtf8(file),
      { metadata, body } = parseMarkdown(content, false);
    const managed =
      content.includes("<!-- paperdesk-generated:") ||
      content.includes("<!-- paperdesk-library:");
    const paperdeskId = managed
      ? path.posix.basename(relative, ".md")
      : undefined;
    const result: Note = {
      id: String(metadata.kb_id || digest(relative)),
      path: relative,
      title: noteTitle(body, metadata, relative),
      noteType: String(metadata.note_type || "note"),
      domain: String(metadata.domain || ""),
      status: String(metadata.status || "working"),
      hash: digest(content),
      updatedAt: fs.statSync(file).mtime.toISOString(),
      tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
      owner: managed
        ? "paperdesk"
        : relative.startsWith(`${this.managed}/`)
          ? "workbench"
          : "external",
      content,
      metadata,
      paperdeskId,
      body: managed ? paperdeskBody(content) : body,
    };
    const recovery = this.draftFile(relative);
    if (fs.existsSync(recovery)) {
      try {
        result.draft = JSON.parse(readUtf8(recovery));
      } catch {
        this.warnings.push(`本机草稿读取失败：${relative}`);
      }
    }
    return result;
  }
  index(relative: string) {
    const n = this.read(relative);
    this.db
      .prepare(
        `INSERT INTO notes(path,id,title,note_type,domain,status,hash,updated_at,tags,owner,missing) VALUES(?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(path) DO UPDATE SET id=excluded.id,title=excluded.title,note_type=excluded.note_type,domain=excluded.domain,status=excluded.status,hash=excluded.hash,updated_at=excluded.updated_at,tags=excluded.tags,owner=excluded.owner,missing=0`,
      )
      .run(
        n.path,
        n.id,
        n.title,
        n.noteType,
        n.domain,
        n.status,
        n.hash,
        n.updatedAt,
        JSON.stringify(n.tags),
        n.owner,
      );
    this.clearFullText(relative);
    if (!relative.startsWith(`${this.managed}/Drafts/`)) {
      const result = this.db
        .prepare("INSERT INTO notes_fts(path,title,body,tags) VALUES(?,?,?,?)")
        .run(
          relative,
          n.title,
          n.owner === "paperdesk" ? n.body || "" : n.content,
          n.tags.join(" "),
        );
      this.ftsRows.set(relative, [result.lastInsertRowid]);
    }
    this.db.prepare("DELETE FROM relations WHERE from_path=?").run(relative);
    for (const link of markdownLinks(n.body || ""))
      this.db
        .prepare("INSERT OR IGNORE INTO relations VALUES(?,?,?)")
        .run(
          relative,
          link.target,
          link.style === "markdown" ? "markdown" : "related",
        );
    for (const key of ["derived_from", "superseded_by", "source"])
      for (const target of Array.isArray(n.metadata[key])
        ? (n.metadata[key] as unknown[])
        : n.metadata[key]
          ? [n.metadata[key]]
          : [])
        this.db
          .prepare("INSERT OR IGNORE INTO relations VALUES(?,?,?)")
          .run(relative, String(target), key);
    if (n.metadata.kb_source) {
      const ref = sourceRefSchema.parse(n.metadata.kb_source);
      this.db
        .prepare(
          "INSERT INTO sources(id,path,ref,text,transfer_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,ref=excluded.ref,text=excluded.text",
        )
        .run(
          ref.id,
          relative,
          JSON.stringify(ref),
          n.body || "",
          ref.transferId || null,
        );
      const extracted = (
        this.db
          .prepare(
            "SELECT body FROM extractions WHERE source_id=? AND source_hash=?",
          )
          .all(ref.id, n.hash) as Row[]
      )
        .map((r) => r.body)
        .join("\n");
      if (extracted)
        this.db
          .prepare("UPDATE notes_fts SET body=? WHERE path=?")
          .run(n.content + "\n\nAI 识读（待核对）\n" + extracted, relative);
      if (
        ref.sha256 &&
        ref.assetPath &&
        ref.mime &&
        !this.db.prepare("SELECT hash FROM assets WHERE hash=?").get(ref.sha256)
      )
        try {
          const bytes = fs.readFileSync(this.absolute(ref.assetPath));
          if (digest(bytes) === ref.sha256)
            this.db
              .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)")
              .run(ref.sha256, ref.assetPath, ref.mime, bytes.length);
        } catch {
          /* Keep the source even when its cloud attachment is unavailable. */
        }
    }
    const extraction = n.metadata.kb_extraction as any;
    if (
      extraction &&
      typeof extraction.sourceId === "string" &&
      typeof extraction.sourceVersion === "string"
    ) {
      this.db
        .prepare(
          "INSERT INTO extractions VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET source_id=excluded.source_id,source_hash=excluded.source_hash,body=excluded.body",
        )
        .run(
          n.path,
          extraction.sourceId,
          extraction.sourceVersion,
          n.body || "",
        );
      const row = this.db
        .prepare("SELECT path FROM sources WHERE id=?")
        .get(extraction.sourceId) as Row | undefined;
      if (row && row.path !== n.path) this.index(row.path);
    }
    return n;
  }
  scan(options: { incremental?: boolean; auditLimit?: number } = {}) {
    this.warnings = [];
    const seen = new Set<string>();
    let complete = true;
    const candidates: { file: string; relative: string }[] = [];
    const oldNotes = new Map(
      (
        this.db.prepare("SELECT path,hash,missing FROM notes").all() as Row[]
      ).map((row) => [row.path, row]),
    );
    const restore = this.db.prepare("UPDATE notes SET missing=0 WHERE path=?");
    const ignore = this.ignoredPaths();
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        complete = false;
        this.warnings.push(
          `目录暂不可读：${portable(path.relative(this.root, dir))}`,
        );
        return;
      }
      for (const e of entries) {
        if (
          e.name.startsWith(".") ||
          ["node_modules", "_templates"].includes(e.name) ||
          e.isSymbolicLink()
        )
          continue;
        const file = path.join(dir, e.name),
          relative = portable(path.relative(this.root, file));
        if (
          ignore.some(
            (p) =>
              relative === p.replace(/\/$/, "") ||
              relative.startsWith(p.endsWith("/") ? p : p + "/"),
          )
        )
          continue;
        if (e.isDirectory()) {
          walk(file);
          continue;
        }
        if (
          !e.isFile() ||
          !/\.md$/i.test(e.name) ||
          e.name === "AGENTS.md" ||
          relative.endsWith("/Library.md")
        )
          continue;
        seen.add(relative);
        candidates.push({ file, relative });
      }
    };
    walk(this.scope);
    const auditLimit = Math.max(
      1,
      Math.min(1024, Math.floor(options.auditLimit || 128)),
    );
    const auditStart = this.scanAuditOffset % Math.max(1, candidates.length);
    const audited = new Set<string>();
    for (let i = 0; i < Math.min(auditLimit, candidates.length); i++)
      audited.add(candidates[(auditStart + i) % candidates.length].relative);
    this.scanAuditOffset =
      (auditStart + auditLimit) % Math.max(1, candidates.length);
    for (const { file, relative } of candidates) {
      try {
        const before = this.fileSignature(file),
          old = oldNotes.get(relative);
        if (
          options.incremental &&
          !this.rebuildRelations &&
          old &&
          !old.missing &&
          this.scanSignatures.get(relative) === before &&
          !audited.has(relative)
        )
          continue;
        const content = readUtf8(file),
          hash = digest(content);
        const indexed =
          this.rebuildRelations || !old || old.hash !== hash
            ? this.index(relative)
            : null;
        if (!indexed && old?.missing) restore.run(relative);
        const after = this.fileSignature(file);
        // A file changed during read/index: do not cache it as verified. Actual
        // save/move checks always read and hash disk independently of this cache.
        if (before === after && (!indexed || indexed.hash === hash))
          this.scanSignatures.set(relative, after);
        else this.scanSignatures.delete(relative);
      } catch {
        this.scanSignatures.delete(relative);
        complete = false;
        this.warnings.push(`文件暂不可读，保留旧索引：${relative}`);
      }
    }
    for (const relative of this.scanSignatures.keys())
      if (!seen.has(relative)) this.scanSignatures.delete(relative);
    if (complete)
      for (const row of this.db
        .prepare("SELECT path FROM notes")
        .all() as Row[])
        if (!seen.has(row.path))
          this.db
            .prepare("UPDATE notes SET missing=1 WHERE path=?")
            .run(row.path);
    if (complete && this.rebuildRelations) {
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES('link-index-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(LINK_INDEX_VERSION);
      this.rebuildRelations = false;
    }
    return { notes: this.list(), warnings: this.warnings };
  }
  list() {
    return (
      this.db
        .prepare("SELECT * FROM notes ORDER BY updated_at DESC")
        .all() as Row[]
    ).map((r) => this.summary(r));
  }
  search(query: string, scope: "workbench" | "vault" = "vault") {
    const q = query.trim().slice(0, 200);
    if (!q)
      return this.list().filter(
        (note) =>
          scope === "vault" ||
          (!note.missing &&
            note.path.startsWith(`${this.managed}/`) &&
            !note.path.includes("/Drafts/") &&
            !note.path.includes("/Inbox/")),
      );
    // Apply the workspace boundary before ranking/limiting, so unrelated notes
    // cannot crowd managed notes out of the first 100 search results.
    const scopeFilter =
      scope === "workbench"
        ? " AND substr(n.path,1,?)=? AND n.path NOT GLOB ? AND n.path NOT GLOB ?"
        : "";
    const scopeArgs =
      scope === "workbench"
        ? [
            this.managed.length + 1,
            `${this.managed}/`,
            "*/Drafts/*",
            "*/Inbox/*",
          ]
        : [];
    let rows: Row[];
    if (Array.from(q).length >= 3)
      rows = this.db
        .prepare(
          "SELECT n.* FROM notes_fts f JOIN notes n ON n.path=f.path WHERE notes_fts MATCH ? AND n.missing=0" +
            scopeFilter +
            " ORDER BY bm25(notes_fts) LIMIT 100",
        )
        .all('"' + q.replaceAll('"', '""') + '"', ...scopeArgs) as Row[];
    else
      rows = this.db
        .prepare(
          "SELECT n.* FROM notes_fts f JOIN notes n ON n.path=f.path WHERE (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\' OR f.tags LIKE ? ESCAPE '\\') AND n.missing=0" +
            scopeFilter +
            " LIMIT 100",
        )
        .all(
          ...Array(3).fill("%" + q.replace(/[\\%_]/g, "\\$&") + "%"),
          ...scopeArgs,
        ) as Row[];
    return rows.map((r) => this.summary(r));
  }
  draftFile(relative: string) {
    return path.join(this.dataDir, "drafts", digest(relative) + ".json");
  }
  keepDraft(relative: string, content: string, baseHash: string) {
    this.absolute(relative);
    atomicWrite(
      this.draftFile(relative),
      JSON.stringify({ path: relative, content, baseHash, savedAt: now() }),
    );
  }
  clearDraft(relative: string, content?: string) {
    const file = this.draftFile(relative);
    if (
      fs.existsSync(file) &&
      (content === undefined || JSON.parse(readUtf8(file)).content === content)
    )
      fs.unlinkSync(file);
  }
  backup(relative: string, content: string, reason: string) {
    const id = randomUUID();
    atomicWrite(
      path.join(this.dataDir, "history", digest(relative), id + ".json"),
      JSON.stringify({
        id,
        path: relative,
        content,
        hash: digest(content),
        reason,
        savedAt: now(),
      }),
    );
    return id;
  }
  history(relative: string) {
    this.absolute(relative);
    const dir = path.join(this.dataDir, "history", digest(relative));
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => JSON.parse(readUtf8(path.join(dir, n))))
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      : [];
  }
  save(relative: string, content: string, expected: string) {
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new AppError("笔记超过 8 MiB", 413);
    const before = this.read(relative);
    this.keepDraft(relative, content, expected);
    if (before.owner === "paperdesk")
      throw new AppError(
        "Paperdesk 正文需要通过已绑定的纸间服务保存",
        409,
        "PAPERDESK_REQUIRED",
      );
    if (before.hash !== expected)
      throw new AppError(
        "笔记已被其他应用修改，草稿已保留，请核对差异",
        409,
        "VERSION_CONFLICT",
        { currentHash: before.hash },
      );
    // Validation must precede every replacement; keepDraft above preserves unfinished YAML.
    parseMarkdown(content);
    if (before.content !== content) {
      this.backup(relative, before.content, "save");
      if (digest(readUtf8(this.absolute(relative))) !== expected)
        throw new AppError("文件在保存前发生变化", 409, "VERSION_CONFLICT");
      atomicWrite(this.absolute(relative), content);
    }
    const result = this.index(relative);
    this.clearDraft(relative, content);
    delete result.draft;
    return result;
  }
  setTitle(relative: string, title: string, expected: string) {
    const note = this.read(relative);
    if (note.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409, "PAPERDESK_REQUIRED");
    if (note.hash !== expected)
      throw new AppError(
        "笔记已有新修改，请重新打开标题窗口后再试。",
        409,
        "VERSION_CONFLICT",
      );
    if (note.title === title) return note;
    const next = withNoteTitle(note.content, title);
    if (
      note.draft &&
      note.draft.content !== note.content &&
      (note.draft.content !== next || note.draft.baseHash !== expected)
    )
      throw new AppError("请先打开这篇笔记，处理未保存的草稿。", 409);
    return this.save(relative, next, expected);
  }
  private noteTrashRoot(create = false) {
    const root = path.join(this.root, ".trash");
    if (create) fs.mkdirSync(root, { recursive: true });
    if (!fs.lstatSync(root).isDirectory())
      throw new AppError("知识库回收站路径不可用", 409);
    return root;
  }
  trashNote(relative: string, expected: string): DeletedNote {
    const file = this.absolute(relative);
    if (!fs.lstatSync(file).isFile())
      throw new AppError("只可删除普通 Markdown 文件", 409);
    const note = this.read(relative);
    if (note.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409, "PAPERDESK_REQUIRED");
    if (
      /\/(?:Inbox|Drafts)\//.test(relative) ||
      /(?:^|\/)(?:AGENTS|Library)\.md$/i.test(relative)
    )
      throw new AppError("请在对应工作区管理这份文件", 409);
    if (note.hash !== expected)
      throw new AppError(
        "笔记已有新修改，请重新核对后删除。",
        409,
        "VERSION_CONFLICT",
      );
    if (note.draft && note.draft.content !== note.content)
      throw new AppError("请先打开这篇笔记，处理未保存的草稿。", 409);

    const id = randomUUID();
    const dir = path.join(this.noteTrashRoot(true), `kwb-note-${id}`);
    fs.mkdirSync(dir);
    const archived = path.join(dir, relative);
    try {
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      if (digest(readUtf8(file)) !== expected)
        throw new AppError(
          "笔记在删除前发生变化，请重新核对。",
          409,
          "VERSION_CONFLICT",
        );
      fs.renameSync(file, archived);
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    this.db.prepare("UPDATE notes SET missing=1 WHERE path=?").run(relative);
    this.scanSignatures.delete(relative);
    return { id, path: relative, hash: note.hash };
  }
  restoreDeletedNote({ id, path: relative, hash }: DeletedNote) {
    const file = this.absolute(relative);
    const dir = path.join(this.noteTrashRoot(), `kwb-note-${id}`);
    if (!fs.lstatSync(dir).isDirectory())
      throw new AppError("笔记已不在回收站中", 404);
    const archive = safePath(dir, relative);
    const entry = fs.lstatSync(archive, { bigint: true });
    if (!entry.isFile() || digest(readUtf8(archive)) !== hash)
      throw new AppError("回收站中的笔记已有变化，请核对文件后恢复。", 409);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.linkSync(archive, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = fs.lstatSync(file, { bigint: true });
      // A retry can finish a restore interrupted after the exclusive link.
      if (existing.dev !== entry.dev || existing.ino !== entry.ino)
        throw new AppError("原位置已有文件，请先确认如何保留两份。", 409);
    }
    const saved = this.index(relative);
    fs.unlinkSync(archive);
    for (
      let folder = path.dirname(archive);
      inside(dir, folder);
      folder = path.dirname(folder)
    ) {
      try {
        fs.rmdirSync(folder);
      } catch {
        break;
      }
    }
    return saved;
  }
  private newNotePath(title: string, noteType: string, id: string) {
    const folder = noteType === "learning-log" ? "Journal" : "Cards";
    const stem = slug(title);
    const name =
      Buffer.byteLength(stem) <= 242
        ? stem
        : Array.from(stem).slice(0, 59).join("");
    return `${this.managed}/${folder}/${name}--${id.slice(0, 8)}.md`;
  }
  private newNoteContent(
    title: string,
    noteType: string,
    id: string,
    content?: string,
  ) {
    const body =
      content ||
      `# ${title}\n\n${noteType === "learning-log" ? "## 本次问题\n\n\n## 过程与观察\n\n\n## 当前判断\n\n\n## 下一步与连接" : "## 核心问题与结论\n\n\n## 机制、模型或推导\n\n\n## 例子与边界\n\n\n## 尚未解决\n\n\n## 来源与连接"}\n\n`;
    return formatMarkdown(
      {
        title,
        note_type: noteType,
        domain: "shared",
        status: "working",
        source: [],
        tags: [],
        kb_id: id,
        ...(noteType === "learning-log"
          ? {
              date: new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Shanghai",
              }).format(new Date()),
            }
          : {}),
      },
      body,
    );
  }
  create(title: string, noteType = "concept", content?: string) {
    const id = randomUUID();
    const relative = this.newNotePath(title, noteType, id);
    atomicWrite(
      this.absolute(relative),
      this.newNoteContent(title, noteType, id, content),
      true,
    );
    return this.index(relative);
  }
  prepareChildNote(
    parent: string,
    title: string,
    markdown: string,
    id: string,
  ) {
    const relative = this.newNotePath(title, "concept", id);
    let body = parseMarkdown(markdown).body.trim();
    // Moving the draft into its own file keeps relative image and note links
    // pointing at the same local resources as they did in the parent.
    for (const link of markdownLinks(body)
      .filter((item) => item.style === "markdown")
      .reverse()) {
      const local = localLinkTarget(link.target, parent, "markdown");
      if (!local) continue;
      const fragment = link.target.includes("#")
        ? link.target.slice(link.target.indexOf("#"))
        : "";
      body =
        body.slice(0, link.from) +
        noteHref(relative, local) +
        fragment +
        body.slice(link.to);
    }
    const backlink = noteLink(relative, parent, PARENT_NOTE_LABEL);
    const heading = body.match(/^# [^\n]+\n*/)?.[0];
    const text =
      (heading?.trimEnd() || "# " + title) +
      "\n\n" +
      backlink +
      "\n\n" +
      (heading ? body.slice(heading.length) : body) +
      "\n";
    return {
      path: relative,
      content: this.newNoteContent(title, "concept", id, text),
    };
  }
  createChild(
    title: string,
    noteType: string,
    request: ChildNoteParent,
    content?: string,
  ): ChildNoteResult {
    const { path: parentPath, expectedHash, requestId } = request;
    const parent = this.read(parentPath);
    if (parent.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409, "PAPERDESK_REQUIRED");

    title = title.replace(/[\r\n]+/g, " ").trim() || "未命名笔记";
    const childPath = this.newNotePath(title, noteType, requestId);
    const childFile = this.absolute(childPath);
    const existing = fs.existsSync(childFile)
      ? this.read(childPath)
      : undefined;
    const backlink = noteLink(childPath, parentPath, PARENT_NOTE_LABEL);
    if (existing) {
      if (
        existing.id !== requestId ||
        !linksTo(existing.body || "", childPath, parentPath)
      )
        throw new AppError("子笔记文件已被占用，请重新创建。", 409);
      // A retry after an interrupted response must not add the link twice.
      if (linksTo(parent.body || "", parentPath, childPath))
        return { child: existing, parent };
    }
    if (parent.hash !== expectedHash)
      throw new AppError(
        "父笔记已修改，请重新选择插入位置。",
        409,
        "VERSION_CONFLICT",
      );

    const { frontmatter } = parseMarkdown(parent.content);
    const bodyStart = Math.max(
      frontmatter.length,
      parent.content.startsWith("\uFEFF") ? 1 : 0,
    );
    const inline = request.placement === "inline";
    const offset = inline
      ? request.offset
      : Math.max(bodyStart, request.offset);
    const before = parent.content.slice(0, offset);
    const after = parent.content.slice(offset);
    if (
      offset < bodyStart ||
      offset > parent.content.length ||
      (before.endsWith("\r") && after.startsWith("\n")) ||
      (/[\uD800-\uDBFF]$/.test(before) && /^[\uDC00-\uDFFF]/.test(after)) ||
      (!inline && offset !== bodyStart && after && !/^\r?\n/.test(after))
    )
      throw new AppError("插入位置已变化，请重新在正文右键。", 409);
    const eol = parent.content.match(/\r?\n/)?.[0] || "\n";
    const prefix =
      inline || offset === 0 || before.endsWith(eol + eol)
        ? ""
        : before.endsWith(eol)
          ? eol
          : eol + eol;
    const suffix = inline ? "" : after.startsWith(eol) ? eol : eol + eol;
    const text = prefix + noteLink(parentPath, childPath, title) + suffix;
    const next = before + text + after;
    if (!linksTo(parseMarkdown(next).body, parentPath, childPath))
      throw new AppError("请在正文段落或空白行上右键创建子笔记。", 409);
    if (Buffer.byteLength(next) > 8 * 1024 * 1024)
      throw new AppError("父笔记超过 8 MiB，无法插入链接。", 413);
    if (
      parent.draft &&
      parent.draft.content !== parent.content &&
      (parent.draft.content !== next || parent.draft.baseHash !== expectedHash)
    )
      throw new AppError("请先处理父笔记未保存的草稿。", 409);

    const body = content?.replace(/^[^\n]*\n+/, "") || "";
    if (!existing)
      atomicWrite(
        childFile,
        this.newNoteContent(
          title,
          noteType,
          requestId,
          "# " + title + "\n\n" + backlink + "\n\n" + body,
        ),
        true,
      );
    const child = this.index(childPath);
    try {
      return {
        child,
        parent: this.save(parentPath, next, expectedHash),
        insertion: { offset, text },
      };
    } catch (error) {
      // Keep the child's data and the parent recovery draft on a partial write.
      throw new AppError(
        "子笔记已创建，父笔记链接保存未确认。" + (error as Error).message,
        error instanceof AppError ? error.status : 500,
        error instanceof AppError ? error.code : "CHILD_LINK_UNCONFIRMED",
        { childPath },
      );
    }
  }
  move(from: string, to: string, expected: string, apply = false) {
    const source = this.read(from);
    if (source.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409);
    if (source.hash !== expected)
      throw new AppError("移动前的笔记版本已变化", 409, "VERSION_CONFLICT");
    const target = this.absolute(to);
    if (!to.endsWith(".md") || fs.existsSync(target))
      throw new AppError("目标已存在或不是 Markdown 文件", 409);
    const all = this.list().filter((n) => !n.missing),
      paths = this.scopePath ? this.linkPaths() : all.map((n) => n.path),
      rewrite = createLinkRewriter(from, to, paths);
    const updates = all
      .map((n) => this.read(n.path))
      .filter((n) => n.owner !== "paperdesk")
      .map((n) => ({
        ...n,
        next: rewrite(n.content, n.path),
      }))
      .filter((n) => n.path === from || n.content !== n.next);
    if (updates.some((n) => n.draft && n.draft.content !== n.content))
      throw new AppError("相关笔记存在尚未保存的草稿，请先处理再移动", 409);
    if (!apply)
      return {
        changes: updates.map((n) => ({
          path: n.path,
          before: n.content,
          after: n.next,
        })),
        from,
        to,
      };
    const journal = path.join(this.dataDir, "moves", randomUUID() + ".json");
    const record = {
      from,
      to,
      updates: updates.map((n) => ({
        path: n.path,
        before: n.content,
        after: n.next,
      })),
      state: "pending",
      createdAt: now(),
    };
    atomicWrite(journal, JSON.stringify(record));
    try {
      for (const n of updates) {
        if (this.read(n.path).hash !== n.hash)
          throw new AppError(
            "链接更新期间发现新修改，已保留恢复记录",
            409,
            "VERSION_CONFLICT",
          );
        this.backup(n.path, n.content, "move");
      }
      atomicWrite(target, updates.find((n) => n.path === from)!.next, true);
      for (const n of updates.filter((n) => n.path !== from))
        this.save(n.path, n.next, n.hash);
      if (this.read(from).hash !== expected)
        throw new AppError(
          "源笔记在移动中发生变化，两份文件均保留",
          409,
          "VERSION_CONFLICT",
        );
      fs.unlinkSync(this.absolute(from));
      this.clearDraft(from);
      this.db.prepare("DELETE FROM notes WHERE path=?").run(from);
      this.clearFullText(from);
      this.db.prepare("DELETE FROM relations WHERE from_path=?").run(from);
      atomicWrite(
        journal,
        JSON.stringify({ ...record, state: "completed", completedAt: now() }),
      );
      return { note: this.index(to), changes: updates.map((n) => n.path) };
    } catch (error) {
      this.rollbackMove(journal, record);
      throw error;
    }
  }
  rollbackMove(journal: string, record: any) {
    const issues: string[] = [];
    for (const n of [...record.updates].reverse())
      try {
        const file = this.absolute(n.path);
        if (!fs.existsSync(file)) {
          if (n.path === record.from) atomicWrite(file, n.before, true);
          else issues.push(n.path);
        } else {
          const current = readUtf8(file);
          if (current === n.after && current !== n.before)
            atomicWrite(file, n.before);
          else if (current !== n.before) issues.push(n.path);
        }
        this.clearDraft(n.path, n.after);
      } catch {
        issues.push(n.path);
      }
    try {
      const target = this.absolute(record.to),
        source = this.absolute(record.from),
        original = record.updates.find((n: any) => n.path === record.from);
      if (fs.existsSync(target)) {
        if (
          fs.existsSync(source) &&
          readUtf8(source) === original.before &&
          readUtf8(target) === original.after
        )
          fs.unlinkSync(target);
        else issues.push(record.to);
      }
    } catch {
      issues.push(record.to);
    }
    atomicWrite(
      journal,
      JSON.stringify({
        ...record,
        state: issues.length ? "needs-recovery" : "rolled-back",
        issues,
        recoveredAt: now(),
      }),
    );
    return issues;
  }
  recoverMoves() {
    const dir = path.join(this.dataDir, "moves"),
      issues: string[] = [];
    if (!fs.existsSync(dir)) return issues;
    for (const file of fs.readdirSync(dir).filter((n) => n.endsWith(".json")))
      try {
        const journal = path.join(dir, file),
          record = JSON.parse(readUtf8(journal));
        if (["pending", "needs-recovery"].includes(record.state))
          issues.push(...this.rollbackMove(journal, record));
      } catch {
        issues.push(file);
      }
    return issues;
  }
}
