import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { startService } from "../server/app.ts";

const source = process.argv[2];
if (!source) throw new Error("请提供 Paperdesk 源码目录作为第一个参数。");
const paperdeskRoot = path.resolve(source),
  { createApp } = await import(
    pathToFileURL(path.join(paperdeskRoot, "server/app.mjs")).href
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-paperdesk-")),
  vaultDir = path.join(root, "vault");
fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
const sample = fs.readFileSync(
    path.join(paperdeskRoot, "public/examples/reading-demo.pdf"),
  ),
  pdfFile = path.join(vaultDir, "示例.pdf");
fs.writeFileSync(pdfFile, sample);
let paperdesk, server, workbench;
try {
  paperdesk = createApp({ vaultDir, dataDir: path.join(root, "paperdesk") });
  await paperdesk.ready;
  server = paperdesk.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, method = "POST") => {
    const r = await fetch(baseUrl + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json();
    assert.ok(r.ok, JSON.stringify(d));
    return d;
  };
  const { document } = await request("/vault/pdfs/open", { path: "示例.pdf" }),
    id = randomUUID();
  const payload = {
    requestId: id,
    documentId: document.id,
    page: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.2 }],
    quote: "Synthetic selection for integration acceptance",
    comment: "仅联动测试，保留原始疑问。",
  };
  const exported = await request("/integrations/knowledge/export", payload);
  assert.equal(exported.id, id);
  assert.equal(
    (await request("/integrations/knowledge/export", payload)).duplicate,
    true,
  );
  // The consumer starts after the producer has completed, proving offline accumulation.
  workbench = await startService({
    vaultDir,
    dataDir: path.join(root, "workbench"),
  });
  assert.equal(workbench.captures.list().length, 1);
  const capture = workbench.captures.list()[0];
  assert.equal(capture.ref.paperdesk.documentId, document.id);
  assert.equal(capture.ref.paperdesk.page, 1);
  assert.match(capture.text, /原始疑问/);
  await workbench.paperdesk.bind(baseUrl);
  const notePath = `Paperdesk/Notes/${document.id}.md`,
    original = workbench.vault.read(notePath);
  assert.equal(original.owner, "paperdesk");
  const text =
    "# 在知识工作台编辑的正文\n\n真实 Paperdesk 接口与合成资料的联调记录。\n";
  const saved = await workbench.paperdesk.save(notePath, text, original.hash);
  assert.match(saved.content, /在知识工作台编辑的正文/);
  assert.match(saved.content, /paperdesk-state:v[123]/);
  const changed = await request(`/documents/${document.id}`, undefined, "GET");
  assert.equal(changed.document.notesZh, text);
  await assert.rejects(
    () => workbench.paperdesk.save(notePath, "过期正文", original.hash),
    /文件已变化/,
  );
  assert.equal(
    createHash("sha256").update(fs.readFileSync(pdfFile)).digest("hex"),
    createHash("sha256").update(sample).digest("hex"),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "real-Paperdesk-producer",
        "durable-export",
        "idempotence",
        "import-after-workbench-start",
        "real-versioned-body-save",
        "stale-write-denied",
        "original-PDF-unchanged",
      ],
      materials: "synthetic example PDF",
    }),
  );
} finally {
  await workbench?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await paperdesk?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
