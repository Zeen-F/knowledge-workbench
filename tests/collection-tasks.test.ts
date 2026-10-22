// @ts-expect-error Pure Electron-independent module; no screen access in these tests.
import * as collectionSession from "../desktop/collection-session.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.ts";
import { Vault } from "../server/vault.ts";
import { Captures } from "../server/capture.ts";
import { Processing } from "../server/processing.ts";
import { recoveryRecordSchema } from "../shared/recovery.ts";

test("collection scope persists, keeps legacy bytes, rejects cross-task trash and batches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-tasks-"));
  const dir = path.join(root, "vault"),
    profile = path.join(root, "profile");
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  let db = openDatabase(profile);
  try {
    let vault = new Vault(dir, profile, db),
      captures = new Captures(vault);
    const legacy = captures.add({ title: "Legacy", text: "Keep original" });
    const original = fs.readFileSync(vault.absolute(legacy.path));
    const a = captures.createTask("Study A"),
      b = captures.createTask("Study B");
    const one = captures.add({ title: "A", text: "A thought", taskId: a.id });
    const two = captures.add({ title: "B", text: "B thought", taskId: b.id });
    assert.deepEqual(
      captures.list(false, "history").map((c) => c.id),
      [legacy.id],
    );
    assert.deepEqual(
      captures.list(false, a.id).map((c) => c.id),
      [one.id],
    );
    assert.throws(
      () => captures.setDeleted([one.id, two.id], true, a.id),
      /不属于/,
    );
    assert.equal(captures.list().length, 3);
    assert.throws(() => captures.setDeleted([one.id], true), /不属于/);
    const processing = new Processing(vault, captures, async () => {
      throw Error("No model");
    });
    assert.throws(
      () =>
        processing.preview([one.id, two.id], [], "codex", "", undefined, a.id),
      /不属于/,
    );
    assert.throws(
      () => processing.preview([one.id], [], "codex", ""),
      /不属于/,
    );
    const preview = processing.preview(
      [one.id],
      [],
      "codex",
      "",
      undefined,
      a.id,
    );
    const job = processing.create(
      [one.id],
      [],
      "codex",
      "",
      undefined,
      preview.previewHash,
      a.id,
    );
    assert.equal(job.snapshot.taskId, a.id);
    captures.setDeleted([one.id], true, a.id);
    assert.throws(() => captures.setDeleted([one.id], false, b.id), /不属于/);
    assert.throws(
      () => processing.preview([one.id], [], "codex", "", undefined, a.id),
      /已从收集箱删除/,
    );
    captures.setTaskEnded(a.id, true);
    assert.throws(
      () => captures.add({ title: "late", taskId: a.id }),
      /请先继续/,
    );
    db.close();
    db = openDatabase(profile);
    vault = new Vault(dir, profile, db);
    vault.scan();
    captures = new Captures(vault);
    assert.equal(captures.task(a.id).ended, true);
    assert.equal(captures.tasks().length, 2);
    assert.equal(captures.list(true, a.id)[0].id, one.id);
    captures.setDeleted([one.id], false, a.id);
    captures.setTaskEnded(a.id, false);
    assert.equal(
      captures.add({ title: "continue", taskId: a.id }).ref.taskId,
      a.id,
    );
    assert.deepEqual(fs.readFileSync(vault.absolute(legacy.path)), original);
    assert.ok(
      recoveryRecordSchema.safeParse({
        kind: "inbox",
        id: a.id,
        value: { title: "draft", thought: "Keep", requestId: one.id },
      }).success,
    );
    assert.ok(
      !recoveryRecordSchema.safeParse({
        kind: "inbox",
        id: "invalid",
        value: {},
      }).success,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task-scoped HTTP operations reject mixed ids and route capture before screen access", async (t) => {
  const { startService } = await import("../server/app.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-tasks-http-"));
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
  const routed: unknown[] = [];
  const service = await startService({
    vaultDir,
    dataDir: path.join(root, "profile"),
    desktop: async (action, taskId) => {
      routed.push({ action, taskId });
      return { ok: true };
    },
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (route: string, body: unknown) =>
    fetch(service.baseUrl + "/api" + route, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + service.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const a = service.captures!.createTask("A"),
    b = service.captures!.createTask("B");
  const one = service.captures!.add({ title: "A", taskId: a.id }),
    two = service.captures!.add({ title: "B", taskId: b.id });
  assert.equal(
    (await post("/captures/trash", { ids: [one.id, two.id], taskId: a.id }))
      .status,
    409,
  );
  assert.equal(
    (
      await post("/jobs/preview", {
        sourceIds: [one.id, two.id],
        executor: "codex",
        taskId: a.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (await post("/desktop/action", { action: "capture" })).status,
    409,
  );
  assert.equal(routed.length, 0);
  assert.equal(
    (await post("/desktop/action", { action: "capture", taskId: b.id })).status,
    200,
  );
  assert.deepEqual(routed, [{ action: "capture", taskId: b.id }]);
  service.captures!.setTaskEnded(b.id, true);
  assert.equal(
    (await post("/desktop/action", { action: "capture", taskId: b.id })).status,
    409,
  );
  assert.equal(routed.length, 1);
});

test("global capture requires explicit task choice; cancel/restart clear it and panel requests never switch desktop task", async () => {
  const { createCollectionSession } = collectionSession;
  const captured: string[] = [],
    chosen: string[] = [];
  const valid = new Set(["A", "B"]);
  const options = {
    validate: async (id: string) => {
      if (!valid.has(id)) throw Error("ended");
    },
    choose: () => chosen.push("choose"),
    capture: async (id: string) => {
      captured.push(id);
    },
  };
  let session = createCollectionSession(options);
  await session.start();
  assert.deepEqual(chosen, ["choose"]);
  assert.equal(captured.length, 0);
  session.clear();
  assert.equal((await session.select("A")).captureRequested, false);
  await session.start();
  await session.start("B");
  await session.start();
  assert.deepEqual(captured, ["A", "B", "A"]);
  valid.delete("A");
  await assert.rejects(session.start(), /ended/);
  assert.equal(captured.length, 3);
  session = createCollectionSession(options);
  await session.start();
  assert.equal(chosen.length, 2);
  assert.equal((await session.select("B")).captureRequested, true);
  assert.equal(captured.length, 3); // Selecting does not itself access the screen.
  await session.start("B");
  assert.equal(captured.at(-1), "B");
});

test("leaving cancels an in-flight capture validation before any screenshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const session = collectionSession.createCollectionSession({
    validate: () => gate,
    choose: () => {},
    capture: () => {
      calls++;
    },
  });
  const pending = session.start("A");
  session.clear();
  release();
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(calls, 0);
});
