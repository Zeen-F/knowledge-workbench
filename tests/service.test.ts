import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startService } from "../server/app.ts";
import { callProvider } from "../server/provider.ts";

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-api-")),
    vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  const publicDir = path.join(root, ".hidden-runtime", "dist");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    "<title>Packaged workbench</title>",
  );
  const service = await startService({
    distDir: publicDir,
    vaultDir,
    dataDir: path.join(root, "profile"),
    encrypt: async (v) => "test-encrypted:" + v,
    decrypt: async (v) => v.slice("test-encrypted:".length),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (
    route: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(service.baseUrl + "/api" + route, {
      method,
      headers: {
        Authorization: "Bearer " + service.token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { root, service, request };
}

test("HTTP requires session, validates origin and persists appearance preference", async (t) => {
  const { service, request } = await fixture(t);
  const page = await fetch(service.baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Packaged workbench/);
  assert.equal((await fetch(service.baseUrl + "/api/notes")).status, 401);
  assert.equal(
    (
      await request("/notes", "GET", undefined, {
        Origin: "https://unrelated.invalid",
      })
    ).status,
    403,
  );
  assert.equal((await request("/note?path=../escape.md")).status, 400);
  assert.equal(
    (await request("/settings/appearance", "PUT", { theme: "night" })).status,
    200,
  );
  assert.equal((await (await request("/status")).json()).theme, "night");
  assert.equal(
    (await request("/settings/appearance", "PUT", { theme: "invalid" })).status,
    400,
  );
});
test("MCP sharing is scoped and paused batch rejects reads and writes", async (t) => {
  const { service, request } = await fixture(t);
  const c = service.captures!.add({ title: "材料", text: "未验证的想法" }),
    j = service.processing!.create([c.id], [], "codex", "限定范围");
  assert.equal((await request("/mcp/batches/" + j.id)).status, 200);
  assert.equal(
    (await request(`/mcp/batches/${j.id}/images/${randomUUID()}`)).status,
    403,
  );
  service.processing!.cancel(j.id);
  assert.equal((await request("/mcp/batches/" + j.id)).status, 403);
  assert.equal(
    (
      await request(`/mcp/batches/${j.id}/proposals`, "POST", {
        requestId: "paused",
        inputHash: j.snapshot.inputHash,
        proposal: {
          title: "test",
          action: "create",
          markdown: "# test",
          sourceIds: [c.id],
        },
      })
    ).status,
    403,
  );
});
test("provider configuration never returns plaintext; direct calls implement both protocols", async (t) => {
  const { request } = await fixture(t);
  assert.equal(
    (
      await request("/settings/provider", "PUT", {
        baseUrl: "https://example.invalid/v1",
        model: "test",
        protocol: "responses",
        apiKey: "synthetic-secret",
      })
    ).status,
    200,
  );
  const cfg = await (await request("/settings")).json();
  assert.equal(cfg.provider.hasKey, true);
  assert.equal(JSON.stringify(cfg).includes("synthetic-secret"), false);
  const bodies: any[] = [];
  const mock = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push({ url: req.url, body: parsed });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.endsWith("/responses")
          ? {
              output: [
                { content: [{ type: "output_text", text: "测试识读" }] },
              ],
            }
          : { choices: [{ message: { content: "测试识读" } }] },
      ),
    );
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(() => new Promise<void>((r) => mock.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(mock.address() as any).port}/v1`;
  for (const protocol of ["responses", "chat-completions"] as const)
    assert.equal(
      await callProvider(
        { baseUrl, model: "mock-vision", protocol, apiKey: "test" },
        "读取材料",
        [{ mime: "image/png", data: "synthetic" }],
      ),
      "测试识读",
    );
  assert.equal(bodies[0].body.store, false);
  assert.equal(bodies[0].body.input[0].content[1].type, "input_image");
  assert.equal(bodies[1].body.messages[1].content[1].type, "image_url");
});
test("failed API summary retries without repeating completed extraction", async (t) => {
  const { service, request } = await fixture(t);
  const capture = service.captures!.add({ title: "输入", text: "原始资料" });
  let extraction = 0,
    summary = 0;
  const mock = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      text = body.input[0].content[0].text;
    res.setHeader("Content-Type", "application/json");
    if (text.startsWith("逐项整理")) {
      extraction++;
      res.end(
        JSON.stringify({ output_text: "【原文】测试文字；【待核对】符号" }),
      );
    } else {
      summary++;
      res.end(
        JSON.stringify({
          output_text:
            summary === 1
              ? "invalid JSON"
              : JSON.stringify({
                  drafts: [
                    {
                      title: "归纳",
                      action: "create",
                      markdown: "# 归纳\n仍需核对",
                      sourceIds: [capture.id],
                      unresolved: ["符号"],
                    },
                  ],
                }),
        }),
      );
    }
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(() => new Promise<void>((r) => mock.close(() => r())));
  await request("/settings/provider", "PUT", {
    baseUrl: `http://127.0.0.1:${(mock.address() as any).port}`,
    model: "mock",
    protocol: "responses",
    apiKey: "test",
  });
  const j = service.processing!.create([capture.id], [], "api", "");
  await service.processing!.run(j.id);
  const wait = async () => {
    for (let i = 0; i < 200 && service.processing!.running.has(j.id); i++)
      await new Promise((r) => setTimeout(r, 20));
  };
  await wait();
  assert.equal(service.processing!.get(j.id).state, "failed");
  await service.processing!.run(j.id);
  await wait();
  assert.equal(service.processing!.get(j.id).state, "review");
  assert.equal(extraction, 1);
  assert.equal(summary, 2);
  assert.equal(service.processing!.proposals().length, 1);
});
