// Uses only a temporary synthetic vault and a mock global-shortcut registrar.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startService } from "../server/app.ts";
import {
  createCaptureShortcuts,
  DEFAULT_CAPTURE_SHORTCUT,
} from "../desktop/shortcuts.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-inbox-controls-"));
let service, browser;
try {
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  service = await startService({
    vaultDir,
    dataDir: path.join(root, "profile"),
    distDir: path.resolve("dist"),
    desktop: true,
  });
  const first = service.captures.add({
    title: "Alpha synthetic",
    text: "KEEP_ALPHA",
  });
  const second = service.captures.add({
    title: "Beta synthetic",
    text: "KEEP_BETA",
  });
  const originals = [first, second].map((c) =>
    fs.readFileSync(service.vault.absolute(c.path)),
  );
  const callbacks = new Map();
  let conflict = false,
    captures = 0;
  const shortcutFile = path.join(root, "shortcuts.json");
  const manager = createCaptureShortcuts({
    shortcuts: {
      register: (key, cb) => {
        if (conflict) return false;
        callbacks.set(key, cb);
        return true;
      },
      unregister: (key) => callbacks.delete(key),
    },
    read: () =>
      fs.existsSync(shortcutFile)
        ? JSON.parse(fs.readFileSync(shortcutFile))
        : {},
    write: (value) => fs.writeFileSync(shortcutFile, JSON.stringify(value)),
    capture: () => captures++,
  });
  manager.initialize();
  browser = await chromium.launch({
    channel: process.env.KWB_TEST_BROWSER || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("syntheticShortcut", (body) =>
    !body || body.action === "read"
      ? manager.status()
      : body.action === "record"
        ? manager.setRecording(body.recording)
        : manager.save(body.accelerator),
  );
  await page.addInitScript(
    ({ token }) => {
      window.workbench = {
        invoke: async (method, route, body) => {
          if (method === "DESKTOP") return window.syntheticShortcut(body);
          const response = await fetch("/api" + route, {
            method,
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const data = await response.json();
          if (!response.ok) throw Error(data.error || "failed");
          return data;
        },
        onCapture: () => () => {},
        onFlush: () => () => {},
        onShortcutRecorded: () => () => {},
        capture: async () => {
          throw Error("Real capture must not run in this test");
        },
      };
    },
    { token: service.token },
  );
  await page.goto(service.baseUrl + "/?visual=shanlan");
  await page.getByRole("button", { name: /^收集箱/ }).click();
  const card = page.locator(".capture-card");
  await expect(card).toHaveCount(2);
  await page.getByLabel("选择 Alpha synthetic", { exact: true }).check();
  await page.getByLabel("选择 Beta synthetic", { exact: true }).check();
  await page.getByLabel("搜索材料", { exact: true }).fill("Alpha");
  await page
    .getByRole("button", { name: "删除所选 2 份", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "删除 2 份材料？",
    exact: true,
  });
  await expect(dialog).toContainText("1 份被当前筛选隐藏");
  await expect(dialog.getByLabel("将删除的材料").locator("li")).toHaveCount(2);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(service.captures.list().length, 2);
  await page
    .getByRole("button", { name: "删除所选 2 份", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "确认删除 2 份", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "删除所选 0 份", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("把值得回看的内容放进来", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "撤销删除 2 份", exact: true })
    .click();
  await expect(card).toHaveCount(1); // Existing filter remains in force.
  await page.getByLabel("搜索材料", { exact: true }).fill("");
  await expect(card).toHaveCount(2);
  await page.route("**/api/captures/trash", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic unavailable" }),
    }),
  );
  await page
    .getByRole("button", { name: "删除 Alpha synthetic", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "删除 1 份材料？", exact: true });
  await dialog
    .getByRole("button", { name: "确认删除 1 份", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "synthetic unavailable",
  );
  assert.equal(service.captures.list().length, 2);
  await page.unroute("**/api/captures/trash");
  await dialog
    .getByRole("button", { name: "确认删除 1 份", exact: true })
    .click();
  await expect(card).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: /^收集箱/ }).click();
  await page
    .getByRole("button", { name: "已删除 · 恢复材料", exact: true })
    .click();
  const trashDialog = page.getByRole("dialog", {
    name: "已删除的材料",
    exact: true,
  });
  await expect(
    trashDialog.getByRole("button", {
      name: "恢复 Alpha synthetic",
      exact: true,
    }),
  ).toBeVisible();
  await trashDialog
    .getByRole("button", { name: "恢复 Alpha synthetic", exact: true })
    .click();
  await expect(
    trashDialog.getByText("没有已删除的材料", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "已删除 · 恢复材料", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "工作台设置",
    exact: true,
  });
  await expect(settings).toContainText("当前：");
  const input = settings.getByRole("textbox", {
    name: "框选截图快捷键",
    exact: true,
  });
  await settings
    .getByRole("button", { name: "录入快捷键", exact: true })
    .click();
  await expect(input).toBeFocused();
  const primary = await page.evaluate(() =>
    /Mac/.test(navigator.platform) ? "Meta" : "Control",
  );
  await input.press(primary + "+Shift+K");
  await expect(input).toHaveValue("CommandOrControl+Shift+K");
  await input.press("Tab");
  await settings
    .getByRole("button", { name: "保存快捷键", exact: true })
    .click();
  await expect(settings).toContainText("快捷键已保存");
  assert.equal(manager.status().accelerator, "CommandOrControl+Shift+K");
  conflict = true;
  await settings
    .getByRole("button", { name: "录入快捷键", exact: true })
    .click();
  await expect(input).toBeFocused();
  await input.press(primary + "+Alt+L");
  await expect(input).toHaveValue("CommandOrControl+Alt+L");
  await input.press("Tab");
  await settings
    .getByRole("button", { name: "保存快捷键", exact: true })
    .click();
  await expect(settings.getByRole("alert")).toContainText("原快捷键保持不变");
  assert.equal(manager.status().accelerator, "CommandOrControl+Shift+K");
  conflict = false;
  await settings
    .getByRole("button", { name: "恢复默认快捷键", exact: true })
    .click();
  await expect(input).toHaveValue(DEFAULT_CAPTURE_SHORTCUT);
  await settings.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".capture-actions")).toContainText(
    manager.status().label,
  );
  assert.equal(captures, 0);
  for (let i = 0; i < originals.length; i++)
    assert.deepEqual(
      fs.readFileSync(service.vault.absolute([first, second][i].path)),
      originals[i],
    );
  assert.deepEqual(errors, []);
  console.log(
    "PASS synthetic Shanlan single/batch deletion, filtered scope, cancel, keyboard, count, empty state, undo, failure retry, persistent recovery; shortcut recording, save, conflict fallback, reset, hint sync; original files unchanged and no screenshots captured",
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
