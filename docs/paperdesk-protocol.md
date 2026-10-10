# Paperdesk 交换协议与工作分配

纸间负责 PDF 阅读、文字选区、区域框选和批注；知识工作台负责采集归档、主编辑、批量整理和审核。不复制 PDF 阅读器，不共用私有数据库。

纸间联动由 [PR #21](https://github.com/Zeen-F/PDF_Vibecoding/pull/21) 管理，基于已发布 beta.2 主线继续开发。CI 固定核对生产端提交 `939b6ff3010e0145594573ee4673578bb375e7be`，避免后续纸间变更悄悄改变验收对象。已公开的 `v1.2.0-beta.2` 包不包含此功能。

## paperdesk-capture/v1

导出路径为 `<Paperdesk 子目录>/Exports/<UUID>/`。先写 `selection.png`（若有），最后写 `manifest.json`。清单示例使用合成标识：

```json
{
  "schema": "paperdesk-capture/v1",
  "id": "cf6ac3d9-fc58-4831-969d-ea94ced575d1",
  "createdAt": "2026-10-10T00:00:00.000Z",
  "source": {
    "documentId": "a1bacba7-ce86-451d-a1c4-f710244b3b53",
    "title": "合成来源示例",
    "pdfSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "pdfPath": "文献/示例.pdf",
    "notePath": "Paperdesk/Notes/a1bacba7-ce86-451d-a1c4-f710244b3b53.md",
    "page": 3,
    "rects": [{ "x": 0.1, "y": 0.2, "width": 0.4, "height": 0.2 }],
    "quote": "原文选区"
  },
  "comment": "我对这个条件仍有疑问"
}
```

图片清单字段为 `image: {file:"selection.png",mime:"image/png",sha256:"真实校验值"}`。消费者等待文件齐全和校验通过；以包 id 去重，不删除纸间原包。工作台关闭时可以继续从纸间导出。默认扫描 Paperdesk；绑定纸间后采用其报告的自定义子目录。

## 三个对象

`shared/contracts.ts` 是 SourceRef、BatchSnapshot、DraftProposal 的运行时校验契约。来源保留原图哈希、实际页码和归一化区域；批次固定材料原文和版本及参考笔记版本；草稿只能引用本批来源，amend 只能修改所选参考笔记且携带 baseHash。

API 与 Codex 返回同一种草稿。MCP 不提供接受、移动或任意文件读写工具。

## 实际正文联动

绑定核对 `/api/plugin/status` 的 service、apiVersion 和 libraryId，以及 `/api/integrations/knowledge/status` 的 `schema: paperdesk-knowledge/v1`、`vaultPath` 和 `subdir`。双方真实路径必须指向同一库；后续保存或回查也重新核对，不能只信任同名库或端口。旧版纸间缺少接口时提示更新。

保存前通过 `/api/documents/:id/vault-note` 核对仓库文件，通过文献详情取得 notesRevision，再用 PATCH 的 expectedNotesRevision 保存正文。服务不可用、库不一致或版本过期时保留本机草稿。

工作台的 `GET /api/paperdesk/source?sourceId=<材料 UUID>` 从正式材料读回来源，再请求纸间 `/api/integrations/knowledge/source/:id` 核对原 PDF 的当前哈希与页数。只有身份与采集时一致才返回 `/?document=<文献 UUID>&page=<实际页>`。网页在点击时预留标签页，完成校验后导航，避免异步请求导致弹窗被阻止。服务离线或文件改变时保留材料，关闭空标签页并提示原因。

实际联调命令：先在两个工作区构建，然后运行 `npm.cmd run test:paperdesk -- <包含上述提交的纸间源码目录>`。首次使用需 `npx.cmd playwright install chromium`；Windows 可设置 `KWB_TEST_BROWSER=msedge` 使用已安装 Edge，追加 `--headed` 显示窗口。

测试使用原创合成三页 PDF 和临时库，实际操作文字选择、区域框选、用户想法、发送重试、工作台收集箱和“回到纸间原页”。两个产品都运行真实服务，不模拟导出／导入响应；唯一网络故障注入是服务实际落盘后丢弃首个回执。另覆盖关闭纸间后导入、缺失／损坏附件等待、同图不同想法、错库绑定、原 PDF 改变、离线来源及正文冲突。截图与当前结果写入忽略的 `output/playwright/paperdesk/`，临时库与测试服务在结束时清理。结果不代替个人 iCloud 同步、模型质量或 Codex 原生面板验收。
