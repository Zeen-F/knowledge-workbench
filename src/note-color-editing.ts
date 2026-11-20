import { markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import {
  noteColorClosing,
  noteColorOpening,
  noteInlineTag,
  pairNoteInlineTags,
  type NoteColor,
  type NoteInlineSpan,
  type NoteInlineTag,
} from "../shared/note-colors";
import { markdownBodyStart } from "../shared/markdown-links";

export function noteInlineSpans(source: string, tree?: Tree) {
  if (!/<\/(?:span|strong)\b/i.test(source)) return [];
  const tags: NoteInlineTag[] = [];
  (tree ?? markdownLanguage.parser.parse(source)).iterate({
    enter(node) {
      if (node.name !== "HTMLTag") return;
      const tag = noteInlineTag(source, node.from, node.to);
      if (tag?.to === node.to) tags.push(tag);
      return false;
    },
  });
  return pairNoteInlineTags(source, tags);
}

type Range = { from: number; to: number };
type ProtectedRange = Range & { bare?: boolean };
const bareMarks = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "EmphasisMark",
  "TableDelimiter",
  "HorizontalRule",
]);
const structureMarks = new Set(
  [...bareMarks].filter((name) => name !== "EmphasisMark"),
);
const preserveSyntax = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "Link",
  "Image",
  "Autolink",
  "LinkReference",
  "URL",
  "Escape",
  ...bareMarks,
]);

function changeLineColor(
  source: string,
  selected: Range,
  color: NoteColor | null,
  spans: NoteInlineSpan[],
  syntax: ProtectedRange[],
) {
  const from = Math.min(selected.from, ...spans.map((span) => span.open.from));
  const to = Math.max(selected.to, ...spans.map((span) => span.close.to));
  const tags = spans.flatMap((span) => [span.open, span.close]);
  const boundaries = [
    ...new Set([
      from,
      to,
      selected.from,
      selected.to,
      ...tags.flatMap((tag) => [tag.from, tag.to]),
      ...syntax.flatMap((range) => [
        Math.max(from, range.from),
        Math.min(to, range.to),
      ]),
    ]),
  ].sort((a, b) => a - b);
  let insert = "";
  let currentColor: string | null = null;
  let currentStrong = false;
  let start: number | undefined;
  let end = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const left = boundaries[i],
      right = boundaries[i + 1];
    if (tags.some((tag) => tag.from <= left && right <= tag.to)) continue;
    const part = source.slice(left, right);
    const protectedPart = syntax.find(
      (range) => range.from < right && range.to > left,
    );
    const selectedText =
      selected.from <= left && right <= selected.to && !protectedPart;
    const formats = spans.filter(
      (span) => span.open.to <= left && right <= span.close.from,
    );
    const original =
      formats.findLast(({ open }) => open.color)?.open.color ?? null;
    const strong = formats.some(({ open }) => open.element === "strong");
    const desired = protectedPart?.bare
      ? null
      : selectedText
        ? color
        : original;
    if (desired !== currentColor || strong !== currentStrong) {
      if (currentColor) insert += noteColorClosing;
      if (strong !== currentStrong) insert += strong ? "<strong>" : "</strong>";
      currentStrong = strong;
      currentColor = desired;
      if (currentColor) insert += noteColorOpening(currentColor);
    }
    if (selectedText && part.trim()) start ??= insert.length;
    insert += part;
    if (selectedText && part.trim()) end = insert.length;
  }
  if (currentColor) insert += noteColorClosing;
  if (currentStrong) insert += "</strong>";
  if (start === undefined) return;
  return { change: { from, to, insert }, start, end };
}

export function editNoteColor(state: EditorState, color: NoteColor | null) {
  const source = state.doc.toString();
  const tree = markdownLanguage.parser.parse(source);
  const spans = noteInlineSpans(source, tree);
  let { from, to } = state.selection.main;
  if (from === to) {
    const span = spans.findLast(
      (span) =>
        span.open.color && span.open.to <= from && from <= span.close.from,
    );
    if (!span) return;
    from = span.open.to;
    to = span.close.from;
  }
  // A color tag inside the delimiter of an emphasis run can change how
  // Markdown treats adjacent punctuation. Keep a formatted phrase together.
  const styledPhrases: Range[] = [];
  tree.iterate({
    enter(node) {
      if (preserveSyntax.has(node.name)) return false;
      if (
        (node.name === "StrongEmphasis" || node.name === "Emphasis") &&
        from < node.to &&
        node.from < to &&
        !source.slice(node.from, node.to).includes("\n")
      ) {
        styledPhrases.push({ from: node.from, to: node.to });
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
        return false;
      }
    },
  });
  const protectedRanges: ProtectedRange[] = [];
  tree.iterate({
    enter(node) {
      if (preserveSyntax.has(node.name)) {
        if (
          node.name === "EmphasisMark" &&
          styledPhrases.some(
            (phrase) => phrase.from <= node.from && node.to <= phrase.to,
          )
        )
          return false;
        let { from, to } = node;
        if (structureMarks.has(node.name)) {
          while (from > 0 && /[ \t]/.test(source[from - 1])) from--;
          while (to < source.length && /[ \t]/.test(source[to])) to++;
        }
        protectedRanges.push({
          from,
          to,
          bare: bareMarks.has(node.name),
        });
        return false;
      }
    },
  });
  for (const expression of [
    /\$\$[^$\n]+\$\$|\\\[[^\n]+?\\\]/g,
    /(?<!\$)\$[^$\n]+\$(?!\$)|\\\([^\n]+?\\\)/g,
    /^[ \t]*(\$\$|\\\[)[ \t]*\n[\s\S]*?\n[ \t]*(\$\$|\\\])[ \t]*$/gm,
    /!?\[\[[^\n\]]+\]\]/g,
  ]) {
    for (const match of source.matchAll(expression))
      protectedRanges.push({
        from: match.index!,
        to: match.index! + match[0].length,
      });
  }
  const bodyStart = markdownBodyStart(source);
  const edits: NonNullable<ReturnType<typeof changeLineColor>>[] = [];
  let spanIndex = 0;
  for (
    let n = state.doc.lineAt(from).number;
    n <= state.doc.lineAt(to).number;
    n++
  ) {
    const line = state.doc.line(n);
    if (line.text.trim() === "[TOC]" || line.to <= bodyStart) continue;
    const startAt = Math.max(from, line.from, bodyStart);
    const selected = source.slice(startAt, Math.min(to, line.to));
    const trimmed = selected.trim();
    if (!trimmed) continue;
    const start = startAt + selected.length - selected.trimStart().length;
    const end = start + trimmed.length;
    while (spanIndex < spans.length && spans[spanIndex].open.from < line.from)
      spanIndex++;
    const relevant: NoteInlineSpan[] = [];
    while (spanIndex < spans.length && spans[spanIndex].open.from < line.to) {
      const span = spans[spanIndex++];
      if (span.open.from < end && start < span.close.to) relevant.push(span);
    }
    const patchStart = Math.min(
      start,
      ...relevant.map((span) => span.open.from),
    );
    const patchEnd = Math.max(end, ...relevant.map((span) => span.close.to));
    const syntax = protectedRanges.filter(
      (range) => range.from < patchEnd && range.to > patchStart,
    );
    const edit = changeLineColor(
      source,
      { from: start, to: end },
      color,
      relevant,
      syntax,
    );
    if (edit) edits.push(edit);
  }
  if (!edits.length) return;
  const changes = state.changes(
    edits
      .map((edit) => edit.change)
      .filter(
        (change) => source.slice(change.from, change.to) !== change.insert,
      ),
  );
  const first = edits[0],
    last = edits[edits.length - 1];
  return {
    changes,
    selection: {
      anchor: changes.mapPos(first.change.from, -1) + first.start,
      head: changes.mapPos(last.change.from, -1) + last.end,
    },
  };
}
