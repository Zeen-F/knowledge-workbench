import {
  EditorState,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { localLinkTarget } from "../shared/note-links";
import { noteOutline } from "../shared/note-outline";
import { renderMarkdown, renderMath } from "./markdown";
import { noteColorStyle } from "../shared/note-colors";
import { noteInlineSpans } from "./note-color-editing";

export const finishPreviewPointerSelection = StateEffect.define<null>();

const previewPointerRelease = ViewPlugin.fromClass(
  class {
    private frame: number | undefined;

    constructor(private readonly view: EditorView) {}

    cancel() {
      if (this.frame === undefined) return;
      this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }

    finish() {
      this.cancel();
      // Wait until CodeMirror has processed the document's mouseup and the
      // browser has delivered click handlers for rendered links and widgets.
      this.frame =
        this.view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
          this.frame = undefined;
          this.view.dispatch({
            effects: finishPreviewPointerSelection.of(null),
          });
        });
    }

    destroy() {
      this.cancel();
    }
  },
  {
    eventObservers: {
      mousedown() {
        this.cancel();
      },
      mouseup(event) {
        if (event.button === 0) this.finish();
      },
      touchstart() {
        this.cancel();
      },
      touchend() {
        this.finish();
      },
    },
  },
);

export const locateNoteReference = StateEffect.define<number>();
export const noteReferenceLine = StateField.define<number | null>({
  create: () => null,
  update(line, tr) {
    const jump = tr.effects.find((effect) => effect.is(locateNoteReference));
    if (jump) return tr.state.doc.lineAt(jump.value).from;
    return tr.docChanged || tr.selection ? null : line;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (line) =>
      line === null
        ? Decoration.none
        : Decoration.set([
            Decoration.line({ class: "cm-child-reference" }).range(line),
          ]),
    ),
});

class Rendered extends WidgetType {
  constructor(
    readonly html: string,
    readonly sourceStart: number,
    readonly layout: "inline" | "block" | "image" = "inline",
  ) {
    super();
  }
  eq(other: Rendered) {
    return (
      other.html === this.html &&
      other.sourceStart === this.sourceStart &&
      other.layout === this.layout
    );
  }
  toDOM(view: EditorView) {
    const block = this.layout === "block";
    const node = view.dom.ownerDocument.createElement(block ? "div" : "span");
    node.className = block
      ? "md-rendered"
      : this.layout === "image"
        ? "md-rendered md-image"
        : "md-inline";
    node.innerHTML = block
      ? this.html
      : this.html.replace(/^<p>/, "").replace(/<\/p>\s*$/, "");
    node.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("a")) return;
      view.dispatch({ selection: { anchor: this.sourceStart } });
      view.focus();
    });
    return node;
  }
  ignoreEvent() {
    return false;
  }
}

type Candidate = {
  from: number;
  to: number;
  ranges: readonly Range<Decoration>[];
};
// Half-open indexes into the source-ordered candidate groups.
type CandidateSpan = { from: number; to: number };
type Preview = {
  candidates: readonly Candidate[];
  revealed: readonly CandidateSpan[];
  decorations: DecorationSet;
};
type Renderers = {
  markdown: typeof renderMarkdown;
  math: typeof renderMath;
};

function selectionSpans(
  candidates: readonly Candidate[],
  state: EditorState,
): CandidateSpan[] {
  const spans: CandidateSpan[] = [];
  const located = state.field(noteReferenceLine, false);
  for (const selection of state.selection.ranges) {
    if (
      located != null &&
      selection.empty &&
      state.doc.lineAt(selection.head).from === located
    )
      continue;
    let low = 0,
      high = candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (candidates[mid].to < selection.from) low = mid + 1;
      else high = mid;
    }
    const from = low;
    high = candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (candidates[mid].from <= selection.to) low = mid + 1;
      else high = mid;
    }
    if (from === low) continue;
    const previous = spans.at(-1);
    if (previous && previous.to >= from) previous.to = low;
    else spans.push({ from, to: low });
  }
  return spans;
}

// Subtract sorted spans without walking candidates in their unchanged overlap.
function subtract(
  spans: readonly CandidateSpan[],
  excluded: readonly CandidateSpan[],
): CandidateSpan[] {
  const result: CandidateSpan[] = [];
  let index = 0;
  for (const span of spans) {
    let from = span.from;
    while (index < excluded.length && excluded[index].to <= from) index++;
    for (
      let i = index;
      i < excluded.length && excluded[i].from < span.to;
      i++
    ) {
      if (excluded[i].from > from) result.push({ from, to: excluded[i].from });
      from = Math.max(from, excluded[i].to);
      if (from >= span.to) break;
    }
    if (from < span.to) result.push({ from, to: span.to });
  }
  return result;
}

function revealSelection(value: Preview, state: EditorState): Preview {
  const revealed = selectionSpans(value.candidates, state);
  const hide = subtract(revealed, value.revealed);
  const show = subtract(value.revealed, revealed);
  if (!hide.length && !show.length) return value;

  let decorations = value.decorations;
  for (const span of hide) {
    const removed = new Set<Decoration>();
    for (let i = span.from; i < span.to; i++)
      for (const range of value.candidates[i].ranges) removed.add(range.value);
    // Limit filtering to newly revealed source. A jump across a long document
    // must not scan every decoration between the previous and current cursor.
    decorations = decorations.update({
      filterFrom: value.candidates[span.from].from,
      filterTo: value.candidates[span.to - 1].to,
      filter: (_from, _to, decoration) => !removed.has(decoration),
    });
  }
  const add: Range<Decoration>[] = [];
  for (const span of show)
    for (let i = span.from; i < span.to; i++)
      add.push(...value.candidates[i].ranges);
  if (add.length) decorations = decorations.update({ add, sort: true });
  return { ...value, revealed, decorations };
}

/** Cache document-derived widgets; selection transactions only reveal groups. */
export function previewField(
  file: string,
  renderers: Renderers = { markdown: renderMarkdown, math: renderMath },
) {
  const create = (state: EditorState): Preview => {
    const content = state.doc.toString(),
      ranges: Range<Decoration>[] = [],
      candidates: Candidate[] = [],
      occupied: { from: number; to: number }[] = [];
    const taken = (from: number, to: number) =>
      occupied.some((r) => r.from <= to && r.to >= from);
    const block = (from: number, to: number, html: string) => {
      occupied.push({ from, to });
      candidates.push({
        from,
        to,
        ranges: [
          Decoration.replace({
            widget: new Rendered(html, from, "block"),
            block: true,
          }).range(from, to),
        ],
      });
    };
    const fm = content.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/);
    if (fm)
      block(
        0,
        fm[0].length,
        '<div class="properties-fold">◇ 笔记属性 <span>双击编辑</span></div>',
      );
    for (const match of content.matchAll(
      /^(```+|~~~+)[^\n]*\n[\s\S]*?^\1\s*$/gm,
    )) {
      const from = match.index!,
        to = from + match[0].length;
      if (!taken(from, to)) block(from, to, renderers.markdown(match[0], file));
    }
    for (const match of content.matchAll(
      /^[ \t]*(\$\$|\\\[)[ \t]*\n([\s\S]*?)\n[ \t]*(\$\$|\\\])[ \t]*$/gm,
    )) {
      const from = match.index!,
        to = from + match[0].length;
      if ((match[1] === "$$") === (match[3] === "$$") && !taken(from, to))
        block(from, to, renderers.math(match[2], true));
    }
    const outline = content.includes("[TOC]")
      ? noteOutline(content).filter((heading) => heading.level > 1)
      : [];
    const formattedText = noteInlineSpans(content);
    let formatIndex = 0;
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (taken(line.from, line.to)) continue;
      const displayMath = line.text.match(
        /^\s*(?:\$\$(.+?)\$\$|\\\[(.+?)\\\])\s*$/,
      );
      if (displayMath) {
        block(
          line.from,
          line.to,
          renderers.math(displayMath[1] || displayMath[2], true),
        );
        continue;
      }
      if (line.text.trim() === "[TOC]" && outline.length) {
        const entries = outline.map(({ title, level, offset }) => {
          const safe = title
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          return (
            '<li style="padding-inline-start:' +
            (level - 2) * 13 +
            'px"><a href="#heading-' +
            offset +
            '" data-note-heading="' +
            offset +
            '">' +
            safe +
            "</a></li>"
          );
        });
        block(
          line.from,
          line.to,
          '<nav class="note-toc" aria-label="笔记目录"><strong>目录</strong><ol>' +
            entries.join("") +
            "</ol></nav>",
        );
        continue;
      }
      if (
        i < state.doc.lines &&
        line.text.includes("|") &&
        /^\s*\|?\s*:?-{3,}/.test(state.doc.line(i + 1).text)
      ) {
        let end = i + 1;
        while (
          end < state.doc.lines &&
          state.doc.line(end + 1).text.includes("|") &&
          state.doc.line(end + 1).text.trim()
        )
          end++;
        const last = state.doc.line(end);
        block(
          line.from,
          last.to,
          renderers.markdown(state.doc.sliceString(line.from, last.to), file),
        );
        i = end;
        continue;
      }
      if (
        /^\s*!\[.*\]\(.*\)\s*$/.test(line.text) ||
        /^\s*!\[\[.+\]\]\s*$/.test(line.text)
      ) {
        // Keep the CodeMirror line around the image. A block replacement
        // adjacent to an empty line can split Chromium's IME composition.
        const widget = new Rendered(
          renderers.markdown(line.text, file),
          line.from,
          "image",
        );
        candidates.push({
          from: line.from,
          to: line.to,
          ranges: [Decoration.replace({ widget }).range(line.from, line.to)],
        });
        continue;
      }
      const inline: Range<Decoration>[] = [];
      while (
        formatIndex < formattedText.length &&
        formattedText[formatIndex].open.from < line.from
      )
        formatIndex++;
      while (
        formatIndex < formattedText.length &&
        formattedText[formatIndex].close.to <= line.to
      ) {
        const { open, close } = formattedText[formatIndex++];
        const { color, element } = open;
        if (open.to < close.from) {
          ranges.push(
            Decoration.mark({
              tagName: element,
              ...(color
                ? {
                    class: "note-inline-color",
                    attributes: { style: noteColorStyle(color) },
                  }
                : {}),
            }).range(open.to, close.from),
          );
        }
        inline.push(Decoration.replace({}).range(open.from, open.to));
        inline.push(Decoration.replace({}).range(close.from, close.to));
      }
      const noteLinks: { from: number; to: number }[] = [];
      if (line.text.includes("]("))
        markdownLanguage.parser.parse(line.text).iterate({
          enter(node) {
            if (node.name !== "Link") return;
            const url = node.node.getChild("URL");
            if (!url) return false;
            const target = line.text
              .slice(url.from, url.to)
              .replace(/^<|>$/g, "");
            if (
              !/^child-note:[a-z0-9][a-z0-9-]{0,39}$/.test(target) &&
              (!/\.md(?:#.*)?$/i.test(target) ||
                !localLinkTarget(target, file, "markdown"))
            )
              return false;
            const from = line.from + node.from;
            const to = line.from + node.to;
            const html = renderers.markdown(
              line.text.slice(node.from, node.to),
              file,
            );
            noteLinks.push({ from, to });
            inline.push(
              Decoration.replace({ widget: new Rendered(html, from) }).range(
                from,
                to,
              ),
            );
            return false;
          },
        });
      const overlapsLink = (from: number, to: number) =>
        noteLinks.some((link) => link.from < to && from < link.to);
      const heading = line.text.match(/^(#{1,6})\s+/);
      if (heading) {
        ranges.push(
          Decoration.line({
            class: `cm-heading cm-h${heading[1].length}`,
          }).range(line.from),
        );
        inline.push(
          Decoration.replace({}).range(
            line.from,
            line.from + heading[0].length,
          ),
        );
      }
      if (/^>\s/.test(line.text))
        ranges.push(Decoration.line({ class: "cm-quote" }).range(line.from));
      for (const m of line.text.matchAll(
        /(?<!\$)\$([^$\n]+)\$(?!\$)|\\\((.+?)\\\)/g,
      )) {
        const from = line.from + m.index!;
        if (overlapsLink(from, from + m[0].length)) continue;
        inline.push(
          Decoration.replace({
            widget: new Rendered(renderers.math(m[1] || m[2], false), from),
          }).range(from, from + m[0].length),
        );
      }
      for (const m of line.text.matchAll(/\*\*([^*]+)\*\*/g)) {
        const from = line.from + m.index!;
        if (overlapsLink(from, from + m[0].length)) continue;
        inline.push(
          Decoration.replace({}).range(from, from + 2),
          Decoration.mark({ class: "cm-strong" }).range(
            from + 2,
            from + m[0].length - 2,
          ),
          Decoration.replace({}).range(
            from + m[0].length - 2,
            from + m[0].length,
          ),
        );
      }
      for (const m of line.text.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)) {
        const from = line.from + m.index!;
        if (overlapsLink(from, from + m[0].length)) continue;
        inline.push(
          Decoration.replace({
            widget: new Rendered(renderers.markdown(m[0], file), from),
          }).range(from, from + m[0].length),
        );
      }
      if (inline.length)
        candidates.push({ from: line.from, to: line.to, ranges: inline });
    }
    candidates.sort((a, b) => a.from - b.from);
    const revealed = selectionSpans(candidates, state);
    let active = 0;
    for (let i = 0; i < candidates.length; i++) {
      while (active < revealed.length && revealed[active].to <= i) active++;
      if (active === revealed.length || revealed[active].from > i)
        ranges.push(...candidates[i].ranges);
    }
    return { candidates, revealed, decorations: Decoration.set(ranges, true) };
  };
  return StateField.define<Preview>({
    create,
    update: (value, tr) => {
      // Reparse after edits so block boundaries, widget offsets and mapped
      // selections always refer to the new document, never stale coordinates.
      if (tr.docChanged) return create(tr.state);
      // Coordinate hit testing must see the same line layout from the press
      // through the last drag event. A range stays in preview after release.
      if (tr.isUserEvent("select.pointer")) return value;
      if (tr.effects.some((effect) => effect.is(finishPreviewPointerSelection)))
        return tr.state.selection.ranges.every((range) => range.empty)
          ? revealSelection(value, tr.state)
          : value;
      if (
        tr.startState.selection.eq(tr.state.selection) &&
        tr.startState.field(noteReferenceLine, false) ===
          tr.state.field(noteReferenceLine, false)
      )
        return value;
      return revealSelection(value, tr.state);
    },
    // Block replacements affect vertical layout and must be directly provided.
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      previewPointerRelease,
    ],
  });
}
