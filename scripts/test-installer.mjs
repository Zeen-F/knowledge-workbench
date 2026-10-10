import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { _electron as electron, expect } from "@playwright/test";
import { seed } from "./seed.mjs";

const [executable, installer] = process.argv
  .slice(2)
  .map((p) => fs.realpathSync.native(p));
assert.equal(process.platform, "win32");
assert.ok(
  executable && installer,
  "Pass the installed EXE and NSIS installer.",
);
const root = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "kwb-installer-")),
);
const vault = path.join(root, "vault"),
  profile = path.join(root, "profile");
seed(vault);
const env = { ...process.env, KWB_VAULT: vault, KWB_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app, appChild;
try {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: root,
    env,
    timeout: 60000,
  });
  appChild = app.process();
  const page = await app.firstWindow();
  await page
    .getByRole("button", { name: "从一个问题开始", exact: false })
    .first()
    .click();
  const editor = page.getByLabel("笔记编辑器");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n安装器不得关闭这篇正在编辑的笔记。");
  const child = spawn(
    installer,
    ["/S", "/currentuser", `/D=${path.dirname(executable)}`],
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Installer did not exit within 60 seconds"));
    }, 60000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(
    exit,
    2,
    "A busy installation must exit without stopping any processes",
  );
  assert.equal(appChild.exitCode, null);
  await expect(editor).toContainText("安装器不得关闭");
  await editor.press("Control+s");
  await expect
    .poll(() => fs.readFileSync(path.join(vault, "从一个问题开始.md"), "utf8"))
    .toContain("安装器不得关闭");
  console.log(
    JSON.stringify({
      passed: true,
      exitCode: exit,
      checks: [
        "busy installer aborts",
        "editor process and input preserved",
        "save after refused update",
      ],
    }),
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (appChild && appChild.exitCode === null) {
    const child = appChild;
    const exited =
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("close", resolve));
    await app.close().catch(() => {});
    await exited;
  }
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("kwb-installer-"));
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
}
