import { expect } from "@playwright/test";
// A BrowserWindow can exist before its preload round trip and React state settle.
// This is a bounded startup precondition, not a replacement for UI assertions.
export async function waitForDesktopReady(page, vaultId, timeout = 30000) {
  const started = Date.now();
  await expect
    .poll(
      () =>
        page.evaluate(async (expectedVaultId) => {
          if (typeof window.workbench?.invoke !== "function") return false;
          const status = await window.workbench.invoke("GET", "/status");
          return (
            status.service === "knowledge-workbench" &&
            status.apiVersion === 1 &&
            status.vault?.id === expectedVaultId &&
            document.querySelector('select[aria-label="笔记范围"]') !== null
          );
        }, vaultId),
      {
        timeout,
        intervals: [100],
        message:
          "Desktop preload, expected vault IPC and renderer must become ready",
      },
    )
    .toBe(true);
  return { ready: true, elapsedMs: Date.now() - started, timeoutMs: timeout };
}
