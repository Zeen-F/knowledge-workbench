import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
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
import { previewField } from "./editor-preview";
import { editorAccess } from "./editor-access";
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

export const Editor = forwardRef<EditorHandle, Props>(
  function Editor(props, ref) {
    const mount = useRef<HTMLDivElement>(null),
      view = useRef<EditorView | null>(null),
      current = useRef(props),
      mode = useRef(new Compartment()),
      access = useRef(new Compartment());
    current.current = props;
    useImperativeHandle(
      ref,
      () => ({
        insert(value) {
          const v = view.current;
          if (!v || current.current.readOnly) return;
          v.dispatch(v.state.replaceSelection(value));
          v.focus();
        },
        wrap(before, after) {
          const v = view.current;
          if (!v || current.current.readOnly) return;
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
        if (
          !files.length ||
          !current.current.onImages ||
          current.current.readOnly
        )
          return false;
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
          access.current.of(editorAccess(Boolean(props.readOnly))),
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
            mousedown(event) {
              if (
                event.button === 0 &&
                (event.target as HTMLElement).closest("a[href]")
              ) {
                // Keep the rendered link until click can navigate. Moving the
                // caret here would reveal source and remove the click target.
                event.preventDefault();
                return true;
              }
              return false;
            },
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
      view.current?.dispatch({
        effects: access.current.reconfigure(
          editorAccess(Boolean(props.readOnly)),
        ),
      });
    }, [props.readOnly, props.path]);
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
