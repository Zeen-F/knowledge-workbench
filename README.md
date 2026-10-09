# 知识工作台 · Knowledge Workbench

面向模拟 IC 学习的 Windows 主编辑器：随时记下想法和截图，集中整理成有来源、可修订的知识。

Markdown 与附件保存在用户选择的 Obsidian 仓库。纸间负责 PDF 阅读和批注；本应用负责写作、收集、知识卡和 AI 草稿审核。

开发状态与验证边界见 [实施记录](docs/implementation.md)。此版本处于早期预览。

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

## 工作区

`src/` 是主编辑界面，`server/` 是存储和整理服务，`shared/` 是交换契约，`desktop/` 是 Windows 桌面壳，`plugins/` 是 Codex 插件，`tests/` 保存合成测试，`docs/` 保存需求与验收记录。临时数据在忽略的 `.local/`，成品在忽略的 `release/`。

详见 [需求](docs/requirements.md)、[架构和数据](docs/architecture.md)、[纸间交换协议](docs/paperdesk-protocol.md)。
