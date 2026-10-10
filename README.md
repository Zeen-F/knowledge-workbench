# 知识工作台 · Knowledge Workbench

面向模拟 IC 学习的 Windows / macOS 主编辑器：随时记下想法和截图，集中整理成有来源、可修订的知识。

Markdown 与附件保存在用户选择的 Obsidian 仓库。纸间负责 PDF 阅读和批注；本应用负责写作、收集、知识卡和 AI 草稿审核。

开发状态与验证边界见 [实施记录](docs/implementation.md)。此版本处于早期预览。

已具备 Markdown 即时渲染与源码编辑、公式、图片、笔记树和标签页、版本冲突与历史恢复、截图收集、双路 AI 草稿审核，以及森林、暖砂、雾蓝、夜读四套皮肤。

Codex 插件可以唤起本机工作台，再在对话右侧打开同一个可编辑页面。安装和使用方式见 [开发与使用](docs/development.md)。

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
