import { AppError, atomicWrite, digest, now } from "./files.ts";
import type { Vault } from "./vault.ts";

export class Paperdesk {
  constructor(public vault: Vault) {}
  profile() {
    const r = this.vault.db
      .prepare("SELECT value FROM settings WHERE key='paperdesk'")
      .get() as any;
    return r ? JSON.parse(r.value) : null;
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
    const storage = await this.request(url.origin, "/api/storage");
    if (storage.mode !== "vault")
      throw new AppError("纸间需要连接同一个 Obsidian 库");
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
    if (
      !actual ||
      digest(actual.replaceAll("\\", "/").toLowerCase()) !==
        digest(
          this.vault.absolute(relative).replaceAll("\\", "/").toLowerCase(),
        )
    )
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
  async sourceUrl(documentId: string, page: number) {
    const p = await this.verify();
    return `${p.baseUrl}/?document=${encodeURIComponent(documentId)}&page=${page}`;
  }
}
