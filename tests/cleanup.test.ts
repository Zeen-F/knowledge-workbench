import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore -- Shared with standalone acceptance scripts.
import { removeTestDirectory } from "../scripts/test-cleanup.mjs";

test("test cleanup accepts aliased temp roots without following links outside its base", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-cleanup-"));
  try {
    const base = path.join(root, "base"),
      outside = path.join(root, "outside"),
      alias = path.join(root, "alias");
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.symlinkSync(
      base,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const child = path.join(base, "中文 child");
    fs.mkdirSync(child);
    fs.symlinkSync(
      outside,
      path.join(child, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await removeTestDirectory(fs.realpathSync.native(child), alias);
    assert.equal(fs.existsSync(child), false);
    assert.equal(
      fs.readFileSync(path.join(outside, "keep.txt"), "utf8"),
      "keep",
    );
    await assert.rejects(removeTestDirectory(base, base), /Unsafe/);
    await assert.rejects(removeTestDirectory(outside, base), /Unsafe/);
    fs.symlinkSync(
      outside,
      path.join(base, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      removeTestDirectory(path.join(base, "escape", "keep.txt"), base),
      /Unsafe/,
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "keep.txt"), "utf8"),
      "keep",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
