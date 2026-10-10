import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RecoveryStore } from "../server/recovery.ts";
import { digest } from "../server/files.ts";
import {
  requirePanelFeatures,
  type RecoveryRecord,
} from "../shared/recovery.ts";
import {
  initializeRemoteRecovery,
  readRecovery,
  writeRecovery,
  clearRecovery,
  flushRecovery,
  recoveryKey,
} from "../src/recovery.ts";

const input = (thought: string) => ({
  title: "合成材料",
  thought,
  requestId: randomUUID(),
});
test("native recovery survives restart, rejects stale edits and preserves damaged files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-panel-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RecoveryStore(root);
  const record: RecoveryRecord = {
    kind: "inbox",
    id: "",
    value: input("未保存想法"),
  };
  const first = store.save(record, null);
  assert.deepEqual(new RecoveryStore(root).list(), [first]);
  assert.deepEqual(store.save(record, null), first);
  const second = store.save(
    { ...record, value: input("另一个窗口") },
    first.hash,
  );
  assert.throws(() => store.save(record, first.hash), /其他窗口/);
  assert.throws(() => store.clear(record, first.hash), /未清除/);
  assert.deepEqual(store.list(), [second]);
  assert.throws(() =>
    store.clear({ kind: "review", id: "../../outside" }, second.hash),
  );
  const file = path.join(root, digest("inbox:") + ".json");
  fs.writeFileSync(file, "damaged synthetic record");
  assert.throws(() => store.list());
  assert.throws(() => store.save(record, null));
  assert.equal(fs.readFileSync(file, "utf8"), "damaged synthetic record");
});

test("opaque panel recovery serializes writes, preserves new input on old receipts, and refuses failed teardown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-panel-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RecoveryStore(root),
    key = recoveryKey("synthetic-vault", "inbox");
  let offline = false,
    release: (() => void) | undefined;
  let delayDelete = false;
  const transport = async (method: string, _route: string, body?: any) => {
    if (offline) throw new Error("synthetic offline");
    if (method === "GET") return { records: store.list() };
    if (method === "PUT") return store.save(body.record, body.expectedHash);
    if (delayDelete)
      await new Promise<void>((r) => {
        release = r;
      });
    store.clear(body.identity, body.expectedHash);
    return { ok: true };
  };
  await initializeRemoteRecovery("synthetic-vault", transport);
  const old = input("旧输入"),
    latest = input("新输入");
  assert.equal(writeRecovery(key, old), "pending");
  await flushRecovery();
  await initializeRemoteRecovery("synthetic-vault", transport);
  assert.deepEqual(readRecovery(key), old);
  delayDelete = true;
  const clearing = clearRecovery(key, old);
  while (!release) await new Promise((r) => setTimeout(r, 1));
  writeRecovery(key, latest);
  release();
  assert.equal(await clearing, false);
  await flushRecovery();
  assert.deepEqual(store.list()[0].record.value, latest);
  offline = true;
  const retained = input("断线输入");
  writeRecovery(key, retained);
  await assert.rejects(() => flushRecovery(), /offline/);
  assert.deepEqual(readRecovery(key), retained);
  offline = false;
  delayDelete = false;
  await flushRecovery(undefined, true);
  assert.deepEqual(store.list()[0].record.value, retained);
  assert.equal(await clearRecovery(key, retained), true);
  assert.equal(readRecovery(key), undefined);
  assert.deepEqual(store.list(), []);
});

test("native feature gate rejects old or incomplete services", () => {
  assert.throws(() => requirePanelFeatures({}), /桌面服务版本较旧/);
  assert.throws(
    () => requirePanelFeatures({ features: { reliability: 1 } }),
    /桌面服务版本较旧/,
  );
  assert.doesNotThrow(() =>
    requirePanelFeatures({ features: { reliability: 1, recovery: 1 } }),
  );
});
