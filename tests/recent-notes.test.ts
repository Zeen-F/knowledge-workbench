import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteSummary } from "../shared/contracts.ts";
import { matchesNoteSection } from "../src/note-navigation.ts";
import { RecentNotes } from "../src/RecentNotes.tsx";

const note = (path: string, noteType = "concept", missing = false) =>
  ({
    path,
    title: path,
    noteType,
    missing,
    updatedAt: "2026-10-10T12:00:00Z",
  }) as NoteSummary;
const render = (notes: NoteSummary[]) =>
  renderToStaticMarkup(createElement(RecentNotes, { notes, onOpen: () => {} }));

test("recent note total and rendered rows both exclude retained drafts, captures and missing notes", () => {
  const raw = [
    note("KnowledgeWorkbench/Cards/Card.md"),
    note("External/Reading.md", "reading"),
    note("KnowledgeWorkbench/Drafts/Retained.md"),
    note("KnowledgeWorkbench/Inbox/Capture.md"),
    note("KnowledgeWorkbench/Cards/Missing.md", "concept", true),
  ];
  const visible = raw.filter((n) => matchesNoteSection(n, "all"));
  const html = render(visible);
  assert.match(html, /2 篇笔记/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.doesNotMatch(html, /Retained|Capture|Missing/);
  const cards = render(raw.filter((n) => matchesNoteSection(n, "concept")));
  assert.match(cards, /1 篇笔记/);
  assert.equal((cards.match(/<button/g) || []).length, 1);
});

test("recent preview keeps total equal to the filtered collection rather than its seven-row window", () => {
  const notes = Array.from({ length: 9 }, (_, i) =>
    note(`KnowledgeWorkbench/Cards/${i}.md`),
  );
  const html = render(notes);
  assert.match(html, /9 篇笔记/);
  assert.equal((html.match(/<button/g) || []).length, 7);
  assert.match(render([]), /0 篇笔记/);
});
