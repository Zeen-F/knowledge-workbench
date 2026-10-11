import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { seed } from "./seed.mjs";
import { removeTestDirectory } from "./test-cleanup.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-sidebar-scope-"));
const vault = path.join(temporary, "中文 Obsidian 库");
const selected = path.join(vault, "KnowledgeWorkbench");
const other = path.join(vault, "独立研究 目录");
const output = path.resolve("output/playwright/sidebar-scope");
seed(vault);
fs.mkdirSync(path.join(selected, "Cards"), { recursive: true });
fs.mkdirSync(other);
fs.writeFileSync(
  path.join(selected, "Cards", "范围内.md"),
  "# 范围内笔记\n\n这是合成测试资料。\n",
);
fs.writeFileSync(path.join(other, "第二目录.md"), "# 第二目录笔记\n");
fs.mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  KWB_VAULT: vault,
  KWB_PROFILE: path.join(temporary, "profile"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
const checks = [];
try {
  app = await electron.launch({ args: ["."], env, timeout: 30000 });
  let page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".vault-switch")).toContainText("中文 Obsidian 库");
  await page
    .getByRole("button", { name: "范围内笔记", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("笔记编辑器")).toBeVisible();
  const editor = page.getByLabel("笔记编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n收起侧栏后保留编辑内容。");
  await page.getByRole("button", { name: "收起导航侧栏", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(editor).toContainText("收起侧栏后保留编辑内容");
  await page.screenshot({ path: path.join(output, "collapsed.png") });
  await page.getByRole("button", { name: "展开导航侧栏", exact: true }).click();
  const separator = page.getByRole("separator", { name: "调整导航侧栏宽度" });
  const bounds = await separator.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(352, bounds.y + 180, { steps: 12 });
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "352");
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "336");
  await editor.press("Control+s");
  await expect(page.getByText("已保存到知识库", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      fs.readFileSync(path.join(selected, "Cards", "范围内.md"), "utf8"),
    )
    .toContain("收起侧栏后保留编辑内容");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(separator).toHaveAttribute("aria-valuenow", "336");
  checks.push(
    "collapse-keeps-editor",
    "mouse-resize",
    "keyboard-resize",
    "width-survives-reload",
  );
  // Substitute only the OS picker response; exercise the real renderer IPC,
  // flush, validation, service restart and preferences write.
  const choose = async (directory) => {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [target],
      });
    }, directory);
    await page.locator(".vault-switch").click();
  };
  await choose(selected);
  await expect(page.locator(".vault-switch")).toContainText(
    "KnowledgeWorkbench",
  );
  await expect(page.locator(".vault-scope")).toContainText(
    "子目录 · KnowledgeWorkbench",
  );
  await expect(page.locator(".note-list")).not.toContainText("从一个问题开始");
  await expect(page.locator(".note-list")).not.toContainText("第二目录笔记");
  await expect(
    page
      .locator(".note-folder > summary")
      .filter({ hasText: "KnowledgeWorkbench" }),
  ).toHaveCount(0);
  await expect(page.locator(".note-list")).toContainText("范围内笔记");
  await page.getByRole("button", { name: "写一篇笔记" }).click();
  const modal = page.getByRole("dialog");
  await modal.locator("input").fill("子目录中新建");
  await modal.getByRole("button", { name: "开始写作", exact: true }).click();
  await expect(page.getByLabel("笔记编辑器")).toContainText("子目录中新建");
  expect(
    fs
      .readdirSync(path.join(selected, "Cards"))
      .some((name) => name.startsWith("子目录中新建")),
  ).toBe(true);
  expect(fs.existsSync(path.join(selected, "KnowledgeWorkbench"))).toBe(false);
  await page.screenshot({ path: path.join(output, "subfolder-expanded.png") });
  checks.push(
    "desktop-picker-opens-subfolder",
    "tree-relative-to-selection",
    "create-without-nesting",
  );
  await choose(temporary);
  await expect(page.locator(".toast")).toContainText("不在 Obsidian");
  await expect(page.getByLabel("笔记编辑器")).toContainText("子目录中新建");
  checks.push("invalid-folder-keeps-current-editor");
  await choose(other);
  await expect(page.locator(".vault-switch")).toContainText("独立研究 目录");
  await expect(page.locator(".note-list")).toContainText("第二目录笔记");
  await expect(page.locator(".note-list")).not.toContainText("范围内笔记");
  await page.getByRole("button", { name: "收起导航侧栏", exact: true }).click();
  await app.close();
  app = undefined;
  delete env.KWB_VAULT;
  app = await electron.launch({ args: ["."], env, timeout: 30000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("button", { name: "展开导航侧栏", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开导航侧栏", exact: true }).click();
  await expect(page.locator(".vault-switch")).toContainText("独立研究 目录");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "336",
  );
  checks.push(
    "switch-between-subfolders",
    "selection-and-layout-survive-restart",
  );
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify(
      { passed: true, checks, pageErrors: errors, modelInvoked: false },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  await removeTestDirectory(temporary, os.tmpdir());
}
