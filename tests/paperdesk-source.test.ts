import test from "node:test";
import assert from "node:assert/strict";
import { Paperdesk } from "../server/paperdesk.ts";
import type { SourceRef } from "../shared/contracts.ts";
const source: SourceRef = {
  schema: "source-ref/v1",
  id: "8e6c5d37-83bb-4326-971e-1f801ab7f055",
  kind: "paperdesk",
  title: "Synthetic source",
  capturedAt: "2026-10-10T00:00:00Z",
  transferId: "0cde01e7-a643-4ff2-b134-eab2e061a15c",
  paperdesk: {
    documentId: "8f5310c6-318c-4eaf-80cf-0d406b218ed7",
    title: "Synthetic PDF",
    pdfSha256: "a".repeat(64),
    page: 2,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
    quote: "Synthetic quote",
  },
};
test("source URLs carry verified PDF and immutable capture identity without raw selected text", async (t) => {
  const service = new Paperdesk({} as any);
  t.mock.method(service, "verify", async () => ({
    baseUrl: "http://127.0.0.1:8788",
  }));
  t.mock.method(service, "request", async () => ({
    documentId: source.paperdesk!.documentId,
    pdfSha256: source.paperdesk!.pdfSha256,
    pageCount: 3,
  }));
  const url = new URL(await service.sourceUrl(source));
  assert.equal(url.searchParams.get("capture"), source.transferId);
  assert.equal(url.searchParams.get("pdfSha256"), source.paperdesk!.pdfSha256);
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.has("rects"), false);
  assert.equal(url.href.includes("Synthetic"), false);
  assert.equal(
    new URL(
      await service.sourceUrl({ ...source, transferId: undefined }),
    ).searchParams.has("capture"),
    false,
  );
});
test("precise return URLs still refuse changed PDF identity or out-of-range page", async (t) => {
  const service = new Paperdesk({} as any);
  t.mock.method(service, "verify", async () => ({
    baseUrl: "http://127.0.0.1:8788",
  }));
  const request = t.mock.method(service, "request", async () => ({
    documentId: source.paperdesk!.documentId,
    pdfSha256: "b".repeat(64),
    pageCount: 3,
  }));
  await assert.rejects(
    () => service.sourceUrl(source),
    (e: any) => e.code === "SOURCE_CHANGED",
  );
  request.mock.mockImplementation(async () => ({
    documentId: source.paperdesk!.documentId,
    pdfSha256: source.paperdesk!.pdfSha256,
    pageCount: 1,
  }));
  await assert.rejects(
    () => service.sourceUrl(source),
    (e: any) => e.code === "SOURCE_CHANGED",
  );
});
