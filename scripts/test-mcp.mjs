import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { startService } from "../server/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-mcp-")),
  vault = path.join(root, "vault");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const service = await startService({ vaultDir: vault, dataDir: root });
const client = new Client({
  name: "workbench-regression-client",
  version: "1.0.0",
});
try {
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({
      baseUrl: service.baseUrl,
      token: service.token,
      vaultId: service.vaultId,
    }),
  );
  const capture = service.captures.add({
      title: "合成材料",
      text: "只测试插件协议，不表示科学结论。",
    }),
    job = service.processing.create([capture.id], [], "codex", "保留来源");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["plugins/knowledge-workbench/dist/mcp.cjs"],
      env: { ...process.env, KWB_PROFILE: root },
      stderr: "pipe",
    }),
  );
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7);
  assert.equal(
    tools.some((t) => /accept|save_note/.test(t.name)),
    false,
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call("workbench_status")).service, "knowledge-workbench");
  assert.equal((await call("workbench_open")).url, service.baseUrl);
  assert.equal((await call("workbench_list_batches")).items[0].id, job.id);
  const batch = await call("workbench_read_batch", { batchId: job.id });
  assert.equal(batch.inputHash, job.snapshot.inputHash);
  assert.match(
    (
      await call("workbench_read_material", {
        batchId: job.id,
        sourceId: capture.id,
      })
    ).text,
    /科学结论/,
  );
  const draft = {
    batchId: job.id,
    requestId: "test-draft",
    inputHash: batch.inputHash,
    proposal: {
      title: "测试草稿",
      action: "create",
      markdown: "# 测试\n\n来源已保留，结论未验证。",
      sourceIds: [capture.id],
      unresolved: ["需回原图核对"],
    },
  };
  const p = await call("workbench_submit_draft", draft);
  assert.equal(p.status, "pending");
  assert.equal((await call("workbench_submit_draft", draft)).id, p.id);
  assert.equal(
    service.vault.list().some((n) => n.path.includes("/Cards/")),
    false,
  );
  service.processing.cancel(job.id);
  const denied = await client.callTool({
    name: "workbench_read_batch",
    arguments: { batchId: job.id },
  });
  assert.equal(denied.isError, true);
  console.log(
    JSON.stringify({
      passed: true,
      tools: tools.map((t) => t.name),
      verification:
        "real SDK stdio transport, synthetic inputs; not a Codex host run",
    }),
  );
} finally {
  await client.close();
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
}
