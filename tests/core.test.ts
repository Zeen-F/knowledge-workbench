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
import { parseMarkdown, rewriteLinks } from "../server/markdown.ts";
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
