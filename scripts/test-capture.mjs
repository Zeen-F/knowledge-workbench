import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { removeTestDirectory } from "./test-cleanup.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-capture-")),
  vault = path.join(root, "vault"),
  profile = path.join(root, "profile");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const env = { ...process.env, KWB_VAULT: vault, KWB_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const captureCount = Number(process.env.KWB_TEST_CAPTURE_COUNT || 20);
let app;
try {
  app = await electron.launch({
    executablePath:
      process.env.KWB_TEST_EXE || createRequire(import.meta.url)("electron"),
    args: process.env.KWB_TEST_EXE ? [] : ["."],
    env,
  });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  const runtime = JSON.parse(
    fs.readFileSync(path.join(profile, "runtime.json"), "utf8"),
  );
  const captures = async () => {
    const r = await fetch(runtime.baseUrl + "/api/captures", {
      headers: { Authorization: "Bearer " + runtime.token },
    });
    return r.json();
  };
  const displays = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const list = screen.getAllDisplays();
    globalThis.__captureCovers = [];
    for (const d of list) {
      const cover = new BrowserWindow({
        ...d.bounds,
        frame: false,
        show: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#000000",
        webPreferences: { sandbox: true },
      });
      await cover.loadURL(
        "data:text/html,<style>html,body{margin:0;width:100%;height:100%;background:%23000}body:before{content:%22%22;position:absolute;left:160px;top:0;width:120px;height:100%;background:%23fff}body:after{content:%22SYNTHETIC CAPTURE TEST%22;position:absolute;left:400px;top:400px;color:white;font:32px sans-serif}</style>",
      );
      cover.setBounds(d.bounds);
      if (process.platform === "darwin") cover.setAlwaysOnTop(true, "status");
      cover.showInactive();
      globalThis.__captureCovers.push(cover);
    }
    return list.map((d) => ({
      id: d.id,
      width: d.size.width,
      height: d.size.height,
      scale: d.scaleFactor,
    }));
  });
  // Exercise the desktopCapturer path and pointer selection, not a mocked image API.
  for (let i = 0; i < captureCount; i++) {
    // Restore the synthetic backgrounds before each capture, since window
    // activation during the previous selection can change their visibility.
    await app.evaluate(() => {
      for (const cover of globalThis.__captureCovers) cover.showInactive();
    });
    await page.evaluate(() => window.workbench.capture("history"));
    const overlays = app
      .windows()
      .filter((p) => p.url().endsWith("/capture.html"));
    expect(overlays.length).toBe(displays.length);
    const overlay = overlays[i % overlays.length];
    await expect(overlay.locator("#screen")).toHaveJSProperty("complete", true);
    await overlay.mouse.move(100, 100);
    await overlay.mouse.down();
    await overlay.mouse.move(220, 180, { steps: 3 });
    await overlay.mouse.up();
    await expect.poll(async () => (await captures()).length).toBe(i + 1);
  }
  await page.evaluate(() => window.workbench.capture("history"));
  const canceled = app.windows().find((p) => p.url().endsWith("/capture.html"));
  await canceled.keyboard.press("Escape").catch((error) => {
    if (!canceled.isClosed()) throw error;
  });
  await expect
    .poll(
      () =>
        app.windows().filter((p) => p.url().endsWith("/capture.html")).length,
    )
    .toBe(0);
  const saved = await captures();
  expect(saved).toHaveLength(captureCount);
  const assets = [...new Set(saved.map((c) => c.ref.assetPath))];
  for (const asset of assets) {
    const png = fs.readFileSync(path.join(vault, asset));
    const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
    console.log(JSON.stringify({ dimensions, displays }));
    expect(
      displays.some(
        (d) =>
          Math.abs(dimensions[0] - 120 * d.scale) <= 1 &&
          Math.abs(dimensions[1] - 80 * d.scale) <= 1,
      ),
    ).toBe(true);
    // Black/white reference bands survive macOS display color conversion.
    // Check both positions, so a blank or incorrectly cropped image cannot pass.
    const pixels = await app.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const { width, height } = image.getSize(),
        bytes = image.toBitmap();
      return [0.25, 0.75].map((x) => {
        const offset =
          (Math.floor(height / 2) * width + Math.floor(width * x)) * 4;
        return Array.from(bytes.subarray(offset, offset + 4));
      });
    }, png.toString("base64"));
    expect(pixels).toEqual([
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
  }
  expect(assets.length).toBeLessThanOrEqual(displays.length);
  const evidence = {
    passed: true,
    captures: saved.length,
    uniqueAssets: assets.length,
    displays,
    cancelPreservedCount: true,
    syntheticPixelsVerified: true,
  };
  fs.mkdirSync("output/acceptance", { recursive: true });
  fs.writeFileSync(
    "output/acceptance/capture.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (app) {
    await app
      .evaluate(() => {
        for (const window of globalThis.__captureCovers || []) window.destroy();
      })
      .catch(() => {});
    await app.close();
  }
  await removeTestDirectory(root, os.tmpdir());
}
