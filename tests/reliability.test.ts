import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { Captures } from "../server/capture.ts";
import { Processing } from "../server/processing.ts";
import { formatMarkdown, paperdeskBody } from "../server/markdown.ts";
import { relatedNotes } from "../server/relations.ts";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-reliability-"));
  const dir = path.join(root, "vault"),
    data = path.join(root, "profile");
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  let db = openDatabase(data);
  let vault = new Vault(dir, data, db),
    captures = new Captures(vault);
  let processing = new Processing(vault, captures, async () => ({
    baseUrl: "http://127.0.0.1:1",
    model: "synthetic",
    protocol: "responses",
    apiKey: "synthetic-test-only",
  }));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get vault() {
      return vault;
    },
    get processing() {
      return processing;
    },
    get captures() {
      return captures;
    },
    restart() {
      db.close();
      db = openDatabase(data);
      vault = new Vault(dir, data, db);
      captures = new Captures(vault);
      processing = new Processing(vault, captures, async () => {
        throw new Error("provider must not be called during recovery");
      });
      vault.scan();
      processing.rebuildProposals();
    },
  };
}
function proposal(f: ReturnType<typeof fixture>) {
  const source = f.captures.add({ title: "原始材料", text: "原始想法" });
  const job = f.processing.create([source.id], [], "codex", "");
  const p = f.processing.submit(
    job.id,
    "synthetic-request",
    {
      title: "结果",
      action: "create",
      markdown: "# 结果",
      sourceIds: [source.id],
    },
    job.snapshot.inputHash,
  );
  return { source, job, p };
}
for (const mode of ["move", "rename"] as const)
  test(`accept resolves stable source identity after external ${mode}`, async (t) => {
    const f = fixture(t),
      { source, job, p } = proposal(f);
    const moved = mode === "move" ? "另一个目录/来源.md" : "已改名.md";
    fs.mkdirSync(path.dirname(f.vault.absolute(moved)), { recursive: true });
    fs.renameSync(f.vault.absolute(source.path), f.vault.absolute(moved));
    // No refresh request: accepting itself must resolve the current path.
    const result = await f.processing.accept(
      p.id,
      p.markdown,
      async (p, c, h) => f.vault.save(p, c, h),
    );
    const note = f.vault.read(result.path!);
    assert.deepEqual(note.metadata.source, [`[[${moved}]]`]);
    assert.equal(
      (note.metadata.kb_source_snapshots as any[])[0].path,
      source.path,
    );
    assert.equal(
      f.processing.get(job.id).snapshot.sources[0].path,
      source.path,
    );
  });
for (const mode of ["missing", "ambiguous"] as const)
  test(`accept refuses ${mode} source identity without creating a note`, async (t) => {
    const f = fixture(t),
      { source, p } = proposal(f);
    if (mode === "missing") fs.unlinkSync(f.vault.absolute(source.path));
    else
      fs.copyFileSync(
        f.vault.absolute(source.path),
        f.vault.absolute("copy.md"),
      );
    await assert.rejects(
      () =>
        f.processing.accept(p.id, p.markdown, async (p, c, h) =>
          f.vault.save(p, c, h),
        ),
      (e: any) => e.code === "SOURCE_UNAVAILABLE",
    );
    assert.equal(
      f.vault.list().filter((n) => n.path.includes("/Cards/")).length,
      0,
    );
  });
test("Markdown rejection coordinates cached state and rebuild leaves active job alone", async (t) => {
  const f = fixture(t),
    { job, p } = proposal(f);
  const doc = f.vault.read(p.path);
  fs.writeFileSync(
    f.vault.absolute(p.path),
    formatMarkdown({ ...doc.metadata, kb_review_state: "rejected" }, doc.body!),
  );
  f.vault.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);
  f.vault.scan();
  f.processing.rebuildProposals();
  assert.equal(f.processing.getProposal(p.id).status, "rejected");
  assert.equal(f.processing.get(job.id).state, "running");
  await assert.rejects(() =>
    f.processing.accept(p.id, p.markdown, async (p, c, h) =>
      f.vault.save(p, c, h),
    ),
  );
  f.restart();
  assert.equal(f.processing.getProposal(p.id).status, "rejected");
});
test("invalid YAML never replaces a valid note; damaged external YAML remains repairable", (t) => {
  const f = fixture(t),
    n = f.vault.create("YAML");
  const broken = "---\ntitle: [broken\n---\nunfinished";
  assert.throws(() => f.vault.save(n.path, broken, n.hash));
  assert.equal(f.vault.read(n.path).content, n.content);
  assert.equal(f.vault.read(n.path).draft?.content, broken);
  fs.writeFileSync(f.vault.absolute(n.path), broken);
  const opened = f.vault.read(n.path);
  assert.equal(opened.content, broken);
  const fixed = f.vault.save(n.path, "# repaired", opened.hash);
  assert.equal(fixed.content, "# repaired");
});
test("amend retains identity, metadata, sources and unresolved issues and cannot promote canonical", async (t) => {
  const f = fixture(t),
    source = f.captures.add({ title: "新材料", text: "新信息" });
  const n = f.vault.create("现有笔记");
  const target = f.vault.save(
    n.path,
    formatMarkdown(
      {
        ...n.metadata,
        status: "canonical",
        custom: { unit: "V" },
        source: ["[[旧来源]]"],
        kb_unresolved: ["旧疑问"],
      },
      "旧正文",
    ),
    n.hash,
  );
  const j = f.processing.create([source.id], [target.path], "codex", "");
  const p = f.processing.submit(
    j.id,
    "amend",
    {
      title: "修订",
      action: "amend",
      targetPath: target.path,
      baseHash: target.hash,
      sourceIds: [source.id],
      unresolved: ["新疑问"],
      markdown: "---\nstatus: canonical\nkb_id: forged\n---\n新正文",
    },
    j.snapshot.inputHash,
  );
  await f.processing.accept(p.id, p.markdown, async (p, c, h) =>
    f.vault.save(p, c, h),
  );
  const saved = f.vault.read(target.path);
  assert.equal(saved.id, n.id);
  assert.equal(saved.status, "working");
  assert.deepEqual(saved.metadata.custom, { unit: "V" });
  assert.deepEqual(saved.metadata.kb_unresolved, ["旧疑问", "新疑问"]);
  assert.deepEqual(saved.metadata.source, ["[[旧来源]]", `[[${source.path}]]`]);
});
test("provider initialization is reserved once and pause wins before initialization resolves", async (t) => {
  const f = fixture(t),
    s = f.captures.add({ title: "输入" });
  let calls = 0,
    resolve!: (v: any) => void;
  f.processing.getProvider = () => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const j = f.processing.create([s.id], [], "api", "");
  const first = f.processing.run(j.id),
    second = f.processing.run(j.id);
  assert.equal(calls, 1);
  f.processing.cancel(j.id);
  resolve({
    baseUrl: "http://127.0.0.1:1",
    protocol: "responses",
    model: "synthetic",
  });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(f.processing.get(j.id).state, "paused");
});
test("persisted summary resumes partial commit across restart without provider calls or duplicates", async (t) => {
  const f = fixture(t),
    s = f.captures.add({ title: "输入" });
  const j = f.processing.create([s.id], [], "api", "");
  f.vault.db
    .prepare("UPDATE job_items SET state='done',output='已提取' WHERE job_id=?")
    .run(j.id);
  const raw = JSON.stringify({
    drafts: [0, 1].map((i) => ({
      title: `结果 ${i}`,
      action: "create",
      sourceIds: [s.id],
      markdown: `# 同一结果 ${i}`,
    })),
  });
  fs.mkdirSync(path.join(f.vault.dataDir, "responses"), { recursive: true });
  fs.writeFileSync(
    path.join(f.vault.dataDir, "responses", j.id + ".json"),
    JSON.stringify({ raw, inputHash: j.snapshot.inputHash }),
  );
  const submit = f.processing.submit.bind(f.processing);
  t.mock.method(
    f.processing,
    "submit",
    (...args: Parameters<Processing["submit"]>) => {
      if (args[1].endsWith(":1"))
        throw new Error("injected second write failure");
      return submit(...args);
    },
  );
  await f.processing.run(j.id);
  while (f.processing.running.has(j.id))
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.processing.proposals().length, 1);
  assert.equal(f.processing.get(j.id).state, "failed");
  f.restart();
  await f.processing.run(j.id);
  while (f.processing.running.has(j.id))
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.processing.get(j.id).state, "review");
  assert.equal(f.processing.proposals().length, 2);
  await f.processing.run(j.id);
  assert.equal(f.processing.proposals().length, 2);
});
test("summary and orphan draft survive crash after file creation, without another model call", async (t) => {
  const f = fixture(t),
    s = f.captures.add({ title: "synthetic input" });
  const j = f.processing.create([s.id], [], "api", "");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        output_text:
          calls === 1
            ? "synthetic extraction"
            : JSON.stringify({
                drafts: [0, 1].map((i) => ({
                  title: `draft ${i}`,
                  action: "create",
                  sourceIds: [s.id],
                  markdown: `result ${i}`,
                })),
              }),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const link = fs.linkSync.bind(fs);
  let failed = false;
  const stub = t.mock.method(
    fs,
    "linkSync",
    (from: fs.PathLike, to: fs.PathLike) => {
      link(from, to);
      if (!failed && String(to).includes("draft 0--")) {
        failed = true;
        throw new Error("crash after file creation");
      }
    },
  );
  await f.processing.run(j.id);
  while (f.processing.running.has(j.id))
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.processing.get(j.id).state, "failed");
  assert.equal(calls, 2);
  stub.mock.restore();
  f.restart();
  await f.processing.run(j.id);
  while (f.processing.running.has(j.id))
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.processing.get(j.id).state, "review");
  assert.equal(calls, 2);
  assert.equal(f.processing.proposals().length, 2);
  assert.equal(
    fs
      .readdirSync(f.vault.absolute("KnowledgeWorkbench/Drafts"))
      .filter((n) => n.startsWith("draft ")).length,
    2,
  );
});
test("rebuild cannot overwrite an in-flight acceptance; external edit is retained on conflict", async (t) => {
  const f = fixture(t),
    s = f.captures.add({ title: "input" }),
    n = f.vault.create("target");
  const j = f.processing.create([s.id], [n.path], "codex", "");
  const p = f.processing.submit(
    j.id,
    "async-amend",
    {
      title: "amend",
      action: "amend",
      targetPath: n.path,
      baseHash: n.hash,
      sourceIds: [s.id],
      markdown: "new body",
    },
    j.snapshot.inputHash,
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const accepting = f.processing.accept(p.id, p.markdown, async (p, c, h) => {
    await gate;
    return f.vault.save(p, c, h);
  });
  const draft = f.vault.read(p.path);
  fs.writeFileSync(
    f.vault.absolute(p.path),
    formatMarkdown(
      { ...draft.metadata, kb_review_state: "rejected" },
      "external edit",
    ),
  );
  f.vault.scan();
  f.processing.rebuildProposals();
  assert.equal(
    (
      f.vault.db
        .prepare("SELECT status FROM proposals WHERE id=?")
        .get(p.id) as any
    ).status,
    "pending",
  );
  assert.throws(() => f.processing.reject(p.id), /正在接受/);
  release();
  await assert.rejects(
    () => accepting,
    (e: any) => e.code === "VERSION_CONFLICT",
  );
  assert.match(f.vault.read(p.path).content, /external edit/);
  f.processing.rebuildProposals();
  assert.equal(f.processing.getProposal(p.id).status, "rejected");
});
test("capture acknowledgement loss retries same request without duplicating input", (t) => {
  const f = fixture(t),
    requestId = "4a136a40-e62f-4c9c-9013-fc41e3bfa689";
  const input = { title: "想法", text: "synthetic", requestId };
  const first = f.captures.add(input);
  f.restart();
  assert.equal(f.captures.add(input).id, first.id);
  assert.equal(f.captures.list().length, 1);
  assert.throws(
    () => f.captures.add({ ...input, text: "changed" }),
    /其他内容/,
  );
});
test("relations aggregate body and property links and label tracked image hashes", (t) => {
  const f = fixture(t),
    s = f.captures.add({
      title: "可读图片名称",
      image:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB3sAAAAASUVORK5CYII=",
    });
  const n = f.vault.create("关联测试");
  f.vault.save(
    n.path,
    formatMarkdown(
      { ...n.metadata, source: [`[[${s.path}]]`] },
      `[[${s.path.replace(/\.md$/, "")}]]\n![[${s.ref.assetPath}]]`,
    ),
    n.hash,
  );
  const links = relatedNotes(f.vault, n.path);
  assert.equal(links.outgoing.length, 2);
  assert.deepEqual(links.outgoing[0].kinds.sort(), ["related", "source"]);
  assert.equal(links.outgoing[1].label, "图片附件 · 可读图片名称");
  assert.equal(links.outgoing[1].sha256, s.ref.sha256);
  assert.equal(relatedNotes(f.vault, s.path).incoming.length, 1);
});
test("Paperdesk generated block removal preserves human text after the block", () => {
  const text =
    "---\ntitle: PDF\n---\n\n前面的正文\n\n<!-- paperdesk-generated:start:v1 -->\n自动内容\n<!-- paperdesk-generated:end:v1 -->\n\n后面的人工正文";
  assert.match(paperdeskBody(text), /前面的正文/);
  assert.match(paperdeskBody(text), /后面的人工正文/);
  assert.doesNotMatch(paperdeskBody(text), /自动内容/);
});
