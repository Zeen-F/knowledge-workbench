# 知识工作台 · Knowledge Workbench

面向模拟 IC 学习与科研写作的 Windows / macOS 主编辑器：随时记下想法和截图，把阅读材料整理成有来源、可修订的知识。Markdown 与附件保存在用户选择的 Obsidian 仓库；[纸间 Paperdesk](https://github.com/Zeen-F/PDF_Vibecoding) 负责 PDF 阅读和批注，知识工作台负责收集、写作与 AI 草稿审核。

这是通过与 AI 对话、反复试用和修改完成的 **vibecoding（vibe coding）** 项目，目前仍处于早期预览。欢迎反馈问题和参与改进；AI 生成的草稿需要人工核对，保存草稿不代表科学结论已验证。

## 下载、启动与升级

在 [GitHub Releases](https://github.com/Zeen-F/knowledge-workbench/releases) 下载 Windows 安装器 `KnowledgeWorkbench-0.1.0-alpha.4-win-x64.exe`。公开桌面预览版为 **0.1.0-alpha.4**，配套 Codex 插件为 **0.1.0-alpha.5**；可下载文件与校验值以 Release 页面为准。当前源码中的材料阅读与审核改进不会自动进入旧安装包。

运行安装器后从原桌面快捷方式打开工作台，首次选择包含 `.obsidian` 的知识库根目录。完整安装包包含运行时，日常使用无需另装 Node.js。知识库和笔记保留在原位置，不放进源码目录或临时打包目录。

升级前保存并正常退出旧工作台，备份 Markdown 和附件，正常断开占用安装目录的旧插件连接。安装器发现占用会退出并保留编辑窗口，不强制结束进程。更新完整应用后继续使用指向正式安装目录的快捷方式，再准备并核对插件；不要只复制 EXE。当前没有自动更新。

Apple Silicon Mac 可下载 [0.1.0-alpha.4 DMG](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.dmg)，将应用拖入「应用程序」，也可从源码构建。Mac 使用 Command 快捷键，关闭窗口后可从 Dock 重开，退出使用 ⌘Q；截图需要屏幕录制权限。当前预览构建未做 Apple 公证，详见 [Mac 适配说明](docs/macos.md)。

## 写作与材料审核

| 功能 | 当前源码中的行为 |
| --- | --- |
| Markdown 编辑 | 即时渲染和源码模式，支持公式、图片、笔记树、标签页；YAML 元数据可折叠，保留原始正文。 |
| 保存保护 | 版本冲突检测、历史恢复与草稿保留；审核编辑保存失败时停留原页，重试成功后才能打开其他材料。 |
| 材料收集 | 收集手写想法、截图与纸间选区，按标题、正文、路径、文献和摘录搜索。 |
| 组合筛选 | 材料类型与“只看已选”可组合，筛选不清空选择或改变批次顺序。 |
| 来源预览 | 原文和原图以只读方式显示；预览链接不直接导航，需要跟随来源时先打开材料笔记。 |
| 草稿对照 | 对照整理时固定的来源与参考文字快照，区分当前笔记；缺失快照会提示。图片仍从原附件路径读取，不是冻结的图片副本。 |
| 编辑状态 | 加载或只读状态会同步锁定编辑器，恢复可编辑后保留正文与选区。 |
| 界面 | 森林、暖砂、雾蓝、夜读四套皮肤，侧栏收起、拖动调宽及 Obsidian 子目录选择。 |

操作与边界见 [材料筛选与审核](docs/materials-review.md)、[侧栏与子文件夹](docs/sidebar-and-subfolders.md) 和 [数据一致性与恢复](docs/data-consistency.md)。

## 科研笔记工作流

1. **收集证据。** 在工作台记下想法或截图；也可在纸间手动选择词句、段落或图表区域，核对实际 PDF 页后“发送到知识库”。两款应用须连接同一个 Obsidian 库。
2. **筛选并核对。** 在收集箱搜索和预览材料，选择顺序及参考笔记。纸间材料保留来源和原始页码，可回查原 PDF；缺失或改变的来源需要核对。
3. **预览交付内容。** 选择“通用整理”或“模拟 IC 科研”。科研配置支持研究笔记、论文提炼和电路实验，区分原文、个人假设、AI 推断及未知项，保留单位与实验条件。未提供的条件不会自动补成典型值。
4. **明确发送。** 核对所选文字、参考快照、图片和整理规则后，再共享给现有 Codex 会话或自己的模型 API。修改选择、顺序、内容或配置后必须重新预览。预览本身不调用模型。
5. **审核草稿。** 对照来源与参考快照编辑返回结果，检查公式、单位、适用条件和待验证项，再点击“确认并保存”。AI 草稿不会自动成为已验证的正式结论。

科研配置随每个批次固定版本，后续偏好变化不改写旧批次。详见 [科研笔记配置](docs/research-profiles.md) 和 [纸间交换协议](docs/paperdesk-protocol.md)。划词／手动选段翻译在纸间完成，需要核对选区并确认发送；工作台不会自动把 PDF 整页交给模型翻译。

## Codex 插件与可选模型 API

打开桌面工作台，在设置中点击“准备本地插件”，执行界面显示的两条 Codex 命令，再在 **Codex 新对话**中启用“知识工作台”，说“打开知识工作台”。由当前桌面程序准备的插件使用对应安装目录内的运行时；升级后应重新准备并核对连接。独立插件模板 ZIP 不包含本机配置，不能替代桌面运行时。

支持 MCP Apps 的宿主可以请求内嵌编辑面板；旧对话可能缓存工具，需刷新或开启新会话。界面支持时可用“交给当前 Codex 对话”，也可复制整理指令。插件只处理用户明确共享的批次，不因材料标题扩大到整个库；返回内容进入待审草稿，正式接受仍由用户完成。

另一条路径是在桌面设置中配置自己的模型 API。服务、模型、协议和图像能力必须匹配，费用由服务商决定；连接测试会发送固定短句。普通编辑、打开材料和交付预览不自动调用模型。不要把密钥放进笔记、聊天或 Git。

真实 MCP 通信与现有 Codex 会话的合成材料整理已验证；**当前宿主内嵌面板的视觉验收仍未完成**。宿主协议模拟、CI 成功和真实模型输出是不同证据，不能相互代替；本轮未验收独立付费模型 API。详细安装、组件边界及测试方式见 [开发与使用](docs/development.md)。

## 数据与恢复

- Markdown 和附件是正式资料；索引、设置、队列与恢复资料保存在知识库之外，不替代原笔记备份。
- 纸间受管理的笔记正文经其 API 与版本校验更新；来源批注和隐藏状态继续由纸间维护，不直接覆盖。
- 保存冲突时核对当前文件、编辑草稿和历史版本，不盲目重试覆盖。正常退出会等待保存，未解决的保存问题会保留窗口。
- 生成结果、原始证据和人工确认状态分别保留。冻结的文字快照有助于回查，不能证明其科学正确性；图片附件也需保留。
- 备份所选知识库的 Markdown 与附件，并保留需要的本机恢复资料。强制结束、断电或删除配置不能保证尚未持久化的输入恢复。

## 从源码运行与检查

需要 Node.js 24+。已有工作区直接进入原目录；首次获取可运行：

```powershell
git clone https://github.com/Zeen-F/knowledge-workbench.git
cd knowledge-workbench
npm.cmd ci
npm.cmd run dev
```

开发入口使用隔离的 `.local/dev-vault` 合成知识库。生产界面构建后打开桌面应用：

```powershell
npm.cmd run build
npm.cmd start
```

自动检查与 Windows 打包：

```powershell
npm.cmd run check
npx.cmd playwright install chromium
npm.cmd run test:materials-review
npm.cmd run desktop:pack:win
# 需要安装器时：
npm.cmd run desktop:dist:win
```

macOS 将 `npm.cmd` 换为 `npm`，先 `npm run build` 再 `npm start`；目录包使用 `npm run desktop:pack:mac`，安装产物使用 `npm run desktop:dist:mac`。构建不自动发布。原生 macOS 运行、中文输入法组合输入和长时间写作仍需各自验收。

`src/` 为界面，`server/` 为存储与整理服务，`shared/` 为交换契约，`desktop/` 为桌面壳，`plugins/` 为 Codex 插件，`tests/` 使用合成资料。临时数据在忽略的 `.local/`，成品在忽略的 `release/`，私人笔记、截图、密钥和数据库不进入 Git。

[需求](docs/requirements.md) · [架构与数据](docs/architecture.md) · [实施记录](docs/implementation.md) · [反馈问题](https://github.com/Zeen-F/knowledge-workbench/issues)

作者联系方式：**微信 a1152017529 · QQ 1152017529**。
