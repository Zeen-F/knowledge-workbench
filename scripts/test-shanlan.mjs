// Synthetic-only regression; never connects to the desktop's configured vault.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../server/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-shanlan-"));
let service, browser;
try {
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  service = await startService({
    vaultDir,
    dataDir: path.join(root, "profile"),
    distDir: path.resolve("dist"),
  });
  for (const title of ["Alpha reference", "Beta reference", "Gamma reference"])
    service.vault.create(title, "concept", `SYNTHETIC_BODY_${title}`);
  service.captures.add({ title: "Inbox only", text: "SYNTHETIC_INBOX" });
  browser = await chromium.launch({
    executablePath: process.env.KWB_TEST_EXECUTABLE,
    channel:
      process.env.KWB_TEST_BROWSER ||
      (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(15000);
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/"))
      writes.push(request.url());
  });
  await page.goto(service.baseUrl);
  await expect(
    page.getByRole("textbox", { name: "搜索知识库", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-preview",
    "shanlan",
  );
  await page.goto(`${service.baseUrl}/?visual=shanlan`);
  await expect(page.locator("html")).toHaveAttribute("data-preview", "shanlan");
  const trigger = page.getByRole("button", {
    name: "快速定位笔记",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "快速定位笔记",
    exact: true,
  });
  const search = dialog.getByRole("combobox", {
    name: "按标题查找笔记",
    exact: true,
  });
  const options = dialog.getByRole("option");
  await expect(search).toBeFocused();
  await expect(options).toHaveCount(3);
  await search.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.fill("SYNTHETIC_BODY");
  await expect(options).toHaveCount(0);
  await search.press("Enter");
  await expect(dialog).toBeVisible();
  await search.fill("Inbox");
  await expect(options).toHaveCount(0);
  await search.fill("Beta");
  await expect(options).toHaveCount(1);
  await search.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("笔记编辑器", { exact: true })).toContainText(
    "SYNTHETIC_BODY_Beta reference",
  );
  await trigger.click();
  await expect(search).toBeFocused();
  await search.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭快速定位", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  writes.length = 0;
  await page.getByRole("button", { name: "紧凑列表", exact: true }).click();
  await page.getByRole("button", { name: "月下场景", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-shelf-density",
    "comfortable",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-shelf-scene",
    "moon",
  );
  assert.deepEqual(writes, []);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-shelf-density",
    "compact",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-shelf-scene",
    "dawn",
  );
  await page.getByRole("button", { name: "收起导航侧栏", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    page.getByRole("textbox", { name: "搜索知识库", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 640 });
  await expect(trigger).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "月下场景", exact: true }),
  ).toBeInViewport();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await trigger.click();
  await expect(dialog).toBeInViewport();
  await expect(search).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(
    "PASS Shanlan opt-in, title-only note scope, keyboard navigation/focus, search shortcut, narrow layout and nonpersistent appearance",
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
