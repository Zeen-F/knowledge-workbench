import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MANAGED,
  sourceRefSchema,
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
  formatMarkdown,
  links,
  noteTitle,
  parseMarkdown,
  paperdeskBody,
  rewriteLinks,
} from "./markdown.ts";

type Row = Record<string, any>;
export class Vault {
  root: string;
  dataDir: string;
  db: DatabaseSync;
  warnings: string[] = [];
  constructor(root: string, dataDir: string, db: DatabaseSync) {
    this.root = fs.realpathSync(root);
    this.dataDir = path.resolve(dataDir);
    this.db = db;
    if (
      !fs.statSync(this.root).isDirectory() ||
      !fs.existsSync(path.join(root, ".obsidian"))
    )
      throw new AppError("请选择包含 .obsidian 文件夹的知识库");
    fs.mkdirSync(dataDir, { recursive: true });
    if (inside(this.root, fs.realpathSync(dataDir)))
      throw new AppError("应用索引必须保存在知识库之外");
    for (const dir of ["Inbox", "Cards", "Journal", "Drafts", "Assets"])
      fs.mkdirSync(safePath(this.root, `${MANAGED}/${dir}`), {
        recursive: true,
      });
  }
  absolute(relative: string) {
    return safePath(this.root, relative);
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
        : relative.startsWith(`${MANAGED}/`)
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
    this.db.prepare("DELETE FROM notes_fts WHERE path=?").run(relative);
    if (!relative.startsWith(`${MANAGED}/Drafts/`))
      this.db
        .prepare("INSERT INTO notes_fts(path,title,body,tags) VALUES(?,?,?,?)")
        .run(
          relative,
          n.title,
          n.owner === "paperdesk" ? n.body || "" : n.content,
          n.tags.join(" "),
        );
    this.db.prepare("DELETE FROM relations WHERE from_path=?").run(relative);
    for (const target of links(n.body || ""))
      this.db
        .prepare("INSERT OR IGNORE INTO relations VALUES(?,?,?)")
        .run(relative, target, "related");
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
  scan() {
    this.warnings = [];
    const seen = new Set<string>();
    let complete = true;
    let ignore = ["_meta/"];
    try {
      const config = JSON.parse(
        readUtf8(path.join(this.root, ".obsidian", "app.json")),
      );
      ignore = [
        ...ignore,
        ...(config.userIgnoreFilters || []).filter(
          (v: unknown) => typeof v === "string",
        ),
      ];
    } catch {}
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
        try {
          const content = readUtf8(file);
          const old = this.db
            .prepare("SELECT hash FROM notes WHERE path=?")
            .get(relative) as Row | undefined;
          if (!old || old.hash !== digest(content)) this.index(relative);
          else
            this.db
              .prepare("UPDATE notes SET missing=0 WHERE path=?")
              .run(relative);
        } catch {
          complete = false;
          this.warnings.push(`文件暂不可读，保留旧索引：${relative}`);
        }
      }
    };
    walk(this.root);
    if (complete)
      for (const row of this.db
        .prepare("SELECT path FROM notes")
        .all() as Row[])
        if (!seen.has(row.path))
          this.db
            .prepare("UPDATE notes SET missing=1 WHERE path=?")
            .run(row.path);
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
            note.path.startsWith(`${MANAGED}/`) &&
            !note.path.includes("/Drafts/") &&
            !note.path.includes("/Inbox/")),
      );
    // Apply the workspace boundary before ranking/limiting, so unrelated notes
    // cannot crowd managed notes out of the first 100 search results.
    const scopeFilter =
      scope === "workbench"
        ? " AND n.path GLOB ? AND n.path NOT GLOB ? AND n.path NOT GLOB ?"
        : "";
    const scopeArgs =
      scope === "workbench" ? [`${MANAGED}/*`, "*/Drafts/*", "*/Inbox/*"] : [];
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
  create(title: string, noteType = "concept", content?: string) {
    const id = randomUUID(),
      folder = noteType === "learning-log" ? "Journal" : "Cards";
    const relative = `${MANAGED}/${folder}/${slug(title)}--${id.slice(0, 8)}.md`;
    const body =
      content ||
      `# ${title}\n\n${noteType === "learning-log" ? "## 本次问题\n\n\n## 过程与观察\n\n\n## 当前判断\n\n\n## 下一步与连接" : "## 核心问题与结论\n\n\n## 机制、模型或推导\n\n\n## 例子与边界\n\n\n## 尚未解决\n\n\n## 来源与连接"}\n\n`;
    atomicWrite(
      this.absolute(relative),
      formatMarkdown(
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
      ),
      true,
    );
    return this.index(relative);
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
      paths = all.map((n) => n.path);
    const updates = all
      .map((n) => this.read(n.path))
      .filter((n) => n.owner !== "paperdesk")
      .map((n) => ({
        ...n,
        next: rewriteLinks(n.content, from, to, n.path, paths),
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
      this.db.prepare("DELETE FROM notes_fts WHERE path=?").run(from);
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
