import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startService } from "../server/app.ts";
import { seed } from "./seed.mjs";
import { removeTestDirectory } from "./test-cleanup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-native-panel-"));
const vault = path.join(root, "中文 测试库");
seed(vault);
const service = await startService({
  vaultDir: vault,
  dataDir: root,
  desktop: async () => {
    throw new Error("Panel must not invoke desktop actions");
  },
  secureStorage: true,
  encrypt: async (s) => s,
  decrypt: async (s) => s,
});
fs.writeFileSync(
  path.join(root, "runtime.json"),
  JSON.stringify({
    baseUrl: service.baseUrl,
    token: service.token,
    vaultId: service.vaultId,
  }),
);
const client = new Client({ name: "native-panel-test", version: "1" });
let browser;
const evidence = path.resolve("output/playwright/native-panel");
fs.mkdirSync(evidence, { recursive: true });
const errors = [],
  requests = [],
  messages = [];
let dropCaptureAck = false,
  failRecovery = false,
  failReviewSave = false;
let holdCapture = false,
  releaseCapture;
const staleReplies = [];
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["plugins/knowledge-workbench/dist/mcp.cjs"],
      env: { ...process.env, KWB_PROFILE: root },
      stderr: "pipe",
    }),
  );
  const tools = (await client.listTools()).tools;
  const opener = tools.find((t) => t.name === "workbench_open");
  assert.equal(opener.title, "打开知识工作台");
  const resource = await client.readResource({
    uri: opener._meta.ui.resourceUri,
  });
  const html = resource.contents[0].text;
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  const material = service.captures.add({
    title: "原图与想法",
    text: "合成材料，只用于面板验收。",
    image: "data:image/png;base64," + image.toString("base64"),
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.KWB_TEST_BROWSER
      ? { channel: process.env.KWB_TEST_BROWSER }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 850 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("hostRequest", async (message) => {
    if (message.method === "test/stale-reply")
      return new Promise((resolve, reject) => {
        staleReplies.push(() =>
          message.params.fail
            ? reject(new Error("synthetic stale failure"))
            : resolve({ stale: true }),
        );
      });
    if (message.method === "ui/initialize")
      return {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "test-host", version: "1" },
        hostCapabilities: {
          serverTools: {},
          openLinks: {},
          message: { text: {} },
        },
        hostContext: {
          theme: "light",
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen"],
        },
      };
    if (message.method === "tools/call") {
      const args = message.params.arguments;
      if (
        (failRecovery && args.route === "/recovery" && args.method === "PUT") ||
        (failReviewSave &&
          args.route?.startsWith("/proposals/") &&
          args.method === "PUT")
      )
        throw new Error("synthetic offline");
      const result = await client.callTool(message.params);
      // No local note content in public tool output, including error details.
      if (message.params.name.startsWith("workbench_panel_")) {
        assert.ok(
          !JSON.stringify({
            content: result.content,
            structuredContent: result.structuredContent,
          }).match(/合成材料|面板恢复想法|断线恢复想法/),
        );
      }
      if (args.route === "/captures" && args.method === "POST") {
        if (dropCaptureAck) {
          dropCaptureAck = false;
          throw new Error("synthetic lost receipt");
        }
        if (holdCapture)
          await new Promise((r) => {
            releaseCapture = r;
          });
      }
      return result;
    }
    if (message.method === "ui/message") {
      messages.push(message.params);
      return {};
    }
    if (message.method === "ui/open-link") return {};
    throw new Error("Unsupported test host request: " + message.method);
  });
  await page.route("http://127.0.0.1:59999/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><iframe id="panel" sandbox="allow-scripts" style="width:100%;height:100vh;border:0"></iframe></body></html>',
    }),
  );
  await page.goto("http://127.0.0.1:59999/");
  await page.evaluate(() => {
    window.panelGeneration = 0;
    window.discardedReplies = 0;
    window.addEventListener("message", async (event) => {
      const source = event.source;
      if (!source || source !== document.querySelector("iframe").contentWindow)
        return;
      const generation = window.panelGeneration;
      const m = event.data;
      if (!m.method || m.id === undefined) return;
      let reply;
      try {
        const result = await window.hostRequest(m);
        reply = { jsonrpc: "2.0", id: m.id, result };
      } catch (e) {
        reply = {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32603, message: e.message },
        };
      }
      // A reload can invalidate event.source while the real MCP call is pending.
      // Never route that document's replies into the replacement panel.
      if (
        generation !== window.panelGeneration ||
        source !== document.querySelector("iframe").contentWindow
      ) {
        window.discardedReplies++;
        return;
      }
      source.postMessage(reply, "*");
    });
  });
  page.on("request", (r) => {
    if (!/^(blob:|data:)/.test(r.url())) requests.push(r.url());
  });
  const load = () =>
    page.evaluate((html) => {
      window.panelGeneration++;
      document.querySelector("iframe").srcdoc = html.replace(
        "<head>",
        "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'\">",
      );
    }, html);
  await load();
  const frame = page.frameLocator("#panel");
  const teardown = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const child = document.querySelector("iframe").contentWindow;
          const timer = setTimeout(() => {
            window.removeEventListener("message", receive);
            reject(new Error("teardown timeout"));
          }, 10000);
          function receive(event) {
            if (event.source !== child || event.data?.id !== "test-teardown")
              return;
            clearTimeout(timer);
            window.removeEventListener("message", receive);
            event.data.error
              ? reject(new Error(event.data.error.message))
              : resolve();
          }
          window.addEventListener("message", receive);
          child.postMessage(
            {
              jsonrpc: "2.0",
              id: "test-teardown",
              method: "ui/resource-teardown",
              params: {},
            },
            "*",
          );
        }),
    );
  await frame
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(frame.locator(".katex-display")).toBeVisible();
  const editor = frame.getByLabel("笔记编辑器");
  await editor.click();
  await editor.press("Control+End");
  await editor.press("Enter");
  await page.keyboard.insertText("原生面板中文保存验证");
  await editor.press("Control+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"))
    .toContain("原生面板中文保存验证");
  await page.screenshot({ path: path.join(evidence, "editor.png") });
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    frame.getByText("Codex 原生面板已连接。", { exact: false }),
  ).toBeVisible();
  await expect(
    frame.getByPlaceholder("输入密钥，仅在本机加密保存"),
  ).toHaveCount(0);
  await frame.getByRole("button", { name: "夜读", exact: true }).click();
  await frame.getByRole("button", { name: "完成", exact: true }).click();
  await frame
    .getByRole("button", { name: /^收集箱/ })
    .first()
    .click();
  await expect(frame.locator(".capture-card img")).toBeVisible();
  await expect(frame.getByRole("button", { name: /框选截图/ })).toBeDisabled();
  await expect(frame.locator(".vault-switch")).toBeDisabled();
  const thought = frame.getByLabel("快速记录想法");
  const inbox = () =>
    frame
      .getByRole("button", { name: /^收集箱/ })
      .first()
      .click();
  await thought.fill("面板恢复想法");
  await expect(
    frame.getByText("已保留本机恢复草稿，尚未写入知识库", { exact: true }),
  ).toBeVisible();
  const discardedBefore = await page.evaluate(() => window.discardedReplies);
  await thought.evaluate(() => {
    for (const fail of [false, true])
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: "stale-" + fail,
          method: "test/stale-reply",
          params: { fail },
        },
        "*",
      );
  });
  await expect.poll(() => staleReplies.length).toBe(2);
  await load();
  for (const release of staleReplies) release();
  await expect
    .poll(() => page.evaluate(() => window.discardedReplies))
    .toBeGreaterThanOrEqual(discardedBefore + 2);
  await inbox();
  await expect(thought).toHaveValue("面板恢复想法");
  const captureCount = service.captures.list().length;
  dropCaptureAck = true;
  await frame.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(
    frame.getByText("保存失败，输入已保留；可重试", { exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(thought).toHaveValue("");
  assert.equal(service.captures.list().length, captureCount + 1);
  await thought.fill("旧回执对应输入");
  holdCapture = true;
  await frame.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect.poll(() => Boolean(releaseCapture)).toBe(true);
  await thought.fill("保存期间新增输入");
  holdCapture = false;
  releaseCapture();
  await expect(thought).toHaveValue("保存期间新增输入");
  await expect
    .poll(() => service.captures.list().length)
    .toBe(captureCount + 2);
  await expect
    .poll(async () => {
      const r = await client.callTool({
        name: "workbench_panel_read",
        arguments: { route: "/recovery", vaultId: service.vaultId },
      });
      return r._meta.panel.data.records.find((s) => s.record.kind === "inbox")
        ?.record.value.thought;
    })
    .toBe("保存期间新增输入");
  failRecovery = true;
  await thought.fill("断线恢复想法");
  await expect(
    frame.getByRole("button", { name: "重试恢复草稿" }),
  ).toBeVisible();
  await assert.rejects(teardown, /synthetic offline/);
  await expect(thought).toHaveValue("断线恢复想法");
  failRecovery = false;
  await frame.getByRole("button", { name: "重试恢复草稿" }).click();
  await expect(
    frame.getByText("已保留本机恢复草稿，尚未写入知识库", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "inbox-recovery.png") });
  await load();
  await inbox();
  await expect(thought).toHaveValue("断线恢复想法");
  await frame.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(thought).toHaveValue("");
  await expect(frame.locator(".capture-card img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  const originalImage = await client.callTool({
    name: "workbench_panel_read",
    arguments: {
      route: "/assets?path=" + encodeURIComponent(material.ref.assetPath),
      vaultId: service.vaultId,
    },
  });
  assert.equal(
    originalImage._meta.panel.data.dataUrl,
    "data:image/png;base64," + image.toString("base64"),
  );
  await expect
    .poll(() =>
      frame.locator(".capture-card img").evaluate((img) => img.naturalWidth),
    )
    .toBe(1);
  const job = service.processing.create([material.id], [], "codex", "核对来源");
  await frame
    .getByRole("button", { name: "交给当前 Codex 对话", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "已发送", exact: true }),
  ).toBeDisabled();
  assert.equal(messages.length, 1);
  assert.ok(messages[0].content[0].text.includes(job.id));
  await page.screenshot({ path: path.join(evidence, "inbox.png") });
  const draft = service.processing.submit(
    job.id,
    "native-panel-review",
    {
      title: "原生审核测试",
      action: "create",
      markdown: "# 待审核\n\n合成结果，未经科学验证。",
      sourceIds: [material.id],
      unresolved: ["核对公式条件"],
    },
    job.snapshot.inputHash,
  );
  await frame
    .getByRole("button", { name: /^待审稿/ })
    .first()
    .click();
  await expect(
    frame.getByRole("button", { name: "确认并保存", exact: true }),
  ).toBeVisible();
  await frame.getByLabel("笔记编辑器").click();
  await frame.getByLabel("笔记编辑器").press("Control+a");
  failReviewSave = true;
  await page.keyboard.insertText("# 已审核\n\n用户修改后接受，仍需核对。");
  await expect
    .poll(async () => {
      const r = await client.callTool({
        name: "workbench_panel_read",
        arguments: { route: "/recovery", vaultId: service.vaultId },
      });
      return r._meta.panel.data.records.some(
        (s) =>
          s.record.kind === "review" &&
          s.record.value.text.includes("用户修改后接受"),
      );
    })
    .toBe(true);
  await load();
  await frame
    .getByRole("button", { name: /^待审稿/ })
    .first()
    .click();
  await expect(frame.getByLabel("笔记编辑器")).toContainText("用户修改后接受");
  failReviewSave = false;
  await frame.getByRole("button", { name: "确认并保存", exact: true }).click();
  await expect
    .poll(
      () =>
        service.processing.proposals().find((p) => p.id === draft.id)?.status,
    )
    .toBe("accepted");
  await page.screenshot({ path: path.join(evidence, "review.png") });
  await load();
  await frame
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(editor).toContainText("原生面板中文保存验证");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n关闭面板前保存验证");
  await teardown();
  assert.ok(
    fs
      .readFileSync(path.join(vault, "从一个问题开始.md"), "utf8")
      .includes("关闭面板前保存验证"),
  );
  await load();
  await frame
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(editor).toContainText("关闭面板前保存验证");
  await page.setViewportSize({ width: 620, height: 850 });
  await page.screenshot({ path: path.join(evidence, "narrow.png") });
  // Refuse stale edits, preserving the version from outside the panel.
  const before = service.vault.read("从一个问题开始.md");
  service.vault.save(before.path, before.content + "\n外部修改\n", before.hash);
  const conflict = await client.callTool({
    name: "workbench_panel_write",
    arguments: {
      vaultId: service.vaultId,
      method: "PUT",
      route: "/note",
      body: {
        path: before.path,
        content: "不得覆盖",
        expectedHash: before.hash,
      },
    },
  });
  assert.equal(conflict.isError, true);
  assert.equal(conflict._meta.panel.code, "VERSION_CONFLICT");
  assert.ok(service.vault.read(before.path).content.includes("外部修改"));
  const runtimePath = path.join(root, "runtime.json");
  const runtime = fs.readFileSync(runtimePath, "utf8");
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({ ...JSON.parse(runtime), vaultId: "0".repeat(64) }),
  );
  const changed = await client.callTool({
    name: "workbench_panel_read",
    arguments: { route: "/notes", vaultId: service.vaultId },
  });
  assert.equal(changed._meta.panel.code, "VAULT_CHANGED");
  fs.writeFileSync(runtimePath, runtime);
  let legacyWrites = 0;
  const legacy = createServer((req, res) => {
    if (req.url !== "/api/status") legacyWrites++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        service: "knowledge-workbench",
        apiVersion: 1,
        vault: { id: service.vaultId },
      }),
    );
  });
  legacy.listen(0, "127.0.0.1");
  await once(legacy, "listening");
  try {
    fs.writeFileSync(
      runtimePath,
      JSON.stringify({
        ...JSON.parse(runtime),
        baseUrl: `http://127.0.0.1:${legacy.address().port}`,
      }),
    );
    const unsupported = await client.callTool({
      name: "workbench_panel_write",
      arguments: {
        route: "/captures",
        method: "POST",
        vaultId: service.vaultId,
        body: { title: "must not write" },
      },
    });
    assert.equal(unsupported._meta.panel.code, "SERVICE_UPGRADE_REQUIRED");
    await load();
    await expect(frame.getByRole("alert")).toContainText("桌面服务版本较旧");
    assert.equal(legacyWrites, 0);
    await page.screenshot({ path: path.join(evidence, "service-upgrade.png") });
  } finally {
    fs.writeFileSync(runtimePath, runtime);
    await new Promise((r) => legacy.close(r));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = {
    passed: true,
    checks: [
      "native-resource",
      "real-MCP-transport",
      "sandbox-no-network",
      "host-discards-replies-after-reload",
      "edit-save-reopen",
      "teardown-flush",
      "math",
      "theme",
      "original-image",
      "explicit-message-once",
      "review-accept",
      "version-conflict",
      "vault-pinning",
      "opaque-inbox-reload-recovery",
      "capture-lost-receipt-deduplication",
      "new-input-survives-old-receipt",
      "offline-recovery-retry",
      "failed-teardown-keeps-panel",
      "opaque-review-reload-recovery",
      "panel-capability-restrictions",
      "legacy-service-upgrade-without-write",
    ],
    host: "browser protocol harness; not Codex desktop UI",
    modelInvoked: false,
  };
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await client.close();
  await service.close();
  await removeTestDirectory(root, os.tmpdir());
}
