const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("capture", {
  image: () => ipcRenderer.invoke("capture:image"),
  select: (rect) => ipcRenderer.invoke("capture:select", rect),
  cancel: () => ipcRenderer.send("capture:cancel"),
});
