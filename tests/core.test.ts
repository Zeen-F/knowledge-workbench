import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { Captures } from "../server/capture.ts";
import { Processing } from "../server/processing.ts";
import { atomicWrite, digest, safePath } from "../server/files.ts";
import {
  markdownLinks,
  parseMarkdown,
  rewriteLinks,
} from "../server/markdown.ts";
// @ts-ignore -- This module is also consumed directly by Electron.
import { cropRect } from "../desktop/geometry.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB3sAAAAASUVORK5CYII=",
  "base64",
);
test("move preserves code examples and rewrites only resolvable prose links", () => {
  const literal =
    "```md\n[[A]] [A](A.md)\n```\n`[[A]]`\n    [[A]]\n<!-- [[A]] -->\n";
  const input = "[[A]] [A](A.md)\n" + literal;
  assert.equal(
    rewriteLinks(input, "A.md", "Folder/B.md", "Index.md", [
      "A.md",
      "Index.md",
    ]),
    "[[Folder/B]] [A](Folder/B.md)\n" + literal,
  );
});
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-中文 测试-")),
    vaultDir = path.join(root, "vault"),
    data = path.join(root, "cache");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  const db = openDatabase(data),
    vault = new Vault(vaultDir, data, db),
    captures = new Captures(vault),
    processing = new Processing(vault, captures, async () => {
      throw new Error("test provider not configured");
    });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, vaultDir, data, db, vault, captures, processing };
}

test("local Codex retries stay on the selected executor and submit only pending drafts", async (t) => {
  const { vault, processing, captures } = fixture(t);
  const source = captures.add({ title: "合成学习记录", text: "来源材料" });
  let attempts = 0;
  let apiCalls = 0;
  processing.getProvider = async () => {
    apiCalls++;
    throw new Error("unexpected API fallback");
  };
  processing.callLocalCodex = async (prompt) => {
    attempts++;
    if (attempts === 1) throw new Error("CLI 已离线");
    assert.ok(prompt.includes(source.id));
    if (attempts === 2) return "提取到的合成材料";
    return JSON.stringify({
      drafts: [
        {
          title: "CLI 待审稿",
          action: "create",
          noteType: "learning-log",
          markdown: "# CLI 待审稿",
          sourceIds: [source.id],
        },
      ],
    });
  };
  const job = processing.create(
    [source.id],
    [],
    "codex-cli",
    "生成一份学习记录",
  );
  const run = async () => {
    await processing.run(job.id);
    while (processing.running.has(job.id))
      await new Promise((resolve) => setImmediate(resolve));
    return processing.get(job.id);
  };
  assert.equal((await run()).state, "failed");
  assert.equal(processing.proposals().length, 0);
  assert.equal((await run()).state, "review");
  assert.equal(attempts, 3);
  assert.equal(apiCalls, 0);
  assert.equal(processing.proposals()[0].status, "pending");
  assert.equal(
    vault.list().filter((note) => note.path.includes("/Journal/")).length,
    0,
  );
});

test("a note optimization binds the selected versions and applies only the reviewed target body", async (t) => {
  const { vault, processing } = fixture(t);
  const target = "KnowledgeWorkbench/Journal/跨导笔记.md";
  const header =
    "\uFEFF---\r\ntitle: 跨导笔记 # 保留注释\r\nnote_type: learning-log\r\nstatus: working\r\ncustom: {a: [1, 2]}\r\n---\r\n";
  const original = header + "\r\n# 跨导笔记\r\n\r\n先写下原有疑问。\r\n";
  atomicWrite(vault.absolute(target), original, true);
  vault.index(target);
  const reference = vault.create(
    "相关参考",
    "concept",
    "# 相关参考\n\n参考中的适用条件。\n",
  );
  const unselected = vault.create(
    "未选笔记",
    "concept",
    "# 未选笔记\n\n无关正文。\n",
  );
  atomicWrite(vault.absolute("其他空间.md"), "# 其他空间\n", true);
  let calls = 0;
  processing.callLocalCodex = async (prompt) => {
    calls++;
    assert.match(prompt, /先写下原有疑问/);
    assert.match(prompt, /参考中的适用条件/);
    assert.doesNotMatch(prompt, /未选笔记|其他空间|保留注释|custom/);
    return JSON.stringify({
      markdown: `# 跨导笔记\n\n整理后保留疑问，参考 [[${reference.path}]]。\n`,
      unresolved: ["条件需验证"],
      targetPath: reference.path,
    });
  };
  const input = {
    path: target,
    scope: "workbench" as const,
    referencePaths: [reference.path],
    instruction: "梳理公式与适用条件",
  };
  assert.throws(
    () =>
      processing.previewNoteOptimization({
        ...input,
        referencePaths: ["其他空间.md"],
      }),
    /当前知识空间/,
  );
  const preview = processing.previewNoteOptimization(input);
  assert.equal(calls, 0);
  assert.equal(preview.noteRevision?.content, original.slice(header.length));
  assert.equal(
    preview.references[0].content,
    "\n# 相关参考\n\n参考中的适用条件。\n",
  );
  vault.save(
    reference.path,
    reference.content + "\n补充条件。\n",
    reference.hash,
  );
  assert.throws(
    () =>
      processing.createNoteOptimization(
        input,
        preview.previewHash,
        randomUUID(),
      ),
    (e: any) => e.code === "PREVIEW_CHANGED",
  );
  const refreshed = processing.previewNoteOptimization(input);
  const requestId = randomUUID();
  const job = processing.createNoteOptimization(
    input,
    refreshed.previewHash,
    requestId,
  );
  assert.equal(
    processing.createNoteOptimization(input, refreshed.previewHash, requestId)
      .id,
    job.id,
  );
  await processing.run(job.id);
  while (processing.running.has(job.id))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    processing.get(job.id).state,
    "review",
    processing.get(job.id).error || "",
  );
  assert.equal(calls, 1);
  assert.equal(vault.read(target).content, original);
  const before = processing.proposals()[0];
  assert.equal(before.status, "pending");
  assert.equal(before.targetPath, target);
  vault.db.prepare("DELETE FROM proposals WHERE id=?").run(before.id);
  processing.rebuildProposals();
  const draft = processing.getProposal(before.id);
  const newer = vault.save(
    target,
    original + "外部补充\r\n",
    preview.noteRevision!.hash,
  );
  const save = async (relative: string, markdown: string, hash: string) =>
    vault.save(relative, markdown, hash);
  await assert.rejects(
    () => processing.accept(draft.id, draft.markdown, save, draft.draftHash),
    (e: any) => e.code === "VERSION_CONFLICT",
  );
  assert.equal(vault.read(target).content, newer.content);
  assert.equal(processing.getProposal(draft.id).status, "pending");
  const rebased = processing.rebase(draft.id, draft.draftHash, newer.hash);
  await processing.accept(
    rebased.id,
    rebased.markdown + "\n外部补充\n",
    save,
    rebased.draftHash,
  );
  const accepted = vault.read(target);
  assert.equal(parseMarkdown(accepted.content).frontmatter, header);
  assert.match(accepted.content, /整理后保留疑问/);
  assert.match(accepted.content, /外部补充/);
  assert.equal(vault.read(unselected.path).content, unselected.content);
  assert.equal(vault.history(target)[0].content, newer.content);
});

test("note optimization binds the CLI settings and screenshots and checks every batch annotation", async (t) => {
  const { vault, processing } = fixture(t);
  const relative = "KnowledgeWorkbench/Journal/失调推导.md";
  const first = "KnowledgeWorkbench/Assets/原图.png";
  const second = "KnowledgeWorkbench/Assets/对照.png";
  const original = [
    "# 失调推导",
    "",
    "![[KnowledgeWorkbench/Assets/原图.png|600]]",
    "",
    "（请推导图里失调如何传到输出。）",
    "",
    "![对照](../Assets/对照.png)",
    "",
    "为什么零温度系数只在某温度点抵消？",
    "",
    "![外链](https://example.invalid/external.png)",
    "",
    "\u0060\u0060\u0060md",
    "TODO 这是示例代码",
    "\u0060\u0060\u0060",
    "",
  ].join("\n");
  atomicWrite(vault.absolute(first), png, true);
  atomicWrite(vault.absolute(second), png, true);
  atomicWrite(vault.absolute(relative), original, true);
  vault.index(relative);
  const input = {
    path: relative,
    scope: "workbench" as const,
    referencePaths: [],
    instruction: "",
    codexOptions: {
      model: "fixture-model",
      effort: "xhigh" as const,
      fast: true,
    },
  };
  let calls = 0;
  const responses = [
    {
      line: 5,
      state: "answered",
      response: "在假设反馈网络为比例关系时，先写闭环节点方程。",
    },
    {
      line: 9,
      state: "needs-context",
      response: "需补充电阻温漂曲线以求出实际抵消温度。",
    },
  ];
  processing.callLocalCodex = async (
    prompt,
    images,
    _signal,
    _profile,
    options,
  ) => {
    calls++;
    assert.deepEqual(options, input.codexOptions);
    assert.deepEqual(
      images?.map((image) => image.data),
      [png.toString("base64"), png.toString("base64")],
    );
    assert.match(prompt, /作者批注/);
    assert.match(prompt, /"image":1.*"noteLine":3/);
    return JSON.stringify({
      markdown: "# 合成推导\n\n在当前偏置假设下，先建立含失调项的节点等式。",
      unresolved: ["实际抵消温度尚需温漂曲线"],
      annotationResponses: calls === 1 ? responses.slice(0, 1) : responses,
    });
  };
  const preview = processing.previewNoteOptimization(input);
  assert.deepEqual(
    preview.noteRevision?.images?.map((image) => [image.path, image.line]),
    [
      [first, 3],
      [second, 7],
    ],
  );
  assert.deepEqual(
    preview.noteRevision?.annotations?.map((item) => [
      item.line,
      item.nearbyImage,
    ]),
    [
      [5, 1],
      [9, 2],
    ],
  );
  assert.equal(preview.noteRevision?.imageIssues?.length, 1);
  assert.throws(
    () =>
      processing.createNoteOptimization(
        { ...input, codexOptions: { ...input.codexOptions, fast: false } },
        preview.previewHash,
        randomUUID(),
      ),
    (error: any) => error.code === "PREVIEW_CHANGED",
  );
  const job = processing.createNoteOptimization(
    input,
    preview.previewHash,
    randomUUID(),
  );
  const run = async () => {
    await processing.run(job.id);
    while (processing.running.has(job.id))
      await new Promise((resolve) => setImmediate(resolve));
    return processing.get(job.id);
  };
  atomicWrite(vault.absolute(first), Buffer.concat([png, Buffer.from([0])]));
  assert.match((await run()).error || "", /图片已变化/);
  assert.equal(calls, 0);
  atomicWrite(vault.absolute(first), png);
  assert.match((await run()).error || "", /漏掉了部分批注回应/);
  assert.equal(processing.proposals().length, 0);
  assert.equal((await run()).state, "review");
  assert.deepEqual(processing.proposals()[0].annotationResponses, responses);
  assert.equal(vault.read(relative).content, original);
});

test("Codex revisions reuse a persisted thread and accept real linked child notes only once", async (t) => {
  const { vault, processing, captures } = fixture(t);
  const target = vault.create(
    "电路笔记",
    "learning-log",
    "# 电路笔记\n\n保留原文。",
  );
  const threadId = randomUUID();
  const input = {
    path: target.path,
    scope: "workbench" as const,
    referencePaths: [],
    instruction: "先整理原文",
    codexOptions: { fast: false, model: "fixture-model" },
  };
  processing.callLocalCodex = async (
    _prompt,
    _images,
    _signal,
    _profile,
    _options,
    session,
  ) => {
    assert.equal(session?.threadId, undefined);
    session!.onThread(threadId);
    return JSON.stringify({
      markdown: "# 电路笔记\n\n第一轮正文。",
      unresolved: [],
    });
  };
  const starter = processing.createNoteOptimization(
    input,
    processing.previewNoteOptimization(input).previewHash,
    randomUUID(),
  );
  const run = async (p: Processing, id: string) => {
    await p.run(id);
    while (p.running.has(id))
      await new Promise((resolve) => setImmediate(resolve));
    const result = p.get(id);
    assert.equal(result.state, "review", result.error || "");
    return result;
  };
  assert.equal((await run(processing, starter.id)).codexThreadId, threadId);
  const first = processing.proposals()[0];
  const edited = processing.edit(
    first.id,
    first.markdown + "\n手工保留的段落。",
    first.draftHash,
  );

  const restarted = new Processing(
    vault,
    captures,
    processing.getProvider,
    async () => {
      throw new Error("fixture must configure the resumed response");
    },
  );
  const feedback = "保留手工改动，把完整推导放进子笔记。";
  const requestId = randomUUID();
  const second = restarted.continueWithCodex(
    edited.id,
    feedback,
    edited.draftHash,
    requestId,
  );
  assert.equal(
    restarted.continueWithCodex(
      edited.id,
      feedback,
      edited.draftHash,
      requestId,
    ).id,
    second.id,
  );
  assert.equal(restarted.getProposal(edited.id).revising, true);
  assert.throws(() => restarted.reject(edited.id), /正在修改/);
  restarted.callLocalCodex = async (
    prompt,
    images,
    _signal,
    _profile,
    options,
    session,
  ) => {
    assert.equal(session?.threadId, threadId);
    assert.equal(options?.model, "fixture-model");
    assert.equal(images?.length, 0);
    assert.match(prompt, /手工保留的段落/);
    assert.ok(prompt.includes(feedback));
    session!.onThread(threadId);
    return JSON.stringify({
      markdown:
        "# 电路笔记\n\n手工保留的段落。[详细推导](child-note:math)\n\n## 原理\n\n## 偏置\n\n## 推导\n\n## 总结\n",
      childNotes: [
        {
          key: "math",
          title: "详细推导",
          markdown: "先写节点方程，再代入偏置条件。",
        },
      ],
      unresolved: [],
    });
  };
  await run(restarted, second.id);
  const updated = restarted.proposals()[0];
  assert.equal(restarted.getProposal(edited.id).supersededBy, updated.id);
  const history = restarted.conversation(second.id);
  assert.equal(history.threadId, threadId);
  assert.equal(history.turns[1].instruction, feedback);
  assert.match(history.turns[0].replies[0].markdown, /第一轮/);
  assert.equal(vault.read(target.path).content, target.content);
  assert.equal(
    vault
      .list()
      .filter((n) => n.title === "详细推导" && !n.path.includes("/Drafts/"))
      .length,
    0,
  );
  const accept = (
    save: (
      path: string,
      content: string,
      hash: string,
    ) => Promise<{ path: string }>,
  ) => restarted.accept(updated.id, updated.markdown, save, updated.draftHash);
  await assert.rejects(
    () =>
      accept(async () => {
        throw new Error("disk fixture");
      }),
    /disk fixture/,
  );
  assert.equal(vault.read(target.path).content, target.content);
  const save = async (path: string, content: string, hash: string) =>
    vault.save(path, content, hash);
  assert.equal((await accept(save)).path, target.path);
  assert.equal((await accept(save)).path, target.path);
  const child = vault.list().find((n) => n.title === "详细推导")!;
  assert.ok(child);
  assert.equal(vault.list().filter((n) => n.title === "详细推导").length, 1);
  const accepted = vault.read(target.path);
  assert.match(accepted.content, /\[TOC\]/);
  assert.doesNotMatch(accepted.content, /child-note:/);
  const [down] = markdownLinks(accepted.body!);
  const [up] = markdownLinks(vault.read(child.path).body!);
  assert.equal(
    vault.resolveLink(down.target, target.path, down.style),
    child.path,
  );
  assert.equal(vault.resolveLink(up.target, child.path, up.style), target.path);
});

test("batch feedback can revise a saved draft after the original changes, with version checks at acceptance", async (t) => {
  const { vault, processing } = fixture(t);
  const note = vault.create("修订测试", "concept", "原始正文。");
  const markdown = "\n第一段：偏置条件。\n\n第二段：仿真结果。";
  const threadId = randomUUID();
  const comments = [
    {
      text: "加粗偏置条件",
      anchor: { text: "偏置条件", offset: 5, line: 2, column: 5 },
    },
    {
      text: "为仿真结果加标题",
      anchor: {
        text: "仿真结果",
        offset: markdown.indexOf("仿真结果"),
        line: 4,
        column: 5,
      },
    },
    { text: "保留原图" },
    { text: "标出尚待核对的数据" },
    { text: "统一术语" },
    { text: "保留参考来源" },
  ];
  const revised = markdown + "\n\n本轮修订。";
  let revisionCalls = 0;
  processing.callLocalCodex = async (
    prompt,
    _images,
    _signal,
    _profile,
    _options,
    session,
  ) => {
    if (session?.live) {
      revisionCalls++;
      assert.equal(session.threadId, threadId);
      for (const { text } of comments) assert.ok(prompt.includes(text));
      assert.ok(
        prompt.includes('"待审稿起始行":4,"待审稿起始列":5,"引用":"仿真结果"'),
      );
    }
    session!.onThread(threadId);
    return JSON.stringify({
      markdown: session?.live ? revised : markdown,
      unresolved: [],
    });
  };
  const run = async (id: string) => {
    await processing.run(id);
    while (processing.running.has(id))
      await new Promise((resolve) => setImmediate(resolve));
    const job = processing.get(id);
    assert.equal(job.state, "review", job.error || "");
  };
  const input = {
    path: note.path,
    scope: "workbench" as const,
    referencePaths: [],
    instruction: "",
  };
  const root = processing.createNoteOptimization(
    input,
    processing.previewNoteOptimization(input).previewHash,
    randomUUID(),
  );
  await run(root.id);
  const draft = processing.proposals()[0];
  const changed = vault.save(
    note.path,
    note.content + "\n本地新改动。",
    note.hash,
  );
  const requestId = randomUUID();
  const submit = () =>
    processing.continueWithCodex(
      draft.id,
      "请按本轮所有意见修订。",
      draft.draftHash,
      requestId,
      { mode: "revision", comments },
    );
  const followUp = submit();
  assert.equal(submit().id, followUp.id);
  await run(followUp.id);
  assert.equal(revisionCalls, 1);
  assert.deepEqual(
    processing.conversation(root.id).turns.at(-1)?.comments,
    comments,
  );
  const nextDraft = processing.proposals()[0];
  assert.equal(nextDraft.jobId, followUp.id);
  assert.equal(nextDraft.baseHash, note.hash);
  await assert.rejects(
    () =>
      processing.accept(
        nextDraft.id,
        nextDraft.markdown,
        async (p, c, h) => vault.save(p, c, h),
        nextDraft.draftHash,
      ),
    { code: "VERSION_CONFLICT" },
  );
  assert.equal(vault.read(note.path).content, changed.content);
});

test("a legacy child draft section becomes a real note when the parent draft is accepted", async (t) => {
  const { vault, processing } = fixture(t);
  const target = vault.create(
    "真实子笔记",
    "concept",
    "# 真实子笔记\n\n旧笔记。",
  );
  processing.callLocalCodex = async () =>
    JSON.stringify({
      markdown:
        "# 真实子笔记\n\n## 现有笔记\n\n### 子笔记草稿一｜完整推导\n\n段落内容。\n\n## 总结\n\n保留总结。\n",
      unresolved: [],
    });
  const input = {
    path: target.path,
    scope: "workbench" as const,
    referencePaths: [],
    instruction: "",
  };
  const job = processing.createNoteOptimization(
    input,
    processing.previewNoteOptimization(input).previewHash,
    randomUUID(),
  );
  await processing.run(job.id);
  while (processing.running.has(job.id))
    await new Promise((resolve) => setImmediate(resolve));
  const proposal = processing.proposals()[0];
  assert.equal(proposal.legacyChildren, true);
  assert.equal(proposal.childNotes?.[0].title, "完整推导");
  await processing.accept(
    proposal.id,
    proposal.markdown,
    async (p, c, h) => vault.save(p, c, h),
    proposal.draftHash,
  );
  const child = vault.list().find((note) => note.title === "完整推导")!;
  assert.match(vault.read(child.path).body!, /段落内容。/);
  assert.match(vault.read(target.path).body!, /保留总结。/);
  assert.doesNotMatch(vault.read(target.path).body!, /子笔记草稿一/);
});

test("review checks draft version, retains unavailable records and allows explicit rebase of stale amendments", async (t) => {
  const { vault, processing, captures } = fixture(t),
    note = vault.create("原笔记"),
    capture = captures.add({ title: "原始想法", text: "需要核对" });
  const job = processing.create([capture.id], [note.path], "codex", "");
  const p = processing.submit(
    job.id,
    "review-version",
    {
      title: "更新",
      action: "amend",
      targetPath: note.path,
      baseHash: note.hash,
      markdown: note.content + "\n修订。",
      sourceIds: [capture.id],
    },
    job.snapshot.inputHash,
  );
  const save = async (p: string, c: string, h: string) => vault.save(p, c, h);
  const edited = processing.edit(
    p.id,
    p.markdown + "\n人工改动。",
    p.draftHash,
  );
  await assert.rejects(
    () => processing.accept(p.id, p.markdown, save, p.draftHash),
    (e: any) => e.code === "VERSION_CONFLICT",
  );
  const changed = vault.save(
    note.path,
    note.content + "\n外部补充。",
    note.hash,
  );
  await assert.rejects(
    () => processing.accept(p.id, edited.markdown, save, edited.draftHash),
    (e: any) => e.code === "VERSION_CONFLICT",
  );
  const rebased = processing.rebase(p.id, edited.draftHash, changed.hash);
  const accepted = await processing.accept(
    p.id,
    rebased.markdown,
    save,
    rebased.draftHash,
  );
  assert.match(vault.read(accepted.path!).content, /人工改动/);
  fs.renameSync(vault.absolute(p.path), vault.absolute(p.path) + ".offline");
  assert.equal(processing.proposals()[0].id, p.id);
  assert.ok(processing.proposals()[0].unavailable);
});

test("existing Markdown keeps BOM, CRLF, custom YAML and unknown syntax; conflict retains draft and history", (t) => {
  const { vault } = fixture(t),
    raw =
      "\uFEFF---\r\ntitle: 中文\r\ncustom: {a: [1, 2]}\r\n---\r\n\r\n# 中文\r\n%%unknown%% [[双链]] $g_m$\r\n";
  atomicWrite(vault.absolute("已有笔记.md"), raw, true);
  const n = vault.index("已有笔记.md");
  assert.equal(n.content, raw);
  assert.deepEqual(n.metadata.custom, { a: [1, 2] });
  assert.equal(vault.save(n.path, raw, n.hash).content, raw);
  assert.equal(vault.history(n.path).length, 0);
  const saved = vault.save(n.path, raw + "补充\r\n", n.hash);
  assert.equal(vault.history(n.path)[0].content, raw);
  atomicWrite(vault.absolute(n.path), raw + "外部修改\r\n");
  assert.throws(
    () => vault.save(n.path, "未保存的想法", saved.hash),
    /其他应用修改/,
  );
  assert.equal(vault.read(n.path).draft?.content, "未保存的想法");
  assert.match(vault.read(n.path).content, /外部修改/);
});
test("changing the display title preserves note bytes outside the title and checks drafts and versions", (t) => {
  const { vault } = fixture(t);
  const file = "B.md";
  const raw =
    "\uFEFF---\r\ntitle: B # 保留注释\r\ncustom: {a: [1, 2]}\r\n---\r\n\r\n# B\r\n[[A#小节]]\r\n";
  atomicWrite(vault.absolute(file), raw, true);
  const note = vault.index(file);
  const title = '新标题: "学习"';
  const saved = vault.setTitle(file, title, note.hash);
  assert.equal(saved.title, title);
  assert.equal(saved.id, note.id);
  assert.equal(
    saved.content,
    raw.replace("title: B", `title: ${JSON.stringify(title)}`),
  );
  assert.equal(vault.history(file)[0].content, raw);
  assert.throws(() => vault.setTitle(file, "旧版本", note.hash), /已有新修改/);
  vault.keepDraft(file, "待保存内容", saved.hash);
  assert.throws(
    () => vault.setTitle(file, "另一个标题", saved.hash),
    /未保存的草稿/,
  );
  assert.equal(vault.read(file).draft?.content, "待保存内容");
  assert.equal(vault.read(file).content, saved.content);
});
test("failed disk replacement preserves original and local draft", (t) => {
  const { vault } = fixture(t),
    n = vault.create("故障恢复");
  const rename = fs.renameSync.bind(fs);
  const stub = t.mock.method(
    fs,
    "renameSync",
    (a: fs.PathLike, b: fs.PathLike) => {
      if (String(b) === vault.absolute(n.path))
        throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
      return rename(a, b);
    },
  );
  assert.throws(() => vault.save(n.path, "下一段尚未保存", n.hash), /ENOSPC/);
  stub.mock.restore();
  assert.equal(vault.read(n.path).content, n.content);
  assert.equal(vault.read(n.path).draft?.content, "下一段尚未保存");
  assert.equal(vault.history(n.path)[0].content, n.content);
});
test("child note creation keeps the parent's source and retries an interrupted link save", (t) => {
  const { vault } = fixture(t);
  const path = "外部/详细 [实验] #1.md";
  const raw =
    "\uFEFF---\r\ncustom: {a: [1, 2]}\r\n---\r\n\r\n# 电路\r\n\r\n待推导\r\n\r\n下段\r\n";
  atomicWrite(vault.absolute(path), raw, true);
  const parent = vault.index(path);
  const request = {
    path,
    expectedHash: parent.hash,
    offset: raw.indexOf("待推导") + "待推导".length,
    requestId: randomUUID(),
  };
  const title = "详细 [推导] #1";
  const create = () =>
    vault.createChild(
      title,
      "learning-log",
      request,
      "# 详细\n\n## 目标与已知条件\n",
    );
  const rename = fs.renameSync.bind(fs);
  const stub = t.mock.method(
    fs,
    "renameSync",
    (a: fs.PathLike, b: fs.PathLike) => {
      if (String(b) === vault.absolute(path))
        throw new Error("injected disk write failure");
      return rename(a, b);
    },
  );
  assert.throws(create, /父笔记链接保存未确认/);
  stub.mock.restore();
  assert.equal(vault.read(path).content, raw);
  assert.equal(vault.list().filter((note) => note.title === title).length, 1);

  const { child, parent: saved, insertion } = create();
  assert.equal(insertion?.offset, request.offset);
  assert.equal(
    saved.content.slice(0, request.offset),
    raw.slice(0, request.offset),
  );
  assert.equal(
    saved.content.slice(request.offset + insertion!.text.length),
    raw.slice(request.offset),
  );
  assert.match(child.body!, /## 目标与已知条件/);
  assert.deepEqual(saved.metadata, parent.metadata);
  assert.equal(vault.read(path).draft, undefined);
  assert.equal(vault.history(path)[0].content, raw);
  assert.equal(create().parent.content, saved.content);
  assert.equal(create().child.path, child.path);

  const [down] = markdownLinks(saved.body!);
  assert.equal(vault.resolveLink(down.target, path, down.style), child.path);
  const moved = "外部/移动之后 #2.md";
  vault.move(path, moved, saved.hash, true);
  const [up] = markdownLinks(vault.read(child.path).body!);
  assert.equal(vault.resolveLink(up.target, child.path, up.style), moved);
});

test("child note creation rejects an outdated parent or an insertion inside a code block", (t) => {
  const { vault } = fixture(t);
  const path = "代码示例.md";
  const raw = "# 示例\n\n```md\n放在围栏内\n```\n";
  atomicWrite(vault.absolute(path), raw, true);
  const parent = vault.index(path);
  const request = {
    path,
    expectedHash: parent.hash,
    offset: raw.indexOf("放在围栏内") + "放在围栏内".length,
    requestId: randomUUID(),
  };
  assert.throws(
    () => vault.createChild("测试", "concept", request),
    /正文段落或空白行/,
  );
  atomicWrite(vault.absolute(path), raw + "\n改用另一版本");
  assert.throws(
    () => vault.createChild("测试", "concept", request),
    /父笔记已修改/,
  );
  assert.equal(vault.list().length, 1);
});

test("child notes can be inserted inside a sentence without changing text or line endings", (t) => {
  const { vault } = fixture(t);
  const path = "示例.md";
  const raw =
    "\uFEFF---\r\ntitle: 示例\r\n---\r\n\r\n先估算电流，再代入公式。\r\n";
  atomicWrite(vault.absolute(path), raw, true);
  const parent = vault.index(path);
  const offset = raw.indexOf("，");
  const result = vault.createChild("推导", "concept", {
    path,
    expectedHash: parent.hash,
    requestId: randomUUID(),
    offset,
    placement: "inline",
  });
  const insertion = result.insertion!;
  assert.equal(insertion.offset, offset);
  assert.match(insertion.text, /^\[推导\]\([^()\r\n]+\.md\)$/);
  assert.equal(
    result.parent.content,
    raw.slice(0, offset) + insertion.text + raw.slice(offset),
  );
  const [link] = markdownLinks(result.parent.body!);
  assert.equal(
    vault.resolveLink(link.target, path, link.style),
    result.child.path,
  );
});

test("note trash preserves bytes and recovers at the same path without replacing a new file", (t) => {
  const { vault } = fixture(t);
  const note = vault.create("回收测试");
  const file = vault.absolute(note.path);
  assert.throws(() => vault.trashNote(note.path, "0".repeat(64)), /新修改/);
  vault.keepDraft(note.path, note.content + "未保存的输入", note.hash);
  assert.throws(() => vault.trashNote(note.path, note.hash), /未保存的草稿/);
  vault.clearDraft(note.path);

  const trashed = vault.trashNote(note.path, note.hash);
  const archive = path.join(
    vault.root,
    ".trash",
    `kwb-note-${trashed.id}`,
    note.path,
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(archive, "utf8"), note.content);
  assert.equal(vault.search(note.title).length, 0);
  assert.equal(
    vault.scan().notes.find((n) => n.path === note.path)?.missing,
    true,
  );

  atomicWrite(file, "# 外部新建", true);
  assert.throws(() => vault.restoreDeletedNote(trashed), /原位置已有文件/);
  assert.equal(fs.readFileSync(file, "utf8"), "# 外部新建");
  assert.equal(fs.readFileSync(archive, "utf8"), note.content);
  fs.unlinkSync(file);
  const restored = vault.restoreDeletedNote(trashed);
  assert.equal(restored.content, note.content);
  assert.equal(restored.id, note.id);
  assert.equal(vault.search(note.title)[0]?.path, note.path);
  assert.equal(fs.existsSync(archive), false);
});
test("Chinese full-text and short substring search; unreadable file keeps old index", (t) => {
  const { vault } = fixture(t);
  const n = vault.create(
    "跨导效率分析",
    "concept",
    "# 跨导效率分析\n\n比较跨导效率与边界条件。",
  );
  assert.equal(vault.search("跨导效率").length, 1);
  assert.equal(vault.search("跨导").length, 1);
  const read = fs.readFileSync.bind(fs);
  const stub = t.mock.method(fs, "readFileSync", ((
    file: any,
    ...args: any[]
  ) => {
    if (String(file) === vault.absolute(n.path))
      throw Object.assign(new Error("offline"), { code: "EIO" });
    return (read as any)(file, ...args);
  }) as any);
  vault.scan();
  stub.mock.restore();
  assert.equal(vault.list()[0].missing, false);
  assert.equal(vault.search("边界").length, 1);
  assert.equal(vault.warnings.length, 1);
});
test("workspace search filters before the result limit for full-text and short Chinese queries", (t) => {
  const { vault } = fixture(t);
  for (let i = 0; i < 110; i++) {
    atomicWrite(vault.absolute(`外部/笔记-${i}.md`), "# 跨导效率\n跨导效率\n");
    atomicWrite(
      vault.absolute(`KnowledgeWorkbench/Inbox/材料-${i}.md`),
      "# 跨导效率\n",
    );
    atomicWrite(
      vault.absolute(`KnowledgeWorkbench/Drafts/草稿-${i}.md`),
      "# 跨导效率\n",
    );
  }
  atomicWrite(
    vault.absolute("KnowledgeWorkbenchOther/跨导效率.md"),
    "# 跨导效率\n",
  );
  vault.scan();
  const note = vault.create(
    "专属空间",
    "concept",
    "# 专属空间\n跨导效率\n" + "条件说明。".repeat(200),
  );
  for (const q of ["跨导效率", "跨导", ""]) {
    assert.deepEqual(
      vault.search(q, "workbench").map((n) => n.path),
      [note.path],
    );
    assert.ok(vault.search(q, "vault").length >= 100);
  }
});
test("move updates incoming and outgoing links, preserves recovery record", (t) => {
  const { vault } = fixture(t);
  atomicWrite(vault.absolute("旧/概念.md"), "# 概念\n\n![图](../图片.png)\n");
  atomicWrite(
    vault.absolute("引用.md"),
    "[[旧/概念|读这里]]\n[概念](%E6%97%A7/%E6%A6%82%E5%BF%B5.md)",
  );
  vault.scan();
  const n = vault.read("旧/概念.md");
  const preview = vault.move(n.path, "新/子目录/概念.md", n.hash, false);
  assert.equal((preview as any).changes.length, 2);
  vault.move(n.path, "新/子目录/概念.md", n.hash, true);
  assert.equal(fs.existsSync(vault.absolute(n.path)), false);
  assert.match(vault.read("引用.md").content, /\[\[新\/子目录\/概念\|读这里/);
  assert.match(vault.read("新/子目录/概念.md").content, /\.\.\/\.\.\//);
  const record = JSON.parse(
    fs.readFileSync(
      path.join(
        vault.dataDir,
        "moves",
        fs.readdirSync(path.join(vault.dataDir, "moves"))[0],
      ),
      "utf8",
    ),
  );
  assert.equal(record.state, "completed");
  assert.equal(record.updates.length, 2);
});
test("move fault rolls back linked notes without removing original", (t) => {
  const { vault } = fixture(t);
  atomicWrite(vault.absolute("A.md"), "# A\n");
  atomicWrite(vault.absolute("B.md"), "[[A]]");
  vault.scan();
  const n = vault.read("A.md"),
    rename = fs.renameSync.bind(fs);
  let failed = false;
  const stub = t.mock.method(
    fs,
    "renameSync",
    (a: fs.PathLike, b: fs.PathLike) => {
      if (!failed && String(b) === vault.absolute("B.md")) {
        failed = true;
        throw new Error("injected move failure");
      }
      return rename(a, b);
    },
  );
  assert.throws(
    () => vault.move("A.md", "子目录/C.md", n.hash, true),
    /injected/,
  );
  stub.mock.restore();
  assert.equal(vault.read("A.md").content, "# A\n");
  assert.equal(vault.read("B.md").content, "[[A]]");
  assert.equal(fs.existsSync(vault.absolute("子目录/C.md")), false);
});
test("path traversal and escaping junctions cannot read outside vault", (t) => {
  const { vault, root } = fixture(t);
  assert.throws(() => safePath(vault.root, "../outside.md"));
  assert.throws(() => safePath(vault.root, "C:/outside.md"));
  assert.throws(() => safePath(vault.root, ".obsidian/app.json"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(vault.root, "链接"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => safePath(vault.root, "链接/test.md"), /链接指向/);
});
test("20 repeated images keep 20 ideas but one asset; indices rebuild from files", (t) => {
  const { vault, captures, db } = fixture(t);
  for (let i = 0; i < 20; i++)
    captures.add({
      title: `图 ${i}`,
      text: `想法 ${i}`,
      image: png.toString("base64"),
    });
  assert.equal(captures.list().length, 20);
  assert.equal(
    fs.readdirSync(vault.absolute("KnowledgeWorkbench/Assets")).length,
    1,
  );
  db.exec("DELETE FROM sources; DELETE FROM notes; DELETE FROM notes_fts;");
  vault.scan();
  assert.equal(captures.list().length, 20);
  assert.equal(new Set(captures.list().map((c) => c.ref.sha256)).size, 1);
  assert.match(
    captures.list().find((c) => c.ref.title === "图 17")!.text,
    /想法 17/,
  );
});
test("partial and corrupt Paperdesk transfers wait, complete package imports only once", (t) => {
  const { vault, captures } = fixture(t),
    id = randomUUID(),
    folder = vault.absolute(`Paperdesk/Exports/${id}`);
  fs.mkdirSync(folder, { recursive: true });
  const manifest = {
    schema: "paperdesk-capture/v1",
    id,
    createdAt: new Date().toISOString(),
    source: {
      documentId: randomUUID(),
      title: "测试文献",
      pdfSha256: "a".repeat(64),
      page: 3,
      rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.2 }],
      quote: "可见文字",
    },
    comment: "原始疑问",
    image: { file: "selection.png", mime: "image/png", sha256: digest(png) },
  };
  atomicWrite(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  captures.importPaperdesk();
  assert.equal(captures.list().length, 0);
  atomicWrite(path.join(folder, "selection.png"), png);
  captures.importPaperdesk();
  captures.importPaperdesk();
  assert.equal(captures.list().length, 1);
  assert.equal(captures.list()[0].ref.paperdesk?.page, 3);
  const mismatched = randomUUID();
  const other = vault.absolute(`Paperdesk/Exports/${mismatched}/manifest.json`);
  atomicWrite(other, JSON.stringify(manifest));
  assert.deepEqual(captures.importPaperdesk().pending, [mismatched]);
  atomicWrite(
    other,
    JSON.stringify({ ...manifest, id: mismatched, createdAt: "not-a-date" }),
  );
  assert.deepEqual(captures.importPaperdesk().pending, [mismatched]);
  assert.equal(captures.list().length, 1);
});
test("batch is immutable; proposal scope and stale edits are rejected; acceptance idempotent", async (t) => {
  const { vault, captures, processing } = fixture(t);
  const source = captures.add({ title: "原始疑问", text: "最初想法" }),
    ref = vault.create("已有结论"),
    job = processing.create([source.id], [ref.path], "codex", "保留疑点");
  vault.save(ref.path, ref.content + "\n更新", ref.hash);
  assert.equal(processing.get(job.id).snapshot.references[0].hash, ref.hash);
  const draft = {
    title: "新认识",
    action: "create",
    noteType: "concept",
    markdown: "# 新认识\n\n待核对。",
    sourceIds: [source.id],
    unresolved: ["模型条件待确认"],
  };
  assert.throws(
    () =>
      processing.submit(
        job.id,
        "bad",
        { ...draft, sourceIds: [randomUUID()] },
        job.snapshot.inputHash,
      ),
    /本批之外/,
  );
  const p = processing.submit(job.id, "new", draft, job.snapshot.inputHash);
  assert.equal(
    processing.submit(job.id, "new", draft, job.snapshot.inputHash).id,
    p.id,
  );
  const accepted = await processing.accept(p.id, p.markdown, async (p, c, h) =>
    vault.save(p, c, h),
  );
  assert.equal(
    (
      await processing.accept(p.id, p.markdown, async (p, c, h) =>
        vault.save(p, c, h),
      )
    ).path,
    accepted.path,
  );
  assert.equal(vault.read(accepted.path!).status, "working");
  assert.match(vault.read(accepted.path!).content, /材料来源/);
  const amendment = processing.create([source.id], [ref.path], "codex", "修订");
  const target = vault.read(ref.path);
  const a = processing.submit(
    amendment.id,
    "amend",
    { ...draft, action: "amend", targetPath: ref.path, baseHash: target.hash },
    amendment.snapshot.inputHash,
  );
  vault.save(ref.path, target.content + "\n再次更新", target.hash);
  await assert.rejects(
    () =>
      processing.accept(a.id, a.markdown, async (p, c, h) =>
        vault.save(p, c, h),
      ),
    (error: any) => error.code === "VERSION_CONFLICT",
  );
  assert.equal(processing.getProposal(a.id).status, "pending");
});
test("accept retry after target write failure does not create duplicate note", async (t) => {
  const { vault, captures, processing } = fixture(t);
  const source = captures.add({ title: "材料", text: "测试" }),
    job = processing.create([source.id], [], "codex", ""),
    p = processing.submit(
      job.id,
      "recovery",
      {
        title: "可恢复草稿",
        action: "create",
        markdown: "# 恢复",
        sourceIds: [source.id],
      },
      job.snapshot.inputHash,
    );
  const save = vault.save.bind(vault);
  const stub = t.mock.method(
    vault,
    "save",
    (...args: Parameters<Vault["save"]>) => {
      if (args[0] === p.path) throw new Error("injected interruption");
      return save(...args);
    },
  );
  await assert.rejects(
    () => processing.accept(p.id, p.markdown, async (p, c, h) => save(p, c, h)),
    /interruption/,
  );
  stub.mock.restore();
  const n = await processing.accept(p.id, p.markdown, async (p, c, h) =>
    save(p, c, h),
  );
  assert.ok(n.path);
  assert.equal(
    vault.list().filter((n) => n.path.includes("/Cards/")).length,
    1,
  );
});
test("20 crop selections map physical pixels at multiple DPI scales and negative desktop origins", () => {
  for (let i = 0; i < 20; i++) {
    const scale = [1, 1.25, 1.5, 2][i % 4],
      logical = { width: 1600, height: 900, x: i % 2 ? -1600 : 0, y: 0 },
      physical = {
        width: Math.round(1600 * scale),
        height: Math.round(900 * scale),
      },
      r = cropRect(
        { x: 100, y: 80, width: 400, height: 200 },
        logical,
        physical,
      );
    assert.deepEqual(r, {
      x: 100 * scale,
      y: 80 * scale,
      width: 400 * scale,
      height: 200 * scale,
    });
  }
  assert.throws(() =>
    cropRect(
      { x: 0, y: 0, width: 0, height: 100 },
      { width: 1600, height: 900 },
      { width: 1600, height: 900 },
    ),
  );
});
