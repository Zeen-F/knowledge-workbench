import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../server/app.ts";
import { seed } from "./seed.mjs";
import { removeTestDirectory } from "./test-cleanup.mjs";

// Every invocation owns a fresh synthetic Vault and profile; never load the user's profile.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-demo-"));
const vaultDir = path.join(root, "vault");
seed(vaultDir);
let service,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service?.close();
  await removeTestDirectory(root, os.tmpdir());
}
try {
  service = await startService({
    vaultDir,
    dataDir: path.join(root, "profile"),
    distDir: path.resolve("dist"),
  });
  console.log(`合成资料演示（仅本机）：${service.baseUrl}`);
  console.log("无需模型或凭据；Ctrl+C 关闭并清理本次演示资料。");
  if (process.argv.includes("--smoke")) {
    const response = await fetch(service.baseUrl + "/api/status", {
      headers: { Authorization: `Bearer ${service.token}` },
    });
    const status = await response.json();
    if (
      !response.ok ||
      !status.vault ||
      status.capabilities.secureCredentials ||
      !service.baseUrl.startsWith("http://127.0.0.1:")
    )
      throw new Error("合成演示隔离检查失败");
    await stop();
    if (fs.existsSync(root)) throw new Error("合成演示未清理");
    console.log(
      JSON.stringify({
        passed: true,
        synthetic: true,
        loopback: true,
        cleaned: true,
      }),
    );
  } else {
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  }
} catch (error) {
  await stop();
  throw error;
}
