import MarkdownIt from "markdown-it";
import { markdownBodyStart } from "./markdown-links.ts";
import { registerNoteFormatting, type NoteInlineTag } from "./note-colors.ts";

const parser = new MarkdownIt({ html: false, linkify: false }).use(
  registerNoteFormatting,
);

export function uncoloredHeading(title: string) {
  if (!/<(?:span|strong)\b/i.test(title)) return title;
  let end = 0;
  let result = "";
  for (const token of parser.parseInline(title, {})[0].children ?? []) {
    if (token.type !== "note_format_open" && token.type !== "note_format_close")
      continue;
    const tag = token.meta as NoteInlineTag;
    result += title.slice(end, tag.from);
    end = tag.to;
  }
  return result + title.slice(end);
}

export function noteOutline(content: string) {
  const bodyStart = markdownBodyStart(content);
  const body = content.slice(bodyStart);
  const lines = [bodyStart];
  for (const match of body.matchAll(/\r?\n/g))
    lines.push(bodyStart + match.index + match[0].length);
  const tokens = parser.parse(body, {});
  return tokens.flatMap((token, i) => {
    if (token.type !== "heading_open" || token.level || !token.map) return [];
    const inline = tokens[i + 1];
    const title = (inline.children || [])
      .map((child) =>
        ["text", "code_inline", "image"].includes(child.type)
          ? child.content
          : "",
      )
      .join("")
      .trim();
    return [
      {
        title: title || inline.content.trim(),
        level: Number(token.tag.slice(1)),
        offset: lines[token.map[0]],
        end: lines[token.map[1]] ?? content.length,
      },
    ];
  });
}
