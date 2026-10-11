import test from "node:test";
import assert from "node:assert/strict";
import type { NoteSummary } from "../shared/contracts.ts";
import { matchesNoteSection } from "../src/note-navigation.ts";

const note = (path: string, noteType = "concept", missing = false) =>
  ({ path, noteType, missing }) as NoteSummary;

test("pending and retained accepted drafts do not inflate formal card badges", () => {
  const retainedDraft = note("KnowledgeWorkbench/Drafts/Synthetic-LDO.md");
  assert.equal(
    [retainedDraft].filter((n) => matchesNoteSection(n, "concept")).length,
    0,
  );
  const afterAcceptance = [
    retainedDraft,
    note("KnowledgeWorkbench/Cards/Synthetic-LDO.md"),
  ];
  const original = structuredClone(afterAcceptance);
  assert.equal(
    afterAcceptance.filter((n) => matchesNoteSection(n, "concept")).length,
    1,
  );
  assert.deepEqual(
    afterAcceptance.filter((n) => matchesNoteSection(n, "all")),
    [afterAcceptance[1]],
  );
  // Counting changes presentation only; the accepted draft is retained intact.
  assert.deepEqual(afterAcceptance, original);
});

test("all, card and learning-log counts share list visibility for inbox and missing records", () => {
  const notes = [
    note("KnowledgeWorkbench/Cards/Card.md"),
    note("KnowledgeWorkbench/Logs/Log.md", "learning-log"),
    note("KnowledgeWorkbench/Drafts/Log.md", "learning-log"),
    note("KnowledgeWorkbench/Inbox/Capture.md"),
    note("KnowledgeWorkbench/Cards/Missing.md", "concept", true),
    note("KnowledgeWorkbench/Logs/Missing.md", "learning-log", true),
    note("External/Reading.md", "reading"),
  ];
  assert.equal(notes.filter((n) => matchesNoteSection(n, "all")).length, 3);
  assert.equal(notes.filter((n) => matchesNoteSection(n, "concept")).length, 1);
  assert.equal(
    notes.filter((n) => matchesNoteSection(n, "learning-log")).length,
    1,
  );
  assert.deepEqual(
    notes.filter((n) => matchesNoteSection(n, "concept")),
    [notes[0]],
  );
});
