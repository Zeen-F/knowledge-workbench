export class ApiError extends Error {
  code?: string;
  details?: unknown;
  status?: number;
}
let ready: Promise<unknown> | undefined;
export async function api<T = any>(
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  if (window.workbench) return window.workbench.invoke(method, route, body);
  ready ||= fetch("/api/session", { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error("无法连接本地服务");
  });
  await ready;
  const r = await fetch("/api" + route, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) {
    const error = new ApiError(data.error || "请求未完成");
    error.code = data.code;
    error.details = data.details;
    error.status = r.status;
    throw error;
  }
  return data;
}
export const fileData = (file: File) =>
  new Promise<string>((resolve, reject) => {
    if (file.size > 20 * 1024 * 1024)
      return reject(new Error("每张图片须小于 20 MiB"));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (window.workbench) void window.workbench.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
// Reserve the new tab during the click; asynchronous validation otherwise loses user activation.
export async function openResolvedExternal(resolveUrl: () => Promise<string>) {
  if (window.workbench)
    return window.workbench.openExternal(await resolveUrl());
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("浏览器未允许打开来源页，请允许弹出窗口后重试");
  tab.opener = null;
  tab.document.title = "正在核对纸间来源";
  tab.document.body.textContent = "正在核对文献和页码…";
  try {
    const url = await resolveUrl();
    if (!/^https?:\/\//i.test(url)) throw new Error("来源地址无效");
    tab.location.replace(url);
  } catch (e) {
    tab.close();
    throw e;
  }
}
export const shortDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
export const prettyState = (value: string) =>
  ({
    queued: "等待处理",
    shared: "等待 Codex",
    running: "处理中",
    paused: "已暂停",
    failed: "需要处理",
    review: "等待审核",
    completed: "已完成",
    pending: "待审",
    accepted: "已接受",
    rejected: "已退回",
    done: "已完成",
  })[value] || value;

export async function nativeAction(
  action: "choose-vault" | "capture" | "plugin",
) {
  const result = await api("POST", "/desktop/action", { action });
  if (result?.reopening) {
    await new Promise((r) => setTimeout(r, 1700));
    window.location.reload();
  }
  return result;
}
