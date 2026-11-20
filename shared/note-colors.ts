import type MarkdownIt from "markdown-it";

export const noteColors = [
  { value: "#a43f34", night: "#f4b0a4", label: "朱红" },
  { value: "#8a530f", night: "#f3c282", label: "琥珀" },
  { value: "#2c6b50", night: "#8fcdb0", label: "深绿" },
  { value: "#2e6e76", night: "#92d1d7", label: "青色" },
  { value: "#2a5f9a", night: "#9ec8f3", label: "蓝色" },
  { value: "#67449e", night: "#d3b7f9", label: "紫色" },
] as const;

export type NoteColor = (typeof noteColors)[number]["value"];
type NoteInlineElement = "span" | "strong";
export type NoteInlineTag = {
  from: number;
  to: number;
  element: NoteInlineElement;
  closing?: true;
  color?: string;
};
export type NoteInlineSpan = { open: NoteInlineTag; close: NoteInlineTag };

const opening =
  /<(span|strong)(?:[ \t]+style[ \t]*=[ \t]*(["'])[ \t]*color[ \t]*:[ \t]*([^"';\r\n]+);?[ \t]*\2)?[ \t]*>/iy;
const closing = /<\/(span|strong)[ \t]*>/iy;
const colorValue =
  /^(#[a-f0-9]{6}|#[a-f0-9]{3})$|^var\([ \t]*--[a-z0-9_-]+[ \t]*,[ \t]*(#[a-f0-9]{6}|#[a-f0-9]{3})[ \t]*\)$/i;

export function noteInlineTag(
  source: string,
  from: number,
  limit: number,
): NoteInlineTag | undefined {
  if (source[from] !== "<") return;
  opening.lastIndex = from;
  const start = opening.exec(source);
  if (start && opening.lastIndex <= limit) {
    const element = start[1].toLowerCase() as NoteInlineElement;
    const tag = { from, to: opening.lastIndex, element };
    if (start[3] === undefined) return element === "strong" ? tag : undefined;
    // Use the explicit fallback from a CSS variable. Only a hex value reaches
    // the renderer, independent of the source's CSS variables.
    const value = colorValue.exec(start[3].trim());
    if (!value) return;
    const raw = (value[1] || value[2]).toLowerCase();
    const color =
      raw.length === 4
        ? raw.replace(/[a-f0-9]/g, (part) => part.repeat(2))
        : raw;
    return { ...tag, color };
  }
  closing.lastIndex = from;
  const end = closing.exec(source);
  if (end && closing.lastIndex <= limit)
    return {
      from,
      to: closing.lastIndex,
      element: end[1].toLowerCase() as NoteInlineElement,
      closing: true,
    };
}

export function pairNoteInlineTags(
  source: string,
  tags: NoteInlineTag[],
): NoteInlineSpan[] {
  const stack: NoteInlineTag[] = [];
  const spans: NoteInlineSpan[] = [];
  for (const tag of tags) {
    if (!tag.closing) stack.push(tag);
    else {
      const open = stack.at(-1);
      if (open?.element !== tag.element) continue;
      stack.pop();
      if (!/[\r\n]/.test(source.slice(open.to, tag.from)))
        spans.push({ open, close: tag });
    }
  }
  return spans.sort((a, b) => a.open.from - b.open.from);
}

export function noteColorStyle(color: string) {
  const night = noteColors.find((entry) => entry.value === color)?.night;
  return (
    "--note-color:" + color + (night ? ";--note-color-night:" + night : "")
  );
}

export const noteColorOpening = (color: string) =>
  '<span style="color: ' + color + '">';
export const noteColorClosing = "</span>";

export function registerNoteFormatting(md: InstanceType<typeof MarkdownIt>) {
  md.inline.ruler.before("html_inline", "note_format_tag", (state, silent) => {
    const tag = noteInlineTag(state.src, state.pos, state.posMax);
    if (!tag) return false;
    if (!silent) {
      const token = state.push("note_format_tag", tag.element, 0);
      token.content = state.src.slice(tag.from, tag.to);
      token.meta = tag;
    }
    state.pos = tag.to;
    return true;
  });
  md.inline.ruler2.after("emphasis", "note_format_pairs", (state) => {
    const tokens = state.tokens.filter(
      (token) => token.type === "note_format_tag",
    );
    if (!tokens.length) return;
    const byTag = new Map(
      tokens.map((token) => [token.meta as NoteInlineTag, token]),
    );
    for (const { open, close } of pairNoteInlineTags(state.src, [
      ...byTag.keys(),
    ])) {
      byTag.get(open)!.type = "note_format_open";
      byTag.get(close)!.type = "note_format_close";
    }
  });
  md.renderer.rules.note_format_tag = (tokens, index) =>
    md.utils.escapeHtml(tokens[index].content);
  md.renderer.rules.note_format_open = (tokens, index) => {
    const { color, element } = tokens[index].meta as NoteInlineTag;
    const style = color
      ? ' class="note-inline-color" style="' + noteColorStyle(color) + '"'
      : "";
    return "<" + element + style + ">";
  };
  md.renderer.rules.note_format_close = (tokens, index) =>
    "</" + (tokens[index].meta as NoteInlineTag).element + ">";
}
