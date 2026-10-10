import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { startService } from "../server/app.ts";
import { chromium, expect } from "@playwright/test";
import { exportSelections, importAndReturn } from "./paperdesk-ui.mjs";

const source = process.argv[2];
if (!source) throw new Error("请提供 Paperdesk 源码目录作为第一个参数。");
const paperdeskRoot = path.resolve(source),
  { createApp } = await import(
    pathToFileURL(path.join(paperdeskRoot, "server/app.mjs")).href
  );
const { readerLayoutPdf } = await import(
  pathToFileURL(path.join(paperdeskRoot, "tests/fixtures/reader-layout.mjs"))
    .href
);
const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "kwb-paperdesk-")),
  ),
  vaultDir = path.join(root, "vault");
fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
const sample = readerLayoutPdf({ pageCount: 3, variant: "knowledge" }),
  pdfFile = path.join(vaultDir, "示例.pdf");
fs.writeFileSync(pdfFile, sample);
const evidence = path.resolve("output/playwright/paperdesk");
fs.mkdirSync(evidence, { recursive: true });
let paperdesk, server, workbench, browser, other;
let baseUrl, result;
const stopPaperdesk = async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = null;
  }
  await paperdesk?.close();
  paperdesk = null;
};
const startPaperdesk = async () => {
  paperdesk = createApp({ vaultDir, dataDir: path.join(root, "paperdesk") });
  await paperdesk.ready;
  server = paperdesk.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
};
try {
  await startPaperdesk();
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
  const { document } = await request("/vault/pdfs/open", { path: "示例.pdf" });
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    channel: process.env.KWB_TEST_BROWSER || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
    reducedMotion: "reduce",
  });
  const errors = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  const exported = await exportSelections(context, baseUrl, evidence);
  assert.equal(
    fs.readdirSync(path.join(vaultDir, "Paperdesk/Exports")).length,
    2,
  );
  await stopPaperdesk();
  // Both producers and models are offline when the workbench reads the durable packages.
  workbench = await startService({
    vaultDir,
    dataDir: path.join(root, "workbench"),
    distDir: path.resolve("dist"),
  });
  assert.equal(workbench.captures.list().length, 2);
  const capture = workbench.captures
    .list()
    .find((c) => c.ref.paperdesk.page === 2);
  const regionCapture = workbench.captures
    .list()
    .find((c) => c.ref.paperdesk.page === 3);
  assert.equal(capture.ref.paperdesk.documentId, document.id);
  assert.match(capture.text, /条件仍需核对/);
  assert.equal(workbench.captures.importPaperdesk().imported, 0);
  assert.deepEqual(
    workbench.captures.image(regionCapture.ref),
    Buffer.from(exported.region.image.split(",")[1], "base64"),
  );
  await startPaperdesk();
  const otherVault = path.join(root, "other-vault");
  fs.mkdirSync(path.join(otherVault, ".obsidian"), { recursive: true });
  other = await startService({
    vaultDir: otherVault,
    dataDir: path.join(root, "other-cache"),
  });
  await assert.rejects(
    () => other.paperdesk.bind(baseUrl),
    (error) => error.code === "PAPERDESK_VAULT_MISMATCH",
  );
  await other.close();
  other = null;
  const page = await importAndReturn(
    context,
    workbench,
    baseUrl,
    evidence,
    regionCapture,
  );
  // Missing or incomplete attachments wait; restoration imports once and reuses the image.
  const delayedId = randomUUID(),
    delayed = path.join(vaultDir, "Paperdesk/Exports", delayedId);
  fs.mkdirSync(delayed);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        vaultDir,
        "Paperdesk/Exports",
        exported.region.requestId,
        "manifest.json",
      ),
      "utf8",
    ),
  );
  fs.writeFileSync(
    path.join(delayed, "manifest.json"),
    JSON.stringify({
      ...manifest,
      id: delayedId,
      comment: "同图的新疑问，独立记录。",
    }),
  );
  assert.deepEqual(workbench.captures.importPaperdesk().pending, [delayedId]);
  fs.writeFileSync(path.join(delayed, "selection.png"), Buffer.from("partial"));
  assert.deepEqual(workbench.captures.importPaperdesk().pending, [delayedId]);
  fs.writeFileSync(
    path.join(delayed, "selection.png"),
    workbench.captures.image(regionCapture.ref),
  );
  assert.equal(workbench.captures.importPaperdesk().imported, 1);
  assert.equal(workbench.captures.importPaperdesk().imported, 0);
  assert.equal(workbench.captures.list().length, 3);
  assert.equal(
    new Set(
      workbench.captures
        .list()
        .filter((c) => c.ref.assetPath)
        .map((c) => c.ref.assetPath),
    ).size,
    1,
  );
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
  fs.writeFileSync(
    pdfFile,
    Buffer.concat([sample, Buffer.from("\n% source changed")]),
  );
  await assert.rejects(() => workbench.paperdesk.sourceUrl(regionCapture.ref));
  fs.writeFileSync(pdfFile, sample);
  await stopPaperdesk();
  await assert.rejects(
    () => workbench.paperdesk.sourceUrl(regionCapture.ref),
    (error) => error.code === "PAPERDESK_OFFLINE",
  );
  await page.getByRole("button", { name: "回到纸间原页" }).click();
  await expect(page.locator(".toast")).toContainText("纸间服务未连接");
  await expect(page.getByLabel("笔记编辑器")).toBeVisible();
  await expect(page.locator(".context-panel")).toContainText("PDF 第 3 页");
  assert.deepEqual(errors, []);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(pdfFile)).digest("hex"),
    createHash("sha256").update(sample).digest("hex"),
  );
  result = {
    passed: true,
    checks: [
      "real-browser-text-and-region-selection",
      "real-Paperdesk-producer",
      "lost-response-retry-same-request",
      "durable-export",
      "idempotence",
      "import-after-workbench-start",
      "real-versioned-body-save",
      "stale-write-denied",
      "original-PDF-unchanged",
      "same-vault-binding",
      "incomplete-image-waits",
      "image-dedup-keeps-separate-ideas",
      "real-browser-source-page-return",
      "changed-PDF-return-denied",
      "offline-source-keeps-material",
    ],
    materials: "synthetic three-page PDF",
    completedAt: new Date().toISOString(),
    browser: process.env.KWB_TEST_BROWSER || "chromium",
    headed: process.argv.includes("--headed"),
  };
} finally {
  await browser?.close();
  await other?.close();
  await workbench?.close();
  await stopPaperdesk();
  assert.ok(path.basename(root).startsWith("kwb-paperdesk-"));
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(fs.existsSync(root), false);
result.cleanup = "temporary vaults and owned services removed";
fs.writeFileSync(
  path.join(evidence, "result.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
