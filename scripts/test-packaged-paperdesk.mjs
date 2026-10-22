import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { _electron as electron, chromium, expect } from "@playwright/test";
import { exportSelections } from "./paperdesk-ui.mjs";

const { values } = parseArgs({
  options: {
    "paperdesk-exe": { type: "string" },
    "workbench-exe": { type: "string" },
    "paperdesk-source": { type: "string" },
    "system-browser": { type: "boolean", default: false },
  },
});
for (const key of ["paperdesk-exe", "workbench-exe", "paperdesk-source"])
  assert.ok(values[key], `Missing --${key}`);
const paperdeskExe = fs.realpathSync.native(values["paperdesk-exe"]);
const workbenchExe = fs.realpathSync.native(values["workbench-exe"]);
const source = fs.realpathSync.native(values["paperdesk-source"]);
// Only the synthetic PDF generator and cleanup helpers come from the source
// checkout. Neither product's application/service code is imported by this test.
const { readerLayoutPdf } = await import(
  pathToFileURL(path.join(source, "tests/fixtures/reader-layout.mjs"))
);
const { closeTestApplication } = await import(
  pathToFileURL(path.join(source, "scripts/desktop-test-support.mjs"))
);
const root = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "kwb-packaged-")),
);
const vault = path.join(root, "中文 测试库"),
  paperProfile = path.join(root, "paperdesk-profile"),
  workProfile = path.join(root, "workbench-profile");
const evidence = path.resolve("output/playwright/packaged-paperdesk");
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
fs.mkdirSync(paperProfile);
const pdf = readerLayoutPdf({ pageCount: 3, variant: "knowledge" });
const pdfPath = path.join(vault, "打包 联调.pdf");
fs.writeFileSync(pdfPath, pdf);
fs.writeFileSync(
  path.join(paperProfile, "desktop-settings.json"),
  JSON.stringify({
    version: 1,
    vaultDir: vault,
    vaultSubdir: "Paperdesk",
    dataDir: path.join(root, "paperdesk-cache"),
    port: 4317,
  }),
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /^(ELECTRON_RUN_AS_NODE|PAPERDESK_(VAULT_DIR|VAULT_SUBDIR|DATA_DIR|DESKTOP_USER_DATA|DESKTOP_PORT)|KWB_(VAULT|PROFILE))$/i.test(
      key,
    )
  )
    delete env[key];
const errors = [],
  checks = [];
const result = {
  kind: "installed-windows-integration",
  passed: false,
  checks,
  errors,
  versions: {},
  systemBrowser: values["system-browser"],
};
let paper, workbench, reader, writer, paperBase, workBase, browser, failure;
const record = (text) => {
  checks.push(text);
  console.log(`PASS: ${text}`);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const screenshot = (page, name) =>
  page.screenshot({
    path: path.join(evidence, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
async function stop(app, base) {
  await closeTestApplication(app, app === paper ? paperProfile : workProfile);
  await assert.rejects(
    fetch(base + "/api/status", { signal: AbortSignal.timeout(1500) }),
  );
}
async function launchPaper() {
  paper = await electron.launch({
    executablePath: paperdeskExe,
    args: [],
    cwd: root,
    env: {
      ...env,
      PAPERDESK_DESKTOP_USER_DATA: paperProfile,
      PAPERDESK_DESKTOP_PORT: "0",
    },
    timeout: 60000,
  });
  reader = await paper.firstWindow();
  reader.on("pageerror", (e) => errors.push(e.message));
  await reader.emulateMedia({ reducedMotion: "reduce" });
  await expect(reader.locator(".app-shell")).toBeVisible();
  paperBase = new URL(reader.url()).origin;
  result.versions.paperdesk = await paper.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
    executable: process.execPath,
  }));
  assert.equal(result.versions.paperdesk.packaged, true);
}
async function launchWorkbench() {
  workbench = await electron.launch({
    executablePath: workbenchExe,
    args: [],
    cwd: root,
    env: { ...env, KWB_VAULT: vault, KWB_PROFILE: workProfile },
    timeout: 60000,
  });
  writer = await workbench.firstWindow();
  writer.on("pageerror", (e) => errors.push(e.message));
  await writer.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    writer.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  workBase = new URL(writer.url()).origin;
  result.versions.workbench = await workbench.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    path: app.getAppPath(),
    executable: process.execPath,
  }));
  assert.equal(result.versions.workbench.packaged, true);
}
const api = (method, route, body) =>
  writer.evaluate(
    ([method, route, body]) => window.workbench.invoke(method, route, body),
    [method, route, body],
  );
try {
  await launchPaper();
  const choice = reader.getByRole("button", {
    name: "打开 Obsidian PDF：打包 联调.pdf",
    exact: true,
  });
  await choice.click();
  await expect(reader.getByLabel("PDF 第 1 页", { exact: true })).toBeVisible();
  const exported = await exportSelections(
    paper.context(),
    paperBase,
    evidence,
    reader,
  );
  const exportRoot = path.join(vault, "Paperdesk/Exports");
  assert.equal(fs.readdirSync(exportRoot).length, 2);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(exportRoot, exported.region.requestId, "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.schema, "paperdesk-capture/v1");
  const image = fs.readFileSync(
    path.join(exportRoot, exported.region.requestId, "selection.png"),
  );
  assert.equal(
    hash(image),
    hash(Buffer.from(exported.region.image.split(",")[1], "base64")),
  );
  record(
    "packaged Electron text/region selection, durable export and lost-response retry",
  );
  await stop(paper, paperBase);
  paper = null;
  await launchWorkbench();
  const captures = await api("GET", "/captures");
  assert.equal(captures.length, 2);
  const region = captures.find((c) => c.ref.paperdesk?.page === 3);
  assert.ok(region);
  assert.equal(region.ref.paperdesk.documentId, manifest.source.documentId);
  assert.equal(
    hash(fs.readFileSync(path.join(vault, region.ref.assetPath))),
    hash(image),
  );
  await api("POST", "/refresh");
  assert.equal((await api("GET", "/captures")).length, 2);
  record(
    "packaged workbench imports with Paperdesk closed; original image and duplicate protection survive packaging",
  );
  await launchPaper();
  await writer.getByRole("button", { name: "设置", exact: true }).click();
  await writer.getByLabel("本机服务地址", { exact: true }).fill(paperBase);
  await writer.getByRole("button", { name: "核对并连接", exact: true }).click();
  await expect(writer.locator(".toast")).toContainText("纸间资料库已绑定");
  await writer.getByRole("button", { name: "完成", exact: true }).click();
  await writer.getByRole("button", { name: /^收集箱/ }).click();
  await writer.getByRole("button", { name: /^未分类 \/ 历史收集 ·/ }).click();
  await expect(writer.locator(".capture-card")).toHaveCount(2);
  await screenshot(writer, "installed-inbox");
  await writer
    .locator(".capture-card h3 button")
    .filter({ hasText: "第 3 页" })
    .click();
  await expect(writer.locator(".context-panel")).toContainText("PDF 第 3 页");
  const importedImage = writer
    .locator(".cm-content img:not(.cm-widgetBuffer)")
    .first();
  await expect(importedImage).toBeVisible();
  await expect
    .poll(() => importedImage.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(20);
  await screenshot(writer, "installed-source-note");
  // Record the desktop IPC destination. In --system-browser mode the actual OS
  // opener is called; otherwise only that OS adapter is replaced for automation.
  await workbench.evaluate(({ shell }, systemBrowser) => {
    const original = shell.openExternal.bind(shell);
    globalThis.packagedSourceUrls = [];
    shell.openExternal = async (url) => {
      if (systemBrowser) await original(url);
      globalThis.packagedSourceUrls.push(url);
    };
  }, values["system-browser"]);
  await writer.getByRole("button", { name: "回到纸间原页" }).click();
  await expect
    .poll(() => workbench.evaluate(() => globalThis.packagedSourceUrls.length))
    .toBe(1);
  const url = await workbench.evaluate(() => globalThis.packagedSourceUrls[0]);
  const returnedSource = new URL(url);
  assert.equal(returnedSource.origin, new URL(paperBase).origin);
  assert.equal(returnedSource.pathname, "/");
  assert.deepEqual(Object.fromEntries(returnedSource.searchParams), {
    document: region.ref.paperdesk.documentId,
    page: "3",
    pdfSha256: region.ref.paperdesk.pdfSha256,
    capture: region.ref.transferId,
  });
  browser = await chromium.launch({
    channel: process.env.KWB_TEST_BROWSER || undefined,
  });
  const returned = await browser.newPage({
    viewport: { width: 1500, height: 950 },
    reducedMotion: "reduce",
  });
  await returned.goto(url);
  await expect(
    returned.getByRole("spinbutton", { name: "页码", exact: true }),
  ).toHaveValue("3");
  await expect(
    returned.locator('.pdf-paper[data-page="3"] .textLayer'),
  ).toContainText("Evidence from page 03");
  await screenshot(returned, "installed-source-return");
  record(
    "desktop source button resolves the bound packaged Paperdesk and renders the original PDF page 3",
  );
  if (values["system-browser"]) {
    const ackFile = path.join(evidence, "system-browser-ack.json");
    fs.rmSync(ackFile, { force: true });
    fs.writeFileSync(
      path.join(evidence, "system-browser-pending.json"),
      JSON.stringify(
        { url, documentId: region.ref.paperdesk.documentId, page: 3 },
        null,
        2,
      ),
    );
    console.log(
      "WAITING: inspect the actual OS-opened source tab, close that test tab, then write system-browser-ack.json with {url,verified:true}.",
    );
    await expect
      .poll(() => fs.existsSync(ackFile), {
        timeout: 240000,
        intervals: [1000],
      })
      .toBe(true);
    const ack = JSON.parse(fs.readFileSync(ackFile, "utf8"));
    assert.equal(ack.url, url);
    assert.equal(typeof ack.verified, "boolean");
    result.systemBrowserVerified = ack.verified;
    if (ack.verified)
      record("actual operating-system browser source return inspected");
    else {
      assert.ok(ack.reason);
      result.systemBrowserInspectionLimit = ack.reason;
    }
  }
  const editor = writer.getByLabel("笔记编辑器");
  await editor.click();
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  await editor.press("Enter");
  await writer.keyboard.insertText("安装后补充：继续核对条件。");
  await editor.press("ControlOrMeta+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, region.path), "utf8"))
    .toContain("安装后补充");
  await stop(workbench, workBase);
  workbench = null;
  await launchWorkbench();
  assert.equal((await api("GET", "/captures")).length, 2);
  await writer.getByRole("button", { name: /^收集箱/ }).click();
  await writer.getByRole("button", { name: /^未分类 \/ 历史收集 ·/ }).click();
  await writer
    .locator(".capture-card h3 button")
    .filter({ hasText: "第 3 页" })
    .click();
  await expect(writer.getByLabel("笔记编辑器")).toContainText("安装后补充");
  record(
    "installed workbench saves and reopens imported Markdown without duplicate capture records",
  );
  await stop(paper, paperBase);
  paper = null;
  await writer.getByRole("button", { name: "回到纸间原页" }).click();
  await expect(writer.locator(".toast")).toContainText("纸间服务未连接");
  await expect(writer.locator(".context-panel")).toContainText("PDF 第 3 页");
  await expect(
    writer.locator(".cm-content img:not(.cm-widgetBuffer)").first(),
  ).toBeVisible();
  await screenshot(writer, "installed-offline-source");
  assert.equal(hash(fs.readFileSync(pdfPath)), hash(pdf));
  assert.deepEqual(errors, []);
  record(
    "offline source warning preserves imported material; original PDF hash unchanged",
  );
  result.passed = true;
} catch (error) {
  failure = error;
  result.error = error.stack;
  await writer
    ?.screenshot({ path: path.join(evidence, "failed-workbench.png") })
    .catch(() => {});
  await reader
    ?.screenshot({ path: path.join(evidence, "failed-paperdesk.png") })
    .catch(() => {});
} finally {
  await browser?.close();
  await closeTestApplication(workbench, workProfile);
  await closeTestApplication(paper, paperProfile);
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("kwb-packaged-"));
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
  result.cleanup = !fs.existsSync(root);
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
