import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  historyField,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  HighlightStyle,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  locateNoteReference,
  noteReferenceLine,
  previewField,
} from "./editor-preview";
import { editorAccess } from "./editor-access";
import { FilePlus2, MapPin, MessageSquare } from "lucide-react";
import { EditorLinkPreview, type LoadLinkPreview } from "./EditorLinkPreview";
import type { ChildNoteResult, CodexReviewAnchor } from "../shared/contracts";
import type { NoteColor } from "../shared/note-colors";
import { editNoteColor } from "./note-color-editing";
import {
  findParentBacklink,
  markdownBodyStart,
} from "../shared/markdown-links";
import { PARENT_NOTE_LABEL } from "../shared/note-links";
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
  setTextColor: (color: NoteColor | null) => boolean;
  focus: () => void;
  getText: () => string;
  getQuote: () => CodexReviewAnchor | undefined;
  goTo: (offset: number, highlightReference?: boolean) => void;
  applySavedInsertion: (
    before: string,
    insertion: NonNullable<ChildNoteResult["insertion"]>,
  ) => void;
};
export type ChildNoteAnchor = {
  content: string;
  offset: number;
  placement: "inline" | "block";
  title: string;
};
type Props = {
  content: string;
  path: string;
  source: boolean;
  onChange: (content: string) => void;
  onImages?: (files: File[]) => Promise<string>;
  onLink?: (target: string, label: string) => void;
  loadLinkPreview?: LoadLinkPreview;
  onCreateChild?: (anchor: ChildNoteAnchor) => void;
  onQuote?: (quote: CodexReviewAnchor) => void;
  readOnly?: boolean;
};

const retained = new Map<string, { content: string; json: any }>();
const savedInsertion = Annotation.define<boolean>();
const protectedBlocks = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "ATXHeading",
  "SetextHeading",
  "Table",
  "LinkReference",
]);
const protectedInline = new Set([
  "Link",
  "Image",
  "InlineCode",
  "HTMLTag",
  "ListMark",
  "QuoteMark",
]);

function quoteRange(
  state: EditorState,
  from: number,
  to: number,
): CodexReviewAnchor | undefined {
  // CodeMirror document offsets use single-character line breaks, including for CRLF files.
  const source = state.doc.sliceString(from, to);
  const text = source.trim().slice(0, 6000).trimEnd();
  if (!text) return;
  const offset = from + (source.length - source.trimStart().length);
  const line = state.doc.lineAt(offset);
  return { text, offset, line: line.number, column: offset - line.from + 1 };
}

export const Editor = forwardRef<EditorHandle, Props>(
  function Editor(props, ref) {
    const mount = useRef<HTMLDivElement>(null),
      view = useRef<EditorView | null>(null),
      current = useRef(props),
      mode = useRef(new Compartment()),
      access = useRef(new Compartment()),
      childMenu = useRef<HTMLDivElement>(null),
      childAnchor = useRef<ChildNoteAnchor>(null),
      quote = useRef<CodexReviewAnchor>(undefined),
      parentBacklink = useRef<string | undefined>(undefined);
    current.current = props;
    const canCreateChild = Boolean(props.onCreateChild);
    const canQuote = Boolean(props.onQuote);
    const hasMenu = canCreateChild || canQuote;

    function openChildMenu(
      v: EditorView,
      mouse?: { x: number; y: number; target: EventTarget },
    ) {
      const menu = childMenu.current;
      if (!menu || v.composing) return false;
      const { state } = v;
      const selection = state.selection.main;
      let at = selection.head;
      let placement: ChildNoteAnchor["placement"] = "inline";
      if (mouse) {
        const element = mouse.target instanceof Element ? mouse.target : null;
        const line = element?.closest(".cm-line");
        const widget = element?.closest(".md-inline");
        if (line) {
          const hit = v.dom.ownerDocument.caretRangeFromPoint(mouse.x, mouse.y);
          // Use the clicked text line even when a rendered image above it
          // shifts the editor's estimated coordinates.
          at =
            hit && line.contains(hit.startContainer)
              ? v.posAtDOM(hit.startContainer, hit.startOffset)
              : v.posAtDOM(line);
          if (widget?.parentNode) {
            const afterWidget =
              Array.from(widget.parentNode.childNodes).indexOf(widget) + 1;
            at = v.posAtDOM(widget.parentNode, afterWidget);
          }
        } else {
          at = v.lineBlockAtHeight(mouse.y - v.documentTop).to;
          if (element?.closest(".md-rendered")) placement = "block";
        }
      }
      const selected =
        !selection.empty && selection.from <= at && at <= selection.to;
      if (current.current.onQuote) {
        const range = selected ? selection : state.doc.lineAt(at);
        quote.current = quoteRange(state, range.from, range.to);
        const quoteAction =
          menu.querySelector<HTMLButtonElement>("[data-quote]");
        if (quoteAction) quoteAction.hidden = !quote.current;
        if (!quote.current && !current.current.onCreateChild) return false;
      }
      if (selected) {
        at = selection.to;
        if (state.doc.lineAt(at).from === at) at--;
      }
      let end = at;
      for (
        let node = syntaxTree(state).resolveInner(at, 1);
        node.parent;
        node = node.parent
      ) {
        if (protectedBlocks.has(node.name)) {
          end = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
          placement = "block";
          break;
        }
        if (protectedInline.has(node.name)) end = Math.max(end, node.to);
      }
      const line = state.doc.lineAt(end);
      if (/^\s*!(?:\[\[[^\n]+\]\]|\[.*\]\(.*\))\s*$/.test(line.text))
        placement = "block";
      if (placement === "block") end = line.to;
      else {
        for (const match of line.text.matchAll(
          /!?\[\[[^\n]+?\]\]|(?<!\$)\$[^$\n]+\$(?!\$)/g,
        )) {
          const start = line.from + match.index;
          const finish = start + match[0].length;
          if (start <= end && end < finish) end = finish;
        }
      }
      const content = state.sliceDoc();
      const offset = state.sliceDoc(0, end).length;
      const bodyStart = Math.max(
        markdownBodyStart(content),
        content.startsWith("\uFEFF") ? 1 : 0,
      );
      childAnchor.current = {
        content,
        offset: Math.max(offset, bodyStart),
        placement: offset < bodyStart ? "block" : placement,
        title: selected
          ? Array.from(
              state
                .sliceDoc(selection.from, selection.to)
                .replace(/\s+/g, " ")
                .trim(),
            )
              .slice(0, 80)
              .join("")
          : "",
      };
      parentBacklink.current = findParentBacklink(content);
      const locate = menu.querySelector<HTMLButtonElement>(
        "[data-locate-parent]",
      );
      if (locate) locate.hidden = !parentBacklink.current;
      const caret = v.coordsAtPos(selection.head);
      const editorBox = v.dom.getBoundingClientRect();
      const x = mouse?.x ?? caret?.left ?? editorBox.left;
      const y = mouse?.y ?? caret?.bottom ?? editorBox.top;
      if (menu.matches(":popover-open")) menu.hidePopover();
      menu.showPopover();
      menu.style.left =
        String(
          Math.max(6, Math.min(x, window.innerWidth - menu.offsetWidth - 6)),
        ) + "px";
      menu.style.top =
        String(
          Math.max(6, Math.min(y, window.innerHeight - menu.offsetHeight - 6)),
        ) + "px";
      menu
        .querySelector<HTMLButtonElement>("button:not([hidden])")
        ?.focus({ preventScroll: true });
      return true;
    }
    function closeChildMenu() {
      childMenu.current?.hidePopover();
      view.current?.focus();
    }
    useEffect(() => {
      const menu = childMenu.current;
      if (!menu) return;
      const dismiss = (event: Event) => {
        if (
          menu.matches(":popover-open") &&
          !event.composedPath().includes(menu)
        )
          menu.hidePopover();
      };
      document.addEventListener("pointerdown", dismiss, true);
      document.addEventListener("scroll", dismiss, true);
      window.addEventListener("blur", dismiss);
      window.addEventListener("resize", dismiss);
      return () => {
        document.removeEventListener("pointerdown", dismiss, true);
        document.removeEventListener("scroll", dismiss, true);
        window.removeEventListener("blur", dismiss);
        window.removeEventListener("resize", dismiss);
      };
    }, [hasMenu]);

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
        setTextColor(color) {
          const v = view.current;
          if (!v || current.current.readOnly || v.composing) return false;
          const edit = editNoteColor(v.state, color);
          if (!edit) return false;
          v.dispatch(edit);
          v.focus();
          return true;
        },
        focus() {
          view.current?.focus();
        },
        getText() {
          return view.current?.state.sliceDoc() || "";
        },
        getQuote() {
          const state = view.current?.state;
          if (!state || view.current?.composing) return;
          const { from, to } = state.selection.main;
          return quoteRange(state, from, to);
        },
        applySavedInsertion(before, { offset, text }) {
          const v = view.current;
          if (!v || v.state.sliceDoc() !== before) return;
          const from = v.state.toText(before.slice(0, offset)).length;
          const insert = v.state.toText(text);
          v.dispatch({
            changes: { from, insert },
            selection: { anchor: from + insert.length },
            annotations: savedInsertion.of(true),
          });
        },
        goTo(offset, highlightReference = false) {
          const v = view.current;
          if (v) {
            const anchor = v.state.toText(
              v.state.sliceDoc().slice(0, offset),
            ).length;
            const scroll = EditorView.scrollIntoView(anchor, { y: "center" });
            v.dispatch({
              selection: { anchor },
              effects: highlightReference
                ? [scroll, locateNoteReference.of(anchor)]
                : scroll,
            });
            if (!highlightReference) v.focus();
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
          noteReferenceLine,
          access.current.of(editorAccess(Boolean(props.readOnly))),
          EditorView.contentAttributes.of({
            "aria-label": "笔记编辑器",
            spellcheck: "false",
          }),
          mode.current.of(props.source ? [] : [previewField(props.path)]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(savedInsertion))
            )
              current.current.onChange(update.state.sliceDoc());
          }),
          EditorView.domEventHandlers({
            keydown(event, v) {
              return (
                (event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")) &&
                openChildMenu(v)
              );
            },
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
            click(event, v) {
              const a = (event.target as HTMLElement).closest("a");
              if (a) {
                event.preventDefault();
                const heading = a.getAttribute("data-note-heading");
                if (heading !== null && /^\d+$/.test(heading)) {
                  const offset = Math.min(Number(heading), v.state.doc.length);
                  v.dispatch({
                    selection: { anchor: offset },
                    effects: EditorView.scrollIntoView(offset, { y: "center" }),
                  });
                  return true;
                }
                current.current.onLink?.(
                  a.getAttribute("href") || "",
                  a.textContent?.trim() || "",
                );
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
      <>
        <div
          className={`editor-surface ${props.source ? "source-mode" : ""}`}
          ref={mount}
          onContextMenu={(event) => {
            const v = view.current;
            if (
              v &&
              openChildMenu(v, {
                x: event.clientX,
                y: event.clientY,
                target: event.target,
              })
            )
              event.preventDefault();
          }}
        />
        {hasMenu && (
          <div
            ref={childMenu}
            popover="manual"
            className="note-context-menu"
            role="menu"
            aria-label="正文操作"
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                closeChildMenu();
              }
              if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not([hidden])",
                  ),
                );
                const focusLast =
                  event.key === "End" ||
                  ((event.key === "ArrowDown" || event.key === "ArrowUp") &&
                    document.activeElement === items[0]);
                (focusLast ? items.at(-1) : items[0])?.focus();
              }
            }}
          >
            {canCreateChild && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeChildMenu();
                    if (childAnchor.current)
                      current.current.onCreateChild?.(childAnchor.current);
                  }}
                >
                  <FilePlus2 size={15} />
                  新建子笔记
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-locate-parent
                  hidden
                  onClick={() => {
                    const target = parentBacklink.current;
                    closeChildMenu();
                    if (target)
                      current.current.onLink?.(target, PARENT_NOTE_LABEL);
                  }}
                >
                  <MapPin size={15} />
                  在父笔记中定位
                </button>
              </>
            )}
            {canQuote && (
              <button
                type="button"
                role="menuitem"
                data-quote
                onClick={() => {
                  closeChildMenu();
                  if (quote.current) current.current.onQuote?.(quote.current);
                }}
              >
                <MessageSquare size={15} />
                就这段问 Codex
              </button>
            )}
          </div>
        )}
        <EditorLinkPreview
          surface={mount}
          load={props.source ? undefined : props.loadLinkPreview}
        />
      </>
    );
  },
);
