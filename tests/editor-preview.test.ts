import test from "node:test";
import assert from "node:assert/strict";
import {
  EditorSelection,
  EditorState,
  StateEffect,
  type StateField,
} from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { previewField } from "../src/editor-preview.ts";

function fixture(doc: string, anchor = 0) {
  const calls = { markdown: 0, math: 0 };
  const field = previewField("notes/synthetic.md", {
    markdown: (text, file) => {
      calls.markdown++;
      return `<p>${file}:${text}</p>`;
    },
    math: (tex, display) => {
      calls.math++;
      return `<span>${display}:${tex}</span>`;
    },
  });
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [field, EditorState.allowMultipleSelections.of(true)],
  });
  return { state, field, calls };
}

function entries(decorations: DecorationSet) {
  const result = [];
  for (let cursor = decorations.iter(); cursor.value; cursor.next())
    result.push({
      from: cursor.from,
      to: cursor.to,
      decoration: cursor.value,
    });
  return result;
}

type PreviewField = ReturnType<typeof previewField>;
type PreviewValue =
  PreviewField extends StateField<infer Value> ? Value : never;

function widgets(value: PreviewValue) {
  return entries(value.decorations).filter(
    (entry) => entry.decoration.spec.widget,
  );
}

test("preview reuses document data for no-op, effects, same-line and distant selections", (t) => {
  const { state, field, calls } = fixture(
    "plain text\n# Heading **bold**\nMath $x^2$ and [[Other]]\nlast line",
  );
  const original = state.field(field);
  assert.deepEqual(calls, { markdown: 1, math: 1 });
  const originalWidgets = widgets(original).map((entry) => entry.decoration);
  const mathLine = state.doc.line(3);
  const headingLine = state.doc.line(2);

  t.mock.method(state.doc, "line", () => {
    throw new Error("selection update must not traverse document lines");
  });
  t.mock.method(state.doc, "toString", () => {
    throw new Error("selection update must not materialize the document");
  });
  for (const spec of [
    {},
    { effects: StateEffect.define<number>().of(1) },
    { selection: { anchor: 0 } },
    { selection: { anchor: 3 } },
  ])
    assert.equal(state.update(spec).state.field(field), original);

  const onMath = state.update({
    selection: { anchor: mathLine.from + 2 },
  }).state;
  assert.equal(onMath.field(field).candidates, original.candidates);
  assert.equal(widgets(onMath.field(field)).length, 0);
  assert.equal(
    onMath.update({ selection: { anchor: mathLine.to } }).state.field(field),
    onMath.field(field),
  );
  const onHeading = onMath.update({
    selection: { anchor: headingLine.from },
  }).state;
  assert.deepEqual(
    widgets(onHeading.field(field)).map((entry) => entry.decoration),
    originalWidgets,
  );
  const headingEntries = entries(onHeading.field(field).decorations).filter(
    (entry) => entry.from >= headingLine.from && entry.to <= headingLine.to,
  );
  assert.equal(headingEntries.length, 1);
  assert.equal(headingEntries[0].decoration.spec.class, "cm-heading cm-h1");
  assert.deepEqual(calls, { markdown: 1, math: 1 });
});

test("block preview reveals the whole intersected block, including endpoints", () => {
  const doc = [
    "---",
    "title: Synthetic",
    "---",
    "plain",
    "```ts",
    "const x = 1;",
    "```",
    "plain",
    "$$",
    "x^2",
    "$$",
    "plain",
    "| A | B |",
    "| --- | --- |",
    "| x | y |",
    "plain",
    "![[synthetic.png]]",
    "plain",
  ].join("\n");
  const { state, field, calls } = fixture(doc, doc.length);
  const original = state.field(field);
  assert.equal(original.candidates.length, 5);
  assert.equal(widgets(original).length, 5);
  assert.deepEqual(calls, { markdown: 3, math: 1 });
  const direct = state.facet(EditorView.decorations);
  assert.equal(direct.length, 1);
  assert.equal(direct[0], original.decorations);
  assert.ok(widgets(original).every((entry) => entry.decoration.spec.block));

  for (const candidate of original.candidates) {
    for (const anchor of [
      candidate.from,
      candidate.to,
      (candidate.from + candidate.to) >>> 1,
    ]) {
      const next = state.update({ selection: { anchor } }).state.field(field);
      assert.equal(widgets(next).length, 4);
      assert.ok(
        !entries(next.decorations).some((entry) =>
          candidate.ranges.some((range) => range.value === entry.decoration),
        ),
      );
      assert.equal(next.candidates, original.candidates);
    }
  }
  assert.deepEqual(calls, { markdown: 3, math: 1 });
});

test("multiple and reversed selections reveal only their lines and restore cached ranges", () => {
  const { state, field, calls } = fixture(
    "plain\n**first**\n$second$\n[[third]]\n> **fourth**\nplain",
  );
  const original = state.field(field);
  const second = state.doc.line(3);
  const fourth = state.doc.line(5);
  const next = state.update({
    selection: EditorSelection.create([
      EditorSelection.cursor(second.from + 1),
      EditorSelection.range(fourth.to, fourth.from),
    ]),
  }).state;
  assert.deepEqual(next.field(field).revealed, [
    { from: 1, to: 2 },
    { from: 3, to: 4 },
  ]);
  assert.ok(
    entries(next.field(field).decorations).some(
      (entry) => entry.decoration.spec.class === "cm-quote",
    ),
  );
  const all = next.update({
    selection: EditorSelection.range(state.doc.length, 0),
  }).state;
  assert.deepEqual(all.field(field).revealed, [{ from: 0, to: 4 }]);
  assert.equal(entries(all.field(field).decorations).length, 1);
  const restored = all.update({ selection: { anchor: 1 } }).state.field(field);
  assert.deepEqual(
    entries(restored.decorations),
    entries(original.decorations),
  );
  assert.equal(restored.candidates, original.candidates);
  assert.deepEqual(calls, { markdown: 1, math: 1 });
});

test("selection overlap changes touch only the symmetric difference and merge candidate spans", () => {
  const { state, field } = fixture("plain\n**a**\n**b**\n**c**\n**d**\nplain");
  const lines = [2, 3, 4, 5].map((line) => state.doc.line(line));
  const first = state.update({
    selection: EditorSelection.range(lines[0].from, lines[2].to),
  }).state;
  const overlap = first.update({
    selection: EditorSelection.range(lines[1].from, lines[3].to),
  }).state;
  assert.deepEqual(overlap.field(field).revealed, [{ from: 1, to: 4 }]);
  assert.equal(entries(overlap.field(field).decorations).length, 3);
  assert.ok(
    entries(overlap.field(field).decorations).every(
      (entry) => entry.from >= lines[0].from && entry.to <= lines[0].to,
    ),
  );
  const joined = overlap
    .update({
      selection: EditorSelection.create([
        EditorSelection.cursor(lines[0].from),
        EditorSelection.cursor(lines[1].from),
        EditorSelection.cursor(lines[3].from),
      ]),
    })
    .state.field(field);
  assert.deepEqual(joined.revealed, [
    { from: 0, to: 2 },
    { from: 3, to: 4 },
  ]);
  assert.equal(entries(joined.decorations).length, 3);
  assert.ok(
    entries(joined.decorations).every(
      (entry) => entry.from >= lines[2].from && entry.to <= lines[2].to,
    ),
  );
});

test("edits invalidate rendered candidates and respect automatically mapped selection and widget offsets", () => {
  const doc = "plain\n$x$ and [[Other]]\n```ts\nconst a = 1;\n```\nend";
  const { state, field, calls } = fixture(doc, doc.indexOf("$x$") + 1);
  const original = state.field(field);
  const inserted = "new line\n";
  const tr = state.update({ changes: { from: 0, insert: inserted } });
  const moved = tr.state.field(field);
  assert.notEqual(moved.candidates, original.candidates);
  assert.equal(
    tr.state.selection.main.head,
    state.selection.main.head + inserted.length,
  );
  assert.deepEqual(moved.revealed, original.revealed);
  for (const [index, candidate] of moved.candidates.entries()) {
    assert.equal(
      candidate.from,
      original.candidates[index].from + inserted.length,
    );
    for (const range of candidate.ranges) {
      const widget = range.value.spec.widget;
      if (widget) assert.equal(widget.sourceStart, range.from);
    }
  }
  assert.deepEqual(calls, { markdown: 4, math: 2 });

  const changed = tr.state.update({
    changes: {
      from: tr.state.selection.main.head,
      to: tr.state.selection.main.head + 1,
      insert: "z^2",
    },
    selection: { anchor: 0 },
  }).state;
  assert.ok(
    widgets(changed.field(field)).some((entry) =>
      entry.decoration.spec.widget.html.includes("z^2"),
    ),
  );
  const cleared = changed.update({
    changes: { from: 0, to: changed.doc.length, insert: "plain" },
  }).state;
  assert.equal(cleared.field(field).candidates.length, 0);
  assert.equal(cleared.field(field).decorations.size, 0);
  assert.ok(cleared.selection.main.head <= cleared.doc.length);
});

test("deleting a block delimiter rebuilds inline preview instead of mapping stale block widgets", () => {
  const doc = "plain\n```\n$x$\n```\nend";
  const { state, field } = fixture(doc);
  assert.equal(widgets(state.field(field))[0].decoration.spec.block, true);
  const next = state
    .update({
      changes: { from: doc.lastIndexOf("```"), to: doc.lastIndexOf("```") + 3 },
    })
    .state.field(field);
  assert.equal(widgets(next).length, 1);
  assert.notEqual(widgets(next)[0].decoration.spec.block, true);
  assert.equal(
    widgets(next)[0].decoration.spec.widget.sourceStart,
    doc.indexOf("$x$"),
  );
});

test("real renderers retain math, wiki links and source offsets after a selection round trip", () => {
  const field = previewField("notes/synthetic.md");
  const doc = "plain\n$x^2$ and [[Folder/Other|Alias]]\nend";
  const state = EditorState.create({ doc, extensions: [field] });
  const original = widgets(state.field(field));
  assert.match(original[0].decoration.spec.widget.html, /katex/);
  assert.match(original[1].decoration.spec.widget.html, /kb:Folder%2FOther/);
  const hidden = state.update({
    selection: { anchor: doc.indexOf("$x") },
  }).state;
  assert.equal(widgets(hidden.field(field)).length, 0);
  const restored = hidden.update({ selection: { anchor: doc.length } }).state;
  assert.deepEqual(widgets(restored.field(field)), original);
});

test("deterministic mixed selection transitions match independent full-range filtering", () => {
  const doc = [
    "plain",
    "# **Heading** and [[Link]]",
    "> **Quote** with $x$",
    "```ts",
    "const a = 1;",
    "```",
    "plain",
    "$$",
    "y^2",
    "$$",
    "plain",
    "| A | B |",
    "| --- | --- |",
    "| C | D |",
    "plain",
    "![[image.png]]",
    "plain",
  ].join("\n");
  const { state, field, calls } = fixture(doc);
  const original = state.field(field);
  const all = entries(original.decorations);
  const originalCalls = { ...calls };
  let current = state;
  let seed = 20261010;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 200; i++) {
    const ranges = Array.from({ length: 1 + (random() % 4) }, () => {
      const anchor = random() % (doc.length + 1);
      return EditorSelection.range(
        anchor,
        random() % 2 ? anchor : random() % (doc.length + 1),
      );
    });
    current = current.update({
      selection: EditorSelection.create(ranges),
    }).state;
    const hidden = new Set(
      original.candidates
        .filter((candidate) =>
          current.selection.ranges.some(
            (range) => range.from <= candidate.to && range.to >= candidate.from,
          ),
        )
        .flatMap((candidate) => candidate.ranges.map((range) => range.value)),
    );
    assert.deepEqual(
      entries(current.field(field).decorations),
      all.filter((entry) => !hidden.has(entry.decoration)),
      `transition ${i}`,
    );
    assert.equal(current.field(field).candidates, original.candidates);
  }
  assert.deepEqual(calls, originalCalls);
});
