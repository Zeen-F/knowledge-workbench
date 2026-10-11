# 知识工作台 · Knowledge Workbench

面向模拟 IC 学习的 Windows / macOS 主编辑器：随时记下想法和截图，集中整理成有来源、可修订的知识。

Markdown 与附件保存在用户选择的 Obsidian 仓库。纸间负责 PDF 阅读和批注；本应用负责写作、收集、知识卡和 AI 草稿审核。

开发状态与验证边界见 [实施记录](docs/implementation.md)。此版本处于早期预览。

已具备 Markdown 即时渲染与源码编辑、公式、图片、笔记树和标签页、版本冲突与历史恢复、截图收集、双路 AI 草稿审核，以及森林、暖砂、雾蓝、夜读四套皮肤。

Codex 插件可以唤起本机工作台，打开原生编辑面板，编辑笔记、收集材料和人工审核草稿。安装和使用方式见 [开发与使用](docs/development.md)。

当前开发工作树增加可选的[科研笔记配置](docs/research-profiles.md)：预览所选数据和固定版本的整理规则，再交给现有 Codex 插件或模型 API。此新增功能尚未包含在下方已发布安装包中。

## 安装 Windows 预览版

在 [GitHub Releases](https://github.com/Zeen-F/knowledge-workbench/releases) 下载 `KnowledgeWorkbench-0.1.0-alpha.3-win-x64.exe`。本版包含 `0.1.0-alpha.4` Codex 插件及原生面板的可靠性和输入恢复优化；仍为早期预览。

保存并退出旧工作台，断开占用安装目录的旧插件连接后运行安装器。安装器遇到文件占用会退出，保留编辑窗口。打开新工作台，在设置中点击“准备本地插件”，执行界面显示的两条命令，再在 Codex 新对话中启用“知识工作台”。

Release 同时提供独立插件模板 ZIP 和 `SHA256SUMS.txt`。插件模板不含本机配置；推荐由新桌面程序准备插件，以使用安装目录内的运行时。知识库和已有笔记保留在原位置，AI 草稿仍需人工确认。

## 开发

需要 Node.js 24+。在 PowerShell 中运行：

```powershell
npm.cmd ci
npm.cmd run dev
```

开发入口使用合成知识库，正式资料不进入源码目录。首次准备后可运行 `npm.cmd run build`、`npm.cmd start` 打开桌面应用。

```powershell
npm.cmd run check
npm.cmd run desktop:dist
```

## macOS

```sh
npm ci
npm run check
npm start
npm run desktop:dist:mac
```

Mac 使用 Command 快捷键，关闭窗口后可从 Dock 重开；退出应用使用 ⌘Q。截图需要系统屏幕录制权限。`desktop:dist` 按当前平台构建，Mac 产物为 `.app`、DMG 和 ZIP。当前为本地临时签名预览，未做 Apple 公证，具体安装和验收边界见 [Mac 适配说明](docs/macos.md)。

## 工作区

`src/` 是主编辑界面，`server/` 是存储和整理服务，`shared/` 是交换契约，`desktop/` 是 Windows / macOS 桌面壳，`plugins/` 是 Codex 插件，`tests/` 保存合成测试，`docs/` 保存需求与验收记录。临时数据在忽略的 `.local/`，成品在忽略的 `release/`。

详见 [需求](docs/requirements.md)、[架构和数据](docs/architecture.md)、[纸间交换协议](docs/paperdesk-protocol.md)。
