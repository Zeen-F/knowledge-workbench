// Guard the test precondition itself: wrong vaults and missing preload/UI must fail.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { waitForDesktopReady } from "./desktop-readiness.mjs";
const browser = await chromium.launch({
  channel: process.env.KWB_TEST_BROWSER || undefined,
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(
    '<select aria-label="笔记范围"><option>workbench</option></select>',
  );
  await assert.rejects(waitForDesktopReady(page, "fixture", 300), /Timeout/);
  await page.evaluate(() => {
    window.workbench = {
      invoke: async () => ({
        service: "knowledge-workbench",
        apiVersion: 1,
        vault: { id: "wrong" },
      }),
    };
  });
  await assert.rejects(waitForDesktopReady(page, "fixture", 300), /Timeout/);
  await page.evaluate(() => {
    document.querySelector("select").remove();
    window.workbench.invoke = async () => ({
      service: "knowledge-workbench",
      apiVersion: 1,
      vault: { id: "fixture" },
    });
  });
  await assert.rejects(waitForDesktopReady(page, "fixture", 300), /Timeout/);
  await page.evaluate(() => {
    window.workbench.invoke = () => new Promise(() => {});
  });
  await assert.rejects(waitForDesktopReady(page, "fixture", 300), /Timeout/);
  await page.evaluate(() => {
    window.workbench.invoke = async () => ({
      service: "knowledge-workbench",
      apiVersion: 1,
      vault: { id: "fixture" },
    });
  });
  await page.evaluate(() => {
    setTimeout(() => {
      const select = document.createElement("select");
      select.setAttribute("aria-label", "笔记范围");
      document.body.append(select);
    }, 100);
  });
  assert.equal((await waitForDesktopReady(page, "fixture", 3000)).ready, true);
  console.log(
    "PASS delayed ready; missing preload, wrong vault, missing renderer UI and stalled IPC fail within a bound",
  );
} finally {
  await browser.close();
}
