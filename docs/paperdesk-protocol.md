# Paperdesk 交换协议与工作分配

纸间负责 PDF 阅读、文字选区、区域框选和批注；知识工作台负责采集归档、主编辑、批量整理和审核。不复制 PDF 阅读器，不共用私有数据库。

纸间生产端提交：`2ca7bfa`，分支 `feat/knowledge-workbench-export`。本次只修改 `server/app.mjs`、`server/knowledge-export.mjs`、`src/App.jsx`、`src/KnowledgeExport.jsx`、`docs/knowledge-workbench.md` 五个文件。它与另一任务的 Windows/Codex 阅读插件发布分开保存，未混入该任务的 beta.2 发布。

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

绑定核对 `/api/plugin/status` 的 service、apiVersion 和 libraryId。保存前通过 `/api/documents/:id/vault-note` 核对仓库文件，通过文献详情取得 notesRevision，再用 PATCH 的 expectedNotesRevision 保存正文。服务不可用、库不一致或版本过期时保留本机草稿。

实际联调命令：`npm.cmd run test:paperdesk -- <包含上述导出提交的纸间源码目录>`。测试使用纸间合成示例 PDF 和临时库，不访问个人 PDF，也不把接口联调等同于实际图文阅读质量验收。
