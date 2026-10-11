import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoteTree } from "../src/NoteTree.tsx";
import type { NoteSummary } from "../shared/contracts.ts";
const notes = (count: number, nested = false) =>
  Array.from(
    { length: count },
    (_, i) =>
      ({
        path: `${nested ? `Folder-${Math.floor(i / 100)}/` : ""}Note-${i}.md`,
        title: `Note ${i}`,
      }) as NoteSummary,
  );
const render = (values: NoteSummary[], active = "") =>
  renderToStaticMarkup(
    createElement(NoteTree, {
      notes: values,
      active,
      dirty: () => false,
      onOpen: () => {},
    }),
  );
test("flat trees mount a bounded page and retain a selected note beyond it", () => {
  const html = render(notes(10000), "Note-9999.md");
  assert.equal((html.match(/<button/g) || []).length, 102);
  assert.ok(html.includes('title="Note-9999.md"'));
  assert.ok(html.includes("再显示 100 篇（共 10000 篇）"));
});
test("large nested trees lazy-mount only expanded active branches", () => {
  const html = render(notes(10000, true), "Folder-99/Note-9999.md");
  assert.equal((html.match(/<button/g) || []).length, 100);
  assert.equal((html.match(/<summary/g) || []).length, 100);
  assert.ok(html.includes('title="Folder-99/Note-9999.md"'));
});
test("small trees retain initially expanded folders", () => {
  assert.equal((render(notes(200, true)).match(/<button/g) || []).length, 200);
});
