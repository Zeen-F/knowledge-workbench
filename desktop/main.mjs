import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  safeStorage,
  utilityProcess,
  globalShortcut,
  desktopCapturer,
  screen,
  shell,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cropRect } from "./geometry.mjs";
import { preparePlugin } from "./plugin-setup.mjs";
import { resolveVaultSelection } from "./vault-selection.mjs";
import { createCredentials } from "./credentials.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const credentials = createCredentials(safeStorage);
const dailyShanlan =
  process.argv.includes("--shanlan-daily") ||
  app.getVersion().includes("shanlan-daily");
const desktopPreview =
  !dailyShanlan &&
  (process.argv.includes("--shanlan-preview") ||
    app.getVersion().includes("shanlan"));
const shanlanAppearance = dailyShanlan || desktopPreview;
const previewProfile =
  desktopPreview &&
  process.argv
    .find((arg) => arg.startsWith("--preview-profile="))
    ?.slice("--preview-profile=".length);
const profileDir = path.resolve(
  previewProfile ||
    process.env.KWB_PROFILE ||
    path.join(
      os.homedir(),
      desktopPreview
        ? ".knowledge-workbench-shanlan-v2"
        : ".knowledge-workbench",
    ),
);
fs.mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.setName(
  desktopPreview ? "Knowledge Workbench Shanlan V2" : "Knowledge Workbench",
);
const rendererUrl = (baseUrl) =>
  shanlanAppearance ? `${baseUrl}/?visual=shanlan` : baseUrl;
let window,
  worker,
  service,
  closing = false,
  quitting = false,
  flushingClose = false,
  captureActive = false;
const overlayMap = new Map(),
  pendingFlush = new Map();
const runtimeFile = path.join(profileDir, "runtime.json");
const writeJson = (file, data) => {
  const tmp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
function validSender(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("无效的应用窗口");
}
async function flush() {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFlush.delete(id);
      reject(new Error("保存确认超时；窗口已保留，请重试或复制未保存的文字。"));
    }, 20000);
    pendingFlush.set(id, { resolve, reject, timer });
    window.webContents.send("workbench:flush", id);
  });
}
ipcMain.on("workbench:flushed", (event, data) => {
  validSender(event);
  const pending = pendingFlush.get(data.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingFlush.delete(data.id);
  data.error ? pending.reject(new Error(data.error)) : pending.resolve();
});
async function stopService() {
  if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);
  const child = worker;
  worker = undefined;
  service = undefined;
  if (!child?.pid) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: "shutdown" });
  });
}
async function start(vaultDir) {
  if (vaultDir) vaultDir = resolveVaultSelection(vaultDir).scope;
  const preferredPort = service
    ? Number(new URL(service.baseUrl).port)
    : readPreferences().port;
  await stopService();
  const child = utilityProcess.fork(path.join(root, "build/service.cjs"), [], {
    serviceName: "Knowledge Workbench files",
    stdio: "pipe",
  });
  worker = child;
  child.stderr?.on("data", (bytes) => {
    process.stderr.write(bytes);
  });
  service = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("本地服务启动超时"));
    }, 30000);
    child.on("message", async (data) => {
      if (data.type === "initialized") {
        child.postMessage({
          type: "start",
          options: {
            vaultDir,
            port: preferredPort,
            dataDir: profileDir,
            distDir: path.join(root, "dist"),
            // Availability is checked only when the user requests credentials.
            // A Keychain prompt must not block startup before a window exists.
            secureStorage: true,
          },
        });
      }
      if (data.type === "crypto") {
        try {
          const value =
            data.action === "encrypt"
              ? credentials.encrypt(data.value)
              : credentials.decrypt(data.value);
          child.postMessage({ type: "crypto-result", id: data.id, value });
        } catch (error) {
          child.postMessage({
            type: "crypto-result",
            id: data.id,
            error: error.message,
          });
        }
      }
      if (data.type === "desktop") {
        try {
          let value;
          if (data.action === "capture") {
            await beginCapture();
            value = { ok: true };
          } else if (data.action === "plugin")
            value = preparePlugin({
              root,
              profileDir,
              executable: process.execPath,
              electron: true,
            });
          else if (data.action === "choose-vault") {
            await flush();
            const choice = await dialog.showOpenDialog(window, {
              title: "选择 Obsidian 知识库或子文件夹",
              properties: ["openDirectory"],
            });
            if (!choice.canceled) {
              const vaultDir = choice.filePaths[0];
              resolveVaultSelection(vaultDir);
              setTimeout(
                () =>
                  void start(vaultDir).catch((error) =>
                    dialog.showErrorBox("知识库未打开", error.message),
                  ),
                250,
              );
              value = { reopening: true };
            } else value = { reopening: false };
          }
          child.postMessage({ type: "crypto-result", id: data.id, value });
        } catch (error) {
          child.postMessage({
            type: "crypto-result",
            id: data.id,
            error: error.message,
          });
        }
      }
      if (data.type === "ready") {
        clearTimeout(timer);
        resolve(data);
      }
      if (data.type === "error") {
        clearTimeout(timer);
        reject(new Error(data.message));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`本地服务退出 (${code})`));
      if (worker === child && !closing) {
        service = undefined;
        if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);
        dialog.showErrorBox(
          "本地服务已停止",
          "请重启应用。编辑中的本机草稿会保留。",
        );
      }
    });
  });
  writeJson(runtimeFile, {
    service: "knowledge-workbench",
    apiVersion: 1,
    baseUrl: service.baseUrl,
    token: service.token,
    vaultId: service.vaultId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  writeJson(path.join(profileDir, "preferences.json"), {
    vaultDir,
    port: Number(new URL(service.baseUrl).port),
  });
  if (window) await window.loadURL(rendererUrl(service.baseUrl));
}
async function request(method, route, body) {
  if (!service) throw new Error("本地服务未连接");
  const response = await fetch(service.baseUrl + "/api" + route, {
    method,
    headers: {
      Authorization: "Bearer " + service.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error), {
      code: data.code,
      details: data.details,
      status: response.status,
    });
  return data;
}
async function chooseVault() {
  await flush();
  const result = await dialog.showOpenDialog(window, {
    title: "选择 Obsidian 知识库或子文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled) return;
  const vaultDir = result.filePaths[0];
  resolveVaultSelection(vaultDir);
  const previous = service;
  try {
    await start(vaultDir);
  } catch (error) {
    if (previous) await start(readPreferences().vaultDir).catch(() => {});
    throw error;
  }
}
function readPreferences() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(profileDir, "preferences.json"), "utf8"),
    );
  } catch {
    return {};
  }
}
function endCapture() {
  for (const { overlay } of overlayMap.values())
    if (!overlay.isDestroyed()) overlay.destroy();
  overlayMap.clear();
  captureActive = false;
  window?.show();
  window?.focus();
}
async function beginCapture() {
  if (captureActive) return;
  if (!service?.vaultId) throw new Error("请先选择知识库");
  const permissionMessage =
    "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 Knowledge Workbench 录制屏幕，然后退出并重新打开应用。开发模式请允许 Electron。";
  if (
    process.platform === "darwin" &&
    ["denied", "restricted"].includes(
      systemPreferences.getMediaAccessStatus("screen"),
    )
  )
    throw new Error(permissionMessage);
  captureActive = true;
  window?.hide();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const displays = screen.getAllDisplays();
    // One shared maximum size upscales the lower-DPI screen on mixed displays.
    // Request each display's physical size, and freeze every frame before overlays.
    const frames = await Promise.all(
      displays.map(async (display) => {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: {
            width: Math.ceil(display.size.width * display.scaleFactor),
            height: Math.ceil(display.size.height * display.scaleFactor),
          },
          fetchWindowIcons: false,
        });
        const source = sources.find((s) => s.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty())
          throw new Error("此显示器无法采集，请重试");
        return { display, image: source.thumbnail };
      }),
    );
    if (
      process.platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") !== "granted"
    )
      throw new Error(permissionMessage);
    for (const { display, image } of frames) {
      const overlay = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        fullscreenable: false,
        hasShadow: false,
        backgroundColor: "#182b28",
        webPreferences: {
          preload: path.join(root, "desktop/capture-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      overlay.setMenuBarVisibility(false);
      if (process.platform === "darwin") {
        overlay.setAlwaysOnTop(true, "screen-saver");
      }
      overlayMap.set(overlay.webContents.id, { overlay, display, image });
      await overlay.loadFile(path.join(root, "desktop/capture.html"));
      overlay.setBounds(display.bounds);
      overlay.show();
    }
    const cursorDisplay = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    [...overlayMap.values()]
      .find((x) => x.display.id === cursorDisplay.id)
      ?.overlay.focus();
  } catch (error) {
    endCapture();
    throw error;
  }
}
ipcMain.handle("capture:image", (event) => {
  const item = overlayMap.get(event.sender.id);
  if (!item || event.senderFrame !== item.overlay.webContents.mainFrame)
    throw new Error("截图窗口已关闭");
  return item.image.toDataURL();
});
ipcMain.on("capture:cancel", (event) => {
  if (overlayMap.has(event.sender.id)) endCapture();
});
ipcMain.handle("capture:select", async (event, rect) => {
  const item = overlayMap.get(event.sender.id);
  if (!item || event.senderFrame !== item.overlay.webContents.mainFrame)
    throw new Error("截图窗口已关闭");
  try {
    const physical = item.image.getSize(),
      crop = cropRect(rect, item.display.size, physical),
      bytes = item.image.crop(crop).toPNG();
    // The original selection is durably written before the user adds a thought.
    const capture = await request("POST", "/captures", {
      title: `截图 ${new Date().toLocaleString("zh-CN")}`,
      text: "",
      image: bytes.toString("base64"),
    });
    window?.webContents.send("workbench:captured", capture);
    return { saved: true };
  } catch (error) {
    dialog.showErrorBox("截图未保存", error.message);
    throw error;
  } finally {
    endCapture();
  }
});
const routes = {
  GET: /^\/(status|notes|note|history|relations|resolve-link|captures|jobs|proposals|settings|paperdesk\/source)(?:\?.*)?$/,
  POST: /^\/(refresh|notes|note\/move|history\/restore|assets|captures|jobs|jobs\/preview|jobs\/[^/]+\/(run|pause|share)|proposals\/[^/]+\/(accept|reject|rebase)|settings\/provider\/test)$/,
  PUT: /^\/(note|draft|settings\/(provider|paperdesk|appearance)|proposals\/[^/]+)$/,
  DELETE: /^\/draft$/,
};
ipcMain.handle("workbench:request", async (event, input) => {
  try {
    validSender(event);
    const { method, route, body } = input;
    if (method === "DESKTOP") {
      let data;
      if (route === "/vault/choose") data = await chooseVault();
      else if (route === "/capture") data = await beginCapture();
      else if (route === "/external") {
        const u = new URL(body.url);
        if (
          !["https:", "http:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw new Error("不支持此链接");
        await shell.openExternal(u.href);
      } else if (route === "/plugin/setup")
        data = preparePlugin({
          root,
          profileDir,
          executable: process.execPath,
          electron: true,
        });
      else throw new Error("桌面操作不存在");
      return { data };
    }
    if (!routes[method]?.test(route)) throw new Error("此窗口没有该接口的权限");
    return { data: await request(method, route, body) };
  } catch (error) {
    return {
      error: error.message,
      code: error.code,
      details: error.details,
      status: error.status,
    };
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("activate", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--background")) return;
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        process.platform === "darwin"
          ? Menu.buildFromTemplate([
              { role: "appMenu" },
              {
                label: "文件",
                submenu: [{ role: "close", label: "关闭窗口" }],
              },
              { role: "editMenu", label: "编辑" },
              {
                label: "显示",
                submenu: [
                  { role: "resetZoom" },
                  { role: "zoomIn" },
                  { role: "zoomOut" },
                  { role: "togglefullscreen" },
                ],
              },
              { role: "windowMenu", label: "窗口" },
            ])
          : null,
      );
      await start(
        (desktopPreview ? undefined : process.env.KWB_VAULT) ||
          readPreferences().vaultDir,
      );
      window = new BrowserWindow({
        width: 1390,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: "#fbfaf6",
        title: desktopPreview
          ? "知识工作台 · 山岚 V2 预览"
          : dailyShanlan
            ? "知识工作台 · 山岚 V2"
            : "Knowledge Workbench · 知识工作台",
        webPreferences: {
          preload: path.join(root, "desktop/preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      });
      if (shanlanAppearance)
        window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (!service || new URL(url).origin !== service.baseUrl)
          event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.on("close", (event) => {
        if (closing) return;
        event.preventDefault();
        if (flushingClose) return;
        flushingClose = true;
        void flush()
          .then(async () => {
            if (process.platform === "darwin" && !quitting) {
              window.hide();
              return;
            }
            closing = true;
            globalShortcut.unregisterAll();
            endCapture();
            await stopService();
            window.destroy();
            app.quit();
          })
          .catch((error) => {
            quitting = false;
            window.show();
            window.focus();
            return dialog.showMessageBox(window, {
              type: "warning",
              title: "笔记尚未保存",
              message: error.message,
              detail: "请处理保存提示后再关闭。输入已保留在本机草稿中。",
              buttons: ["返回编辑"],
            });
          })
          .finally(() => {
            flushingClose = false;
          });
      });
      await window.loadURL(rendererUrl(service.baseUrl));
      if (!process.argv.includes("--background")) window.show();
      if (
        !desktopPreview &&
        !globalShortcut.register(
          "CommandOrControl+Alt+S",
          () =>
            void beginCapture().catch((error) =>
              dialog.showErrorBox("截图未开始", error.message),
            ),
        )
      )
        dialog.showMessageBox(window, {
          type: "info",
          message: `${process.platform === "darwin" ? "⌘ + ⌥ + S" : "Ctrl + Alt + S"} 已被其他程序占用`,
          detail: "仍可从收集箱点击“框选截图”。",
          buttons: ["知道了"],
        });
    })
    .catch(async (error) => {
      console.error("Knowledge Workbench startup failed:", error);
      dialog.showErrorBox("知识工作台未能启动", error.message);
      closing = true;
      await stopService();
      app.quit();
    });
  app.on("before-quit", (event) => {
    quitting = true;
    if (window && !window.isDestroyed() && !closing) {
      event.preventDefault();
      window.close();
    }
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    worker?.kill();
    if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);
  });
}
