import { EditorState, StateField, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { renderMarkdown, renderMath } from "./markdown";

class Rendered extends WidgetType {
  constructor(
    readonly html: string,
    readonly sourceStart: number,
    readonly block = false,
  ) {
    super();
  }
  eq(other: Rendered) {
    return (
      other.html === this.html &&
      other.sourceStart === this.sourceStart &&
      other.block === this.block
    );
  }
  toDOM(view: EditorView) {
    const node = document.createElement(this.block ? "div" : "span");
    node.className = this.block ? "md-rendered" : "md-inline";
    node.innerHTML = this.block
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
  for (const selection of state.selection.ranges) {
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
            widget: new Rendered(html, from, true),
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
    for (const match of content.matchAll(/^\$\$\s*\n([\s\S]*?)\n\$\$\s*$/gm)) {
      const from = match.index!,
        to = from + match[0].length;
      if (!taken(from, to)) block(from, to, renderers.math(match[1], true));
    }
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (taken(line.from, line.to)) continue;
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
        block(line.from, line.to, renderers.markdown(line.text, file));
        continue;
      }
      const inline: Range<Decoration>[] = [];
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
      for (const m of line.text.matchAll(/(?<!\$)\$([^$\n]+)\$(?!\$)/g)) {
        const from = line.from + m.index!;
        inline.push(
          Decoration.replace({
            widget: new Rendered(renderers.math(m[1], false), from),
          }).range(from, from + m[0].length),
        );
      }
      for (const m of line.text.matchAll(/\*\*([^*]+)\*\*/g)) {
        const from = line.from + m.index!;
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
      if (!tr.selection || tr.startState.selection.eq(tr.state.selection))
        return value;
      return revealSelection(value, tr.state);
    },
    // Block replacements affect vertical layout and must be directly provided.
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
}
