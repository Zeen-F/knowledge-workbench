import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  historyField,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { renderMarkdown, renderMath } from "./markdown";
const defaultHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--ink)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  {
    tag: [tags.link, tags.url],
    color: "var(--accent)",
    textDecoration: "underline",
  },
  { tag: tags.comment, color: "var(--muted)" },
  { tag: [tags.keyword, tags.string], color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "Consolas, monospace" },
]);

export type EditorHandle = {
  insert: (value: string) => void;
  wrap: (before: string, after: string) => void;
  focus: () => void;
  getText: () => string;
  goTo: (offset: number) => void;
};
type Props = {
  content: string;
  path: string;
  source: boolean;
  onChange: (content: string) => void;
  onImages?: (files: File[]) => Promise<string>;
  onLink?: (target: string) => void;
  readOnly?: boolean;
};

const retained = new Map<string, { content: string; json: any }>();

class Rendered extends WidgetType {
  constructor(
    readonly html: string,
    readonly sourceStart: number,
    readonly block = false,
  ) {
    super();
  }
  eq(other: Rendered) {
    return other.html === this.html && other.sourceStart === this.sourceStart;
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

function previewField(file: string) {
  const create = (state: EditorState) => {
    const content = state.doc.toString(),
      ranges: any[] = [],
      occupied: { from: number; to: number }[] = [];
    const active = (from: number, to: number) =>
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    const taken = (from: number, to: number) =>
      occupied.some((r) => r.from <= to && r.to >= from);
    const block = (from: number, to: number, html: string) => {
      occupied.push({ from, to });
      if (!active(from, to))
        ranges.push(
          Decoration.replace({
            widget: new Rendered(html, from, true),
            block: true,
          }).range(from, to),
        );
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
      if (!taken(from, to)) block(from, to, renderMarkdown(match[0], file));
    }
    for (const match of content.matchAll(/^\$\$\s*\n([\s\S]*?)\n\$\$\s*$/gm)) {
      const from = match.index!,
        to = from + match[0].length;
      if (!taken(from, to)) block(from, to, renderMath(match[1], true));
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
          renderMarkdown(state.doc.sliceString(line.from, last.to), file),
        );
        i = end;
        continue;
      }
      if (
        /^\s*!\[.*\]\(.*\)\s*$/.test(line.text) ||
        /^\s*!\[\[.+\]\]\s*$/.test(line.text)
      ) {
        block(line.from, line.to, renderMarkdown(line.text, file));
        continue;
      }
      const heading = line.text.match(/^(#{1,6})\s+/);
      if (heading) {
        ranges.push(
          Decoration.line({
            class: `cm-heading cm-h${heading[1].length}`,
          }).range(line.from),
        );
        if (!active(line.from, line.to))
          ranges.push(
            Decoration.replace({}).range(
              line.from,
              line.from + heading[0].length,
            ),
          );
      }
      if (/^>\s/.test(line.text))
        ranges.push(Decoration.line({ class: "cm-quote" }).range(line.from));
      if (active(line.from, line.to)) continue;
      for (const m of line.text.matchAll(/(?<!\$)\$([^$\n]+)\$(?!\$)/g)) {
        const from = line.from + m.index!;
        ranges.push(
          Decoration.replace({
            widget: new Rendered(renderMath(m[1], false), from),
          }).range(from, from + m[0].length),
        );
      }
      for (const m of line.text.matchAll(/\*\*([^*]+)\*\*/g)) {
        const from = line.from + m.index!;
        ranges.push(
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
        ranges.push(
          Decoration.replace({
            widget: new Rendered(renderMarkdown(m[0], file), from),
          }).range(from, from + m[0].length),
        );
      }
    }
    return Decoration.set(ranges, true);
  };
  return StateField.define<DecorationSet>({
    create,
    update: (_value, tr) => create(tr.state),
    provide: (f) => EditorView.decorations.from(f),
  });
}

export const Editor = forwardRef<EditorHandle, Props>(
  function Editor(props, ref) {
    const mount = useRef<HTMLDivElement>(null),
      view = useRef<EditorView | null>(null),
      current = useRef(props),
      mode = useRef(new Compartment());
    current.current = props;
    useImperativeHandle(
      ref,
      () => ({
        insert(value) {
          const v = view.current;
          if (!v) return;
          v.dispatch(v.state.replaceSelection(value));
          v.focus();
        },
        wrap(before, after) {
          const v = view.current;
          if (!v) return;
          const { from, to } = v.state.selection.main;
          const text = v.state.sliceDoc(from, to);
          v.dispatch({
            changes: { from, to, insert: before + text + after },
            selection: {
              anchor: from + before.length,
              head: from + before.length + text.length,
            },
          });
          v.focus();
        },
        focus() {
          view.current?.focus();
        },
        getText() {
          return view.current?.state.sliceDoc() || "";
        },
        goTo(offset) {
          const v = view.current;
          if (v) {
            offset = current.current.content
              .slice(0, offset)
              .replace(/\r\n/g, "\n").length;
            v.dispatch({
              selection: { anchor: Math.min(offset, v.state.doc.length) },
              effects: EditorView.scrollIntoView(
                Math.min(offset, v.state.doc.length),
                { y: "center" },
              ),
            });
            v.focus();
          }
        },
      }),
      [],
    );
    useEffect(() => {
      if (!mount.current) return;
      let disposed = false;
      const importImages = (files: File[]) => {
        if (!files.length || !current.current.onImages) return false;
        const v = view.current!,
          onChange = props.onChange,
          notePath = props.path,
          position = v.state.selection.main.from;
        const placeholder = `\n<!-- 插入图片 ${Date.now()} -->\n`;
        v.dispatch({ changes: { from: position, insert: placeholder } });
        const finish = (text: string) => {
          if (!disposed) {
            const index = v.state.doc.toString().indexOf(placeholder);
            if (index >= 0)
              v.dispatch({
                changes: {
                  from: index,
                  to: index + placeholder.length,
                  insert: text,
                },
              });
          } else {
            const previous = retained.get(notePath);
            if (previous && previous.content.includes(placeholder)) {
              const next = previous.content.replace(placeholder, text);
              retained.delete(notePath);
              onChange(next);
            }
          }
        };
        void current.current
          .onImages(files)
          .then((text) => finish("\n" + text + "\n"))
          .catch(() => finish(""));
        return true;
      };
      const config = {
        doc: props.content,
        selection: {
          anchor: props.source
            ? 0
            : Math.min(
                props.content
                  .replace(/\r\n/g, "\n")
                  .match(/^\uFEFF?---\n[\s\S]*?\n---\n/)?.[0].length || 0,
                props.content.length,
              ),
        },
        extensions: [
          EditorState.lineSeparator.of(
            props.content.includes("\r\n") ? "\r\n" : "\n",
          ),
          history(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          highlightSelectionMatches(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorState.readOnly.of(Boolean(props.readOnly)),
          EditorView.contentAttributes.of({
            "aria-label": "笔记编辑器",
            spellcheck: "false",
          }),
          mode.current.of(props.source ? [] : [previewField(props.path)]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              current.current.onChange(update.state.sliceDoc());
          }),
          EditorView.domEventHandlers({
            paste(event) {
              const files = [...(event.clipboardData?.files || [])].filter(
                (f) => f.type.startsWith("image/"),
              );
              if (importImages(files)) {
                event.preventDefault();
                return true;
              }
              return false;
            },
            drop(event) {
              const files = [...(event.dataTransfer?.files || [])].filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length) {
                event.preventDefault();
                const at = view.current?.posAtCoords({
                  x: event.clientX,
                  y: event.clientY,
                });
                if (at != null)
                  view.current?.dispatch({ selection: { anchor: at } });
                return importImages(files);
              }
              return false;
            },
            click(event) {
              const a = (event.target as HTMLElement).closest("a");
              if (a) {
                event.preventDefault();
                current.current.onLink?.(a.getAttribute("href") || "");
                return true;
              }
              return false;
            },
          }),
        ],
      };
      const previous = retained.get(props.path);
      const state =
        previous?.content === props.content
          ? EditorState.fromJSON(previous.json, config, {
              history: historyField,
            })
          : EditorState.create(config);
      const instance = new EditorView({ parent: mount.current, state });
      view.current = instance;
      return () => {
        disposed = true;
        retained.set(props.path, {
          content: instance.state.sliceDoc(),
          json: instance.state.toJSON({ history: historyField }),
        });
        if (retained.size > 50) retained.delete(retained.keys().next().value!);
        instance.destroy();
        view.current = null;
      };
    }, [props.path]);
    useEffect(() => {
      const v = view.current;
      if (v && v.state.sliceDoc() !== props.content)
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: props.content },
        });
    }, [props.content]);
    useEffect(() => {
      view.current?.dispatch({
        effects: mode.current.reconfigure(
          props.source ? [] : [previewField(props.path)],
        ),
      });
    }, [props.source, props.path]);
    return (
      <div
        className={`editor-surface ${props.source ? "source-mode" : ""}`}
        ref={mount}
      />
    );
  },
);
