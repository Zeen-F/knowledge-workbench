import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.ts";
import { atomicWrite } from "../server/files.ts";
import { Vault } from "../server/vault.ts";
import { relatedNotes } from "../server/relations.ts";

function fixture(t: any, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-move-regression-"));
  const vaultDir = path.join(root, "vault"),
    dataDir = path.join(root, "cache");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  const db = openDatabase(dataDir),
    vault = new Vault(vaultDir, dataDir, db);
  t.after(() => {
    db.close();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [file, content] of Object.entries(files))
    atomicWrite(vault.absolute(file), content);
  vault.scan();
  return { vault, db, vaultDir, dataDir };
}

test("rename preserves same-folder wiki references and only updates the intended target", (t) => {
  const { vault } = fixture(t, {
    "A.md": "# Root A",
    "Folder/A.md": "# Local A",
    "Folder/Index.md": "# Index\n\n[[./A#part|local]] [[../A|root]]",
  });
  const original = vault.read("Folder/Index.md").content;
  assert.deepEqual(
    relatedNotes(vault, "Folder/Index.md").outgoing.map((link) => link.to_ref),
    ["Folder/A.md", "A.md"],
  );
  const source = vault.read("A.md");
  const preview = vault.move(source.path, "B.md", source.hash) as any;
  assert.equal(vault.read("Folder/Index.md").content, original);
  const expected = "# Index\n\n[[./A#part|local]] [[B|root]]";
  assert.equal(
    preview.changes.find((note: any) => note.path === "Folder/Index.md").after,
    expected,
  );
  vault.move(source.path, "B.md", source.hash, true);
  assert.equal(vault.read("Folder/Index.md").content, expected);
  assert.deepEqual(
    relatedNotes(vault, "Folder/Index.md").outgoing.map((link) => link.to_ref),
    ["Folder/A.md", "B.md"],
  );
  const local = vault.read("Folder/A.md");
  vault.move(local.path, "Folder/Local.md", local.hash, true);
  assert.equal(
    vault.read("Folder/Index.md").content,
    "# Index\n\n[[Folder/Local#part|local]] [[B|root]]",
  );
});

test("moving a note with linked images keeps asset paths and both link layers intact", (t) => {
  const input =
    '[![inline](Assets/one.png)](https://example.org/source)\n[![reference][fig]](A.md#part)\n\n[fig]: Assets/two.png "Caption"';
  const { vault } = fixture(t, {
    "Image.md": input,
    "A.md": "# A",
    "Assets/one.png": "synthetic image path fixture",
    "Assets/two.png": "synthetic image path fixture",
  });
  const source = vault.read("Image.md");
  const expected = input
    .replace("(Assets/one.png)", "(../Assets/one.png)")
    .replace("(A.md#part)", "(../A.md#part)")
    .replace(": Assets/two.png", ": ../Assets/two.png");
  const preview = vault.move(
    source.path,
    "Folder/Image.md",
    source.hash,
  ) as any;
  assert.equal(
    preview.changes.find((note: any) => note.path === source.path).after,
    expected,
  );
  vault.move(source.path, "Folder/Image.md", source.hash, true);
  assert.equal(vault.read("Folder/Image.md").content, expected);
  const targets = relatedNotes(vault, "Folder/Image.md").outgoing.map(
    (link) => link.to_ref,
  );
  assert.deepEqual(targets.sort(), [
    "A.md",
    "Assets/one.png",
    "Assets/two.png",
  ]);
  for (const target of targets)
    assert.ok(fs.existsSync(vault.absolute(target)));
});

test("upgrading the link index restores linked-image relations without editing note files", (t) => {
  const { vault, db, vaultDir, dataDir } = fixture(t, {
    "Image.md": "[![figure](Assets/one.png)](https://example.org/source)",
    "Assets/one.png": "synthetic image path fixture",
  });
  const before = vault.read("Image.md");
  db.prepare("DELETE FROM relations WHERE from_path=?").run("Image.md");
  db.prepare(
    "UPDATE settings SET value='2' WHERE key='link-index-version'",
  ).run();
  const restarted = new Vault(vaultDir, dataDir, db);
  restarted.scan({ incremental: true });
  assert.deepEqual(
    relatedNotes(restarted, "Image.md").outgoing.map((link) => link.to_ref),
    ["Assets/one.png"],
  );
  assert.equal(restarted.read("Image.md").hash, before.hash);
});
