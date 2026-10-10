import fs from "node:fs";
import { AppError } from "./files.ts";
import { relativePathSchema, type SourceRef } from "../shared/contracts.ts";
import type { Vault } from "./vault.ts";

export class Paperdesk {
  constructor(public vault: Vault) {}
  profile() {
    const r = this.vault.db
      .prepare("SELECT value FROM settings WHERE key='paperdesk'")
      .get() as any;
    return r ? JSON.parse(r.value) : null;
  }
  samePath(left: string, right: string) {
    const normalize = (value: string) => {
      const real = fs.realpathSync.native(value);
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return normalize(left) === normalize(right);
  }
  async storage(base: string) {
    const storage = await this.request(
      base,
      "/api/integrations/knowledge/status",
    ).catch((e) => {
      if (e instanceof AppError && e.status === 404)
        throw new AppError(
          "此纸间版本尚未提供知识库联动，请更新并重新启动纸间",
          409,
        );
      throw e;
    });
    if (
      storage.schema !== "paperdesk-knowledge/v1" ||
      typeof storage.vaultPath !== "string"
    )
      throw new AppError("请更新纸间以启用知识工作台联动", 409);
    if (!this.samePath(storage.vaultPath, this.vault.root))
      throw new AppError(
        "纸间与工作台连接了不同的知识库，请选择同一个库",
        409,
        "PAPERDESK_VAULT_MISMATCH",
      );
    relativePathSchema.parse(storage.subdir);
    return storage;
  }
  async bind(baseUrl: string) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new AppError("纸间地址必须是本机 HTTP 地址");
    const status = await this.request(url.origin, "/api/plugin/status");
    if (status.service !== "paperdesk" || status.apiVersion !== 1)
      throw new AppError("地址上的服务不是兼容的纸间");
    const storage = await this.storage(url.origin);
    const profile = {
      baseUrl: url.origin,
      libraryId: status.libraryId,
      subdir: storage.subdir,
    };
    this.vault.db
      .prepare(
        "INSERT INTO settings VALUES('paperdesk',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(profile));
    return profile;
  }
  async request(base: string, route: string, options: RequestInit = {}) {
    try {
      const r = await fetch(base + route, {
        ...options,
        headers: { "Content-Type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (!r.ok)
        throw new AppError(
          data.error || "纸间操作失败",
          r.status,
          data.code || "PAPERDESK_ERROR",
        );
      return data;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        "纸间服务未连接，草稿已保留。请启动已绑定的纸间。",
        409,
        "PAPERDESK_OFFLINE",
      );
    }
  }
  async verify() {
    const p = this.profile();
    if (!p) throw new AppError("请在设置中连接纸间", 409, "PAPERDESK_OFFLINE");
    const s = await this.request(p.baseUrl, "/api/plugin/status");
    if (
      s.service !== "paperdesk" ||
      s.apiVersion !== 1 ||
      s.libraryId !== p.libraryId
    )
      throw new AppError("纸间资料库与绑定记录不一致", 409);
    const storage = await this.storage(p.baseUrl);
    if (storage.subdir !== p.subdir)
      throw new AppError("纸间资料目录已变化，请重新连接", 409);
    return p;
  }
  async save(relative: string, content: string, expected: string) {
    this.vault.keepDraft(relative, content, expected);
    const note = this.vault.read(relative);
    if (note.hash !== expected)
      throw new AppError(
        "纸间笔记文件已变化，请重新核对",
        409,
        "VERSION_CONFLICT",
      );
    if (!note.paperdeskId || !/^[a-f0-9-]{36}$/i.test(note.paperdeskId))
      throw new AppError("此纸间管理文件不能编辑正文");
    const p = await this.verify();
    const uri = await this.request(
      p.baseUrl,
      `/api/documents/${note.paperdeskId}/vault-note`,
    );
    const actual = new URL(uri.uri).searchParams.get("path");
    if (!actual || !this.samePath(actual, this.vault.absolute(relative)))
      throw new AppError("纸间打开的是另一个知识库，已停止保存", 409);
    const result = await this.request(
      p.baseUrl,
      `/api/documents/${note.paperdeskId}`,
    );
    const doc = result.document || result;
    if (this.vault.read(relative).hash !== expected)
      throw new AppError(
        "纸间读取期间文件发生变化，请核对后重试",
        409,
        "VERSION_CONFLICT",
      );
    if (typeof doc.notesRevision !== "string" || !doc.notesRevision)
      throw new AppError("纸间未提供正文版本，已停止保存", 409);
    this.vault.backup(relative, note.content, "paperdesk");
    await this.request(p.baseUrl, `/api/documents/${note.paperdeskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        notesZh: content,
        notesEn: "",
        expectedNotesRevision: doc.notesRevision,
      }),
    });
    const saved = this.vault.index(relative);
    this.vault.clearDraft(relative, content);
    return saved;
  }
  async sourceUrl(ref: SourceRef) {
    const source = ref.paperdesk;
    if (!source) throw new AppError("这份材料没有纸间来源");
    const p = await this.verify();
    const current = await this.request(
      p.baseUrl,
      `/api/integrations/knowledge/source/${encodeURIComponent(source.documentId)}`,
    );
    if (
      current.documentId !== source.documentId ||
      current.pdfSha256 !== source.pdfSha256 ||
      !Number.isSafeInteger(current.pageCount) ||
      source.page > current.pageCount
    )
      throw new AppError(
        "原 PDF 身份或页码已变化，请核对保存的材料",
        409,
        "SOURCE_CHANGED",
      );
    return `${p.baseUrl}/?document=${encodeURIComponent(source.documentId)}&page=${source.page}`;
  }
}
