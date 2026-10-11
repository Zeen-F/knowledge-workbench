# macOS 安装与使用

当前桌面版本为 **0.1.0-alpha.4**，配套 Codex 插件 **0.1.0-alpha.5**。Mac 与 Windows 共用主线源码；当前 Mac 下载面向 **Apple Silicon（arm64）**，仍为未公证预览版。

## 安装与升级

从 [alpha.4 Release](https://github.com/Zeen-F/knowledge-workbench/releases/tag/v0.1.0-alpha.4) 下载：

- [DMG 安装映像](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.dmg)
- [ZIP 压缩包](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/KnowledgeWorkbench-0.1.0-alpha.4-mac-arm64.zip)
- [SHA-256 校验文件](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/SHA256SUMS-mac-arm64.txt)与[构建来源](https://github.com/Zeen-F/knowledge-workbench/releases/download/v0.1.0-alpha.4/BUILDINFO-mac-arm64.json)

将整个 `Knowledge Workbench.app` 放入“应用程序”或 `~/Applications`，不要单独复制内部可执行文件。应用自带运行时，日常使用不需要另装 Node.js。升级前保存并用 ⌘Q 退出，再替换 `.app`；建议保持安装路径不变。已有 Markdown、附件和库外运行配置保留原位置。

当前安装包使用本地 **ad-hoc 签名，未做 Developer ID 签名或 Apple 公证**。本地签名校验通过不代表下载后可通过 Gatekeeper。尚未提供 Intel 下载包或完成 Intel 实机验收，也不提供自动更新。

## 选择知识库

- 选择 Obsidian 根目录时，默认进入 `KnowledgeWorkbench/` 专属空间“我的知识库”，目录、数量、最近编辑和搜索跟随范围；可切换到整个仓库。重新启动默认回到专属空间。
- 直接选择已有 `KnowledgeWorkbench/` 时复用其 `Cards/`、`Journal/`、`Inbox/`、`Drafts/` 和 `Assets/`，不嵌套创建同名目录。
- 选择其他子目录时，普通笔记读写限定于该目录；新建工作台资料放入它下面的 `KnowledgeWorkbench/`。切换前等待保存，不迁移已有笔记。

索引、任务、恢复状态和设置默认保存在库外的 `~/.knowledge-workbench/`，并按选择范围区分。旧待审任务需回到创建它的目录范围审核。不要把另一台机器的本机运行配置或加密密钥直接搬过来；模型设置在本机重新填写。完整规则见[侧栏与子目录说明](sidebar-and-subfolders.md)。

## Mac 操作与权限

| 操作           | 行为                                                                  |
| -------------- | --------------------------------------------------------------------- |
| ⌘S / ⌘N / ⌘Z   | 保存 / 新建 / 撤销；复制、粘贴、全选也使用 Command                    |
| 侧栏按钮与边界 | 收起或展开；拖动调宽、双击复位，边界获得焦点后可用方向键调整          |
| ⌘W 或关闭按钮  | 等待保存后隐藏窗口，保留本地服务与 Codex 面板连接；从 Dock 点图标重开 |
| ⌘Q             | 等待保存后退出并停止服务；保存失败时保留窗口与输入                    |
| ⌘⌥S            | 框选截图，需要系统屏幕录制权限                                        |

截图权限位于“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”；安装版对应 Knowledge Workbench，开发运行对应 Electron。按系统提示授权并重启。没有权限时会提示原因，不把空白图像记为采集成功。截图按当前显示器的逻辑坐标换算原始像素；单次选区不跨屏，全屏空间行为需另行验收。

启动与普通笔记操作不访问钥匙串；实际保存或读取模型密钥时才检查系统加密，可能出现 macOS 授权提示。加密不可用时拒绝该操作，不退回明文。预览版更换签名后可能需要重新确认钥匙串访问，详见 [Electron safeStorage 说明](https://www.electronjs.org/docs/latest/api/safe-storage/)。

## Codex 插件

先把应用放到固定位置，再在桌面“设置 → 准备本地插件”生成本机配置，执行界面显示的安装命令，并在 Codex 新对话启用插件。移动 `.app` 后重新准备，避免路径指向旧位置。独立插件 ZIP 是通用模板，不包含本机路径与个人资料。

安装版插件使用应用内的运行时。关闭窗口后服务仍可用；完全退出后，插件可以根据已记录的路径唤起后台服务。原生面板与桌面后端需配套使用，旧 Codex 会话可能保留之前的连接。开发环境可使用 `npm run plugin:setup`。

## 本版验收

2026-10-12，Apple Silicon 实机基于主线 `764bceac34ab09868cd8449ac8198801ba421d12` 完成构建与安装验收。该提交与发布标签 `v0.1.0-alpha.4` 指向的 `c7aafd5` 具有相同源码树 `17eb4bd1f89c1e78ca792b6030318702ac7d09f7`。Mac 下载包来自这次本机构建，来源与校验值记录在 `BUILDINFO-mac-arm64.json`；Windows 下载包仍沿用其独立 CI 构建记录。

| 检查         | 结果                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 完整本地检查 | 格式、类型、91 项核心/服务测试与生产构建通过                                                              |
| 安装版桌面   | 22 项通过，覆盖编辑、渲染链接、公式、主题、保存/撤销、待审稿、重启、默认范围，以及 Mac 关闭/Dock/退出行为 |
| 侧栏与子目录 | 12 项通过，覆盖鼠标和键盘调宽、布局恢复、目录切换、同名链接、科研预览与错误目录保留编辑器                 |
| 插件与面板   | 9 个 MCP 工具、21 项面板协议检查通过；已安装 alpha.5 插件缓存的实际 stdio 连接与桌面服务核验通过          |
| 恢复与竞态   | 8 组浏览器可靠性场景通过，页面错误为零                                                                    |
| 包与安装内容 | DMG、ZIP 内的 `app.asar` 与已验收安装版一致；本地 ad-hoc 签名校验通过                                     |

同一主线提交的 [macOS CI](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152811566)、[Windows CI](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152811459)和 [Windows 安装包工作流](https://github.com/Zeen-F/knowledge-workbench/actions/runs/38152822254)均成功。

自动测试使用隔离的临时合成库。更新后也查看了实际 Mac 窗口，确认专属空间与侧栏入口；原有笔记、配置和 Obsidian 书签的校验值保持一致。个人库未作为写入测试夹具，私人日志和截图不随安装包或源码公开。

这些结果不替代真实模型调用、Codex 桌面原生宿主菜单实测、中文输入法组合输入、iCloud 多设备同步、当前 Mac Paperdesk 双应用联动或下载后的 Gatekeeper 验收。早期版本的双屏截图与主线集成过程见[实施记录](implementation.md)，不将历史验收自动计为本版复测。

## 开发与可重放检查

需要 Node.js 24+：

```sh
npm ci
npm run check
npm start
```

`npm run dev` 使用合成库。构建命令：

```sh
npm run desktop:pack:mac
npm run desktop:dist:mac
```

默认按当前架构构建。Apple Silicon 应用输出到 `release/mac-arm64/Knowledge Workbench.app`，Intel 输出到 `release/mac/Knowledge Workbench.app`；DMG 与 ZIP 位于 `release/`，名称包含架构。可追加 `-- --x64` 或 `-- --arm64`，但跨架构产出不代表相应硬件通过验收。

```sh
npm run test:mcp
npm run test:codex-host
npm run test:ui
npm run test:sidebar-subfolder
KWB_TEST_BROWSER=chrome npm run test:panel
KWB_TEST_BROWSER=chrome npm run test:reliability-ui
KWB_TEST_EXE="$PWD/release/mac-arm64/Knowledge Workbench.app/Contents/MacOS/Knowledge Workbench" npm run test:ui
KWB_TEST_EXE="$PWD/release/mac-arm64/Knowledge Workbench.app/Contents/MacOS/Knowledge Workbench" npm run test:sidebar-subfolder
```

浏览器测试也可在 `npx playwright install chromium` 后不设置 `KWB_TEST_BROWSER`，使用 Playwright Chromium。桌面测试使用带中文与空格路径的系统临时库，结束后清理自身资料与服务。`test:codex-host` 检查隔离 app-server 连接，不代表真实模型或 Codex 原生菜单点击验收。

GitHub `macOS checks and preview` 工作流执行检查、构建与成品桌面回归，并把 `.app` 复制到 checkout 外的临时安装目录测试。CI 工件有保留期限；日常下载以 Release 为准。完整验证状态按具体提交记录，不以工作流文件存在作为通过证据。

## 正式签名与公证

当前预览未配置 Developer ID 身份与公证凭据。正式分发需准备开发者计划权限、带私钥的 Developer ID Application 签名身份和公证凭据；免费账号与 ad-hoc 签名不能替代这些前提。凭据放入钥匙串或专用密钥存储，不进入源码。

具备条件后，启用 Hardened Runtime，使用 Developer ID 重新签名并构建，再向 Apple 提交。收到 Accepted 后还需附加并验证公证票据、通过 Gatekeeper 检查，并对最终成品重做桌面与插件验收，才能标记为已公证。

依据：[Apple Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) · [Apple 公证要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。
