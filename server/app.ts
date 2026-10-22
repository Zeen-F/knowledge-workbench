import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  API_VERSION,
  PRODUCT,
  providerSchema,
  relativePathSchema,
  hashSchema,
} from "../shared/contracts.ts";
import {
  AppError,
  atomicWrite,
  detectImage,
  digest,
  decodeBase64,
} from "./files.ts";
import { openDatabase } from "./database.ts";
import { Vault } from "./vault.ts";
import { resolveVaultSelection } from "../desktop/vault-selection.mjs";
import { Captures } from "./capture.ts";
import { Processing } from "./processing.ts";
import { Paperdesk } from "./paperdesk.ts";
import { callProvider, validateProvider } from "./provider.ts";
import { paperdeskBody } from "./markdown.ts";
import { relatedNotes } from "./relations.ts";
import { RecoveryStore } from "./recovery.ts";
import {
  GENERAL_PROFILE,
  researchSelectionSchema,
} from "../shared/research-profiles.ts";
import {
  SERVICE_FEATURES,
  recoveryIdentitySchema,
  recoveryRecordSchema,
} from "../shared/recovery.ts";

export type ServiceOptions = {
  vaultDir?: string;
  dataDir: string;
  distDir?: string;
  port?: number;
  token?: string;
  dev?: boolean;
  secureStorage?: boolean;
  encrypt?: (value: string) => Promise<string>;
  decrypt?: (value: string) => Promise<string>;
  desktop?: (action: string) => Promise<any>;
};
export async function startService(options: ServiceOptions) {
  // Reject invalid selections before opening a database or starting a service.
  if (options.vaultDir) resolveVaultSelection(options.vaultDir);
  const token = options.token || randomBytes(32).toString("hex"),
    vaultId = options.vaultDir
      ? digest(fs.realpathSync(options.vaultDir))
      : null;
  const dataDir = path.join(options.dataDir, "vaults", vaultId || "unbound");
  const db = options.vaultDir ? openDatabase(dataDir) : null;
  const vault =
    options.vaultDir && db ? new Vault(options.vaultDir, dataDir, db) : null;
  const captures = vault ? new Captures(vault) : null,
    paperdesk = vault ? new Paperdesk(vault) : null;
  const recovery = vault
    ? new RecoveryStore(path.join(dataDir, "ui-recovery"))
    : null;
  const getProvider = async () => {
    const row = db
      ?.prepare("SELECT value FROM settings WHERE key='provider'")
      .get() as any;
    if (!row)
      throw new AppError(
        "请先在设置中配置模型接口",
        400,
        "PROVIDER_NOT_CONFIGURED",
      );
    const config = JSON.parse(row.value);
    if (!options.decrypt)
      throw new AppError("此运行方式不能解密密钥，请使用桌面应用");
    return { ...config, apiKey: await options.decrypt(config.secret) };
  };
  const processing =
    vault && captures ? new Processing(vault, captures, getProvider) : null;
  const recoveryIssues = vault?.recoverMoves() || [];
  if (vault) {
    vault.scan();
    captures!.importPaperdesk();
    processing!.rebuildProposals();
  }
  const app = express();
  app.disable("x-powered-by");
  const authorized = (candidate: string | undefined) => {
    if (!candidate) return false;
    const a = Buffer.from(candidate),
      b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  app.use((req, res, next) => {
    if (
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(
        req.headers.host || "",
      )
    )
      return res.status(403).json({ error: "仅允许本机访问" });
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      !(options.dev && origin === "http://127.0.0.1:5186")
    )
      return res.status(403).json({ error: "请求来源不匹配" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!options.dev)
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'",
      );
    next();
  });
  app.get("/api/session", (_req, res) => {
    res.cookie("kwb_session", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("kwb_session="))
      ?.slice(12);
    if (!authorized(bearer) && !authorized(cookie))
      return res
        .status(401)
        .json({ error: "应用连接已失效，请重新打开", code: "SESSION_EXPIRED" });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "30mb" }));
  app.get("/api/status", (_req, res) =>
    res.json({
      service: PRODUCT,
      apiVersion: API_VERSION,
      features: SERVICE_FEATURES,
      desktop: Boolean(options.desktop),
      capabilities: {
        capture: Boolean(options.desktop),
        captureTrash: true,
        chooseVault: Boolean(options.desktop),
        plugin: Boolean(options.desktop),
        secureCredentials:
          options.secureStorage !== false &&
          Boolean(options.encrypt && options.decrypt),
      },
      theme: JSON.parse(
        String(
          (
            db
              ?.prepare("SELECT value FROM settings WHERE key='theme'")
              .get() as any
          )?.value || '"forest"',
        ),
      ),
      vault: vault
        ? {
            name: path.basename(vault.scope),
            root: vault.root,
            scope: vault.scope,
            scopePath: vault.scopePath,
            id: vaultId,
          }
        : null,
      warnings: [
        ...(vault?.warnings || []),
        ...recoveryIssues.map(
          (p) => "移动恢复需要核对，本机历史副本已保留：" + p,
        ),
      ],
    }),
  );
  app.post("/api/desktop/action", async (req, res) => {
    if (!options.desktop) throw new AppError("此入口需要已启动的桌面服务");
    res.json(
      await options.desktop(
        z
          .object({ action: z.enum(["choose-vault", "capture", "plugin"]) })
          .parse(req.body).action,
      ),
    );
  });
  app.use("/api", (_req, _res, next) => {
    if (!vault) throw new AppError("请先打开知识库", 409, "NO_VAULT");
    next();
  });
  app.get("/api/recovery", (_req, res) =>
    res.json({ records: recovery!.list() }),
  );
  app.put("/api/recovery", (req, res) => {
    const b = z
      .object({
        record: recoveryRecordSchema,
        expectedHash: hashSchema.nullable(),
      })
      .parse(req.body);
    res.json(recovery!.save(b.record, b.expectedHash));
  });
  app.delete("/api/recovery", (req, res) => {
    const b = z
      .object({
        identity: recoveryIdentitySchema,
        expectedHash: hashSchema.nullable(),
      })
      .parse(req.body);
    recovery!.clear(b.identity, b.expectedHash);
    res.json({ ok: true });
  });
  const route = z.object({ path: relativePathSchema }),
    save = z.object({
      path: relativePathSchema,
      content: z.string().max(8 * 1024 * 1024),
      expectedHash: hashSchema,
    });
  const saveNote = async (relative: string, content: string, hash: string) =>
    vault!.read(relative).owner === "paperdesk"
      ? paperdesk!.save(relative, content, hash)
      : vault!.save(relative, content, hash);
  app.get("/api/notes", (req, res) => {
    const { q, scope } = z
      .object({
        q: z.string().default(""),
        scope: z.enum(["workbench", "vault"]).default("vault"),
      })
      .parse(req.query);
    res.json(vault!.search(q, scope));
  });
  app.post("/api/refresh", (_req, res) => {
    const scan = vault!.scan(),
      imports = captures!.importPaperdesk();
    processing!.rebuildProposals();
    res.json({ ...scan, imports });
  });
  app.get("/api/note", (req, res) =>
    res.json(vault!.read(route.parse(req.query).path)),
  );
  app.post("/api/notes", (req, res) => {
    const b = z
      .object({
        title: z.string().min(1).max(200),
        noteType: z.enum(["concept", "learning-log"]).default("concept"),
      })
      .parse(req.body);
    res.status(201).json(vault!.create(b.title, b.noteType));
  });
  app.put("/api/note", async (req, res) => {
    const b = save.parse(req.body);
    res.json(await saveNote(b.path, b.content, b.expectedHash));
  });
  app.put("/api/draft", (req, res) => {
    const b = save.parse(req.body);
    vault!.keepDraft(b.path, b.content, b.expectedHash);
    res.json({ saved: true });
  });
  app.delete("/api/draft", (req, res) => {
    const b = z
      .object({ path: relativePathSchema, content: z.string() })
      .parse(req.body);
    vault!.clearDraft(b.path, b.content);
    res.json({ ok: true });
  });
  app.post("/api/note/move", (req, res) => {
    const b = z
      .object({
        from: relativePathSchema,
        to: relativePathSchema,
        expectedHash: hashSchema,
        apply: z.boolean().default(false),
      })
      .parse(req.body);
    res.json(vault!.move(b.from, b.to, b.expectedHash, b.apply));
  });
  app.get("/api/history", (req, res) =>
    res.json(vault!.history(route.parse(req.query).path)),
  );
  app.post("/api/history/restore", async (req, res) => {
    const b = z
      .object({
        path: relativePathSchema,
        id: z.string().uuid(),
        expectedHash: hashSchema,
      })
      .parse(req.body);
    const h = vault!.history(b.path).find((h) => h.id === b.id);
    if (!h) throw new AppError("历史副本不存在", 404);
    res.json(
      await saveNote(
        b.path,
        vault!.read(b.path).owner === "paperdesk"
          ? parseHistoryBody(h.content)
          : h.content,
        b.expectedHash,
      ),
    );
  });
  app.get("/api/relations", (req, res) => {
    const p = route.parse(req.query).path;
    res.json(relatedNotes(vault!, p));
  });
  app.get("/api/resolve-link", (req, res) => {
    const input = z
      .object({
        path: relativePathSchema,
        target: z.string().max(8192),
        style: z.enum(["wiki", "markdown"]),
      })
      .parse(req.query);
    const resolved = vault!.resolveLink(input.target, input.path, input.style);
    const outside = Boolean(
      resolved &&
        vault!.scopePath &&
        !resolved.startsWith(vault!.scopePath + "/"),
    );
    res.json({ path: outside ? null : resolved, outside });
  });
  app.post("/api/assets", (req, res) => {
    const b = z
      .object({ data: z.string().max(28 * 1024 * 1024) })
      .parse(req.body);
    res.status(201).json(captures!.asset(decodeBase64(b.data)));
  });
  app.get("/api/assets", (req, res) => {
    const p = route.parse(req.query).path;
    if (!/\.(png|jpe?g|webp)$/i.test(p)) throw new AppError("不支持此附件类型");
    const bytes = fs.readFileSync(vault!.absolute(p));
    const { mime } = detectImage(bytes);
    res.type(mime).send(bytes);
  });
  app.get("/api/captures", (req, res) => {
    const query = z
      .object({ deleted: z.enum(["true", "false"]).optional() })
      .parse(req.query);
    res.json(captures!.list(query.deleted === "true"));
  });
  for (const action of ["trash", "restore"] as const) {
    app.post(`/api/captures/${action}`, (req, res) => {
      const { ids } = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
        .strict()
        .parse(req.body);
      res.json(captures!.setDeleted(ids, action === "trash"));
    });
  }
  app.post("/api/captures", (req, res) => {
    const b = z
      .object({
        title: z.string().min(1).max(200),
        text: z.string().max(500000).default(""),
        requestId: z.string().uuid().optional(),
        image: z
          .string()
          .max(28 * 1024 * 1024)
          .optional(),
      })
      .parse(req.body);
    res.status(201).json(captures!.add(b));
  });
  app.get("/api/jobs", (_req, res) => res.json(processing!.list()));
  const batchInputSchema = z.object({
    sourceIds: z.array(z.string().uuid()),
    referencePaths: z.array(relativePathSchema).default([]),
    executor: z.enum(["api", "codex"]),
    instruction: z.string().max(10000).default(""),
    researchSelection: researchSelectionSchema.optional(),
    expectedPreviewHash: hashSchema.optional(),
  });
  app.post("/api/jobs/preview", (req, res) => {
    const b = batchInputSchema.parse(req.body);
    res.json(
      processing!.preview(
        b.sourceIds,
        b.referencePaths,
        b.executor,
        b.instruction,
        b.researchSelection,
      ),
    );
  });
  app.post("/api/jobs", (req, res) => {
    const b = batchInputSchema.parse(req.body);
    res
      .status(201)
      .json(
        processing!.create(
          b.sourceIds,
          b.referencePaths,
          b.executor,
          b.instruction,
          b.researchSelection,
          b.expectedPreviewHash,
        ),
      );
  });
  app.post("/api/jobs/:id/run", async (req, res) =>
    res.json(await processing!.run(String(req.params.id))),
  );
  app.post("/api/jobs/:id/pause", (req, res) =>
    res.json(processing!.cancel(String(req.params.id))),
  );
  app.post("/api/jobs/:id/share", (req, res) => {
    const j = processing!.get(String(req.params.id));
    if (j.executor !== "codex") throw new AppError("此任务使用 API");
    db!
      .prepare("UPDATE jobs SET state='shared',error=NULL WHERE id=?")
      .run(j.id);
    res.json(processing!.get(j.id));
  });
  app.get("/api/proposals", (_req, res) => res.json(processing!.proposals()));
  app.put("/api/proposals/:id", (req, res) => {
    const b = z
      .object({ markdown: z.string().max(500000), expectedHash: hashSchema })
      .parse(req.body);
    res.json(
      processing!.edit(String(req.params.id), b.markdown, b.expectedHash),
    );
  });
  app.post("/api/proposals/:id/accept", async (req, res) => {
    const b = z
      .object({ markdown: z.string().max(500000), expectedHash: hashSchema })
      .parse(req.body);
    res.json(
      await processing!.accept(
        String(req.params.id),
        b.markdown,
        saveNote,
        b.expectedHash,
      ),
    );
  });
  app.post("/api/proposals/:id/rebase", (req, res) => {
    const b = z
      .object({ expectedHash: hashSchema, targetHash: hashSchema })
      .parse(req.body);
    res.json(
      processing!.rebase(String(req.params.id), b.expectedHash, b.targetHash),
    );
  });
  app.post("/api/proposals/:id/reject", (req, res) =>
    res.json(processing!.reject(String(req.params.id))),
  );
  app.get("/api/settings", (_req, res) => {
    const row = db!
      .prepare("SELECT value FROM settings WHERE key='provider'")
      .get() as any;
    const config = row ? JSON.parse(row.value) : null;
    if (config) {
      config.hasKey = Boolean(config.secret);
      delete config.secret;
    }
    res.json({
      provider: config,
      researchSelection: (() => {
        try {
          const row = db!
            .prepare("SELECT value FROM settings WHERE key='research-profile'")
            .get() as any;
          return researchSelectionSchema.parse(
            row ? JSON.parse(row.value) : GENERAL_PROFILE,
          );
        } catch {
          return GENERAL_PROFILE;
        }
      })(),
      paperdesk: paperdesk!.profile(),
      encrypted: Boolean(options.encrypt),
    });
  });
  app.put("/api/settings/provider", async (req, res) => {
    const config = validateProvider(providerSchema.parse(req.body));
    if (!options.encrypt || options.secureStorage === false)
      throw new AppError("请在桌面应用中保存密钥；浏览器开发入口不保存凭据");
    const previous = db!
      .prepare("SELECT value FROM settings WHERE key='provider'")
      .get() as any;
    const secret = config.apiKey
      ? await options.encrypt(config.apiKey)
      : previous
        ? JSON.parse(previous.value).secret
        : null;
    if (!secret) throw new AppError("请输入 API 密钥");
    const { apiKey, ...publicConfig } = config;
    db!
      .prepare(
        "INSERT INTO settings VALUES('provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify({ ...publicConfig, secret }));
    res.json({ saved: true });
  });
  app.put("/api/settings/appearance", (req, res) => {
    const b = z
      .object({ theme: z.enum(["forest", "sand", "mist", "night"]) })
      .parse(req.body);
    db!
      .prepare(
        "INSERT INTO settings VALUES('theme',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(b.theme));
    res.json(b);
  });
  app.post("/api/settings/provider/test", async (req, res) => {
    const config = validateProvider(providerSchema.parse(req.body));
    if (!config.apiKey) config.apiKey = (await getProvider()).apiKey;
    const start = Date.now();
    const output = await callProvider(config, "只回复：连接正常");
    res.json({ output, elapsedMs: Date.now() - start });
  });
  app.put("/api/settings/paperdesk", async (req, res) =>
    res.json(
      await paperdesk!.bind(
        z.object({ baseUrl: z.string().url() }).parse(req.body).baseUrl,
      ),
    ),
  );
  app.get("/api/paperdesk/source", async (req, res) => {
    const b = z
      .object({
        sourceId: z.string().uuid(),
      })
      .parse(req.query);
    res.json({
      url: await paperdesk!.sourceUrl(captures!.snapshot(b.sourceId).ref),
    });
  });
  app.get("/api/mcp/batches", (_req, res) =>
    res.json(
      processing!
        .list()
        .filter(
          (j) =>
            j.executor === "codex" && ["shared", "review"].includes(j.state),
        )
        .map((j) => ({
          id: j.id,
          createdAt: j.createdAt,
          state: j.state,
          count: j.snapshot.sources.length,
          instruction: j.snapshot.instruction,
        })),
    ),
  );
  const shared = (id: string) => {
    const job = processing!.get(id);
    if (job.executor !== "codex" || !["shared", "review"].includes(job.state))
      throw new AppError("这批材料尚未共享或已撤回", 403);
    return job;
  };
  app.get("/api/mcp/batches/:id", (req, res) =>
    res.json(shared(String(req.params.id)).snapshot),
  );
  app.get("/api/mcp/batches/:id/images/:sourceId", (req, res) => {
    const j = shared(String(req.params.id)),
      item = j.snapshot.sources.find((s) => s.id === req.params.sourceId);
    if (!item) throw new AppError("材料不在共享批次中", 403);
    const bytes = captures!.image(item.ref);
    res.json({ mimeType: item.ref.mime, data: bytes.toString("base64") });
  });
  app.post("/api/mcp/batches/:id/proposals", (req, res) => {
    const j = shared(String(req.params.id));
    const b = z
      .object({
        requestId: z.string().min(1).max(200),
        inputHash: hashSchema,
        proposal: z.unknown(),
      })
      .parse(req.body);
    res.json(processing!.submit(j.id, b.requestId, b.proposal, b.inputHash));
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  if (options.distDir) {
    app.use(express.static(options.distDir, { index: false }));
    app.get("/", (_req, res) => {
      res.cookie("kwb_session", token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      // A user profile may contain a dot-prefixed directory. Constrain the
      // lookup to the public root so Express does not classify its ancestors
      // as hidden web files (e.g. ~/.knowledge-workbench/runtime).
      res.sendFile("index.html", { root: options.distDir! });
    });
  }
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: error.issues.map((i) => i.message).join("；"),
          code: "INVALID",
        });
      const status =
        error instanceof AppError
          ? error.status
          : error.type === "entity.too.large"
            ? 413
            : 500;
      res.status(status).json({
        error:
          error instanceof AppError
            ? error.message
            : status === 413
              ? "数据超出大小限制"
              : "文件或服务操作未完成，请保留输入并检查文件可用性。",
        code: error instanceof AppError ? error.code : "IO_ERROR",
        details: error instanceof AppError ? error.details : undefined,
      });
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port || 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as any).port,
    baseUrl = `http://127.0.0.1:${port}`;
  const timer = vault
    ? setInterval(() => {
        try {
          vault.scan({ incremental: true });
          captures!.importPaperdesk();
        } catch {}
      }, 5000)
    : null;
  timer?.unref();
  return {
    app,
    server,
    baseUrl,
    token,
    vault,
    db,
    captures,
    processing,
    paperdesk,
    vaultId,
    async close() {
      if (timer) clearInterval(timer);
      for (const controller of processing?.running.values() || [])
        controller.abort();
      while (processing?.running.size)
        await new Promise((r) => setTimeout(r, 30));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db?.close();
    },
  };
}
function parseHistoryBody(content: string) {
  return paperdeskBody(content);
}
