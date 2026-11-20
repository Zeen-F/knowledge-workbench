import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { seed } from "./seed.mjs";
import { createHash } from "node:crypto";
import { waitForDesktopReady } from "./desktop-readiness.mjs";
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
const executable = fs.realpathSync.native(
  process.env.KWB_TEST_EXE || createRequire(import.meta.url)("electron"),
);
let app;
const errors = [];
const startup = [];
const expectedVaultId = createHash("sha256")
  .update(fs.realpathSync(vault))
  .digest("hex");
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
  checkpoint("renderer-ready");
  startup.push(await waitForDesktopReady(page, expectedVaultId));
  console.log(JSON.stringify({ desktopReadiness: startup.at(-1) }));
  checkpoint("workspace-scope");
  await expect(page.getByLabel("笔记范围")).toHaveValue("workbench");
  await expect(page.locator(".note-list")).toContainText("专属笔记");
  await expect(page.locator(".note-list")).not.toContainText("从一个问题开始");
  await expect(page.locator("nav")).toContainText("全部笔记1");
  await expect(page.locator(".recent-notes")).not.toContainText(
    "从一个问题开始",
  );
  await page.screenshot({ path: "output/playwright/workspace-home.png" });
  checkpoint("sidebar-note-actions");
  const noteList = page.locator(".note-list");
  const row = (name) => noteList.getByRole("button", { name, exact: true });
  const originalPath = path.join(vault, "KnowledgeWorkbench/Cards/专属笔记.md");
  const originalNote = fs.readFileSync(originalPath, "utf8");
  await row("专属笔记").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "笔记操作" })).toBeVisible();
  await page.getByRole("menuitem", { name: "修改标题", exact: true }).click();
  const titleDialog = page.getByRole("dialog", { name: "修改笔记标题" });
  const titleInput = titleDialog.getByLabel("新标题");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("电路学习记录");
  await titleInput.press("Enter");
  await expect(row("电路学习记录")).toBeVisible();
  expect(fs.readFileSync(originalPath, "utf8")).toBe(
    originalNote.replace("note_type:", 'title: "电路学习记录"\nnote_type:'),
  );
  await row("电路学习记录").press("Shift+F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const moveDialog = page.getByRole("dialog", { name: "重命名或移动笔记" });
  const destination = "KnowledgeWorkbench/Cards/新文件名.md";
  await moveDialog.getByLabel("知识库内的新位置").fill(destination);
  await moveDialog.getByRole("button", { name: "预览链接更新" }).click();
  await moveDialog.getByRole("button", { name: "确认移动并更新链接" }).click();
  await expect(row("电路学习记录")).toHaveAttribute("title", destination);
  expect(fs.existsSync(originalPath)).toBe(false);
  await expect(page.getByLabel("笔记编辑器")).toHaveCount(0);
  checkpoint("sidebar-copy-and-trash");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.testCopiedLink = text;
        },
      },
    });
  });
  const movedPath = path.join(vault, destination);
  const movedNote = fs.readFileSync(movedPath, "utf8");
  await row("电路学习记录").click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制笔记链接" }).click();
  await expect(page.getByText("笔记链接已复制")).toBeVisible();
  expect(await page.evaluate(() => window.testCopiedLink)).toBe(
    "[[KnowledgeWorkbench/Cards/新文件名]]",
  );
  await row("电路学习记录").click();
  await expect(page.getByLabel("笔记编辑器")).toBeVisible();
  await row("电路学习记录").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除笔记", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: "删除笔记",
    exact: true,
  });
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  expect(fs.readFileSync(movedPath, "utf8")).toBe(movedNote);
  await row("电路学习记录").press("Shift+F10");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await deleteDialog.getByRole("button", { name: "移到回收站" }).click();
  await expect(row("电路学习记录")).toHaveCount(0);
  await expect(page.getByLabel("笔记编辑器")).toHaveCount(0);
  expect(fs.existsSync(movedPath)).toBe(false);
  const trash = path.join(vault, ".trash");
  const [entry] = fs.readdirSync(trash);
  expect(fs.readFileSync(path.join(trash, entry, destination), "utf8")).toBe(
    movedNote,
  );
  await page.getByRole("button", { name: "撤销删除", exact: true }).click();
  await expect(row("电路学习记录")).toBeVisible();
  expect(fs.readFileSync(movedPath, "utf8")).toBe(movedNote);
  checkpoint("learning-log-templates");
  const learningLogs = page
    .locator("nav")
    .getByRole("button", { name: /^学习记录/ });
  const newNote = page.getByRole("dialog", { name: "写一篇新笔记" });
  const title = newNote.getByLabel("新笔记标题");
  const templatePreview = newNote.getByRole("region", { name: "模板预览" });
  const journal = path.join(vault, "KnowledgeWorkbench/Journal");
  const readJournal = (prefix) =>
    fs.readFileSync(
      path.join(
        journal,
        fs.readdirSync(journal).find((file) => file.startsWith(prefix + "--")),
      ),
      "utf8",
    );
  await learningLogs.click();
  await page.getByRole("button", { name: /^写一篇笔记/ }).click();
  await expect(
    newNote.getByRole("combobox", { name: "类型", exact: true }),
  ).toHaveValue("learning-log");
  await expect(newNote.getByRole("radio")).toHaveCount(10);
  await expect(
    newNote.getByRole("radio", { name: "空白", exact: true }),
  ).toBeChecked();
  await expect(templatePreview).toContainText("正文只插入笔记标题");
  await title.fill("空白学习记录");
  await title.press("Enter");
  await expect(page.getByLabel("笔记编辑器")).toContainText("空白学习记录");
  expect(readJournal("空白学习记录").split("---").at(-1).trim()).toBe(
    "# 空白学习记录",
  );
  await learningLogs.click();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(
    newNote.getByRole("combobox", { name: "类型", exact: true }),
  ).toHaveValue("learning-log");
  await newNote.getByRole("radio", { name: "仿真实验" }).check();
  await expect(templatePreview).toContainText("指标与测量方法");
  await expect(templatePreview).toContainText("偏差与下一轮验证");
  await newNote.screenshot({
    path: "output/playwright/learning-log-templates.png",
  });
  await title.fill("仿真实验记录");
  await newNote.getByRole("button", { name: "开始写作" }).click();
  await expect(page.getByLabel("笔记编辑器")).toContainText("仿真实验记录");
  expect(readJournal("仿真实验记录").match(/^## .+$/gm)).toEqual([
    "## 电路与仿真条件",
    "## 指标与测量方法",
    "## 结果与证据",
    "## 偏差与下一轮验证",
  ]);
  checkpoint("note-optimization-preview");
  const assetPath = "KnowledgeWorkbench/Assets/ime-probe.png";
  fs.writeFileSync(
    path.join(vault, assetPath),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB3sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const optimizePath = path.join(journal, "跨导随记.md");
  const optimizeOriginal =
    "---\nnote_type: learning-log\nprivate_field: 属性不送出\n---\n# 跨导随记\n\n原有观察。[[跨导参考]] [[库外参考]]\n\n![[" +
    assetPath +
    "]]\n\n（请推导图中输入变化怎样传到输出。）\n";
  fs.writeFileSync(optimizePath, optimizeOriginal);
  fs.writeFileSync(
    path.join(vault, "KnowledgeWorkbench/Cards/跨导参考.md"),
    "# 跨导参考\n\n被取消的参考正文。\n",
  );
  fs.writeFileSync(
    path.join(vault, "库外参考.md"),
    "# 库外参考\n\n当前范围外。\n",
  );
  await page.getByRole("button", { name: "刷新知识库" }).click();
  await expect(row("跨导随记")).toBeVisible();
  await row("跨导随记").click({ button: "right" });
  await page.getByRole("menuitem", { name: "交给 Codex 优化" }).click();
  const optimization = page.getByRole("dialog", { name: "交给 Codex 优化" });
  const codex = optimization.getByRole("group", { name: "Codex CLI 运行设置" });
  await expect(codex.getByLabel("思考强度")).toBeEnabled({ timeout: 15000 });
  await codex.getByLabel("思考强度").selectOption("");
  const fast = codex.getByRole("checkbox", { name: "Fast 模式" });
  if (await fast.isEnabled()) await fast.uncheck();
  const suggested = optimization.getByRole("checkbox", { name: /^跨导参考/ });
  await expect(suggested).toBeChecked();
  await expect(
    optimization.getByRole("checkbox", { name: /^库外参考/ }),
  ).toHaveCount(0);
  await suggested.uncheck();
  await optimization
    .getByRole("searchbox", { name: "搜索参考笔记" })
    .fill("仿真实验记录");
  await optimization.getByRole("checkbox", { name: /^仿真实验记录/ }).check();
  await optimization.getByRole("button", { name: "预览发送内容" }).click();
  const sendPreview = optimization.getByRole("region", {
    name: "发送内容预览",
  });
  await expect(sendPreview).toContainText("原有观察");
  await expect(sendPreview).toContainText("仿真实验记录");
  await expect(sendPreview).toContainText("笔记里的批注与问题（1）");
  await expect(sendPreview).toContainText("Fast 关闭");
  await sendPreview.getByText("随正文交接的图片（1）", { exact: true }).click();
  await expect(
    sendPreview.getByRole("img", { name: /正文第.*行的图片/ }),
  ).toBeVisible();
  await expect(sendPreview).not.toContainText("被取消的参考正文");
  await expect(sendPreview).not.toContainText("属性不送出");
  await optimization.screenshot({
    path: "output/playwright/note-optimization-preview.png",
  });
  await optimization.getByRole("button", { name: "返回选择" }).click();
  await optimization.getByRole("button", { name: "取消", exact: true }).click();
  expect(fs.readFileSync(optimizePath, "utf8")).toBe(optimizeOriginal);
  expect(
    (await page.evaluate(() => window.workbench.invoke("GET", "/jobs"))).some(
      (job) => job.snapshot.noteRevision,
    ),
  ).toBe(false);
  checkpoint("image-ime-composition");
  const examples = [
    ["内嵌图片拼音", `![[${assetPath}]]`],
    ["Markdown 图片拼音", `![测试图片](/${assetPath})`],
  ];
  for (const [name, markup] of examples)
    fs.writeFileSync(
      path.join(journal, name + ".md"),
      `# ${name}\n\n${markup}\n`,
    );
  await page.getByRole("button", { name: "刷新知识库" }).click();
  const cdp = await app.context().newCDPSession(page);
  for (const [name, markup] of examples) {
    await row(name).click();
    const imageEditor = page.getByLabel("笔记编辑器");
    const image = imageEditor.locator(".md-rendered img");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBe(1);
    const firstLine = imageEditor.locator(
      ":is(.md-rendered, .cm-line):has(img:not(.cm-widgetBuffer)) + .cm-line",
    );
    await firstLine.click({ position: { x: 2, y: 8 } });
    for (const text of ["s", "sheng"]) {
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await expect(firstLine).toHaveText(text);
    }
    await cdp.send("Input.insertText", { text: "生" });
    await expect(firstLine).toHaveText("生");
    await expect(image).toHaveCount(1);
    await expect
      .poll(() => fs.readFileSync(path.join(journal, name + ".md"), "utf8"))
      .toBe(`# ${name}\n\n${markup}\n生`);
  }
  await cdp.detach();
  checkpoint("child-note-from-editor");
  const parentTitle = "低压带隙结构";
  const childTitle = "小信号 [A#1] 推导";
  const anchorText = "图下待推导";
  const restOfLine = "，后文仍在同一行。";
  const parentPath = path.join(journal, parentTitle + ".md");
  const parentRaw = [
    "---",
    "note_type: learning-log",
    "---",
    "",
    "# " + parentTitle,
    "",
    "![[" + assetPath + "]]",
    anchorText + restOfLine,
    "",
    "后续段落",
    "",
  ].join("\r\n");
  fs.writeFileSync(parentPath, parentRaw);
  await page.getByRole("button", { name: "刷新知识库" }).click();
  await row(parentTitle).click();
  const childFlowEditor = page.getByLabel("笔记编辑器");
  const anchor = childFlowEditor.getByText(anchorText + restOfLine, {
    exact: true,
  });
  await anchor.scrollIntoViewIfNeeded();
  const caretBounds = await anchor.evaluate((line, at) => {
    const caret = document.createRange();
    caret.setStart(line.firstChild, at);
    caret.collapse(true);
    return caret.getBoundingClientRect().toJSON();
  }, anchorText.length);
  await page.mouse.click(
    caretBounds.left,
    caretBounds.top + caretBounds.height / 2,
    {
      button: "right",
    },
  );
  await expect(page.getByRole("menu", { name: "正文操作" })).toBeVisible();
  await page.getByRole("menuitem", { name: "新建子笔记" }).click();
  const childDialog = page.getByRole("dialog", { name: "新建子笔记" });
  const childName = childDialog.getByRole("textbox", { name: "新笔记标题" });
  await expect(childName).toBeFocused();
  await childName.fill(childTitle);
  await childDialog.getByRole("radio", { name: "公式推导" }).check();
  await childDialog.getByRole("button", { name: "创建并打开" }).click();
  await expect(childFlowEditor).toContainText("目标与已知条件");
  const backlink = childFlowEditor.getByRole("link", { name: "返回父笔记" });
  await expect(backlink).toBeVisible();
  const childFile = fs
    .readdirSync(journal)
    .find((file) => file.startsWith(childTitle + "--"));
  expect(childFile).toBeDefined();
  const savedParent = fs.readFileSync(parentPath, "utf8");
  const beforeLink = parentRaw.slice(
    0,
    parentRaw.indexOf(anchorText) + anchorText.length,
  );
  expect(savedParent.startsWith(beforeLink + "[")).toBe(true);
  expect(savedParent.endsWith(parentRaw.slice(beforeLink.length))).toBe(true);
  expect(
    savedParent.slice(beforeLink.length, savedParent.indexOf(restOfLine)),
  ).not.toMatch(/[\r\n]/);
  const derivedText = "悬浮卡片应显示这段推导正文。";
  await childFlowEditor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  await page.keyboard.insertText("\n" + derivedText);
  await childFlowEditor.press("ControlOrMeta+s");
  await expect
    .poll(() => fs.readFileSync(path.join(journal, childFile), "utf8"))
    .toContain(derivedText);
  await backlink.click();
  const childLink = childFlowEditor.getByRole("link", {
    name: childTitle,
    exact: true,
  });
  await expect(childLink).toBeVisible();
  const located = childFlowEditor.locator(".cm-child-reference");
  await expect(located).toContainText(anchorText);
  await expect(located).toContainText(restOfLine);
  await expect(
    located.getByRole("link", { name: childTitle }),
  ).toBeInViewport();
  await expect(childFlowEditor).toContainText(anchorText);
  await page
    .getByRole("button", { name: "关闭 " + childTitle, exact: true })
    .click();
  await childLink.hover();
  const hover = page.getByLabel("笔记预览", { exact: true });
  await expect(hover).toContainText(derivedText);
  await expect(childFlowEditor).toContainText("后续段落");
  await hover.hover();
  await expect(hover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hover).toHaveCount(0);
  await childLink.click();
  await expect(childFlowEditor).toContainText(derivedText);
  await expect(hover).toHaveCount(0);
  await page
    .getByRole("button", { name: "关闭 " + parentTitle, exact: true })
    .click();
  const newOpening =
    "# " +
    parentTitle +
    "\r\n\r\n" +
    Array.from({ length: 70 }, (_, i) => "上方补充段落 " + (i + 1)).join(
      "\r\n\r\n",
    );
  fs.writeFileSync(
    parentPath,
    savedParent.replace("# " + parentTitle, newOpening),
  );
  await childFlowEditor.press("Shift+F10");
  await page.getByRole("menuitem", { name: "在父笔记中定位" }).click();
  await expect(
    located.getByRole("link", { name: childTitle }),
  ).toBeInViewport();
  await expect(located).toContainText(restOfLine);
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
  await page.getByRole("button", { name: /^未分类 \/ 历史收集 ·/ }).click();
  await page
    .getByLabel("快速记录想法")
    .fill("这是一份隔离测试想法，需要保留来源。");
  await page.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(page.locator(".capture-card")).toHaveCount(1);
  checkpoint("local-codex-default");
  await page.locator(".capture-card").getByRole("checkbox").check();
  await page.getByRole("button", { name: "整理所选 1", exact: true }).click();
  const batching = page.getByRole("dialog", { name: "整理这一批材料" });
  const executor = batching.getByRole("combobox", {
    name: "执行方式",
    exact: true,
  });
  await expect(executor).toHaveValue("codex-cli");
  await expect(
    executor.getByRole("option", { name: "模型 API（备用）" }),
  ).toHaveCount(1);
  await expect(batching.locator(".executor-status")).toBeVisible();
  await executor.selectOption("api");
  await expect(
    batching.getByRole("button", { name: "预览交付内容" }),
  ).toBeEnabled();
  await batching.getByRole("button", { name: "返回", exact: true }).click();
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
    await page.evaluate(() => window.workbench.capture());
    await expect(
      page.getByRole("dialog", { name: "选择本次收集任务", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消收集", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "选择本次收集任务", exact: true }),
    ).toHaveCount(0);
    const permission = await app.evaluate(({ systemPreferences }) =>
      systemPreferences.getMediaAccessStatus("screen"),
    );
    console.log(JSON.stringify({ screenPermission: permission }));
    if (["denied", "restricted"].includes(permission)) {
      const error = await page.evaluate(() =>
        window.workbench.capture("history").then(
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
  startup.push(await waitForDesktopReady(reopened, expectedVaultId));
  console.log(JSON.stringify({ desktopReadiness: startup.at(-1) }));
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
  checkpoint("collection-tasks-native");
  await reopened
    .getByRole("button", { name: /收集箱/ })
    .first()
    .click();
  await expect(
    reopened.getByRole("dialog", { name: "选择本次收集任务", exact: true }),
  ).toBeVisible();
  await reopened
    .getByRole("textbox", { name: "新收集任务名称", exact: true })
    .fill("Native synthetic study");
  await reopened
    .getByRole("button", { name: "新建并开始收集", exact: true })
    .click();
  await expect(reopened.locator(".capture-card")).toHaveCount(0);
  await reopened
    .getByLabel("快速记录想法")
    .fill("Native task isolated thought");
  await reopened.getByRole("button", { name: "保存想法", exact: true }).click();
  await expect(reopened.locator(".capture-card")).toHaveCount(1);
  await reopened
    .getByRole("button", { name: "结束本次收集", exact: true })
    .click();
  await expect(
    reopened.getByRole("dialog", { name: "选择本次收集任务", exact: true }),
  ).toBeVisible();
  await reopened
    .getByRole("button", {
      name: "继续任务 Native synthetic study",
      exact: true,
    })
    .click();
  await expect(reopened.locator(".capture-card")).toContainText(
    "Native task isolated thought",
  );
  await reopened
    .getByRole("button", {
      name: "删除 Native task isolated thought",
      exact: true,
    })
    .click();
  await reopened
    .getByRole("button", { name: "确认删除 1 份", exact: true })
    .click();
  await expect(reopened.locator(".capture-card")).toHaveCount(0);
  await reopened
    .getByRole("button", { name: "撤销删除 1 份", exact: true })
    .click();
  await expect(reopened.locator(".capture-card")).toHaveCount(1);
  checkpoint("completed");
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "desktop-start",
        "task-selection-scope-end-resume-trash-undo",
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
        "sidebar-title-and-file-rename",
        "sidebar-link-copy-and-recoverable-delete",
        "learning-log-template-picker-and-blank",
        "note-optimization-scoped-reference-preview",
        "ime-composition-on-first-line-after-images",
        "editor-context-child-note-and-hover-round-trip",
        "codex-cli-first-api-and-conversation-options",
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
      startup,
      screenshots: "output/playwright",
    }),
  );
} catch (error) {
  console.error(`Desktop test failed during ${stage}:`, error);
  const page = app?.windows()[0];
  const diagnostic = {
    stage,
    error: String(error.message),
    startup,
    rendererErrors: errors,
  };
  try {
    const saved = JSON.parse(
      fs.readFileSync(path.join(profile, "runtime.json"), "utf8"),
    );
    diagnostic.runtime = {
      service: saved.service,
      apiVersion: saved.apiVersion,
      expectedVault: saved.vaultId === expectedVaultId,
    };
  } catch {
    diagnostic.runtime = { available: false };
  }
  if (page) {
    let timer;
    try {
      diagnostic.renderer = await Promise.race([
        page.evaluate(() => ({
          readyState: document.readyState,
          preload: typeof window.workbench?.invoke === "function",
          scopeControl: Boolean(
            document.querySelector('select[aria-label="笔记范围"]'),
          ),
        })),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ observationTimedOut: true }),
            3000,
          );
        }),
      ]);
    } catch (failure) {
      diagnostic.renderer = { error: String(failure.message) };
    } finally {
      clearTimeout(timer);
    }
  }
  console.error(JSON.stringify({ desktopFailure: diagnostic }));
  fs.writeFileSync(
    "output/playwright/desktop-failure.json",
    JSON.stringify(diagnostic, null, 2),
  );
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
