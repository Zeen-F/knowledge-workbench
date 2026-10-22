const { contextBridge, ipcRenderer } = require("electron");
const flushCallbacks = new Set();
ipcRenderer.on("workbench:flush", async (_event, id) => {
  try {
    await Promise.all([...flushCallbacks].map((callback) => callback()));
    ipcRenderer.send("workbench:flushed", { id });
  } catch (error) {
    ipcRenderer.send("workbench:flushed", { id, error: error.message });
  }
});
async function request(method, route, body) {
  const response = await ipcRenderer.invoke("workbench:request", {
    method,
    route,
    body,
  });
  if (response.error) {
    const error = new Error(response.error);
    Object.assign(error, {
      code: response.code,
      details: response.details,
      status: response.status,
    });
    throw error;
  }
  return response.data;
}
contextBridge.exposeInMainWorld("workbench", {
  invoke: request,
  chooseVault: () => request("DESKTOP", "/vault/choose"),
  capture: () => request("DESKTOP", "/capture"),
  openExternal: (url) => request("DESKTOP", "/external", { url }),
  onShortcutRecorded(callback) {
    const listener = (_event, accelerator) => callback(accelerator);
    ipcRenderer.on("workbench:shortcut-recorded", listener);
    return () => ipcRenderer.removeListener("workbench:shortcut-recorded", listener);
  },
  onCapture(callback) {
    const listener = () => callback();
    ipcRenderer.on("workbench:captured", listener);
    return () => ipcRenderer.removeListener("workbench:captured", listener);
  },
  onFlush(callback) {
    flushCallbacks.add(callback);
    return () => flushCallbacks.delete(callback);
  },
});
