import { startService } from "./app.ts";
import { randomUUID } from "node:crypto";

const parent = (process as any).parentPort;
let service: Awaited<ReturnType<typeof startService>> | undefined;
const pending = new Map<
  string,
  { resolve: (value: string) => void; reject: (error: Error) => void }
>();
function cryptoRequest(
  action: string,
  value: string,
  type = "crypto",
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    parent.postMessage({ type, id, action, value });
  });
}
if (parent) {
  parent.on("message", async (event: any) => {
    const data = event.data;
    try {
      if (data.type === "start") {
        service = await startService({
          ...data.options,
          encrypt: (v) => cryptoRequest("encrypt", v),
          decrypt: (v) => cryptoRequest("decrypt", v),
          desktop: (action, taskId) =>
            cryptoRequest(action, taskId || "", "desktop"),
        });
        parent.postMessage({
          type: "ready",
          baseUrl: service.baseUrl,
          token: service.token,
          vaultId: service.vaultId,
        });
      } else if (data.type === "crypto-result") {
        const task = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) task?.reject(new Error(data.error));
        else task?.resolve(data.value);
      } else if (data.type === "shutdown") {
        await service?.close();
        process.exit(0);
      }
    } catch (e) {
      parent.postMessage({
        type: "error",
        message: e instanceof Error ? e.message : "服务启动失败",
      });
    }
  });
  // The packaged helper can load more slowly than the development runtime.
  // Tell the desktop when its message listener is ready before accepting start.
  parent.postMessage({ type: "initialized" });
}
