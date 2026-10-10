import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { removeTestDirectory } from "./test-cleanup.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { startService } from "../server/app.ts";
import { preparePlugin } from "../desktop/plugin-setup.mjs";
import { codexCommand } from "./codex-command.mjs";

fs.mkdirSync(".local", { recursive: true });
const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "kwb-codex-host-")),
  ),
  profile = path.join(root, "workbench"),
  codexHome = path.join(root, "codex"),
  vault = path.join(root, "vault");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
const service = await startService({ vaultDir: vault, dataDir: profile });
const configured = preparePlugin({
  root: process.cwd(),
  profileDir: profile,
  executable: process.execPath,
});
fs.writeFileSync(
  path.join(profile, "runtime.json"),
  JSON.stringify({
    baseUrl: service.baseUrl,
    token: service.token,
    vaultId: service.vaultId,
  }),
);
const env = { ...process.env, CODEX_HOME: codexHome, KWB_PROFILE: profile },
  command = codexCommand();
let child;
const pending = new Map();
let sequence = 0;
try {
  for (const args of [
    ["plugin", "marketplace", "add", configured.marketplace, "--json"],
    [
      "plugin",
      "add",
      "knowledge-workbench@knowledge-workbench-local",
      "--json",
    ],
  ]) {
    const r = spawnSync(command, args, {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message);
  }
  const capture = service.captures.add({
      title: "宿主验收合成材料",
      text: "仅协议验收，保留原始想法。",
    }),
    job = service.processing.create([capture.id], [], "codex", "核对来源");
  child = spawn(command, ["app-server", "--stdio"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  child.stderr.on("data", (v) => {
    diagnostics = (diagnostics + v.toString()).slice(-4000);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(task.timer);
      message.error
        ? task.reject(new Error(JSON.stringify(message.error)))
        : task.resolve(message.result);
    } else if (message.id !== undefined && message.method)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: "Unexpected request in bounded protocol test",
          },
        }) + "\n",
      );
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(method + " timed out: " + diagnostics));
        }, 45000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  await rpc("initialize", {
    clientInfo: { name: "workbench_acceptance", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n",
  );
  const installed = await rpc("plugin/installed", { cwds: [root] });
  const detail = await rpc("plugin/read", {
    pluginName: "knowledge-workbench",
    marketplacePath: path.join(
      configured.marketplace,
      ".agents/plugins/marketplace.json",
    ),
  });
  fs.mkdirSync(".local", { recursive: true });
  fs.writeFileSync(
    ".local/host-plugin.json",
    JSON.stringify({ installed, detail }, null, 2),
  );
  const thread = await rpc("thread/start", {
      cwd: root,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }),
    threadId = thread.thread.id;
  let inventory;
  for (let i = 0; i < 3; i++) {
    inventory = await rpc("mcpServerStatus/list", { threadId, limit: 20 });
    if (
      inventory.data?.some(
        (s) =>
          s.name.includes("knowledge") && Object.keys(s.tools || {}).length,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const server = inventory.data?.find((s) => s.name.includes("knowledge"));
  assert.ok(
    server,
    "Knowledge Workbench plugin missing from actual Codex inventory: " +
      JSON.stringify(inventory) +
      " diagnostics " +
      diagnostics,
  );
  const descriptors = Object.values(server.tools || {});
  const openTool = descriptors.find((t) => t.name === "workbench_open");
  assert.equal(openTool?.title, "打开知识工作台");
  assert.equal(
    openTool?._meta?.ui?.resourceUri,
    "ui://knowledge-workbench/panel-v1.html",
  );
  assert.deepEqual(openTool?._meta?.["openai/ui"]?.entrypoints, [
    { type: "global" },
    { type: "thread" },
  ]);
  const call = async (tool, args = {}) => {
    const r = await rpc("mcpServer/tool/call", {
      threadId,
      server: server.name,
      tool,
      arguments: args,
    });
    const value = r.result || r;
    assert.ok(!value.isError, JSON.stringify(value));
    return JSON.parse(value.content[0].text);
  };
  assert.equal((await call("workbench_status")).service, "knowledge-workbench");
  assert.equal((await call("workbench_open")).url, service.baseUrl);
  const batch = await call("workbench_read_batch", { batchId: job.id });
  assert.equal(batch.inputHash, job.snapshot.inputHash);
  assert.match(
    (
      await call("workbench_read_material", {
        batchId: job.id,
        sourceId: capture.id,
      })
    ).text,
    /原始想法/,
  );
  const result = await call("workbench_submit_draft", {
    batchId: job.id,
    requestId: "host-probe",
    inputHash: batch.inputHash,
    proposal: {
      title: "宿主测试草稿",
      action: "create",
      markdown: "# 来源保留\n\n仅测试工具回传。",
      sourceIds: [capture.id],
      unresolved: ["未验证科学内容"],
    },
  });
  assert.equal(result.status, "pending");
  assert.equal(
    service.vault.list().some((n) => n.path.includes("/Cards/")),
    false,
  );
  console.log(
    JSON.stringify({
      passed: true,
      host: "Codex app-server",
      server: server.name,
      checks: [
        "installed-local-plugin",
        "discovered-tools",
        "open-url",
        "native-panel-entrypoint-metadata",
        "read-scoped-material",
        "draft-roundtrip",
      ],
      modelInvoked: false,
    }),
  );
} catch (error) {
  console.error("Codex host acceptance failed:", error.message);
  throw error;
} finally {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error("test ended"));
  }
  if (child) {
    child.stdin.end();
    await new Promise((r) => {
      const timer = setTimeout(() => {
        child.kill();
        r();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
  }
  await service.close();
  await removeTestDirectory(root, os.tmpdir());
}
