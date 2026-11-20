import test from "node:test";
import assert from "node:assert/strict";
import {
  EditorSelection,
  EditorState,
  StateEffect,
  type StateField,
} from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  finishPreviewPointerSelection,
  previewField,
} from "../src/editor-preview.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { editNoteColor, noteInlineSpans } from "../src/note-color-editing.ts";
import { noteOutline } from "../shared/note-outline.ts";
import { noteTitle } from "../server/markdown.ts";

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

test("note colors render in Markdown while keeping bold, math, and regular HTML handling", () => {
  const source = [
    "**<span style='color: #A43F34;'>关键条件</span>**",
    "",
    "| 符号 | 说明 |",
    "| --- | --- |",
    '| $V_{BE}$ | <span style="color: #123">参考定义</span> |',
    "",
    '<span style="color: #a43f34; background: url(unsafe)">字面内容</span>',
    "",
    '`<span style="color: #a43f34">样例</span>`',
    "",
    '所以<strong style="color: var(--color-orange, #B56A28)">正确符号和 $V_{OS}$</strong>，再验证。',
    '<span style="color: #2a5f9a">**蓝色结论**</span>',
    '<strong style="color: var(--color-orange, orange)">未知色值</strong>',
  ].join("\n");
  const html = renderMarkdown(source, "synthetic.md", { inertLinks: true });
  assert.match(
    html,
    /<strong><span class="note-inline-color"[^>]+>关键条件<\/span><\/strong>/,
  );
  assert.match(
    html,
    /<td><span class="note-inline-color" style="--note-color:#112233">参考定义<\/span><\/td>/,
  );
  assert.match(html, /class="katex"/);
  assert.match(html, /&lt;span[^\n]+background: url\(unsafe\)/);
  assert.match(html, /<code>&lt;span/);
  assert.match(
    html,
    /所以<strong class="note-inline-color" style="--note-color:#b56a28">正确符号和 <span class="katex">/,
  );
  assert.match(
    html,
    /note-inline-color"[^>]+><strong>蓝色结论<\/strong><\/span>/,
  );
  assert.match(html, /&lt;strong[^\n]+未知色值&lt;\/strong&gt;/);
  assert.equal([...html.matchAll(/class="note-inline-color"/g)].length, 4);
});

test("the live editor marks only the formatted text and keeps navigation labels plain", () => {
  const colored = '<span style="color: #2a5f9a">假设</span>';
  const bold =
    '<strong style="color: var(--color-orange, #B56A28)">新结论</strong>';
  const doc = "前文\n## " + colored + "\n## " + bold + "\n`" + colored + "`";
  const { state, field } = fixture(doc);
  const marks = entries(state.field(field).decorations).filter(
    (entry) => entry.decoration.spec.class === "note-inline-color",
  );
  assert.equal(marks.length, 2);
  assert.equal(doc.slice(marks[0].from, marks[0].to), "假设");
  assert.match(marks[0].decoration.spec.attributes.style, /#2a5f9a/);
  assert.equal(doc.slice(marks[1].from, marks[1].to), "新结论");
  assert.equal(marks[1].decoration.spec.tagName, "strong");
  assert.match(marks[1].decoration.spec.attributes.style, /#b56a28/);
  assert.equal(noteOutline(doc)[0].title, "假设");
  assert.equal(noteOutline(doc)[1].title, "新结论");
  assert.equal(noteTitle("# " + colored, {}, "synthetic.md"), "假设");
  assert.equal(noteTitle("# " + bold, {}, "synthetic.md"), "新结论");
});

test("changing part of a colored phrase keeps the surrounding colors and tolerates resetting it", () => {
  const source = '<span style="color: #a43f34">前中后</span>';
  const from = source.indexOf("中");
  const state = EditorState.create({
    doc: source,
    selection: { anchor: from, head: from + 1 },
  });
  const blue = state.update(editNoteColor(state, "#2a5f9a")!).state;
  assert.deepEqual(
    noteInlineSpans(blue.doc.toString()).map(({ open }) => open.color),
    ["#a43f34", "#2a5f9a", "#a43f34"],
  );
  const reset = blue.update(editNoteColor(blue, null)!).state.doc.toString();
  assert.equal(
    reset,
    '<span style="color: #a43f34">前</span>中<span style="color: #a43f34">后</span>',
  );
});

test("recoloring part of an HTML strong phrase preserves its emphasis and adjacent colors", () => {
  const source =
    '所以<strong style="color: var(--color-orange, #B56A28)">前中后</strong>。';
  const from = source.indexOf("中");
  const state = EditorState.create({
    doc: source,
    selection: { anchor: from, head: from + 1 },
  });
  const blue = state.update(editNoteColor(state, "#2a5f9a")!).state;
  assert.equal(
    blue.doc.toString(),
    '所以<strong><span style="color: #b56a28">前</span><span style="color: #2a5f9a">中</span><span style="color: #b56a28">后</span></strong>。',
  );
  const reset = blue.update(editNoteColor(blue, null)!).state.doc.toString();
  assert.equal(
    reset,
    '所以<strong><span style="color: #b56a28">前</span>中<span style="color: #b56a28">后</span></strong>。',
  );
});

test("applying a color leaves heading and list syntax, formulas, and code intact", () => {
  const source = "## 读**结论**接下文\n- 使用 $x^2$ 与 `const`\n\n$$x^2$$";
  const state = EditorState.create({
    doc: source,
    selection: { anchor: 0, head: source.length },
  });
  const changed = state
    .update(editNoteColor(state, "#2c6b50")!)
    .state.doc.toString();
  assert.match(changed, /^## <span /);
  assert.match(changed, /\n- <span /);
  assert.match(changed, /\$x\^2\$/);
  assert.match(changed, /\n\$\$x\^2\$\$$/);
  const html = renderMarkdown(changed, "synthetic.md");
  assert.match(html, /<strong>结论<\/strong>/);
  assert.match(html, /<code>const<\/code>/);
  assert.match(html, /katex-display/);
});

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
  assert.ok(
    widgets(original)
      .slice(0, -1)
      .every((entry) => entry.decoration.spec.block),
  );
  const image = widgets(original).at(-1)!;
  assert.equal(image.decoration.spec.widget.layout, "image");
  assert.ok(!image.decoration.spec.block);

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

test("mouse selection keeps the rendered layout until the user finishes with a caret", () => {
  const { state, field, calls } = fixture(
    '前文\n正文 <span style="color: #a43f34">颜色</span> **加粗**\n$x^2$\n末尾',
  );
  const original = state.field(field);
  const anchor = state.doc.toString().indexOf("颜色");
  const pressed = state.update({
    selection: { anchor },
    userEvent: "select.pointer",
  }).state;
  assert.equal(pressed.field(field), original);
  const dragging = pressed.update({
    selection: { anchor, head: state.doc.line(3).to },
    userEvent: "select.pointer",
  }).state;
  assert.equal(dragging.field(field), original);
  const released = dragging.update({
    effects: finishPreviewPointerSelection.of(null),
  }).state;
  assert.equal(released.field(field), original);

  const caret = released.update({
    selection: { anchor },
    userEvent: "select.pointer",
  }).state;
  assert.equal(caret.field(field), original);
  const clicked = caret
    .update({
      effects: finishPreviewPointerSelection.of(null),
    })
    .state.field(field);
  assert.deepEqual(clicked.revealed, [{ from: 0, to: 1 }]);
  assert.equal(clicked.candidates, original.candidates);
  assert.deepEqual(calls, { markdown: 0, math: 1 });
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
