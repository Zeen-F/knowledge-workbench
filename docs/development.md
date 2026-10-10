# 开发与使用

唯一源码工作区采用 Git 分支维护；临时资料在 `.local/` 或自动清理的系统临时目录，个人库和凭据不进入版本控制。

```powershell
npm.cmd ci
npm.cmd run dev
```

开发网址为 `http://127.0.0.1:5186`，使用 `.local/dev-vault` 合成资料。`npm.cmd run build` 后 `npm.cmd start` 打开桌面窗口。首次选择包含 `.obsidian` 文件夹的知识库。用户资料始终是 Markdown 和附件。

```powershell
npm.cmd run check
npm.cmd run test:mcp
npm.cmd run test:codex-host
npm.cmd run test:ui
npm.cmd run test:capture
npm.cmd run test:paperdesk -- <纸间源码目录>
npm.cmd run desktop:pack
npm.cmd run desktop:dist
```

`desktop:pack` 生成 Windows x64 目录包；`desktop:dist` 生成当前版本安装程序，不自动发布。打包后设置 `KWB_TEST_EXE` 为目录包 exe 的绝对路径，再运行 `test:ui` 验证实际包。关闭窗口会等待保存；未处理冲突时返回编辑。

安装器检测目标 EXE 是否仍被占用；占用时退出并提示先保存和关闭，不按进程名称杀进程。Codex 插件也可能正在使用该 EXE。默认用户安装路径为 `%LOCALAPPDATA%/Programs/knowledge-workbench/`，桌面入口应指向完整安装目录，不能只复制 EXE。静默安装和占用保护可分别验证，静默安装不替代交互向导验收。

```powershell
node scripts/test-installer.mjs <已安装的工作台EXE> <NSIS安装包>
npm.cmd run test:packaged-paperdesk -- --paperdesk-exe <已安装的纸间EXE> --workbench-exe <已安装的工作台EXE> --paperdesk-source <纸间源码目录>
```

打包联调只从源码读取合成 PDF 夹具与清理帮助函数，两个产品由真实 EXE 启动，资料位于自动清理的系统临时目录。设置 `KWB_TEST_BROWSER=msedge` 可使用本机 Edge，默认使用 Playwright Chromium。脚本默认记录桌面来源按钮的目的地址，然后在隔离浏览器验证原页；操作系统打开外部浏览器这一步在自动模式下替换。可显式加 `--system-browser` 实际打开系统浏览器；按终端提示核验并关闭测试页后，在当前证据目录填写确认文件。浏览器不可检查时如实填写 `verified:false` 与原因，不能把接口调用成功当作窗口验收。

## Codex 内编辑

工作台设置里点击“准备本地插件”，按显示的两条命令添加本地市场与插件；开发环境可用 `npm.cmd run plugin:setup`。插件构建产物和运行配置分开，插件包中没有个人笔记或密钥。

在 Codex 新对话启用“知识工作台”，说“打开知识工作台”。插件核对或启动本机服务，主机在对话右侧打开其页面。页面与独立桌面窗口共用编辑器、笔记和四种皮肤。不是把笔记复制为 ChatGPT 文档。当前对话的工具列表可能缓存，安装后需要在新对话启用。

在收集箱选择材料、排序和参考笔记，选择 Codex 后复制整理指令。模型可读取这批文字和原图，提交待审草稿。软件内 API 方式在设置中填写服务地址、密钥、支持图像输入的模型和协议；密钥用系统加密保存，连接测试只发送固定短句。

## 验收边界

自动测试使用合成资料，故障测试会主动注入读写错误。实际模型效果需要用户配置的服务与模型。中文字符输入测试不替代真实输入法候选、组合输入和长时间写作检查。截图按每个显示器单独框选；可从任意显示器启动，单次选区不跨越两个屏幕。

构建依赖的审计中，electron-builder 间接引入 sprintf-js 的中等级拒绝服务问题；当前上游最新 sprintf-js 仍在受影响范围。本次不执行自动降级构建器。运行时依赖审计与完整构建依赖审计分别记录，CI 检查运行时依赖。

`test:codex-host` 需要已安装的 Codex CLI，使用隔离的 Codex 配置目录，通过真实 app-server 发现工具、读取共享材料和提交草稿，不发起模型对话。`test:capture` 会暂时覆盖桌面为合成画面并连续框选，验证原图保存、像素、取消和去重；请在可操作桌面的会话中运行。

仓库保留可分发的插件模板。安装时生成的本机插件采用 Codex 兼容插件结构，把绝对运行时路径写入 `.mcp.json`，以适配带空格和中文的 Windows 安装位置。已打包应用使用自带 Electron 的 Node 运行时，使用者无需另外安装 Node.js。`workbench_open` 的唤起配置只接受安装时记录的路径。

版本控制不包含真实笔记、截图、密钥、本机队列或安装包。GitHub 的 Windows checks 检查源码与桌面基本流程，并在临时 CI 工作目录读取固定 Paperdesk 提交进行双应用联调；手动 Windows package 工作流提供安装包构建产物。日常开发仍各保留一份源码，不为联调复制第二套本机工作区。纸间导出功能由 PR #21 单独合并，不改写 beta.2 发布产物。完整命令与证据范围见 [联动协议](paperdesk-protocol.md)。

## 本轮一致性回归

来源解析、批量恢复、Markdown 审核状态和本机草稿的权威关系见 [数据一致性与恢复约定](data-consistency.md)。`npm.cmd run check` 现在包含 lint、typecheck、test 和 build；新增 `npm.cmd run test:reliability-ui` 验证浏览器输入恢复与响应竞态，`npm.cmd run demo -- --smoke` 验证独立合成演示与退出清理。
