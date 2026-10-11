import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveVaultSelection } from "../desktop/vault-selection.mjs";
import { startService } from "../server/app.ts";
import { atomicWrite } from "../server/files.ts";
import { relatedNotes } from "../server/relations.ts";

function fixture(t: any) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-scope-"));
  const root = path.join(temporary, "中文 Obsidian 库");
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  atomicWrite(
    path.join(root, "Other", "外部.md"),
    "# 不在所选范围\n\nOUTSIDE_SEARCH_MARKER",
  );
  atomicWrite(
    path.join(root, "KnowledgeWorkbench", "Cards", "已有笔记.md"),
    "# 已有笔记\n\n[[KnowledgeWorkbench/Cards/另一篇]]",
  );
  atomicWrite(
    path.join(root, "KnowledgeWorkbench", "Cards", "另一篇.md"),
    "# 另一篇",
  );
  const services: Awaited<ReturnType<typeof startService>>[] = [];
  t.after(async () => {
    for (const service of services.reverse()) await service.close();
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  async function open(directory: string) {
    const service = await startService({
      vaultDir: directory,
      dataDir: path.join(temporary, "profile"),
    });
    services.push(service);
    return service;
  }
  return { temporary, root, open };
}

test("opening KnowledgeWorkbench selects its contents without nesting or exposing sibling notes", async (t) => {
  const { root, open } = fixture(t);
  const selected = path.join(root, "KnowledgeWorkbench");
  const service = await open(selected);
  const vault = service.vault!;
  assert.equal(vault.root, fs.realpathSync(root));
  assert.equal(vault.scope, fs.realpathSync(selected));
  assert.equal(vault.managed, "KnowledgeWorkbench");
  assert.equal(vault.list().length, 2);
  assert.equal(vault.search("OUTSIDE_SEARCH_MARKER").length, 0);
  assert.deepEqual(
    relatedNotes(vault, "KnowledgeWorkbench/Cards/已有笔记.md").outgoing.map(
      (link) => link.to_ref,
    ),
    ["KnowledgeWorkbench/Cards/另一篇.md"],
  );
  const created = vault.create("新增笔记");
  assert.match(created.path, /^KnowledgeWorkbench\/Cards\//);
  assert.equal(fs.existsSync(path.join(selected, "KnowledgeWorkbench")), false);
  assert.equal(
    fs.readFileSync(path.join(root, "Other", "外部.md"), "utf8"),
    "# 不在所选范围\n\nOUTSIDE_SEARCH_MARKER",
  );
  const status = await fetch(service.baseUrl + "/api/status", {
    headers: { Authorization: "Bearer " + service.token },
  }).then((r) => r.json());
  assert.equal(status.vault.name, "KnowledgeWorkbench");
  assert.equal(status.vault.scopePath, "KnowledgeWorkbench");
  const outside = await fetch(
    service.baseUrl + "/api/note?path=Other%2F外部.md",
    { headers: { Authorization: "Bearer " + service.token } },
  );
  assert.equal(outside.status, 403);
  assert.throws(
    () => vault.move(created.path, "Other/不能移动.md", created.hash, true),
    /当前选定/,
  );
  assert.ok(fs.existsSync(vault.absolute(created.path)));
});

test("subfolder collection, assets, review and restart keep their paths inside the selected folder", async (t) => {
  const { root, open } = fixture(t);
  const selected = path.join(root, "电源 研究");
  fs.mkdirSync(selected);
  const service = await open(selected);
  const { vault, captures, processing } = service;
  const capture = captures!.add({
    title: "合成 RC 材料",
    text: "R=1kΩ，C=1nF",
    image:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRj8AAAAASUVORK5CYII=",
  });
  assert.ok(capture.path.startsWith("电源 研究/KnowledgeWorkbench/Inbox/"));
  assert.ok(
    capture.ref.assetPath!.startsWith("电源 研究/KnowledgeWorkbench/Assets/"),
  );
  assert.ok(captures!.image(capture.ref).length > 0);
  const job = processing!.create([capture.id], [], "codex", "仅用于路径测试");
  const proposal = processing!.submit(
    job.id,
    randomUUID(),
    {
      title: "RC 草稿",
      action: "create",
      noteType: "concept",
      markdown: "# RC\n\n合成路径测试，不是模型结论。",
      sourceIds: [capture.id],
    },
    job.snapshot.inputHash,
  );
  const accepted = await processing!.accept(
    proposal.id,
    proposal.markdown,
    async (p, c, h) => vault!.save(p, c, h),
    proposal.draftHash,
  );
  assert.ok(accepted.path);
  assert.ok(accepted.path.startsWith("电源 研究/KnowledgeWorkbench/Cards/"));
  assert.ok(
    vault!
      .search("RC", "workbench")
      .some((note) => note.path === accepted.path),
  );
  assert.ok(
    vault!
      .search("合成 RC 材料", "workbench")
      .every(
        (note) =>
          !note.path.includes("/Inbox/") && !note.path.includes("/Drafts/"),
      ),
  );
  const reopened = await open(selected);
  assert.ok(reopened.vault!.list().some((n) => n.path === accepted.path));
  assert.equal(reopened.captures!.list().length, 1);
  assert.equal(
    reopened.processing!.getProposal(proposal.id).status,
    "accepted",
  );
  const wholeVault = await open(root);
  assert.notEqual(wholeVault.vaultId, service.vaultId);
  assert.ok(wholeVault.vault!.list().some((n) => n.path === "Other/外部.md"));
  assert.equal(
    vault!.list().some((n) => n.path === "Other/外部.md"),
    false,
  );
});

test("subfolder selection rejects metadata and ordinary folders outside Obsidian without creating markers", (t) => {
  const { root, temporary } = fixture(t);
  assert.throws(
    () => resolveVaultSelection(path.join(root, ".obsidian")),
    /配置/,
  );
  assert.throws(() => resolveVaultSelection(temporary), /不在 Obsidian/);
  assert.equal(fs.existsSync(path.join(temporary, ".obsidian")), false);
  const nested = path.join(root, "Nested");
  fs.mkdirSync(path.join(nested, ".obsidian"), { recursive: true });
  assert.equal(resolveVaultSelection(nested).root, fs.realpathSync(nested));
});

test("a junction to a sibling folder cannot escape the selected scope", async (t) => {
  const { root, open } = fixture(t);
  const selected = path.join(root, "KnowledgeWorkbench");
  fs.symlinkSync(
    path.join(root, "Other"),
    path.join(selected, "SiblingLink"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { vault } = await open(selected);
  assert.throws(
    () => vault!.read("KnowledgeWorkbench/SiblingLink/外部.md"),
    /链接指向知识库之外/,
  );
  assert.equal(
    vault!.list().some((n) => n.title === "不在所选范围"),
    false,
  );
});

test("scoped navigation and renaming preserve root-priority short wiki links", async (t) => {
  const { root, open } = fixture(t);
  atomicWrite(path.join(root, "A.md"), "# Parent A");
  atomicWrite(
    path.join(root, "KnowledgeWorkbench", "Cards", "A.md"),
    "# Local A",
  );
  atomicWrite(
    path.join(root, "KnowledgeWorkbench", "Cards", "Links.md"),
    "# Links\n\n[[A]] [[./A]]",
  );
  const service = await open(path.join(root, "KnowledgeWorkbench"));
  const vault = service.vault!;
  const from = "KnowledgeWorkbench/Cards/Links.md";
  const response = await fetch(
    service.baseUrl +
      "/api/resolve-link?" +
      new URLSearchParams({ path: from, target: "A", style: "wiki" }),
    { headers: { Authorization: "Bearer " + service.token } },
  ).then((r) => r.json());
  assert.deepEqual(response, { path: null, outside: true });
  assert.equal(
    vault.resolveLink("./A", from, "wiki"),
    "KnowledgeWorkbench/Cards/A.md",
  );
  const local = vault.read("KnowledgeWorkbench/Cards/A.md");
  vault.move(local.path, "KnowledgeWorkbench/Cards/Local.md", local.hash, true);
  assert.equal(
    vault.read(from).content,
    "# Links\n\n[[A]] [[KnowledgeWorkbench/Cards/Local]]",
  );
  assert.equal(fs.readFileSync(path.join(root, "A.md"), "utf8"), "# Parent A");
});
