import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { removeTestDirectory } from "./test-cleanup.mjs";
import { startService } from "../server/app.ts";
import { preparePlugin } from "../desktop/plugin-setup.mjs";
import {
  portableResearchSkill,
  RESEARCH_CORE,
} from "../shared/research-profiles.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-mcp-")),
  vault = path.join(root, "vault");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const service = await startService({ vaultDir: vault, dataDir: root });
const client = new Client({
  name: "workbench-regression-client",
  version: "1.0.0",
});
try {
  const packaged = preparePlugin({
    root: process.cwd(),
    profileDir: root,
    executable: process.execPath,
  });
  const packagedPlugin = path.join(
    packaged.marketplace,
    "plugins",
    "knowledge-workbench",
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(packagedPlugin, ".codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.skills, "./skills/");
  assert.equal(
    fs.readFileSync(
      path.join(packagedPlugin, "skills/analog-ic-research/SKILL.md"),
      "utf8",
    ),
    portableResearchSkill(),
  );
  for (const reference of ["paper", "experiment"])
    assert.ok(
      fs.existsSync(
        path.join(
          packagedPlugin,
          `skills/analog-ic-research/references/${reference}.md`,
        ),
      ),
    );
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
    job = service.processing.create([capture.id], [], "codex", "保留来源", {
      id: "analog-ic-research",
      focus: "experiment",
    });
  const privateCapture = service.captures.add({
    title: "未共享",
    text: "PRIVATE_SOURCE_SENTINEL",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["plugins/knowledge-workbench/dist/mcp.cjs"],
      env: { ...process.env, KWB_PROFILE: root },
      stderr: "pipe",
    }),
  );
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 9);
  const open = tools.find((t) => t.name === "workbench_open");
  assert.equal(open.title, "打开知识工作台");
  assert.deepEqual(open._meta["openai/ui"].entrypoints, [
    { type: "global" },
    { type: "thread" },
  ]);
  for (const name of ["workbench_panel_read", "workbench_panel_write"]) {
    assert.deepEqual(tools.find((t) => t.name === name)._meta.ui.visibility, [
      "app",
    ]);
  }
  const resource = await client.readResource({
    uri: open._meta.ui.resourceUri,
  });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(resource.contents[0].text.includes("<html"));
  assert.ok(!resource.contents[0].text.includes(service.token));
  const privateRead = await client.callTool({
    name: "workbench_panel_read",
    arguments: { route: "/captures", vaultId: service.vaultId },
  });
  assert.ok(privateRead._meta.panel.data.some((c) => c.id === capture.id));
  assert.ok(!JSON.stringify(privateRead.content).includes(capture.id));
  assert.ok(
    !JSON.stringify(privateRead.structuredContent).includes(capture.id),
  );
  for (const args of [
    { route: "/captures" },
    { route: "/captures", vaultId: "0".repeat(64) },
    { route: "/mcp/batches", vaultId: service.vaultId },
  ])
    assert.equal(
      (await client.callTool({ name: "workbench_panel_read", arguments: args }))
        .isError,
      true,
    );
  assert.equal(
    (
      await client.callTool({
        name: "workbench_panel_write",
        arguments: {
          method: "PUT",
          route: "/settings/provider",
          vaultId: service.vaultId,
          body: {},
        },
      })
    ).isError,
    true,
  );
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
  assert.deepEqual(batch.researchProfile, job.snapshot.researchProfile);
  assert.equal(
    batch.researchProfile.instructions.split(RESEARCH_CORE).length - 1,
    1,
  );
  assert.equal(JSON.stringify(batch).includes(privateCapture.id), false);
  assert.equal(
    (
      await client.callTool({
        name: "workbench_read_material",
        arguments: { batchId: job.id, sourceId: privateCapture.id },
      })
    ).isError,
    true,
  );
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
        "real SDK stdio transport + copied native skill package + scoped immutable research profile, synthetic inputs; not a Codex host run",
    }),
  );
} finally {
  await client.close();
  await service.close();
  await removeTestDirectory(root, os.tmpdir());
}
