import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function codexCommand() {
  if (process.env.CODEX_EXE) {
    if (!fs.existsSync(process.env.CODEX_EXE))
      throw new Error("CODEX_EXE 不存在");
    return process.env.CODEX_EXE;
  }
  if (process.platform !== "win32") return "codex";
  const npmPrefix = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"),
    "npm/node_modules/@openai/codex/node_modules/@openai",
  );
  for (const arch of ["codex-win32-x64", "codex-win32-arm64"])
    for (const triple of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"])
      for (const folder of ["bin", "codex"]) {
        const file = path.join(
          npmPrefix,
          arch,
          "vendor",
          triple,
          folder,
          "codex.exe",
        );
        if (fs.existsSync(file)) return file;
      }
  throw new Error(
    "未找到 Codex 原生 CLI。请使用设置页面显示的命令，或用 CODEX_EXE 指向已安装的 codex.exe。",
  );
}
