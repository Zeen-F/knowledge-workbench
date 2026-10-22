import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  sourceRefSchema,
  transferSchema,
  type Capture,
  type SourceRef,
} from "../shared/contracts.ts";
import {
  AppError,
  atomicWrite,
  decodeBase64,
  detectImage,
  digest,
  now,
  readUtf8,
  safePath,
  slug,
} from "./files.ts";
import { formatMarkdown } from "./markdown.ts";
import type { Vault } from "./vault.ts";

export class Captures {
  constructor(public vault: Vault) {}
  task(id: string) {
    if (id === "history")
      return { id, name: "未分类 / 历史收集", ended: false };
    const row = this.vault.db
      .prepare("SELECT * FROM collection_tasks WHERE id=?")
      .get(id) as any;
    if (!row) throw new AppError("收集任务不存在", 404);
    return {
      id: row.id,
      name: row.name,
      ended: Boolean(row.ended),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  tasks() {
    return (
      this.vault.db
        .prepare(
          "SELECT id FROM collection_tasks ORDER BY updated_at DESC,rowid DESC",
        )
        .all() as any[]
    ).map(({ id }) => ({
      ...this.task(id),
      count: this.list(false, id).length,
    }));
  }
  createTask(name: string) {
    name = name.trim();
    if (!name || name.length > 100)
      throw new AppError("请输入 1 至 100 字的任务名称");
    const id = randomUUID(),
      time = now();
    this.vault.db
      .prepare("INSERT INTO collection_tasks VALUES(?,?,?,?,0)")
      .run(id, name, time, time);
    return this.task(id);
  }
  setTaskEnded(id: string, ended: boolean) {
    this.task(id);
    if (id === "history") return this.task(id);
    this.vault.db
      .prepare("UPDATE collection_tasks SET ended=?,updated_at=? WHERE id=?")
      .run(ended ? 1 : 0, now(), id);
    return this.task(id);
  }
  assertScope(ids: string[], taskId = "history") {
    this.task(taskId);
    for (const id of ids)
      if ((this.get(id).ref.taskId || "history") !== taskId)
        throw new AppError("材料不属于当前收集任务，请重新选择", 409);
  }

  asset(bytes: Buffer) {
    const { mime, ext } = detectImage(bytes),
      hash = digest(bytes),
      relative = `${this.vault.managed}/Assets/${hash}.${ext}`,
      file = this.vault.absolute(relative);
    if (fs.existsSync(file)) {
      if (digest(fs.readFileSync(file)) !== hash)
        throw new AppError("已有附件与校验值不一致，请核对文件", 409);
    } else atomicWrite(file, bytes, true);
    this.vault.db
      .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)")
      .run(hash, relative, mime, bytes.length);
    return { assetPath: relative, sha256: hash, mime };
  }
  add({
    title,
    text = "",
    image,
    ref: supplied,
    requestId,
    taskId = "history",
  }: {
    title: string;
    text?: string;
    image?: string;
    ref?: Partial<SourceRef>;
    requestId?: string;
    taskId?: string;
  }) {
    if (this.task(taskId).ended) throw new AppError("请先继续该收集任务", 409);
    const id = requestId || supplied?.id || randomUUID();
    const requestHash = digest(
      JSON.stringify({
        title,
        text,
        image,
        ...(taskId !== "history" ? { taskId } : {}),
      }),
    );
    const requestFile = path.join(
      this.vault.dataDir,
      "capture-requests",
      id + ".json",
    );
    let capturedAt = now();
    if (requestId && fs.existsSync(requestFile)) {
      const receipt = JSON.parse(readUtf8(requestFile));
      if (receipt.hash !== requestHash)
        throw new AppError("想法保存标识已用于其他内容", 409);
      capturedAt = receipt.capturedAt;
    } else if (requestId)
      atomicWrite(
        requestFile,
        JSON.stringify({ hash: requestHash, capturedAt }),
      );
    if (supplied?.transferId) {
      const existing = this.vault.db
        .prepare("SELECT * FROM sources WHERE transfer_id=?")
        .get(supplied.transferId) as any;
      if (existing) return this.get(existing.id);
    }
    const asset = image ? this.asset(decodeBase64(image)) : {};
    const ref = sourceRefSchema.parse({
      schema: "source-ref/v1",
      id,
      kind: image ? "image" : "text",
      capturedAt,
      title,
      ...supplied,
      ...asset,
      ...(taskId !== "history" ? { taskId } : {}),
    });
    const relative = `${this.vault.managed}/Inbox/${ref.capturedAt.slice(0, 10)}--${slug(title)}--${id.slice(0, 8)}.md`;
    if (requestId && fs.existsSync(this.vault.absolute(relative))) {
      const existing = this.vault.read(relative);
      if (existing.metadata.kb_capture_request !== requestHash)
        throw new AppError("已有材料与保存请求不同，请核对", 409);
      this.vault.index(relative);
      return this.get(id);
    }
    const body = `# ${title}\n\n${ref.assetPath ? `![[${ref.assetPath}]]\n\n` : ""}${ref.paperdesk ? `## 来源\n\n${ref.paperdesk.title} · PDF 第 ${ref.paperdesk.page} 页\n\n${ref.paperdesk.quote ? "> " + ref.paperdesk.quote.replaceAll("\n", "\n> ") + "\n\n" : ""}` : ""}## 我当时的想法\n\n${text}\n`;
    atomicWrite(
      this.vault.absolute(relative),
      formatMarkdown(
        {
          title,
          note_type: "source-note",
          domain: "shared",
          status: "working",
          source: [],
          tags: [],
          kb_id: id,
          kb_source: ref,
          ...(requestId ? { kb_capture_request: requestHash } : {}),
        },
        body,
      ),
      true,
    );
    this.vault.index(relative);
    return this.get(id);
  }
  get(id: string): Capture {
    const row = this.vault.db
      .prepare("SELECT * FROM sources WHERE id=?")
      .get(id) as any;
    if (!row) throw new AppError("材料不存在", 404);
    return {
      id: row.id,
      path: row.path,
      ref: JSON.parse(row.ref),
      text: row.text,
    };
  }
  isDeleted(id: string) {
    return Boolean(
      this.vault.db
        .prepare("SELECT 1 FROM capture_trash WHERE source_id=?")
        .get(id),
    );
  }
  setDeleted(ids: string[], deleted: boolean, taskId = "history") {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 100)
      throw new AppError("每次请选择 1 至 100 份材料");
    // A local inbox tombstone never removes source Markdown, shared assets,
    // or snapshots already referenced by jobs and generated notes.
    this.vault.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertScope(unique, taskId);
      const statement = this.vault.db.prepare(
        deleted
          ? "INSERT OR IGNORE INTO capture_trash(source_id,deleted_at) VALUES(?,?)"
          : "DELETE FROM capture_trash WHERE source_id=?",
      );
      for (const id of unique)
        deleted ? statement.run(id, now()) : statement.run(id);
      this.vault.db.exec("COMMIT");
    } catch (error) {
      this.vault.db.exec("ROLLBACK");
      throw error;
    }
    return { ids: unique, deleted };
  }
  list(deleted = false, taskId?: string) {
    if (taskId) this.task(taskId);
    return (
      this.vault.db
        .prepare(
          `SELECT id FROM sources WHERE ${deleted ? "" : "NOT "}EXISTS (SELECT 1 FROM capture_trash WHERE source_id=sources.id) ORDER BY rowid DESC`,
        )
        .all() as any[]
    )
      .map((r) => this.get(r.id))
      .filter((c) => !taskId || (c.ref.taskId || "history") === taskId);
  }
  snapshot(id: string) {
    const before = this.get(id),
      note = this.vault.index(before.path),
      current = this.get(id);
    if ((note.metadata.kb_source as any)?.id !== id)
      throw new AppError("材料身份已变化，请重新选择", 409);
    return { ...current, version: note.hash };
  }
  image(ref: SourceRef) {
    if (!ref.assetPath || !ref.sha256)
      throw new AppError("这份材料没有图片", 404);
    const bytes = fs.readFileSync(this.vault.absolute(ref.assetPath));
    if (digest(bytes) !== ref.sha256)
      throw new AppError(
        "原图已发生变化，请重新选择材料",
        409,
        "SOURCE_CHANGED",
      );
    return bytes;
  }
  importPaperdesk() {
    const row = this.vault.db
      .prepare("SELECT value FROM settings WHERE key='paperdesk'")
      .get() as any;
    const subdir = row
        ? JSON.parse(row.value).subdir || "Paperdesk"
        : "Paperdesk",
      base = `${subdir}/Exports`;
    // The existing Paperdesk exchange remains in the parent vault; only its
    // validated export packages are read here. Imported content stays in scope.
    const root = safePath(this.vault.root, base);
    if (!fs.existsSync(root)) return { imported: 0, pending: [] as string[] };
    let imported = 0;
    const pending: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith(".")
      )
        continue;
      try {
        const manifestPath = safePath(
          this.vault.root,
          `${base}/${entry.name}/manifest.json`,
        );
        if (!fs.existsSync(manifestPath)) {
          pending.push(entry.name);
          continue;
        }
        const manifest = transferSchema.parse(
          JSON.parse(readUtf8(manifestPath)),
        );
        if (manifest.id !== entry.name)
          throw new Error("交换包标识与目录不一致");
        if (
          this.vault.db
            .prepare("SELECT id FROM sources WHERE transfer_id=?")
            .get(manifest.id)
        )
          continue;
        let image: string | undefined;
        if (manifest.image) {
          const file = safePath(
              this.vault.root,
              `${base}/${entry.name}/${manifest.image.file}`,
            ),
            bytes = fs.readFileSync(file);
          if (digest(bytes) !== manifest.image.sha256)
            throw new Error("附件尚未完整同步");
          image = bytes.toString("base64");
        }
        this.add({
          title: manifest.source.title + ` · 第 ${manifest.source.page} 页`,
          text: manifest.comment,
          image,
          ref: {
            kind: "paperdesk",
            capturedAt: manifest.createdAt,
            paperdesk: manifest.source,
            transferId: manifest.id,
          },
        });
        imported++;
      } catch {
        pending.push(entry.name);
      }
    }
    return { imported, pending };
  }
}
