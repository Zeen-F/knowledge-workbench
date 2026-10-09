import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { preparePlugin } from "../desktop/plugin-setup.mjs";
import { codexCommand } from "./codex-command.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const profileDir =
  process.env.KWB_PROFILE || path.join(os.homedir(), ".knowledge-workbench");
const result = preparePlugin({
  root,
  profileDir,
  executable: process.execPath,
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
