import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../server/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-ui-recovery-"));
const vaultDir = path.join(root, "vault");
fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n\n[[Beta]]");
fs.writeFileSync(path.join(vaultDir, "Beta.md"), "# Beta\n\n新操作");
const evidence = path.resolve("output/reliability");
fs.mkdirSync(evidence, { recursive: true });
const service = await startService({
  vaultDir,
  dataDir: path.join(root, "profile"),
  distDir: path.resolve("dist"),
});
let browser;
const checks = [],
  errors = [];
try {
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.baseUrl);
  const inbox = () =>
    page
      .getByRole("button", { name: /收集箱/ })
      .first()
      .click();
  const all = () =>
    page
      .getByRole("button", { name: /全部笔记/ })
      .first()
      .click();
  await inbox();
  await page.getByLabel("想法标题").fill("未保存标题");
  await page.getByLabel("快速记录想法").fill("未点击保存也必须恢复");
  await all();
  await inbox();
  await expect(page.getByLabel("快速记录想法")).toHaveValue(
    "未点击保存也必须恢复",
  );
  checks.push("inbox navigation recovery");
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await inbox();
  await expect(page.getByLabel("想法标题")).toHaveValue("未保存标题");
  await expect(page.getByLabel("快速记录想法")).toHaveValue(
    "未点击保存也必须恢复",
  );
  checks.push("inbox reload recovery");
  await page.route("**/api/captures", async (route) => {
    if (route.request().method() === "POST") await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(page.getByLabel("快速记录想法")).toHaveValue(
    "未点击保存也必须恢复",
  );
  await expect(
    page.getByRole("button", { name: "保存想法", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/api/captures");
  let release, entered;
  const arrived = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  await page.route("**/api/captures", async (route) => {
    if (route.request().method() === "POST") {
      entered();
      await gate;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存想法", exact: true }).click();
  await arrived;
  await page.getByLabel("快速记录想法").fill("保存过程中继续写的新想法");
  release();
  await expect(page.locator(".capture-card")).toHaveCount(1);
  await expect(page.getByLabel("快速记录想法")).toHaveValue(
    "保存过程中继续写的新想法",
  );
  await all();
  await inbox();
  await expect(page.getByLabel("快速记录想法")).toHaveValue(
    "保存过程中继续写的新想法",
  );
  checks.push("failed retry and input during save");
  await page.unroute("**/api/captures");
  await page.screenshot({
    path: path.join(evidence, "inbox-recovery.png"),
    fullPage: true,
  });
  await expect(page.getByRole("button", { name: /框选截图/ })).toBeDisabled();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "准备本地插件", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: path.join(evidence, "browser-capabilities.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  checks.push("browser capability affordances");
  await all();
  let releaseNote, noteEntered;
  const noteArrived = new Promise((r) => {
    noteEntered = r;
  });
  const noteGate = new Promise((r) => {
    releaseNote = r;
  });
  await page.route("**/api/note?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("path") === "Alpha.md"
    ) {
      noteEntered();
      await noteGate;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Alpha", exact: true })
    .first()
    .click();
  await noteArrived;
  await page.getByRole("button", { name: "Beta", exact: true }).first().click();
  await expect(page.getByLabel("笔记编辑器")).toContainText("新操作");
  const alphaResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/note" &&
      new URL(r.url()).searchParams.get("path") === "Alpha.md",
  );
  releaseNote();
  await alphaResponse;
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.unroute("**/api/note?*");
  await expect(page.getByLabel("笔记编辑器")).toContainText("新操作");
  checks.push("out of order note opens");
  let releaseSearch, searchEntered;
  const searchArrived = new Promise((r) => {
    searchEntered = r;
  });
  const searchGate = new Promise((r) => {
    releaseSearch = r;
  });
  await page.route("**/api/notes?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "Alpha") {
      searchEntered();
      await searchGate;
    }
    await route.continue();
  });
  const search = page.getByPlaceholder("搜索笔记与想法");
  await search.fill("Alpha");
  await searchArrived;
  await search.fill("新操作");
  await expect(page.locator(".note-list")).toContainText("Beta");
  const oldSearch = page.waitForResponse((r) =>
    r.url().includes("/api/notes?q=Alpha"),
  );
  releaseSearch();
  await oldSearch;
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(page.locator(".note-list")).not.toContainText("Alpha");
  await page.unroute("**/api/notes?*");
  await search.fill("");
  checks.push("out of order searches");
  let releaseRelation, relationEntered;
  const relationArrived = new Promise((r) => {
    relationEntered = r;
  });
  const relationGate = new Promise((r) => {
    releaseRelation = r;
  });
  await page.route("**/api/relations?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("path") === "Alpha.md"
    ) {
      relationEntered();
      await relationGate;
      await route.fulfill({
        json: {
          outgoing: [{ to_ref: "Beta.md", label: "STALE_RELATION" }],
          incoming: [],
          related: [],
        },
      });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Alpha", exact: true })
    .first()
    .click();
  await relationArrived;
  await page.getByRole("button", { name: "Beta", exact: true }).first().click();
  const oldRelation = page.waitForResponse((r) =>
    r.url().includes("/api/relations?path=Alpha.md"),
  );
  releaseRelation();
  await oldRelation;
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(page.getByText("STALE_RELATION", { exact: true })).toHaveCount(
    0,
  );
  await page.unroute("**/api/relations?*");
  checks.push("out of order relation reads");
  const source = service.captures.list()[0];
  const job = service.processing.create([source.id], [], "codex", "");
  const proposal = service.processing.submit(
    job.id,
    "ui-review",
    {
      title: "恢复审核",
      action: "create",
      markdown: "# 人工核对\n原始正文",
      sourceIds: [source.id],
    },
    job.snapshot.inputHash,
  );
  await page.reload();
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await page.route("**/api/proposals/*", async (route) => {
    if (route.request().method() === "PUT") await route.abort("failed");
    else await route.continue();
  });
  const reviewEditor = page.getByLabel("笔记编辑器");
  await reviewEditor.click();
  await reviewEditor.press("Control+End");
  await page.keyboard.insertText("\n离线审核的新判断");
  await all();
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await expect(reviewEditor).toContainText("离线审核的新判断");
  await page.reload();
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await expect(reviewEditor).toContainText("离线审核的新判断");
  await page.unroute("**/api/proposals/*");
  await page.getByRole("button", { name: "确认并保存", exact: true }).click();
  await expect
    .poll(() => service.processing.getProposal(proposal.id).status)
    .toBe("accepted");
  expect(
    service.vault.read(service.processing.getProposal(proposal.id).acceptedPath)
      .content,
  ).toContain("离线审核的新判断");
  await page.screenshot({
    path: path.join(evidence, "accepted-recovery.png"),
    fullPage: true,
  });
  checks.push(
    "offline review navigation/reload recovery and latest acceptance",
  );
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  fs.writeFileSync(
    path.join(evidence, "ui-result.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser?.close();
  await service.close();
  fs.rmSync(root, { recursive: true, force: true });
}
