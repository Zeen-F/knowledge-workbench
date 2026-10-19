// Synthetic-only browser regression. Requires a working Playwright Chromium runtime.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../server/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-materials-review-"));
let service, browser;
const evidence = path.resolve("output/materials-review");
fs.mkdirSync(evidence, { recursive: true });
try {
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  service = await startService({
    vaultDir,
    dataDir: path.join(root, "profile"),
    distDir: path.resolve("dist"),
  });
  const first = service.captures.add({
    title: "噪声推导",
    text: "MOS noise [external](https://example.com)",
  });
  const second = service.captures.add({
    title: "文献标注",
    text: "原文条件",
    ref: {
      kind: "paperdesk",
      paperdesk: {
        documentId: crypto.randomUUID(),
        title: "Synthetic analog paper",
        pdfSha256: "a".repeat(64),
        page: 17,
        rects: [],
        quote: "Input noise",
      },
    },
  });
  const reference = service.vault.create(
    "参考笔记",
    "concept",
    "FROZEN_REFERENCE_SENTINEL",
  );
  const job = service.processing.create(
    [second.id, first.id],
    [reference.path],
    "codex",
    "",
  );
  service.processing.submit(
    job.id,
    "review-materials",
    {
      title: "核对噪声",
      action: "create",
      markdown: "# 噪声\n\n待人工核对",
      sourceIds: [first.id, second.id],
      unresolved: ["核对输入条件"],
    },
    job.snapshot.inputHash,
  );
  service.vault.save(
    reference.path,
    "# 参考笔记\n\nCURRENT_REFERENCE_SENTINEL",
    reference.hash,
  );
  browser = await chromium.launch({
    executablePath: process.env.KWB_TEST_EXECUTABLE,
    channel:
      process.env.KWB_TEST_BROWSER ||
      (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/jobs/.test(request.url()))
      writes.push(request.url());
  });
  await page.goto(service.baseUrl);
  await page
    .getByRole("button", { name: /收集箱/ })
    .first()
    .click();
  await page.getByLabel("选择 文献标注", { exact: true }).check();
  await page.getByLabel("搜索材料", { exact: true }).fill("MOS");
  await expect(page.locator(".capture-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "整理所选 1" })).toBeEnabled();
  await page
    .getByRole("button", { name: "预览 噪声推导", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "噪声推导" });
  await expect(dialog.locator(".material-body a")).toHaveCount(0);
  await dialog.getByRole("button", { name: "加入所选" }).click();
  await expect(
    dialog.getByRole("button", { name: "取消选择" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "预览 噪声推导", exact: true }),
  ).toBeFocused();
  await page.getByLabel("搜索材料", { exact: true }).fill("not found");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.locator(".capture-card.selected")).toHaveCount(2);
  await expect(
    page
      .locator(".capture-card")
      .filter({ hasText: "文献标注" })
      .locator(".capture-select b"),
  ).toHaveText("1");
  await page.getByLabel("材料类型").selectOption("paperdesk");
  await page.getByRole("button", { name: "只看已选 2", exact: true }).click();
  await expect(page.locator(".capture-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "预览 文献标注", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").locator(".material-provenance"),
  ).toHaveText("Synthetic analog paper · PDF 第 17 页");
  await page.screenshot({
    path: path.join(evidence, "material-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消选择", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.getByLabel("搜索材料", { exact: true })).toBeFocused();
  if (writes.length)
    throw new Error("Filtering and preview unexpectedly created or ran a job");
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await expect(page.locator(".review-evidence-summary")).toContainText(
    "2 份原始材料 · 1 篇参考笔记 · 1 项待核对",
  );
  const referenceDetails = page
    .locator(".evidence-item")
    .filter({ has: page.getByText("参考笔记", { exact: true }) });
  await referenceDetails.locator("summary").click();
  await expect(referenceDetails).toContainText("FROZEN_REFERENCE_SENTINEL");
  await expect(referenceDetails).not.toContainText(
    "CURRENT_REFERENCE_SENTINEL",
  );
  await page.screenshot({
    path: path.join(evidence, "review-evidence.png"),
    fullPage: true,
  });
  await referenceDetails.locator("summary").click();
  await referenceDetails.locator("summary").click();
  await page.route("**/api/proposals/*", async (route) => {
    if (route.request().method() === "PUT") await route.abort("failed");
    else await route.continue();
  });
  await page.getByLabel("笔记编辑器").click();
  await page
    .getByLabel("笔记编辑器")
    .press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(" REVIEW_EDIT_SENTINEL");
  await referenceDetails
    .getByRole("button", { name: "打开当前参考笔记" })
    .click();
  await expect(page.locator(".review-evidence-summary")).toBeVisible();
  await expect(page.getByLabel("笔记编辑器")).toContainText(
    "REVIEW_EDIT_SENTINEL",
  );
  await page.unroute("**/api/proposals/*");
  let releaseNote,
    noteRequested = false;
  const noteGate = new Promise((resolve) => {
    releaseNote = resolve;
  });
  await page.route("**/api/note?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("path") === reference.path
    ) {
      noteRequested = true;
      await noteGate;
    }
    await route.continue();
  });
  await referenceDetails
    .getByRole("button", { name: "打开当前参考笔记" })
    .click();
  await expect.poll(() => noteRequested).toBe(true);
  await expect(
    referenceDetails.getByRole("button", { name: "打开当前参考笔记" }),
  ).toBeDisabled();
  await page.getByLabel("笔记编辑器").click();
  await page.keyboard.type(" MUST_NOT_APPEAR_DURING_NAVIGATION");
  await expect(page.getByLabel("笔记编辑器")).not.toContainText(
    "MUST_NOT_APPEAR_DURING_NAVIGATION",
  );
  releaseNote();
  await expect(page.getByLabel("笔记编辑器")).toContainText(
    "CURRENT_REFERENCE_SENTINEL",
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS materials filtering, preview/close/focus, selection order, no auto-sharing, frozen review references, failed-save navigation guard and retry",
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
