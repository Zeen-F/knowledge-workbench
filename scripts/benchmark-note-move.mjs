import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createLinkRewriter } from "../server/markdown.ts";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { removeTestDirectory } from "./test-cleanup.mjs";

const counts = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [500, 1000, 2000];
if (
  counts.some(
    (count) => !Number.isSafeInteger(count) || count < 1 || count > 100000,
  )
)
  throw new Error("Invalid note count");
const measure = (fn) => {
  const start = performance.now();
  fn();
  return +(performance.now() - start).toFixed(2);
};
const results = [];
for (const count of counts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-move-bench-"));
  const vaultDir = path.join(root, "vault"),
    dataDir = path.join(root, "cache");
  let db;
  try {
    fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, "Notes"));
    const paths = Array.from({ length: count }, (_, i) => `Notes/Note-${i}.md`);
    const content = "# Unlinked plain note\nBody",
      from = paths[0],
      to = "New.md";
    for (const relative of paths)
      fs.writeFileSync(path.join(vaultDir, relative), content);
    db = openDatabase(dataDir);
    const vault = new Vault(vaultDir, dataDir, db);
    vault.scan();
    const source = vault.read(from);
    const rewriteLoopMs = [],
      movePreviewMs = [];
    for (let run = 0; run < 3; run++) {
      rewriteLoopMs.push(
        measure(() => {
          // Include context construction once, just as the real move does.
          const rewrite = createLinkRewriter(from, to, paths);
          for (const current of paths)
            assert.equal(rewrite(content, current), content);
        }),
      );
      movePreviewMs.push(
        measure(() => {
          const preview = vault.move(from, to, source.hash);
          assert.deepEqual(
            preview.changes.map((note) => note.path),
            [from],
          );
          assert.equal(vault.read(from).hash, source.hash);
          assert.equal(fs.existsSync(vault.absolute(to)), false);
        }),
      );
    }
    const applyMs = measure(() => vault.move(from, to, source.hash, true));
    assert.equal(vault.read(to).content, content);
    assert.equal(fs.existsSync(vault.absolute(from)), false);
    assert.equal(vault.list().filter((note) => !note.missing).length, count);
    results.push({ count, rewriteLoopMs, movePreviewMs, applyMs });
  } finally {
    db?.close();
    await removeTestDirectory(root, os.tmpdir());
  }
}
console.log(
  JSON.stringify(
    {
      synthetic: true,
      node: process.version,
      platform: process.platform,
      scope:
        "rewrite loop includes shared indexes; preview/apply include real temporary-vault IO; no personal files",
      results,
    },
    null,
    2,
  ),
);
