# 云端增量优化与复现

基线：`baaa9ad41be8c17ad04b41455e6e67ee66729ef1`。本批次在独立云端工作树完成，未提交、推送、创建 PR、打包发布或修改个人知识库。下列结果只来自 Linux / Node v24.19.0 的合成资料，不能推定 Windows、真实云盘或个人大型库的表现。

## 变化

- 链接索引与移动重写共用现有 markdown-it 解析规则。识别 wiki、标准 Markdown、图片和引用式链接，保留别名、标题、锚点、BOM/CRLF；代码围栏、行内代码、注释和原有四空格示例保持原样。共享解析器处理明确路径、相对路径、唯一短名和大小写，重复短名不会猜选。正文中的标准 Markdown 链接现在进入反向链接。派生索引版本变化后，从 Markdown 重建链接；不修改正文。
- CodeMirror 缓存文档对应的预览候选与渲染结果。光标改变只更新受选区影响的范围，无关事务复用原值；文档修改仍完整重建。块级装饰继续直接由 StateField 提供，未改成会破坏布局的可视区域插件。
- 后台五秒扫描复用文件签名，每轮轮转审核 128 篇未变化笔记的正文。所有文件仍遍历和 stat；新增/元数据变化文件立即读取。首次启动、手动刷新和窗口重新获得焦点/可见时仍完整核对正文。保存、移动、冲突检查与草稿恢复完全不依赖扫描缓存，照常直接读盘并计算哈希。
- FTS 替换使用启动时恢复的 path→rowid 映射，避免每篇新笔记都扫描整个 FTS 表。其他 SQLite 连接改变 data_version 时重新加载映射；删除同时核对 rowid 和 path，防止行号复用误删。
- 大于 300 篇的树按需展开文件夹；每个目录先展示 100 篇，再通过“再显示”递增。活动笔记始终可见，切换到新活动笔记时展开其目录。小库保留默认展开方式。没有丢弃搜索结果或改变磁盘目录。
- Paperdesk 来源链接携带经校验的 PDF 哈希及已有 transferId，供配套 Paperdesk 精确回到选区；不在 URL 中放入引文或矩形正文。

## 测量

计时为本机合成测量，不是性能承诺。确定性的工作量（正文读取次数、渲染按钮数）比单次耗时更可靠。

| 场景 | 基线 | 新实现 | 范围 |
| --- | ---: | ---: | --- |
| 1,000 篇，后台扫描中位数 | 36.41 ms / 1,000 次读正文 | 12.18 ms / 128 次 | 3 次热扫描 |
| 10,000 篇，后台扫描中位数 | 327.93 ms / 10,000 次 | 97.30 ms / 128 次 | 3 次热扫描 |
| 10,000 篇，一篇外部修改 | 329.89 ms / 10,001 次 | 95.50 ms / 130 次 | 包括实际重索引 |
| 10,000 篇，显式全量扫描 | 312.95 ms / 10,000 次 | 221.46 ms / 10,000 次 | 全量哈希保留 |
| 10,000 篇，首次索引 | 21.66 s | 3.55 s | 消除逐笔全文索引表扫描，正文仍读 20,000 次 |
| 2,401 行，远距离光标事务中位数 | 40.40 ms | 0.049 ms | 仅 CodeMirror 状态更新 |
| 同文档，同一行光标事务 | 39.96 ms | 0.004 ms | 不含浏览器布局/绘制 |
| 同文档，无关 effect 事务 | 41.25 ms | 0.003 ms | 不含浏览器布局/绘制 |
| 同文档，修改正文 | 42.73 ms | 40.19 ms | 仍重建，无增量编辑性能承诺 |
| 10,000 篇平铺树服务端渲染 | 535.12 ms / 10,000 按钮 | 18.73 ms / 102 按钮 | 100 篇、末尾活动笔记、加载按钮 |
| 10,000 篇分组树服务端渲染 | 503.10 ms / 10,000 按钮 | 11.38 ms / 100 按钮 | 100 个目录，仅活动目录展开 |

树测量是 React 服务端渲染，不是浏览器帧率。编辑器基准自动从 Git 基线提取原函数，并对每种场景检查最终装饰等价。后台扫描基准先在原始基线运行，再在修改后的工作树运行，原始 JSON 留在忽略的 output/performance 下。

## 扫描取舍

签名包括设备、inode、大小、mtimeNs、ctimeNs 和 mode。若外部工具写入后所有这些信息都不变，只能依靠轮转正文审核；稳定的 10,000 篇库、每五秒 128 篇，一轮约 395 秒。这影响背景索引新鲜度，不影响打开/保存时的直接版本校验。手动刷新或重新聚焦会立即完整核对。目录遍历、stat 和列表读取仍与库大小成正比；大量文件同时改变时也会读取所有变化内容。

测试模拟了“正文改变而文件签名完全不变”，验证保存立即报版本冲突并留下草稿，之后轮转审核发现改变。读取失败保留旧索引，且不把未见文件误判为删除。

## 复现

```sh
npm ci --cache .local/npm-cache
npm run check
npm run test:mcp
node --import tsx scripts/benchmark-vault.mjs
node --import tsx scripts/benchmark-editor-preview.mjs 300 40
node --import tsx scripts/benchmark-note-tree.mjs
KWB_TEST_EXECUTABLE=/usr/bin/chromium npm run test:reliability-ui
KWB_TEST_EXECUTABLE=/usr/bin/chromium npm run test:panel
npm run demo -- --smoke
```

`benchmark-vault.mjs` 默认生成 1,000 与 10,000 篇临时笔记，结束关闭数据库并删除本次目录；支持传入数量。初次索引的实际耗时取决于磁盘与笔记内容。`KWB_TEST_EXECUTABLE` 是可选的浏览器路径，Windows 原有浏览器选择仍可通过 `KWB_TEST_BROWSER` 指定。

## 验证边界

本批初次核心版本完整 check 通过：59 项测试、格式、类型与生产构建；真实 MCP SDK stdio 验证 9 个工具通过。后续补齐解析上下文及 FTS 行号缓存后，核心新增 27 项针对性测试通过；整体最终检查由科研模板整合步骤再次运行。浏览器回归曾尝试系统 Chromium，但执行环境拒绝 Chromium 创建 IPC socket，普通及获准提权执行均在启动时失败；不能将此写成 UI 测试通过。独立联调与新增科研模板的最终验证以最后的交付报告为准。

没有执行 Windows 安装包、Windows 原生截图、真实输入法、多显示器、真实模型、个人资料库、真实 Codex 桌面宿主或远端 CI。构建仍有原有的大分块警告；未借本批次重构整个打包链。

## 参考与许可

实现为适配当前产品的原创代码，无外部源码整段移植或新运行时依赖：

- [CodeMirror 官方装饰示例](https://codemirror.net/examples/decoration/) 与[系统指南](https://codemirror.net/docs/guide/)：状态装饰、缓存和布局约束
- [SilverBullet 路径解析](https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/lib/resolve_path.ts) 与[关系索引](https://github.com/silverbulletmd/silverbullet/blob/main/plugs/index/relation.ts)：统一解析/重写、明确歧义的思路；未照搬不同的重名优先级
- [Dataview 索引生命周期](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/data-index/index.ts)：派生索引失效与增量更新的思路；未引入 Obsidian 依赖
- 现有 markdown-it 的公开插件规则 API 承担 Markdown 语法判定，未新增第二套标准 Markdown 解析依赖
