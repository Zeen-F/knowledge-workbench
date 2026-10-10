import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/client.ts";
import {
  recoveryKey,
  readRecovery,
  writeRecovery,
  clearRecovery,
} from "../src/recovery.ts";

test("browser reconnects only a local session expiry once; upstream 401 never replays a write", async (t) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  t.after(() => {
    delete (globalThis as any).window;
  });
  let sessions = 0,
    writes = 0,
    mode = "expired";
  t.mock.method(globalThis, "fetch", async (url: any) => {
    if (String(url) === "/api/session") {
      sessions++;
      return new Response("{}");
    }
    writes++;
    if (mode === "expired" && writes === 1)
      return new Response(
        JSON.stringify({ code: "SESSION_EXPIRED", error: "expired" }),
        { status: 401 },
      );
    if (mode === "upstream")
      return new Response(
        JSON.stringify({ code: "PROVIDER_ERROR", error: "upstream" }),
        { status: 401 },
      );
    return new Response(JSON.stringify({ ok: true }));
  });
  assert.deepEqual(await api("POST", "/synthetic", { text: "input" }), {
    ok: true,
  });
  assert.equal(sessions, 2);
  assert.equal(writes, 2);
  mode = "upstream";
  await assert.rejects(
    () => api("POST", "/synthetic", { text: "input" }),
    /upstream/,
  );
  assert.equal(writes, 3);
  assert.equal(sessions, 2);
});
test("recovery keys isolate vaults and drafts and stale acknowledgements cannot clear newer input", () => {
  const a = recoveryKey("vault A", "inbox"),
    b = recoveryKey("vault B", "inbox"),
    c = recoveryKey("vault A", "review", "id1"),
    d = recoveryKey("vault A", "review", "id2");
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) || null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  try {
    writeRecovery(a, { text: "old" });
    writeRecovery(b, { text: "B" });
    writeRecovery(c, { text: "review1" });
    writeRecovery(d, { text: "review2" });
    writeRecovery(a, { text: "new" });
    assert.equal(clearRecovery(a, { text: "old" }), false);
    assert.deepEqual(readRecovery(a), { text: "new" });
    assert.deepEqual(readRecovery(b), { text: "B" });
    assert.deepEqual(readRecovery(c), { text: "review1" });
    assert.deepEqual(readRecovery(d), { text: "review2" });
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as any).localStorage;
  }
});
