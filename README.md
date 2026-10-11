# 知识工作台 · Knowledge Workbench

面向模拟 IC 学习与研究的 Windows / macOS 知识编辑器。随时写下想法、收集截图与阅读材料，再整理成有来源、可修订的笔记。

**Markdown 和附件保存在自己的 Obsidian 仓库，AI 草稿由自己审核。** 知识工作台负责编辑与整理，Obsidian 继续管理知识库，纸间（Paperdesk）负责 PDF 阅读和批注。

[下载安装](#下载安装) · [第一次使用](#第一次使用) · [连接 Codex](#连接-codex) · [Mac 使用说明](docs/macos.md) · [开发指南](docs/development.md)

## 可以做什么

从自由记录开始，按需收集材料、整理草稿、核对后保存；不使用 AI 也可以完整地写作和管理笔记。

| 场景       | 能力                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| 写作与学习 | Markdown 即时渲染与源码编辑、公式、图片、双链、标签页、保存与撤销                             |
| 收集材料   | 框选截图、粘贴与拖入图片、收集箱，以及 Paperdesk 图文材料交换                                 |
| 管理知识   | 知识卡、学习记录、目录与搜索；侧栏可收起、调宽，也可直接选择 Obsidian 子文件夹                |
| 按需整理   | 把主动选择的材料交给 Codex 或配置的模型 API；整理前预览输入与规则                             |
| 核对与修订 | AI 输出先进入待审稿，支持部分接受；保留来源、适用条件和未解决问题，提供版本冲突保护与历史恢复 |

界面提供森林、暖砂、雾蓝、夜读四套主题。科研笔记配置区分原始材料、用户想法、AI 草稿、人工确认与科学验证；接受草稿不代表结论已经验证。详见[科研整理配置](docs/research-profiles.md)。

## 下载安装

当前预览版：桌面 **0.1.0-alpha.4**，Codex 插件 **0.1.0-alpha.5**。安装包自带运行时，日常使用不需要另装 Node.js。

| 平台                  | 下载                                                                                                                                                                                                                                                                        | 状态                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Windows x64           | [EXE 安装器](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-win-x64.exe)                                                                                                                                   | 未签名预览版                          |
| macOS · Apple Silicon | [DMG](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.dmg) · [ZIP](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.zip) | 本地 ad-hoc 签名，**未做 Apple 公证** |

Mac 将整个 `Knowledge Workbench.app` 放入“应用程序”或 `~/Applications` 后使用。当前未提供 Intel Mac 安装包，也未完成 Intel 实机验收。系统下载验证可能阻止未公证应用启动，详见 [Mac 安装与权限说明](docs/macos.md)。

升级前保存并退出旧工作台。Windows 还需断开占用安装目录的旧插件连接；Mac 使用 ⌘Q 完全退出，再替换应用。已有 Markdown 与附件保留原位置。当前不提供自动更新。

- [完整发布说明](https://github.com/Zeen-F/knowledge-workbench/releases/tag/v0.1.0-alpha.4)
- Windows：[SHA-256 校验文件](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/SHA256SUMS.txt) · [构建来源](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/BUILDINFO.json)
- Mac：[SHA-256 校验文件](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/SHA256SUMS-mac-arm64.txt) · [构建来源](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/BUILDINFO-mac-arm64.json)

## 第一次使用

1. **选择资料位置。** 可以打开现有 Obsidian 仓库，也可以直接选择它的子文件夹。打开整个库时，默认进入 `KnowledgeWorkbench/` 专属空间“我的知识库”；需要时可切换到整个仓库。
2. **开始记录。** 写知识卡或学习记录，把暂时没整理的文字与图片放进收集箱。目录、数量和搜索跟随当前范围。
3. **按需整理。** 选择要交给 AI 的材料，核对输入与来源后生成待审稿；逐项审核，再接受需要的部分。

直接选择已有 `KnowledgeWorkbench/` 时会复用 `Cards/`、`Journal/`、`Inbox/`、`Drafts/`、`Assets/`，不再嵌套创建同名目录。普通笔记读写限定在所选范围，已有笔记不会自动迁移。索引、任务与恢复状态存放在库外；旧待审任务请切回创建它的目录范围完成。详见[侧栏与子目录说明](docs/sidebar-and-subfolders.md)。

## 连接 Codex

1. 先将桌面应用安装到固定位置，打开“设置 → 准备本地插件”。
2. 执行界面显示的安装命令，再在 Codex 新对话中启用“知识工作台”。
3. 通过插件打开编辑面板，编辑笔记、收集材料或审核草稿；整理只使用主动共享的材料。

Release 提供[独立插件模板 ZIP](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/knowledge-workbench-codex-plugin-0.1.0-alpha.5.zip)，其中不含个人资料或本机配置。推荐由桌面程序准备插件，以使用安装目录内的运行时；移动应用后需重新准备。已有 Codex 会话可能保留旧连接，升级后请在新对话中启用。

也可以在工作台设置自己的模型 API。普通编辑不依赖模型；调用前可查看材料与整理规则。更多配置见[开发与使用](docs/development.md)。

## 验证状态

alpha.4 主线提交 `764bcea` 已通过 [Windows 检查](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152811459)、[macOS 检查与打包](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152811566)及 [Windows 安装包验收](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152822254)。

本次 Mac 交付还在 Apple Silicon 实机通过 91 项核心/服务测试、22 项安装版桌面检查、12 项侧栏与子目录检查，以及 MCP、面板协议和恢复场景检查。DMG、ZIP 内的应用资源与已验收安装版一致。详细证据与边界见 [Mac 验收记录](docs/macos.md#本版验收)及[实施记录](docs/implementation.md)。

自动测试使用临时合成库。面板协议检查不等同于 Codex 桌面原生宿主实测；本次 Mac 更新未验证真实模型调用、中文输入法组合输入、iCloud 多设备同步或下载后的 Gatekeeper 放行。项目仍处于早期预览。

## 本地开发

需要 **Node.js 24+**。macOS / Linux 使用 `npm`；Windows PowerShell 将以下命令中的 `npm` 换成 `npm.cmd`。

```sh
npm ci
npm run dev
```

开发入口使用 `.local/dev-vault/` 合成资料。打开 Electron 桌面：

```sh
npm run build
npm start
```

| 操作                           | 命令                             |
| ------------------------------ | -------------------------------- |
| 格式、类型、核心测试与生产构建 | `npm run check`                  |
| Electron 桌面回归              | `npm run test:ui`                |
| 侧栏与子目录回归               | `npm run test:sidebar-subfolder` |
| 在 Mac 构建 DMG / ZIP          | `npm run desktop:dist:mac`       |
| 在 Windows 构建 x64 安装器     | `npm.cmd run desktop:dist:win`   |

`desktop:dist` 按当前平台构建。Mac 权限、插件配置与成品回归命令见 [macOS 文档](docs/macos.md)。

`src/` 为编辑界面，`server/` 为存储与整理服务，`shared/` 为交换契约，`desktop/` 为桌面壳，`plugins/` 为 Codex 插件，`tests/` 为合成测试，`docs/` 为设计与验收记录。临时数据和安装包分别位于忽略的 `.local/` 与 `release/`；个人笔记、密钥、数据库和本机配置不进入 Git，安装包通过 Releases 分发。

更多文档：[产品需求](docs/requirements.md) · [架构与数据](docs/architecture.md) · [性能优化](docs/performance-upgrade.md) · [Paperdesk 交换协议](docs/paperdesk-protocol.md) · [实施记录](docs/implementation.md)。
