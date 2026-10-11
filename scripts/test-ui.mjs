import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { seed } from "./seed.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { preparePlugin } from "../desktop/plugin-setup.mjs";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-ui-")),
  vault = path.join(testRoot, "知识库 中文 vault"),
  profile = path.join(testRoot, "配置 中文 profile");
seed(vault);
fs.mkdirSync(path.join(vault, "KnowledgeWorkbench/Cards"), { recursive: true });
fs.writeFileSync(
  path.join(vault, "KnowledgeWorkbench/Cards/专属笔记.md"),
  "---\nnote_type: concept\n---\n# 专属笔记\n\n只属于工作台的合成笔记。\n",
);
fs.mkdirSync("output/playwright", { recursive: true });
const env = { ...process.env, KWB_VAULT: vault, KWB_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const executable =
  process.env.KWB_TEST_EXE || createRequire(import.meta.url)("electron");
let app;
const errors = [];
let stage = "launch";
const checkpoint = (name) => {
  stage = name;
  console.log(JSON.stringify({ desktopTestStage: stage }));
};
try {
  checkpoint("launch");
  app = await electron.launch({
    executablePath: executable,
    args: process.env.KWB_TEST_EXE ? [] : ["."],
    env,
    timeout: 30000,
  });
  app.context().setDefaultTimeout(15000);
  app.context().setDefaultNavigationTimeout(30000);
  app.process().stderr.on("data", (bytes) => {
    if (/Error|Exception/.test(bytes.toString())) process.stderr.write(bytes);
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  checkpoint("workspace-scope");
  await expect(page.getByLabel("笔记范围")).toHaveValue("workbench");
  await expect(page.locator(".note-list")).toContainText("专属笔记");
  await expect(page.locator(".note-list")).not.toContainText("从一个问题开始");
  await expect(page.locator("nav")).toContainText("全部笔记1");
  await expect(page.locator(".recent-notes")).not.toContainText(
    "从一个问题开始",
  );
  await page.screenshot({ path: "output/playwright/workspace-home.png" });
  await page.getByLabel("搜索知识库").fill("从一个问题开始");
  await expect(page.locator(".note-list")).toContainText("没有找到匹配笔记");
  await page.getByLabel("笔记范围").selectOption("vault");
  await expect(page.locator(".note-list")).toContainText("从一个问题开始");
  checkpoint("editor-and-themes");
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
  checkpoint("editing-and-undo");
  await page.getByRole("button", { name: "即时渲染", exact: true }).click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  expect(fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8")).toBe(
    original,
  );
  const editor = page.getByLabel("笔记编辑器");
  if (process.platform === "darwin") {
    const roles = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.flatMap((item) =>
        (item.submenu?.items || []).map((child) => child.role),
      ),
    );
    for (const role of ["quit", "close", "copy", "paste", "selectall"])
      expect(roles).toContain(role);
  }
  await editor.click();
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  await editor.press("Enter");
  await page.keyboard.insertText("中文补充：保存、撤销和重开测试。");
  await editor.press("ControlOrMeta+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"))
    .toContain("中文补充");
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  await page.keyboard.insertText("UNDO_PROBE");
  await page
    .getByRole("button", { name: "今天的学习记录", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "从一个问题开始", exact: true })
    .first()
    .click();
  await editor.press("ControlOrMeta+z");
  await editor.press("ControlOrMeta+s");
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
  let runtime = JSON.parse(
    fs.readFileSync(path.join(profile, "runtime.json"), "utf8"),
  );
  checkpoint("plugin-runtime");
  if (!process.env.KWB_TEST_EXE) {
    preparePlugin({
      root: process.cwd(),
      profileDir: profile,
      executable: process.execPath,
    });
    const launch = JSON.parse(
      fs.readFileSync(path.join(profile, "launch.json"), "utf8"),
    );
    expect(launch.executable).toBe(executable);
    expect(fs.existsSync(launch.executable)).toBe(true);
  }
  await page.evaluate(() =>
    window.workbench.invoke("DESKTOP", "/plugin/setup"),
  );
  const pluginConfig = JSON.parse(
    fs.readFileSync(
      path.join(
        profile,
        "plugin-marketplace/plugins/knowledge-workbench/.mcp.json",
      ),
      "utf8",
    ),
  );
  const transport = pluginConfig.mcpServers["knowledge-workbench"];
  expect(transport.command).toBe(executable);
  const pluginClient = new Client({
    name: "desktop-runtime-check",
    version: "1.0.0",
  });
  try {
    await pluginClient.connect(
      new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: { ...process.env, ...transport.env },
        stderr: "pipe",
      }),
    );
    const opened = await pluginClient.callTool({
      name: "workbench_open",
      arguments: {},
    });
    expect(opened.isError).not.toBe(true);
    expect((await pluginClient.listTools()).tools).toHaveLength(9);
  } finally {
    await pluginClient.close();
  }
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
  checkpoint("draft-review");
  await page
    .getByRole("button", { name: /待审稿/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "确认并保存", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  const reviewEditor = page.getByLabel("笔记编辑器");
  await reviewEditor.click();
  await reviewEditor.press("ControlOrMeta+a");
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
  if (process.platform === "darwin") {
    checkpoint("close-and-reopen-window");
    await page
      .getByRole("button", { name: "从一个问题开始", exact: false })
      .first()
      .click();
    await editor.click();
    await editor.press("Meta+ArrowDown");
    await page.keyboard.insertText("\n关闭窗口前的待保存文字。");
    // CDP key injection does not dispatch native macOS menu accelerators.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(false);
    expect(
      fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"),
    ).toContain("关闭窗口前的待保存文字");
    expect((await request("/status")).vault.id).toBe(runtime.vaultId);
    await app.evaluate(({ app }) => app.emit("activate"));
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    const permission = await app.evaluate(({ systemPreferences }) =>
      systemPreferences.getMediaAccessStatus("screen"),
    );
    console.log(JSON.stringify({ screenPermission: permission }));
    if (["denied", "restricted"].includes(permission)) {
      const error = await page.evaluate(() =>
        window.workbench.capture().then(
          () => "unexpected-success",
          (error) => error.message,
        ),
      );
      expect(error).toContain("屏幕与系统音频录制");
    }
  }
  checkpoint("quit-and-restart");
  await app.close();
  app = undefined;
  await expect
    .poll(() => fs.existsSync(path.join(profile, "runtime.json")))
    .toBe(false);
  app = await electron.launch({
    executablePath: executable,
    args: process.env.KWB_TEST_EXE ? [] : ["."],
    env,
    timeout: 30000,
  });
  app.context().setDefaultTimeout(15000);
  app.context().setDefaultNavigationTimeout(30000);
  const reopened = await app.firstWindow();
  await expect(reopened.getByLabel("笔记范围")).toHaveValue("workbench");
  await expect(reopened.locator(".note-list")).not.toContainText(
    "从一个问题开始",
  );
  await reopened.getByLabel("笔记范围").selectOption("vault");
  await reopened
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  await expect(reopened.getByLabel("笔记编辑器")).toContainText("中文补充");
  runtime = JSON.parse(
    fs.readFileSync(path.join(profile, "runtime.json"), "utf8"),
  );
  if (process.platform === "darwin") {
    checkpoint("failed-save-prevents-quit");
    await reopened.evaluate(() => {
      window.__removeFailingFlush = window.workbench.onFlush(() => {
        throw new Error("synthetic save failure");
      });
    });
    await app.evaluate(({ app, dialog }) => {
      globalThis.__originalDialog = dialog.showMessageBox;
      dialog.showMessageBox = async (_window, options) => {
        globalThis.__closeWarning = options.message;
        return { response: 0 };
      };
      app.quit();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.__closeWarning))
      .toContain("synthetic save failure");
    expect((await request("/status")).vault.id).toBe(runtime.vaultId);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(true);
    await reopened.evaluate(() => window.__removeFailingFlush());
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = globalThis.__originalDialog;
    });
  }
  checkpoint("completed");
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
        "desktop-plugin-runtime",
        "workspace-default-and-counts",
        "workspace-search-scope",
        "whole-vault-switch",
        "workspace-default-after-restart",
        ...(process.platform === "darwin"
          ? [
              "native-menu",
              "command-shortcuts",
              "close-keeps-service",
              "dock-reopen",
              "quit-stops-service",
              "failed-save-prevents-quit",
            ]
          : []),
      ],
      screenshots: "output/playwright",
    }),
  );
} catch (error) {
  console.error(`Desktop test failed during ${stage}:`, error);
  const page = app?.windows()[0];
  if (page)
    await page
      .screenshot({
        path: "output/playwright/desktop-failure.png",
        timeout: 5000,
      })
      .catch(() => {});
  throw error;
} finally {
  checkpoint("cleanup");
  if (app) await app.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
