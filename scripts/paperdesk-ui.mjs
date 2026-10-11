import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import path from "node:path";

export async function exportSelections(context, base, evidence, desktopPage) {
  const page = desktopPage || (await context.newPage());
  if (!desktopPage) await page.goto(base);
  const pageInput = page.getByRole("spinbutton", { name: "页码", exact: true });
  await expect(pageInput).toBeEnabled();
  await page
    .getByRole("combobox", { name: "阅读缩放", exact: true })
    .selectOption("page");
  await pageInput.fill("2");
  await pageInput.press("Enter");
  const line = page
    .locator('.pdf-paper[data-page="2"] .textLayer span')
    .filter({ hasText: "Evidence from page 02 stays on page 02." });
  await expect(line).toBeVisible();
  await expect(page.locator('.pdf-paper[data-page="2"]')).not.toHaveClass(
    /is-loading/,
  );
  await expect(page.locator(".reader-status")).toHaveCount(0);
  await line.click({ trial: true });
  const bounds = await line.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.screenshot({
    path: path.join(evidence, "paperdesk-text-selection.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.locator(".selection-bar")).toContainText(
    "Evidence from page 02",
  );
  await page.getByRole("button", { name: "发送到知识库", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "发送到知识库",
    exact: true,
  });
  await dialog
    .getByLabel("你的想法（可选）")
    .fill("文字选区联调：条件仍需核对。");
  await expect(pageInput).toBeDisabled();
  const attempts = [];
  const exportRoute = `${base}/api/integrations/knowledge/export`;
  await page.route(exportRoute, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const committed = await route.fetch();
      assert.equal(committed.status(), 201);
      await route.abort("connectionreset"); // The actual producer committed; only its response is lost.
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "发送到知识库", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("你的想法（可选）")).toHaveValue(
    "文字选区联调：条件仍需核对。",
  );
  await expect(dialog.getByLabel("你的想法（可选）")).toBeDisabled();
  await page.screenshot({
    path: path.join(evidence, "paperdesk-retry.png"),
    fullPage: true,
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "重试发送", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  await page.unroute(exportRoute);
  await pageInput.fill("3");
  await pageInput.press("Enter");
  await expect(
    page.locator('.pdf-paper[data-page="3"] .textLayer'),
  ).toContainText("Evidence from page 03");
  await page.getByRole("button", { name: "区域批注", exact: true }).click();
  const layer = page
    .locator('.pdf-paper[data-page="3"]')
    .getByLabel("拖动框选批注区域", { exact: true });
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 0.1 * box.width, box.y + 0.3 * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + 0.84 * box.width, box.y + 0.63 * box.height, {
    steps: 8,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "发送到知识库", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "原始选区" })).toBeVisible();
  await dialog
    .getByLabel("你的想法（可选）")
    .fill("图片选区联调：保留原图，不推断公式。");
  await page.screenshot({
    path: path.join(evidence, "paperdesk-region-export.png"),
    fullPage: true,
    animations: "disabled",
  });
  const exported = page.waitForResponse(
    (r) => r.url() === exportRoute && r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "发送到知识库", exact: true })
    .click();
  const response = await exported;
  assert.equal(response.status(), 201);
  const region = response.request().postDataJSON();
  await expect(dialog).toHaveCount(0);
  assert.equal(region.page, 3);
  assert.equal(region.quote, "");
  assert.ok(region.image.startsWith("data:image/png;base64,"));
  assert.equal(region.rects.length, 1);
  for (const [key, expected] of Object.entries({
    x: 0.1,
    y: 0.3,
    width: 0.74,
    height: 0.33,
  }))
    assert.ok(Math.abs(region.rects[0][key] - expected) < 0.015);
  if (!desktopPage) await page.close();
  return { text: attempts[0], region };
}

export async function importAndReturn(
  context,
  workbench,
  paperdeskBase,
  evidence,
  regionCapture,
) {
  const page = await context.newPage();
  await page.goto(workbench.baseUrl);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("本机服务地址", { exact: true }).fill(paperdeskBase);
  await page.getByRole("button", { name: "核对并连接", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("纸间资料库已绑定");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: /^收集箱/ }).click();
  await expect(page.locator(".capture-card")).toHaveCount(2);
  await page.screenshot({
    path: path.join(evidence, "paperdesk-import-inbox.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .locator(".capture-card h3 button")
    .filter({ hasText: "第 3 页" })
    .click();
  await expect(page.getByLabel("笔记编辑器")).toBeVisible();
  await expect(page.locator(".context-panel")).toContainText("PDF 第 3 页");
  const image = page.locator(".cm-content img:not(.cm-widgetBuffer)").first();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(20);
  assert.equal(workbench.captures.image(regionCapture.ref).length > 100, true);
  await page.screenshot({
    path: path.join(evidence, "paperdesk-import-note.png"),
    fullPage: true,
    animations: "disabled",
  });
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "回到纸间原页" }).click();
  const reader = await popup;
  const expectedSourceParams = {
    document: regionCapture.ref.paperdesk.documentId,
    page: "3",
    pdfSha256: regionCapture.ref.paperdesk.pdfSha256,
    capture: regionCapture.ref.transferId,
  };
  await expect(reader).toHaveURL(
    (url) =>
      url.origin === new URL(paperdeskBase).origin &&
      url.pathname === "/" &&
      url.hash === "" &&
      url.searchParams.size === Object.keys(expectedSourceParams).length &&
      Object.entries(expectedSourceParams).every(
        ([key, value]) => url.searchParams.get(key) === value,
      ),
  );
  await expect(
    reader.getByRole("spinbutton", { name: "页码", exact: true }),
  ).toHaveValue("3");
  await expect(
    reader.locator('.pdf-paper[data-page="3"] .textLayer'),
  ).toContainText("Evidence from page 03");
  await reader.screenshot({
    path: path.join(evidence, "paperdesk-source-return.png"),
    fullPage: true,
    animations: "disabled",
  });
  await reader.close();
  return page;
}
