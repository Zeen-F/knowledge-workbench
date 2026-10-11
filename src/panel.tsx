import { App as McpApp } from "@modelcontextprotocol/ext-apps";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeRemoteRecovery, flushRecovery } from "./recovery";
import { requirePanelFeatures } from "../shared/recovery";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./themes.css";
import "./panel.css";

const bridge = new McpApp(
  { name: "knowledge-workbench", version: "0.1.0-alpha.4" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false },
);
const flushers = new Set<() => Promise<void>>();
let vaultId: string | null | undefined;
let closed = false;
let root: ReturnType<typeof createRoot> | undefined;
const imageUrls = new Set<string>();
const images = new WeakMap<HTMLImageElement, string>();
const placeholder =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

async function invoke(
  method: string,
  route: string,
  body?: unknown,
): Promise<any> {
  if (closed) throw new Error("面板已关闭");
  const result = await bridge.callServerTool(
    {
      name: method === "GET" ? "workbench_panel_read" : "workbench_panel_write",
      arguments: {
        route,
        ...(vaultId === undefined ? {} : { vaultId }),
        ...(method === "GET" ? {} : { method, body }),
      },
    },
    { timeout: 45000 },
  );
  const panel = result._meta?.panel as any;
  if (result.isError || !panel || panel.error) {
    const error = new Error(
      panel?.error || "宿主未返回面板数据，请重新打开知识工作台。",
    );
    throw Object.assign(error, {
      code: panel?.code,
      status: panel?.status,
      details: panel?.details,
    });
  }
  return panel.data;
}

// Images travel through app-only tools; no cookies, tokens or direct localhost
// connections enter the sandbox. Limit simultaneous transfers to three.
const imageQueue: Array<() => Promise<void>> = [];
let loading = 0;
function pump() {
  while (!closed && loading < 3 && imageQueue.length) {
    loading++;
    void imageQueue.shift()!().finally(() => {
      loading--;
      pump();
    });
  }
}
function scanImages() {
  document
    .querySelectorAll<HTMLImageElement>('img[src*="#kwb-asset="]')
    .forEach((img) => {
      const source = img.getAttribute("src")!;
      if (images.get(img) === source) return;
      images.set(img, source);
      imageQueue.push(async () => {
        try {
          const relative = decodeURIComponent(source.split("#kwb-asset=")[1]);
          const data = await invoke(
            "GET",
            "/assets?path=" + encodeURIComponent(relative),
          );
          if (closed || !img.isConnected || img.getAttribute("src") !== source)
            return;
          const match =
            /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
              data.dataUrl,
            );
          if (!match) throw new Error("图片返回格式无效");
          const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(
            new Blob([bytes], { type: match[1] }),
          );
          imageUrls.add(url);
          img.src = url;
        } catch (error) {
          if (img.isConnected) {
            img.src = placeholder;
            img.alt = `图片加载失败：${(error as Error).message}`;
            img.title = img.alt;
          }
        }
      });
      pump();
    });
  // Release images no longer displayed, including editor widget replacement.
  const displayed = new Set([...document.images].map((img) => img.src));
  for (const url of imageUrls)
    if (!displayed.has(url)) {
      URL.revokeObjectURL(url);
      imageUrls.delete(url);
    }
}
const observer = new MutationObserver(scanImages);
bridge.ontoolresult = () => {}; // Tool results never cause automatic reading/sharing.
bridge.onteardown = async () => {
  // Flush uses the same recovery-draft and version checks as the desktop editor.
  await Promise.all([...flushers].map((flush) => flush()));
  await flushRecovery(undefined, true);
  closed = true;
  observer.disconnect();
  imageQueue.length = 0;
  root?.unmount();
  for (const url of imageUrls) URL.revokeObjectURL(url);
  return {};
};

async function start() {
  document.documentElement.classList.add("native-panel");
  await bridge.connect();
  const status = await invoke("GET", "/status");
  requirePanelFeatures(status);
  vaultId = status.vault?.id || null;
  if (vaultId) await initializeRemoteRecovery(vaultId, invoke);
  window.workbench = {
    panel: true,
    invoke,
    chooseVault: async () => {
      throw new Error("请在桌面应用切换知识库，再重新打开此面板。");
    },
    capture: async () => {
      throw new Error(
        "请使用桌面工作台的截图快捷键；此面板支持粘贴和拖入图片。",
      );
    },
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("链接无效");
      const result = await bridge.openLink({ url });
      if (result.isError) throw new Error("宿主未能打开来源链接");
    },
    onFlush: (fn) => {
      flushers.add(fn);
      return () => {
        flushers.delete(fn);
      };
    },
    onCapture: () => () => {},
    sendToCodex: async (text) => {
      const result = await bridge.sendMessage({
        role: "user",
        content: [{ type: "text", text }],
      });
      if (result.isError)
        throw new Error(
          "宿主不支持直接发送，请使用复制指令。不要重复点击发送。",
        );
    },
  };
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  await bridge.sendSizeChanged({ height: 760 }).catch(() => {});
}
void start().catch((error) => {
  const container = document.getElementById("root")!;
  const card = document.createElement("section");
  card.setAttribute("role", "alert");
  const title = document.createElement("h2");
  title.textContent =
    error.code === "SERVICE_UPGRADE_REQUIRED"
      ? "需要更新桌面工作台"
      : "知识工作台暂时无法打开";
  const detail = document.createElement("p");
  detail.textContent = error.message;
  card.append(title, detail);
  container.replaceChildren(card);
});
