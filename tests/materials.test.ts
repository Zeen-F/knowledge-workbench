import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Capture, Job, Proposal } from "../shared/contracts.ts";
import { filterMaterials, reviewEvidence } from "../src/materials.ts";
import { MaterialContent, SnapshotText } from "../src/MaterialContent.tsx";
import { renderMarkdown } from "../src/markdown.ts";

const capture = (
  id: string,
  kind: Capture["ref"]["kind"],
  title: string,
  text = "",
) =>
  ({
    id,
    path: `KnowledgeWorkbench/Inbox/${id}.md`,
    text,
    ref: {
      id,
      schema: "source-ref/v1",
      kind,
      title,
      capturedAt: "2026-10-19T08:00:00Z",
    },
  }) as Capture;
const materials = [
  capture("a", "text", "噪声推导", "MOS Thermal noise"),
  capture("b", "image", "电路截图"),
  capture("c", "paperdesk", "文献标注"),
];
materials[2].ref.paperdesk = {
  title: "Analog Design",
  page: 17,
  quote: "Input Noise",
  documentId: "doc",
  pdfSha256: "a".repeat(64),
  rects: [],
};

test("material filters combine type, selected-only and case-insensitive multiword content/source search", () => {
  assert.deepEqual(
    filterMaterials(materials, "noise MOS", "all", false, []).map((c) => c.id),
    ["a"],
  );
  assert.deepEqual(
    filterMaterials(materials, "Analog input", "paperdesk", false, []).map(
      (c) => c.id,
    ),
    ["c"],
  );
  assert.deepEqual(
    filterMaterials(materials, "", "image", true, ["c", "b"]).map((c) => c.id),
    ["b"],
  );
  assert.equal(
    filterMaterials(materials, "not found", "all", false, []).length,
    0,
  );
  assert.equal(filterMaterials(materials, "", "all", true, []).length, 0);
});

test("filtering never mutates selected order, original captures or the batch scope", () => {
  const selected = ["c", "a"];
  const before = structuredClone(materials);
  filterMaterials(materials, "噪声", "text", true, selected);
  assert.deepEqual(selected, ["c", "a"]);
  assert.deepEqual(materials, before);
  assert.deepEqual(
    filterMaterials(materials, "  ", "all", false, selected),
    materials,
  );
  assert.equal(
    filterMaterials(materials, "Inbox/b.md", "all", false, []).length,
    1,
  );
});

test("review uses only linked sources in frozen batch order and includes frozen references", () => {
  const references = [
    {
      path: "Cards/ref.md",
      hash: "frozen",
      title: "Old reference",
      content: "Snapshot body",
    },
  ];
  const job = { snapshot: { sources: materials, references } } as Job;
  const proposal = { sourceIds: ["c", "a", "missing", "missing"] } as Proposal;
  const evidence = reviewEvidence(proposal, job);
  assert.deepEqual(
    evidence.sources.map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(evidence.missing, ["missing"]);
  assert.equal(evidence.references, references);
  assert.deepEqual(reviewEvidence(proposal).missing, ["c", "a", "missing"]);
});

test("read-only material renders provenance and safe Markdown without navigation or raw HTML", () => {
  const html = renderToStaticMarkup(
    createElement(MaterialContent, { capture: materials[2] }),
  );
  assert.match(html, /Analog Design/);
  assert.match(html, /PDF 第.*17.*页/);
  const text =
    "# Heading\n\n[web](https://example.com) [[Note]] <script>alert(1)</script>";
  const snapshot = renderToStaticMarkup(
    createElement(SnapshotText, { text, path: "Inbox/a.md" }),
  );
  assert.match(snapshot, /<h1>Heading/);
  assert.doesNotMatch(snapshot, /<a\b|<script\b/);
  assert.match(snapshot, /snapshot-link/);
  assert.match(
    renderMarkdown(text, "Inbox/a.md"),
    /<a href="https:\/\/example.com"/,
  );
});

test("snapshot frontmatter is retained in collapsed metadata rather than rendered as a heading", () => {
  const text =
    "---\r\ntitle: Reference\r\nsource: [paper]\r\n---\r\n# Body\n\nFrozen reference";
  const html = renderToStaticMarkup(
    createElement(SnapshotText, { text, path: "Cards/ref.md" }),
  );
  assert.match(html, /<details class="snapshot-metadata"><summary>/);
  assert.match(html, /<pre>---/);
  assert.match(html, /source: \[paper\]/);
  assert.match(html, /<h1>Body<\/h1>/);
  assert.doesNotMatch(html, /<h2>title:/);
  const incomplete = renderToStaticMarkup(
    createElement(SnapshotText, {
      text: "---\ntitle: Keep visible",
      path: "Cards/ref.md",
    }),
  );
  assert.doesNotMatch(incomplete, /snapshot-metadata/);
  assert.match(incomplete, /Keep visible/);
  for (const metadata of ["title: [broken", "a scalar", "- a list"]) {
    const malformed = renderToStaticMarkup(
      createElement(SnapshotText, {
        text: `---\n${metadata}\n---\n# Body`,
        path: "Cards/ref.md",
      }),
    );
    assert.doesNotMatch(malformed, /snapshot-metadata/);
    assert.ok(
      malformed.includes(
        renderMarkdown(`---\n${metadata}\n---\n# Body`, "Cards/ref.md", {
          inertLinks: true,
        }),
      ),
    );
  }
});
