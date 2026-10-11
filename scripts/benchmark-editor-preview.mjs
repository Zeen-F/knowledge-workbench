// Run: node --import tsx scripts/benchmark-editor-preview.mjs [sections] [samples]
// Measures only CodeMirror state updates, not DOM layout, painting or typing UX.
// Both versions use the same current renderers to isolate preview-field work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorState, StateEffect } from "@codemirror/state";
import { previewField } from "../src/editor-preview.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const baseline = "baaa9ad";
const sections = Number(process.argv[2] || 300);
const samples = Number(process.argv[3] || 40);
if (
  !Number.isInteger(sections) ||
  sections < 2 ||
  !Number.isInteger(samples) ||
  samples < 5
)
  throw new Error("sections must be >= 2 and samples >= 5 (integers)");
const doc = [
  "Synthetic benchmark",
  ...Array.from({ length: sections }, (_, i) =>
    [
      `# Section ${i}`,
      `A **claim ${i}** links to [[Concept-${i}]] with $x_${i}^2 + y_${i}^2$.`,
      "Plain text to exercise selection changes without rendering.",
      "```ts",
      `const value${i} = ${i};`,
      "```",
      "Another plain paragraph.",
      "",
    ].join("\n"),
  ),
].join("\n");
const effects = StateEffect.define();
const warmup = 5;

function snapshot(state, field) {
  const value = state.field(field);
  const decorations = value.decorations || value;
  const result = [];
  for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec;
    result.push({
      from: cursor.from,
      to: cursor.to,
      class: spec.class,
      block: spec.block,
      widget: spec.widget && {
        html: spec.widget.html,
        sourceStart: spec.widget.sourceStart,
        block: spec.widget.block,
      },
    });
  }
  return result;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(4)),
    p95Ms: Number(
      sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
      ].toFixed(4),
    ),
    totalMs: Number(values.reduce((a, b) => a + b, 0).toFixed(3)),
  };
}

const scenarios = {
  unrelatedEffect: () => ({ effects: effects.of(1) }),
  sameLineCursor: (state, i) => ({
    selection: { anchor: state.doc.line(3).from + (i % 15) },
  }),
  distantCursor: (state, i) => ({
    selection: {
      anchor: state.doc.line(3 + ((i * 97) % sections) * 8).from + 2,
    },
  }),
  documentEdit: (_state, i) => ({
    changes: { from: 0, to: 1, insert: i % 2 ? "S" : "s" },
  }),
};

function run(makeField, scenario, count) {
  const field = makeField("synthetic/benchmark.md");
  const start = performance.now();
  let state = EditorState.create({ doc, extensions: [field] });
  const initializationMs = performance.now() - start;
  const values = [];
  for (let i = 0; i < count + warmup; i++) {
    const spec = scenario(state, i);
    const before = performance.now();
    state = state.update(spec).state;
    const duration = performance.now() - before;
    if (i >= warmup) values.push(duration);
  }
  return {
    stats: stats(values),
    initializationMs,
    snapshot: snapshot(state, field),
  };
}

await fs.mkdir(path.join(root, ".local"), { recursive: true });
const temp = await fs.mkdtemp(
  path.join(root, ".local/editor-preview-benchmark-"),
);
try {
  const source = execFileSync("git", ["show", `${baseline}:src/Editor.tsx`], {
    cwd: root,
    encoding: "utf8",
  });
  const start = source.indexOf("class Rendered extends WidgetType");
  const end = source.indexOf("\nexport const Editor", start);
  assert.ok(
    start >= 0 && end > start,
    "baseline preview extraction must match",
  );
  const oldModule = path.join(temp, "baseline.ts");
  await fs.writeFile(
    oldModule,
    [
      'import {EditorState, StateField} from "@codemirror/state";',
      'import {Decoration, EditorView, WidgetType, type DecorationSet} from "@codemirror/view";',
      `import {renderMarkdown, renderMath} from ${JSON.stringify(pathToFileURL(path.join(root, "src/markdown.ts")).href)};`,
      source
        .slice(start, end)
        .replace(
          "function previewField(file: string)",
          "export function previewField(file: string)",
        ),
    ].join("\n"),
  );
  const old = await import(pathToFileURL(oldModule).href);
  const results = {};
  for (const [name, scenario] of Object.entries(scenarios)) {
    const count =
      name === "documentEdit" ? Math.max(5, Math.floor(samples / 4)) : samples;
    const before = run(old.previewField, scenario, count);
    const after = run(previewField, scenario, count);
    assert.deepEqual(
      after.snapshot,
      before.snapshot,
      `${name}: final preview differs from baseline`,
    );
    results[name] = {
      samples: count,
      baseline: before.stats,
      optimized: after.stats,
      initialBuildMs: {
        baseline: Number(before.initializationMs.toFixed(3)),
        optimized: Number(after.initializationMs.toFixed(3)),
      },
      equivalentFinalDecorations: true,
    };
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        baseline,
        sections,
        lines: doc.split("\n").length,
        characters: doc.length,
        warmupUpdatesPerScenario: warmup,
        measurement:
          "Synthetic state-field updates only; no browser DOM/layout/paint. Current renderers shared by baseline and optimized field. Edits intentionally rebuild.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
