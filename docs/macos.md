# macOS 适配

代码基线为 Windows 主工作区 `C:\Users\86177\Desktop\File\知识库开发` 对应的 GitHub `700dfec`。Mac 工作区通过 Git 克隆，适配在 `codex/macos-adaptation` 分支完成。Windows 工作区与个人资料保持原样。

## 开发与打包

需要 Node.js 24+，首次执行 `npm ci`，再执行 `npm run check`。`npm run dev` 使用合成库；`npm run build` 后 `npm start` 打开 Electron 桌面。首次启动选择已有 Obsidian 库；选择正式资料库前先完成示例验收。

```sh
npm run desktop:pack:mac
npm run desktop:dist:mac
```

默认按当前 Mac 架构构建：Apple Silicon 输出到 `release/mac-arm64/Knowledge Workbench.app`，Intel 输出到 `release/mac/Knowledge Workbench.app`。安装包在 `release/`，文件名包含架构。要构建另一架构可追加 `-- --x64` 或 `-- --arm64`；能产出安装包不等于在该硬件上实际通过验收。

将整个 `.app` 放入 Applications 或 `~/Applications`，再打开；不要单独复制内部可执行文件。当前使用本地 ad-hoc 签名，未配置 Developer ID 或 Apple 公证。下载后的系统验证与本地构建启动分别验收。

## Mac 操作

- 使用 ⌘S 保存、⌘N 新建、⌘Z 撤销；复制、粘贴、全选等也使用 Command。
- ⌘W 或关闭按钮先等待保存，再隐藏窗口，保留本地服务和 Codex 面板连接。从 Dock 点图标重开。⌘Q 退出时等待保存，停止服务；保存失败保留窗口并提示处理。
- ⌘⌥S 框选截图。macOS 需要“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”许可；正式应用对应 Knowledge Workbench，开发运行对应 Electron。按系统提示授权并重启。没有授权时提示原因，不把空白屏幕记为采集成功。
- 截图选区按当前显示器的逻辑坐标换算原始像素；单次选区仍不跨屏。真实 Retina、多屏和全屏空间行为需要分别验证。

用户配置、索引和队列默认放在 `~/.knowledge-workbench/`，正文和附件继续在用户选择的库内。不将 Windows 的本机运行配置或加密密钥搬到 Mac；模型设置在本机重新填写。iCloud 的完整下载与两机轮流编辑另行验收。

## Codex 插件

桌面“设置 → 准备本地插件”生成本机路径，再按界面命令安装。建议先把应用放到固定位置，再准备插件；移动 `.app` 后重新准备，避免启动配置指向旧位置。开发运行也支持 `npm run plugin:setup`。

开发插件通过 Electron 包提供的实际执行路径找到 `.app/Contents/MacOS/Electron`；成品插件直接使用应用内自带运行时。原生面板与桌面后端必须配套使用。关闭 Mac 窗口后服务仍可用；完全退出后插件可以根据已记录的本机路径唤起后台服务。

## 可重放验收

```sh
npm run check
npm run test:mcp
npm run test:codex-host
npm run test:ui
KWB_TEST_BROWSER=chrome npm run test:panel
KWB_TEST_BROWSER=chrome npm run test:reliability-ui
KWB_TEST_EXE="$PWD/release/mac-arm64/Knowledge Workbench.app/Contents/MacOS/Knowledge Workbench" npm run test:ui
```

浏览器协议测试也可不设置 `KWB_TEST_BROWSER`，在 `npx playwright install chromium` 后使用 Playwright Chromium。桌面测试使用带中文及空格路径的系统临时库，验证 Mac 原生菜单、Command 编辑、关闭保留服务、Dock 重开、退出清理，以及桌面生成的插件配置经实际 Electron stdio 连接；全部测试在结束后清理自身临时库。

GitHub `macOS checks and preview` 工作流执行检查、浏览器回归、构建和成品桌面回归，并保存预览构建产物。新增工作流不等于远端 CI 已通过。当前实际验证结果另记于 [实施记录](implementation.md)。屏幕权限、真实输入法、实际 Codex 菜单点击、真实模型和正式 iCloud 库不由这些自动测试代替。

平台行为依据：[Electron 菜单](https://www.electronjs.org/docs/latest/tutorial/menus)、[屏幕采集与授权](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[electron-builder v26 Mac 打包](https://www.electron.build/v26/docs/mac/)。
