import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Desktop modules run directly in Electron.
import * as shortcutsModule from "../desktop/shortcuts.mjs";
const {
  createCaptureShortcuts,
  normalizeCaptureShortcut,
  formatCaptureShortcut,
  DEFAULT_CAPTURE_SHORTCUT,
} = shortcutsModule;
function fixture(t: any, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-shortcut-")),
    file = path.join(root, "shortcuts.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const callbacks = new Map<string, () => void>(),
    events: string[] = [];
  let failRegister = false,
    failWrite = false,
    captured = 0,
    recorded = "";
  const create = () =>
    createCaptureShortcuts({
      platform,
      shortcuts: {
        register(key: string, callback: () => void) {
          events.push("register:" + key);
          if (failRegister) return false;
          callbacks.set(key, callback);
          return true;
        },
        unregister(key: string) {
          events.push("unregister:" + key);
          callbacks.delete(key);
        },
      },
      read: () =>
        fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {},
      write: (value: unknown) => {
        events.push("write");
        if (failWrite) throw Error("disk full");
        fs.writeFileSync(file, JSON.stringify(value));
      },
      capture: () => captured++,
      record: (value: string) => (recorded = value),
    });
  return {
    create,
    file,
    callbacks,
    events,
    failRegister: (v: boolean) => (failRegister = v),
    failWrite: (v: boolean) => (failWrite = v),
    get captured() {
      return captured;
    },
    get recorded() {
      return recorded;
    },
  };
}
test("shortcut validation and display preserve Mac and Windows modifiers", () => {
  assert.equal(
    normalizeCaptureShortcut("ctrl+alt+k", "win32"),
    "Control+Alt+K",
  );
  assert.equal(
    formatCaptureShortcut(DEFAULT_CAPTURE_SHORTCUT, "darwin"),
    "⌘ + ⌥ + S",
  );
  assert.equal(
    formatCaptureShortcut(DEFAULT_CAPTURE_SHORTCUT, "win32"),
    "Ctrl + Alt + S",
  );
  for (const value of [
    "S",
    "Shift+S",
    "Ctrl+Ctrl+S",
    "Ctrl+",
    "Ctrl+Delete",
    "Bogus+S",
    "CommandOrControl+Command+S",
  ])
    assert.throws(() => normalizeCaptureShortcut(value, "darwin"));
  assert.throws(() => normalizeCaptureShortcut("Command+Alt+S", "win32"));
});
test("new shortcut registers and persists before the old one is removed; restart and default restore", (t) => {
  const f = fixture(t),
    manager = f.create();
  assert.equal(manager.initialize().accelerator, DEFAULT_CAPTURE_SHORTCUT);
  f.events.length = 0;
  manager.save("CommandOrControl+Shift+K");
  assert.deepEqual(f.events, [
    "register:CommandOrControl+Shift+K",
    "write",
    "unregister:" + DEFAULT_CAPTURE_SHORTCUT,
  ]);
  assert.equal(f.create().initialize().accelerator, "CommandOrControl+Shift+K");
  manager.save(DEFAULT_CAPTURE_SHORTCUT);
  assert.equal(
    JSON.parse(fs.readFileSync(f.file, "utf8")).capture,
    DEFAULT_CAPTURE_SHORTCUT,
  );
});
test("registration and persistence failure preserve the old valid binding and stored preference", (t) => {
  const f = fixture(t),
    manager = f.create();
  manager.initialize();
  manager.save(DEFAULT_CAPTURE_SHORTCUT);
  f.failRegister(true);
  assert.throws(() => manager.save("Alt+K"), /占用/);
  f.failRegister(false);
  assert.equal(manager.status().accelerator, DEFAULT_CAPTURE_SHORTCUT);
  assert.ok(f.callbacks.has(DEFAULT_CAPTURE_SHORTCUT));
  f.failWrite(true);
  assert.throws(() => manager.save("Alt+K"), /保存失败/);
  assert.ok(f.callbacks.has(DEFAULT_CAPTURE_SHORTCUT));
  assert.ok(!f.callbacks.has("Alt+K"));
  assert.equal(
    JSON.parse(fs.readFileSync(f.file, "utf8")).capture,
    DEFAULT_CAPTURE_SHORTCUT,
  );
});
test("recording consumes the registered shortcut without screenshot; startup conflict reports unavailable", (t) => {
  const f = fixture(t),
    manager = f.create();
  manager.initialize();
  manager.setRecording(true);
  f.callbacks.get(DEFAULT_CAPTURE_SHORTCUT)!();
  assert.equal(f.captured, 0);
  assert.equal(f.recorded, DEFAULT_CAPTURE_SHORTCUT);
  manager.setRecording(false);
  f.callbacks.get(DEFAULT_CAPTURE_SHORTCUT)!();
  assert.equal(f.captured, 1);
  f.failRegister(true);
  const state = f.create().initialize();
  assert.equal(state.registered, false);
  assert.match(state.error, /占用/);
});
