import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { relatedNotes } from "../server/relations.ts";
function fixture(t: any, count = 200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-index-test-"));
  const vaultDir = path.join(root, "vault"),
    dataDir = path.join(root, "cache");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  for (let i = 0; i < count; i++)
    fs.writeFileSync(
      path.join(vaultDir, `${String(i).padStart(4, "0")}.md`),
      `# Note ${i}\n\nOriginal text ${i}`,
    );
  const db = openDatabase(dataDir),
    vault = new Vault(vaultDir, dataDir, db);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  vault.scan();
  return { vault, vaultDir, dataDir, db };
}
test("background scan bounds unchanged content reads and sees additions, edits and deletion", (t) => {
  const { vault, vaultDir } = fixture(t);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", ((file: any, ...args: any[]) => {
    if (String(file).endsWith(".md")) reads++;
    return (read as any)(file, ...args);
  }) as any);
  vault.scan({ incremental: true, auditLimit: 17 });
  assert.equal(reads, 17);
  fs.writeFileSync(path.join(vaultDir, "0199.md"), "# Changed externally");
  fs.writeFileSync(path.join(vaultDir, "new.md"), "# Newly added");
  fs.unlinkSync(path.join(vaultDir, "0198.md"));
  vault.scan({ incremental: true, auditLimit: 17 });
  assert.equal(vault.search("Changed externally").length, 1);
  assert.equal(
    vault.list().find((n) => n.path === "new.md")?.title,
    "Newly added",
  );
  assert.equal(vault.list().find((n) => n.path === "0198.md")?.missing, true);
});
test("rotating content audits discover unchanged-stat writes while saves still hash disk immediately", (t) => {
  const { vault, vaultDir } = fixture(t);
  const relative = "0199.md",
    before = vault.read(relative),
    signature = (vault as any).fileSignature(path.join(vaultDir, relative));
  const original = (vault as any).fileSignature.bind(vault);
  t.mock.method(vault as any, "fileSignature", (file: string) =>
    file.endsWith(relative) ? signature : original(file),
  );
  fs.writeFileSync(
    path.join(vaultDir, relative),
    "# Changed without metadata hint",
  );
  assert.throws(
    () => vault.save(relative, "# My unsaved edit", before.hash),
    (error: any) => error.code === "VERSION_CONFLICT",
  );
  assert.equal(vault.read(relative).draft?.content, "# My unsaved edit");
  for (let i = 0; i < Math.ceil(200 / 17); i++)
    vault.scan({ incremental: true, auditLimit: 17 });
  assert.equal(vault.search("without metadata").length, 1);
});
test("failed background reads retain old data and never mark unseen notes missing", (t) => {
  const { vault, vaultDir } = fixture(t, 2),
    read = fs.readFileSync;
  fs.unlinkSync(path.join(vaultDir, "0001.md"));
  t.mock.method(fs, "readFileSync", ((file: any, ...args: any[]) => {
    if (String(file).endsWith("0000.md"))
      throw new Error("simulated cloud read error");
    return (read as any)(file, ...args);
  }) as any);
  vault.scan({ incremental: true });
  assert.equal(vault.warnings.length, 1);
  assert.ok(vault.list().every((n) => !n.missing));
  assert.equal(vault.search("Original text").length, 2);
});
test("startup and explicit scans rebuild invalidated link index from unchanged Markdown", (t) => {
  const { vault, db, dataDir, vaultDir } = fixture(t, 0);
  fs.mkdirSync(path.join(vaultDir, "Folder"));
  fs.writeFileSync(path.join(vaultDir, "Folder", "Target.md"), "# Target");
  fs.writeFileSync(
    path.join(vaultDir, "Folder", "Index.md"),
    "[target](Target.md) `[[Ghost]]`\n\n[missing](../Target.md)",
  );
  vault.scan();
  const incoming = relatedNotes(vault, "Folder/Target.md").incoming;
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from_path, "Folder/Index.md");
  assert.deepEqual(
    relatedNotes(vault, "Folder/Index.md").outgoing.map((x) => [
      x.to_ref,
      x.resolved,
    ]),
    [
      ["Folder/Target.md", true],
      ["Target.md", false],
    ],
  );
  db.prepare("DELETE FROM relations").run();
  db.prepare("DELETE FROM settings WHERE key='link-index-version'").run();
  const restarted = new Vault(vaultDir, dataDir, db);
  restarted.scan({ incremental: true });
  assert.equal(relatedNotes(restarted, "Folder/Target.md").incoming.length, 1);
});

test("FTS row identity replaces existing rows, clears duplicate cache rows and survives moves/restart", (t) => {
  const { vault, db, dataDir, vaultDir } = fixture(t, 1);
  const before = vault.read("0000.md");
  const saved = vault.save(
    before.path,
    "# Replacement\n\nUnique new wording",
    before.hash,
  );
  assert.equal(vault.search("Original text").length, 0);
  assert.equal(vault.search("Unique new wording").length, 1);
  db.prepare("INSERT INTO notes_fts(path,title,body,tags) VALUES(?,?,?,?)").run(
    saved.path,
    "stale duplicate",
    "stale duplicate",
    "",
  );
  const restarted = new Vault(vaultDir, dataDir, db);
  restarted.index(saved.path);
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS total FROM notes_fts WHERE path=?")
        .get(saved.path) as any
    ).total,
    1,
  );
  restarted.move(saved.path, "Moved.md", saved.hash, true);
  assert.equal(restarted.search("Unique new wording")[0].path, "Moved.md");
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS total FROM notes_fts WHERE path=?")
        .get(saved.path) as any
    ).total,
    0,
  );
  const again = new Vault(vaultDir, dataDir, db);
  again.index("Moved.md");
  assert.equal(again.search("Unique new wording").length, 1);
});

test("an independent SQLite writer invalidates the FTS row map without deleting unrelated recycled rows", (t) => {
  const { vault, db, dataDir } = fixture(t, 2);
  const external = openDatabase(dataDir);
  try {
    const old = external
      .prepare("SELECT rowid FROM notes_fts WHERE path=?")
      .get("0000.md") as any;
    external.prepare("DELETE FROM notes_fts WHERE path=?").run("0000.md");
    external
      .prepare(
        "INSERT INTO notes_fts(rowid,path,title,body,tags) VALUES(?,?,?,?,?)",
      )
      .run(old.rowid, "foreign.md", "Foreign", "Keep independent row", "");
    external
      .prepare("INSERT INTO notes_fts(path,title,body,tags) VALUES(?,?,?,?)")
      .run("0000.md", "External stale row", "Replace this stale row", "");
    vault.index("0000.md");
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS total FROM notes_fts WHERE path=?")
          .get("0000.md") as any
      ).total,
      1,
    );
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS total FROM notes_fts WHERE path=?")
          .get("foreign.md") as any
      ).total,
      1,
    );
    assert.equal(vault.search("Original text").length, 2);
  } finally {
    external.close();
  }
});
