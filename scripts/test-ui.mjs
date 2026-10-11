import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { seed } from "./seed.mjs";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-ui-")),
  vault = path.join(testRoot, "vault"),
  profile = path.join(testRoot, "profile");
seed(vault);
fs.mkdirSync("output/playwright", { recursive: true });
const env = { ...process.env, KWB_VAULT: vault, KWB_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const executable =
  process.env.KWB_TEST_EXE || createRequire(import.meta.url)("electron");
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: executable,
    args: process.env.KWB_TEST_EXE ? [] : ["."],
    env,
    timeout: 30000,
  });
  app.process().stderr.on("data", (bytes) => {
    if (/Error|Exception/.test(bytes.toString())) process.stderr.write(bytes);
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(page.getByLabel("笔记编辑器")).toBeVisible();
  await expect(page.locator(".katex-display")).toBeVisible();
  await page.screenshot({
    path: "output/playwright/editor.png",
    fullPage: true,
  });
  await page
    .locator(".cm-content")
    .getByRole("link", { name: "今天的学习记录", exact: true })
    .click();
  await expect(page.getByLabel("笔记编辑器")).toContainText(
    "给下一次学习留下线索",
  );
  await page
    .locator(".cm-content")
    .getByRole("link", { name: "从一个问题开始", exact: true })
    .click();
  await expect(page.locator(".katex-display")).toBeVisible();
  for (const [theme, label] of [
    ["sand", "暖砂"],
    ["mist", "雾蓝"],
    ["night", "夜读"],
    ["forest", "森林"],
  ]) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.screenshot({
      path: `output/playwright/theme-${theme}.png`,
      fullPage: true,
    });
  }
  const original = fs.readFileSync(
    path.join(vault, "从一个问题开始.md"),
    "utf8",
  );
  await page.getByRole("button", { name: "即时渲染", exact: true }).click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  expect(fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8")).toBe(
    original,
  );
  const editor = page.getByLabel("笔记编辑器");
  await editor.click();
  await editor.press("Control+End");
  await editor.press("Enter");
  await page.keyboard.insertText("中文补充：保存、撤销和重开测试。");
  await editor.press("Control+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"))
    .toContain("中文补充");
  await editor.press("Control+End");
  await page.keyboard.insertText("UNDO_PROBE");
  await page
    .getByRole("button", { name: "今天的学习记录", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "从一个问题开始", exact: true })
    .first()
    .click();
  await editor.press("Control+z");
  await editor.press("Control+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"))
    .not.toContain("UNDO_PROBE");
  await page
    .getByRole("button", { name: /收集箱/ })
    .first()
    .click();
  await page
    .getByLabel("快速记录想法")
    .fill("这是一份隔离测试想法，需要保留来源。");
  await page.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(page.locator(".capture-card")).toHaveCount(1);
  await page.screenshot({
    path: "output/playwright/inbox.png",
    fullPage: true,
  });
  const runtime = JSON.parse(
    fs.readFileSync(path.join(profile, "runtime.json"), "utf8"),
  );
  const request = async (route, method = "GET", body) => {
    const response = await fetch(runtime.baseUrl + "/api" + route, {
      method,
      headers: {
        Authorization: "Bearer " + runtime.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const materials = await request("/captures"),
    job = await request("/jobs", "POST", {
      sourceIds: [materials[0].id],
      executor: "codex",
    });
  const proposal = await request(`/mcp/batches/${job.id}/proposals`, "POST", {
    requestId: "ui-proposal",
    inputHash: job.snapshot.inputHash,
    proposal: {
      title: "界面审核测试",
      action: "create",
      markdown: "# 界面审核测试\n\n保留这一句。\n\n删除这一句。",
      sourceIds: [materials[0].id],
      unresolved: ["人工核对条件"],
    },
  });
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "确认并保存", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  const reviewEditor = page.getByLabel("笔记编辑器");
  await reviewEditor.click();
  await reviewEditor.press("Control+a");
  await page.keyboard.insertText("# 界面审核测试\n\n已人工修改，部分接受。");
  await page.getByRole("button", { name: "确认并保存", exact: true }).click();
  await expect
    .poll(async () => {
      const proposals = await request("/proposals");
      return proposals.find((p) => p.id === proposal.id)?.status;
    })
    .toBe("accepted");
  const accepted = (await request("/proposals")).find(
    (p) => p.id === proposal.id,
  );
  expect(
    fs.readFileSync(path.join(vault, accepted.acceptedPath), "utf8"),
  ).toContain("部分接受");
  await page.screenshot({
    path: "output/playwright/accepted-note.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await app.close();
  app = undefined;
  app = await electron.launch({
    executablePath: executable,
    args: process.env.KWB_TEST_EXE ? [] : ["."],
    env,
    timeout: 30000,
  });
  const reopened = await app.firstWindow();
  await reopened
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(reopened.getByLabel("笔记编辑器")).toContainText("中文补充");
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "desktop-start",
        "live-math",
        "rendered-link-click-navigation",
        "four-themes",
        "source-toggle-preserves-file",
        "Chinese-input",
        "undo-across-tabs",
        "save",
        "capture-inbox",
        "partial-draft-acceptance",
        "restart",
      ],
      screenshots: "output/playwright",
    }),
  );
} finally {
  if (app) await app.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
