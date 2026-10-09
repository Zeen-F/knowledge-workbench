# 架构与数据边界

界面使用 React、TypeScript 和 CodeMirror 6。即时渲染是 Markdown 原文上的装饰层，公式用 KaTeX；源码与即时渲染共用一个文本状态。四套皮肤使用同一组语义颜色，不改变文件。桌面和 Codex 内嵌浏览器使用同一个本机页面和服务。

Electron 主进程负责窗口、系统加密、知识库选择和屏幕采集；业务服务在独立 utility process 中运行，使用 Node.js 内置 SQLite。窗口启用 sandbox、contextIsolation，禁用 nodeIntegration，只能调用受限接口。服务绑定 127.0.0.1，并核对 Host、Origin 和本机会话凭据。

## 模块

| 模块 | 主要实现 | 数据流 |
| --- | --- | --- |
| Editor | `src/Editor.tsx`、`src/App.tsx` | 原文编辑、源码模式、自动保存、冲突比较、历史恢复 |
| Vault | `server/vault.ts`、`files.ts` | 限定仓库路径、版本校验、临时写入、读回、恢复日志 |
| Capture | `desktop/main.mjs`、`server/capture.ts` | 物理像素裁剪、内容校验去重、想法独立记录 |
| Knowledge | `database.ts`、`markdown.ts` | FTS5 trigram、短词子串、双链及来源关系 |
| Processing | `processing.ts`、`provider.ts` | 固定批次、逐项提取、重试、草稿审核与幂等保存 |
| Integrations | `paperdesk.ts`、`mcp.ts` | Paperdesk 版本接口、MCP 共享范围和草稿回传 |

## 文件与本机状态

正式知识库新增 `KnowledgeWorkbench/Inbox`、`Cards`、`Journal`、`Drafts`、`Assets`。已有笔记保留原位置。图片使用 SHA-256 文件名；重复图片共用附件，每次采集仍有独立来源笔记和想法。`Drafts` 也保存标明待核对的逐项 AI 识读结果。

默认本机状态在 `%USERPROFILE%/.knowledge-workbench/`，测试可用 `KWB_PROFILE` 指定隔离位置。使用用户目录避免 Windows Store 宿主重定向 AppData 后，Codex 与独立桌面窗口找不到同一份配置。这里包含加密密钥、`runtime.json`、插件启动配置，以及按知识库绝对路径哈希隔离的索引、队列、保存历史、冲突草稿、移动恢复和接受日志；不进入云同步库或 Git。

| 表 | 内容 | 可重建性 |
| --- | --- | --- |
| notes、notes_fts | 路径、标题、类型、领域、状态、版本、标签及全文 | 从 Markdown 重建 |
| sources、assets | 原始想法、来源、图片校验值及交换包标识 | 从来源笔记和附件重建 |
| relations | 双链、来源、派生、替代 | 从正文与属性重建 |
| extractions | AI 识读文字与原材料版本 | 从识读草稿重建 |
| proposals | 待审、已接受或退回的结果 | 从草稿元数据重建 |
| jobs、job_items | 固定输入、完成分项、错误、共享状态 | 本机运行状态，备份时保留 |
| settings | 界面偏好、服务配置与加密凭据 | 本机配置，不能从笔记重建 |

## 保存与恢复

保存先保留本机草稿，再比较内容 SHA-256；修改前保留完整历史，通过同目录临时文件写入、替换和读回校验后才报告已保存。外部版本变化暂停保存。目录或云文件读取失败会保留旧索引并提示，不当成空文件或直接删除。

移动先预览可解析引用变更，写完整恢复日志。中途失败按预期内容条件回滚；如果又出现外部编辑则保留两份内容及日志，不覆盖外部版本。下次启动会检查未完成移动。

AI 接受新稿使用确定目标路径和接受日志，响应丢失或中断重试不会重复创建笔记。修改旧稿必须匹配参考快照版本。AI 接受后仍为 working，不自动提高到 canonical。Paperdesk 笔记正文仅通过其版本 API 保存，生成区和隐藏状态由纸间维护。

本版没有跨设备事务锁；同一篇笔记按单设备编辑，等待 iCloud 等服务完成同步后再换设备。
