import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { Captures } from "../server/capture.ts";
import { Processing } from "../server/processing.ts";
import { startService } from "../server/app.ts";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-trash-"));
  const dir = path.join(root, "vault"),
    profile = path.join(root, "profile");
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  let db = openDatabase(profile),
    vault = new Vault(dir, profile, db),
    captures = new Captures(vault);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get vault() {
      return vault;
    },
    get captures() {
      return captures;
    },
    restart() {
      db.close();
      db = openDatabase(profile);
      vault = new Vault(dir, profile, db);
      captures = new Captures(vault);
      vault.scan();
    },
  };
}
test("inbox deletion preserves original files, shared assets, notes and existing batches across restart", (t) => {
  const f = fixture(t),
    first = f.captures.add({ title: "One", image: png }),
    second = f.captures.add({ title: "Two", image: png });
  const note = f.vault.create("Existing note", "concept", "Keep this note");
  const processing = new Processing(f.vault, f.captures, async () => {
    throw Error("No provider calls");
  });
  const job = processing.create([first.id], [], "codex", "");
  const files = [first.path, second.path, first.ref.assetPath!, note.path];
  const before = files.map((p) => fs.readFileSync(f.vault.absolute(p)));
  f.captures.setDeleted([first.id], true);
  assert.deepEqual(
    f.captures.list().map((c) => c.id),
    [second.id],
  );
  assert.equal(f.captures.list(true)[0].id, first.id);
  assert.throws(
    () => processing.preview([first.id], [], "codex", ""),
    /先恢复/,
  );
  assert.deepEqual(processing.get(job.id).snapshot, job.snapshot);
  for (let i = 0; i < files.length; i++)
    assert.deepEqual(fs.readFileSync(f.vault.absolute(files[i])), before[i]);
  f.restart();
  assert.equal(f.captures.list(true)[0].id, first.id);
  f.captures.setDeleted([first.id], false);
  assert.equal(f.captures.list().length, 2);
  assert.equal(f.captures.list(true).length, 0);
  for (let i = 0; i < files.length; i++)
    assert.deepEqual(fs.readFileSync(f.vault.absolute(files[i])), before[i]);
});
test("batch deletion is atomic, idempotent and does not resurrect repeated transfers", (t) => {
  const f = fixture(t),
    transferId = randomUUID();
  const one = f.captures.add({ title: "Transfer", ref: { transferId } });
  const two = f.captures.add({ title: "Second" });
  assert.throws(
    () => f.captures.setDeleted([one.id, randomUUID()], true),
    /不存在/,
  );
  assert.equal(f.captures.list().length, 2);
  f.captures.setDeleted([one.id, two.id, one.id], true);
  f.captures.setDeleted([one.id, two.id], true);
  assert.equal(f.captures.list().length, 0);
  assert.equal(f.captures.list(true).length, 2);
  assert.equal(
    f.captures.add({ title: "Transfer", ref: { transferId } }).id,
    one.id,
  );
  assert.equal(f.captures.list().length, 0);
  f.captures.setDeleted([one.id, two.id], false);
  f.captures.setDeleted([one.id, two.id], false);
  assert.equal(f.captures.list().length, 2);
});
test("HTTP trash endpoints validate scope, require authentication, and support recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-trash-api-"));
  const dir = path.join(root, "vault");
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  const service = await startService({
    vaultDir: dir,
    dataDir: path.join(root, "profile"),
  });
  try {
    const c = service.captures!.add({ title: "HTTP synthetic" });
    const call = (route: string, body?: unknown, auth = true) =>
      fetch(service.baseUrl + "/api" + route, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer " + service.token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (await call("/captures/trash", { ids: [c.id] }, false)).status,
      401,
    );
    assert.equal((await call("/captures/trash", { ids: [] })).ok, false);
    assert.equal(
      (await call("/captures/trash", { ids: [c.id], deleteFiles: true })).ok,
      false,
    );
    assert.equal(service.captures!.list().length, 1);
    assert.equal((await call("/captures/trash", { ids: [c.id] })).ok, true);
    assert.equal(
      (await (await call("/captures?deleted=true")).json()).length,
      1,
    );
    assert.equal((await call("/captures/restore", { ids: [c.id] })).ok, true);
    assert.equal((await (await call("/captures")).json()).length, 1);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
