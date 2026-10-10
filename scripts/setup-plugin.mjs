import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { preparePlugin } from "../desktop/plugin-setup.mjs";
import { codexCommand } from "./codex-command.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const profileDir =
  process.env.KWB_PROFILE || path.join(os.homedir(), ".knowledge-workbench");
const installed = process.argv.includes("--installed-runtime")
  ? JSON.parse(fs.readFileSync(path.join(profileDir, "launch.json"), "utf8"))
  : null;
if (
  installed &&
  (!path.isAbsolute(installed.executable) ||
    !fs.existsSync(installed.executable))
)
  throw new Error("已安装桌面运行时不可用；请先打开桌面工作台。");
const result = preparePlugin({
  root,
  profileDir,
  executable: installed?.executable || process.execPath,
  electron: Boolean(installed),
  preserveLaunch: Boolean(installed),
});
console.log(result.message);
if (process.argv.includes("--install")) {
  for (const args of [
    ["plugin", "marketplace", "add", result.marketplace, "--json"],
    [
      "plugin",
      "add",
      "knowledge-workbench@knowledge-workbench-local",
      "--json",
    ],
  ]) {
    // Resolve the native CLI rather than interpolating user-controlled arguments into a shell.
    const child = spawnSync(codexCommand(), args, {
      stdio: "inherit",
      windowsHide: true,
    });
    if (child.error || child.status !== 0)
      throw child.error || new Error("插件安装未完成；请执行上方两条命令。");
  }
}
