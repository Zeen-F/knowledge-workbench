import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Vault } from "../server/vault.ts";
import { openDatabase } from "../server/database.ts";

// Synthetic notes only. Timing is machine-dependent; read counts are deterministic.
const results = [];
for (const count of process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [1000, 10000]) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
    throw new Error("Invalid note count");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-vault-bench-"));
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const file = path.join(
      vaultDir,
      `Topic-${Math.floor(i / 100)}`,
      `Note-${i}.md`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `# Synthetic note ${i}\n\n跨导效率、边界条件。 [[Note-${(i + 1) % count}]]\n` +
        "Measured synthetic content, never a personal vault.\n".repeat(20),
    );
  }
  const dataDir = path.join(root, "cache");
  const db = openDatabase(dataDir);
  const vault = new Vault(vaultDir, dataDir, db);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(vaultDir) && String(file).endsWith(".md"))
      reads++;
    return read.call(this, file, ...args);
  };
  const measure = (name, fn) => {
    reads = 0;
    const start = performance.now();
    fn();
    return {
      name,
      ms: +(performance.now() - start).toFixed(2),
      markdownReads: reads,
    };
  };
  try {
    const samples = [measure("cold-full", () => vault.scan())];
    for (let run = 0; run < 3; run++)
      samples.push(
        measure("warm-background", () => vault.scan({ incremental: true })),
      );
    fs.appendFileSync(
      path.join(vaultDir, "Topic-0", "Note-0.md"),
      "\nOne external edit.",
    );
    samples.push(
      measure("one-edit-background", () => vault.scan({ incremental: true })),
    );
    samples.push(measure("explicit-full", () => vault.scan()));
    if (vault.list().length !== count) throw new Error("Index count changed");
    results.push({ count, samples });
  } finally {
    fs.readFileSync = read;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      synthetic: true,
      results,
    },
    null,
    2,
  ),
);
