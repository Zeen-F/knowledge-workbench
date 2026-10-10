import { spawn } from "node:child_process";
import path from "node:path";
import { startService } from "../server/app.ts";
import { seed } from "./seed.mjs";
const vaultDir = path.resolve(".local/dev-vault"),
  dataDir = path.resolve(".local/dev-profile");
seed(vaultDir);
const service = await startService({
  vaultDir,
  dataDir,
  port: 4386,
  dev: true,
});
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit", windowsHide: true },
);
console.log("隔离测试库已准备：http://127.0.0.1:5186");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  vite.kill();
  await service.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
vite.once("exit", () => void stop());
