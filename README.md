# 知识工作台 · Knowledge Workbench

**Vibe Coding 项目 · 早期预览**

面向模拟 IC 学习与研究，把想法、截图和资料整理成**有来源、可修订的笔记**。支持 Windows 与 macOS，Markdown 和附件保存在你选择的 Obsidian 知识库。

项目通过与 AI 对话、反复试用和修改持续开发。你可以先自由写作，需要时再把选中的材料交给 Codex 或模型 API；AI 结果进入待审区，由你核对并确认保存。

[下载预览版](#下载与安装) · [第一次使用](#第一次使用) · [可选 AI 整理](#可选-ai-整理) · [反馈问题](https://github.com/Zeen-F/knowledge-workbench/issues)

## 下载与安装

当前公开桌面版为 [**0.1.0-alpha.4**](https://github.com/Zeen-F/knowledge-workbench/releases/tag/v0.1.0-alpha.4)，配套 Codex 插件为 **0.1.0-alpha.5**。**桌面包自带运行环境，普通使用无需安装 Node.js，也不要求配置 AI。**

| 平台 | 下载 | 安装方式 |
| --- | --- | --- |
| Windows x64 | [Windows 安装器](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-win-x64.exe) | 运行安装器，按界面提示安装 |
| macOS · Apple Silicon（M 系列） | [Mac DMG](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.dmg) · [Mac ZIP](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.zip) | 将整个 `Knowledge Workbench.app` 放入“应用程序”或 `~/Applications` 后打开 |

Windows 包未签名；Mac 使用本地 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证。请核对下载来源并遵循系统提示；Mac 的本地启动验收不等同于下载后的 Gatekeeper 放行。目前未提供 Intel Mac 或其他架构安装包，也没有自动更新。

[Release 页面](https://github.com/Zeen-F/knowledge-workbench/releases/tag/v0.1.0-alpha.4)同时提供 Windows／Mac 分别使用的 SHA-256 校验文件、构建来源与验证范围。Mac 操作和权限说明见[macOS 指南](docs/macos.md)。

**更新前：** 保存并退出旧工作台，备份资料；Windows 还需断开占用安装目录的旧插件连接，安装器遇到文件占用会退出。Mac 使用 ⌘Q 完全退出后再替换应用。原有 Markdown 和附件保留在原位置；使用 Codex 插件时，升级桌面后重新准备并更新插件。

## 第一次使用

1. **选择资料位置。** 打开桌面应用，选择已有 Obsidian 知识库根目录（包含 `.obsidian`），也可以直接选择库内子文件夹。没有知识库时，先用 Obsidian 创建一个。
2. **写第一篇笔记。** 新建知识卡或学习记录，写下自己的理解；可以插入公式、粘贴图片，在即时渲染与源码模式间切换。
3. **积累材料。** 把截图和想法放进收集箱，暂时不使用 AI 也可以继续记录。Mac 上使用工作台框选截图，需要屏幕录制权限；先按提示授权并重启应用。
4. **核对保存。** 等待保存完成，再切换设备或退出。Mac 关闭窗口后可从 Dock 重开，⌘Q 才会完全退出；保存失败时保留窗口处理。

选择整个库时，默认进入 `KnowledgeWorkbench/` 专属空间，可切换到“整个 Obsidian 仓库”。直接选择子目录时，显示与搜索限于所选范围；选择已有 `KnowledgeWorkbench/` 会直接复用。具体目录规则见[侧栏与子目录说明](docs/sidebar-and-subfolders.md)。

## 一次学习可以这样记录

**收集电路图与疑问 → 写下自己的分析 → 按需整理材料 → 审核草稿 → 回查来源并继续修订**

- **随时写：** Markdown 即时渲染与源码编辑，支持公式、图片、笔记树和标签页。
- **随时收集：** 区域截图、粘贴图片、导入材料，并保留原始想法。
- **整理成笔记：** 用知识卡积累主题，用学习记录保留过程；通过标签、搜索和链接查找内容。
- **保留修改过程：** 版本冲突提示、历史与草稿恢复；保存失败时保留输入。
- **调整工作区：** 收起或拖动侧栏、选择 Obsidian 子目录，切换森林、暖砂、雾蓝、夜读四套皮肤。

纸间负责 PDF 阅读与批注；工作台负责主编辑、材料整理和审核。两款工具可以分别使用，联动版本要求见[下方说明](#与纸间-paperdesk-配合)。

## 可选 AI 整理

### 先预览，再交付，最后审核

在收集箱勾选材料，点击“整理所选”，选择参考笔记、执行方式与整理配置：

1. 点击“预览交付内容”，核对选中的文字、图片、参考笔记和整理规则。预览本身不调用模型。
2. Codex 方式先确认共享批次，再在原生面板点击“交给当前 Codex 对话”，或复制指令到已启用插件的对话；API 方式点击“确认发送并生成草稿”。
3. 返回结果进入待审区；核对来源、修改草稿，再点击“确认并保存”。

普通浏览和编辑不会自动把全库交给模型。主动交付的材料、图片、参考笔记与指令会进入所选服务的模型请求；分享未公开资料前，请核对内容与服务方的数据政策。

**人工确认保存不等于科学结论已验证。** 接受后的内容仍保持 `working`，不会自动提升为 `canonical`。

### 两种执行方式

| 方式 | 准备方法 |
| --- | --- |
| Codex 插件 | 在桌面“设置 → 准备本地插件”生成本机配置，执行界面显示的两条安装命令，在 Codex 新对话中启用“知识工作台” |
| 模型 API | 在桌面设置填写服务地址、协议、支持图像输入的模型和密钥；密钥使用系统加密保存 |

Codex 插件可唤起本机工作台、打开原生编辑面板，并将选定批次交给当前对话。Release 中的独立插件 ZIP 是模板，不含本机运行配置；推荐由已安装桌面程序准备插件。Mac 应先把应用放到固定位置，移动后重新准备。

具体步骤与宿主兼容边界见[插件和 API 使用说明](docs/development.md#codex-内编辑)。

### 模拟 IC 科研配置

除通用整理外，可选“模拟 IC 科研”，按研究笔记、论文提炼或电路实验组织材料，区分原文、用户假设、AI 推断与未知项，保留来源和适用条件。

单位、PVT、供电、温度、频率和负载等提示仅做有限的确定性检查；未提供的条件不会补成“典型值”，没有提示也不代表结论正确。配置与规则版本可在交付前预览，详见[科研笔记配置](docs/research-profiles.md)。

## 数据、备份与多设备使用

- **正文与附件在知识库：** 工作台使用普通 Markdown 和附件；已有笔记保留原位置。新资料存入所选范围的工作台专属目录；选择已有 `KnowledgeWorkbench/` 时复用其中的 Inbox、Cards、Journal、Drafts、Assets，不再嵌套创建。
- **运行状态在本机：** 索引、任务、恢复数据、设置和加密凭据位于库外，按选定目录分别保存。原有待审任务需切回创建它时的目录范围处理。
- **备份要完整：** 正常退出后备份知识库，并保留库外任务、恢复记录与设置。只同步 Markdown 不能代替完整备份；跨设备使用时在本机重新配置模型凭据。
- **同篇笔记错开编辑：** 外部修改引发冲突时暂停保存，先核对和合并内容。使用 iCloud 等同步服务时，等待文件完整同步后再换设备；没有跨设备事务锁。
- **未保存内容仍有风险：** 强制退出、断电或服务离线时，不能保证最后一次输入已持久化；遇到保存失败请保留窗口处理。

详细说明见[架构与数据](docs/architecture.md)和[数据一致性与恢复](docs/data-consistency.md)。安装包与仓库不包含个人笔记、截图、密钥或本机配置。

## 与纸间 Paperdesk 配合

[纸间 Paperdesk](https://github.com/Zeen-F/PDF_Vibecoding)负责阅读 PDF、选择文字与区域、保存批注；知识工作台接收材料，整理笔记，并回查来源。

**当前两个公开下载包不能直接完成“纸间发送 → 工作台导入”的完整流程：**

| 纸间版本 | 联动状态 |
| --- | --- |
| 公开版 `1.2.0-beta.2` | 不含“发送到知识工作台”接口 |
| 当前源码 `1.2.0-beta.4` | 已实现交换包发送，尚未公开发布；Windows beta.4 开发与验收见 [PR #23](https://github.com/Zeen-F/PDF_Vibecoding/pull/23)，不能替代 Mac 验收 |

双方需连接同一个 Obsidian 库。兼容版本中，纸间保存选中文字、区域原图、想法和实际页码；工作台可在纸间关闭时导入已完成的交换包。来源回查需要兼容的纸间服务在线，并通过原 PDF 身份校验。

交换包导入本身不调用模型。当前 Mac Paperdesk 成品联动尚未验证，源码或 Windows 结果不能替代它。协议和验证范围见[联动说明](docs/paperdesk-protocol.md)与[纸间 beta.3 本机记录](https://github.com/Zeen-F/PDF_Vibecoding/blob/main/docs/history/1.2.0-beta.3.md)。

## 预览版边界

- 暂不提供移动端、内置云同步、多人协作、全库问答或自动更新。
- 截图按显示器分别框选，单次选区不能跨屏；真实多屏、Retina 和系统权限行为需要分别核对。
- 自动测试主要使用隔离合成资料，不等于真实模型质量、科学正确性或个人知识库同步已经验证。
- 当前 Mac 发布未覆盖真实模型、Codex 原生宿主菜单、中文输入法组合、iCloud 多设备同步、Intel 硬件和下载后的 Gatekeeper。
- 具体通过项与未验证项以[本版 Release](https://github.com/Zeen-F/knowledge-workbench/releases/tag/v0.1.0-alpha.4)为准；历史实施过程见[实施记录](docs/implementation.md)。

## 从源码运行与开发

需要 **Git 与 Node.js 24+**。以下使用公开版源码；要参与当前开发，可改为克隆 main，并新建开发分支。

```sh
git clone --branch v0.1.0-alpha.4 https://github.com/Zeen-F/knowledge-workbench.git
cd knowledge-workbench
npm ci
npm run dev
```

Windows PowerShell 使用 `npm.cmd` 替代 `npm`。开发入口使用隔离的合成知识库；不要把正式资料放入源码目录或用于自动测试。

启动桌面版、检查与打包：

```sh
npm run build
npm start
npm run check
npm run desktop:dist
```

`desktop:dist` 按当前主机平台构建；Mac 也可显式使用 `npm run desktop:dist:mac`。详细命令见[开发指南](docs/development.md)与[macOS 指南](docs/macos.md)。

临时数据与构建成品不进入 Git，工作区安排见开发指南。

## 关于这个项目

知识工作台围绕个人模拟 IC 学习中的写作、截图收集和资料整理逐步完善，采用 **Vibe Coding** 的方式，通过与 AI 对话、实际试用和反复修改推进。

项目仍处于早期预览。欢迎通过 [GitHub Issues](https://github.com/Zeen-F/knowledge-workbench/issues)反馈问题和建议；报告问题时请去掉私人笔记、路径和密钥。

## 联系作者

- 微信：a1152017529
- QQ：1152017529

