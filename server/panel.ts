import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PANEL_RESOURCE = "ui://knowledge-workbench/panel-v1.html";
const mimeType = "text/html;profile=mcp-app";
const appOnly = {
  ui: { visibility: ["app"] },
  "openai/visibility": "private",
  "openai/widgetAccessible": true,
};
const routes: Record<string, RegExp> = {
  GET: /^\/(status|notes|note|history|relations|captures|jobs|proposals|settings|assets|paperdesk\/source)(?:\?[^#]*)?$/,
  POST: /^\/(refresh|notes|note\/move|history\/restore|assets|captures|jobs|jobs\/[a-f0-9-]+\/(run|pause|share)|proposals\/[a-f0-9-]+\/(accept|reject|rebase))$/,
  PUT: /^\/(note|draft|settings\/(paperdesk|appearance)|proposals\/[a-f0-9-]+)$/,
  DELETE: /^\/draft$/,
};

// This is a component-only bridge, never a model tool for arbitrary file access.
// Reuse the application's version checks and acceptance flow, pinning each panel
// to the vault it first opened so a desktop library switch cannot retarget edits.
export function registerPanel(
  server: McpServer,
  profileDir: string,
  htmlPath: string,
) {
  const schema = {
    route: z.string().max(8192),
    vaultId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
  };
  async function request(
    method: string,
    route: string,
    vaultId: string | null | undefined,
    body?: unknown,
  ) {
    if (!routes[method]?.test(route))
      throw new Error("此面板不支持该操作，请使用桌面应用。");
    if (vaultId === undefined && !(method === "GET" && route === "/status"))
      throw new Error("请先连接知识库");
    const runtime = JSON.parse(
      fs.readFileSync(path.join(profileDir, "runtime.json"), "utf8"),
    );
    const base = new URL(runtime.baseUrl);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.pathname !== "/" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !runtime.token
    )
      throw new Error("工作台运行配置无效");
    const fetchLocal = (target: string, verb = "GET", data?: unknown) =>
      fetch(base.origin + "/api" + target, {
        method: verb,
        headers: {
          Authorization: "Bearer " + runtime.token,
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    const statusResponse = await fetchLocal("/status");
    const status = await statusResponse.json();
    if (
      !statusResponse.ok ||
      status.service !== "knowledge-workbench" ||
      status.apiVersion !== 1 ||
      (status.vault?.id || null) !== runtime.vaultId ||
      (vaultId !== undefined && vaultId !== runtime.vaultId)
    )
      throw Object.assign(
        new Error("知识库连接已变化，请保存本地草稿后重新打开面板。"),
        { code: "VAULT_CHANGED", status: 409 },
      );
    if (route === "/status") return status;
    const response = await fetchLocal(route, method, body);
    if (method === "GET" && route.startsWith("/assets?") && response.ok) {
      const mime = response.headers.get("content-type")?.split(";")[0];
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime || ""))
        throw new Error("附件不是支持的图片");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024)
        throw new Error("图片超过 20 MiB，请在桌面查看");
      return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    }
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || "操作未完成"), {
        code: data.code,
        details: data.details,
        status: response.status,
      });
    return data;
  }
  const handler = (method: string) => async (args: any) => {
    try {
      return {
        content: [{ type: "text" as const, text: "工作台界面已更新。" }],
        structuredContent: { ok: true },
        _meta: {
          panel: {
            data: await request(
              method === "WRITE" ? args.method : method,
              args.route,
              args.vaultId,
              args.body,
            ),
          },
        },
      };
    } catch (error) {
      const e = error as any;
      // Details can contain private note versions. Keep them out of model context.
      return {
        isError: true,
        content: [
          { type: "text" as const, text: "工作台操作未完成，请查看面板提示。" },
        ],
        _meta: {
          panel: {
            error: e.message,
            code: e.code,
            details: e.details,
            status: e.status,
          },
        },
      };
    }
  };
  server.registerTool(
    "workbench_panel_read",
    {
      title: "读取工作台界面",
      description:
        "Component-only: display local notes and assets without sharing their contents with the model.",
      inputSchema: schema,
      _meta: appOnly,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler("GET"),
  );
  server.registerTool(
    "workbench_panel_write",
    {
      title: "保存工作台界面操作",
      description:
        "Component-only: user-initiated editing and draft review. Never call from the model.",
      inputSchema: {
        ...schema,
        vaultId: schema.vaultId.unwrap(),
        method: z.enum(["POST", "PUT", "DELETE"]),
        body: z.unknown().optional(),
      },
      _meta: appOnly,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler("WRITE"),
  );
  const meta = {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    },
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
    "openai/widgetDescription":
      "知识工作台：编辑笔记、收集学习材料并审核草稿。浏览内容不会自动共享给模型。",
  };
  server.registerResource(
    "knowledge_workbench_panel",
    PANEL_RESOURCE,
    { title: "知识工作台", mimeType, _meta: meta },
    async () => ({
      contents: [
        {
          uri: PANEL_RESOURCE,
          mimeType,
          text: fs.readFileSync(htmlPath, "utf8"),
          _meta: meta,
        },
      ],
    }),
  );
}
