import MarkdownIt from "markdown-it";
import katex from "katex";
import { registerNoteFormatting } from "../shared/note-colors";

export function resolvePath(target: string, current: string) {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {}
  const parts = (
    decoded.startsWith("KnowledgeWorkbench/") || decoded.startsWith("/")
      ? decoded.replace(/^\//, "")
      : current.split("/").slice(0, -1).concat(decoded).join("/")
  ).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack.join("/");
}
export const assetUrl = (relative: string) =>
  window.workbench?.panel
    ? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=#kwb-asset=" +
      encodeURIComponent(relative)
    : "/api/assets?path=" + encodeURIComponent(relative);
export function renderMarkdown(
  text: string,
  current: string,
  options: { inertLinks?: boolean } = {},
) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(
    registerNoteFormatting,
  );
  md.inline.ruler.before("escape", "note_math", (state, silent) => {
    const at = state.pos;
    const opening = ["$$", "\\(", "$"].find((token) =>
      state.src.startsWith(token, at),
    );
    if (!opening) return false;
    const start = at + opening.length;
    const closing = opening === "\\(" ? "\\)" : opening;
    if (
      opening === "$" &&
      (state.src[at - 1] === "$" || /\s/.test(state.src[start] || ""))
    )
      return false;
    let end = state.src.indexOf(closing, start);
    while (end >= 0 && end < state.posMax) {
      if (
        state.src[end - 1] !== "\\" &&
        (opening !== "$" || state.src[end + 1] !== "$")
      )
        break;
      end = state.src.indexOf(closing, end + closing.length);
    }
    const tex = end < 0 ? "" : state.src.slice(start, end);
    if (
      !tex.trim() ||
      end + closing.length > state.posMax ||
      /[\r\n]/.test(tex) ||
      (opening === "$" &&
        (/\s$/.test(tex) || /\d/.test(state.src[end + 1] || "")))
    )
      return false;
    if (!silent) {
      const token = state.push("note_math", "", 0);
      token.content = tex;
      token.meta = { display: opening === "$$" };
    }
    state.pos = end + closing.length;
    return true;
  });
  md.block.ruler.before(
    "fence",
    "note_math_block",
    (state, start, end, silent) => {
      const source = (line: number) =>
        state.src.slice(
          state.bMarks[line] + state.tShift[line],
          state.eMarks[line],
        );
      const opening = source(start).trim();
      const single = opening.match(/^\\\[(.+?)\\\]$/);
      if (single) {
        if (silent) return true;
        const token = state.push("note_math", "", 0);
        token.block = true;
        token.map = [start, start + 1];
        token.meta = { display: true };
        token.content = single[1];
        state.line = start + 1;
        return true;
      }
      if (opening !== "$$" && opening !== "\\[") return false;
      const closing = opening === "$$" ? "$$" : "\\]";
      let last = start + 1;
      while (last < end && source(last).trim() !== closing) last++;
      if (last >= end || last === start + 1) return false;
      if (silent) return true;
      const token = state.push("note_math", "", 0);
      token.block = true;
      token.map = [start, last + 1];
      token.meta = { display: true };
      token.content = Array.from({ length: last - start - 1 }, (_, i) =>
        source(start + 1 + i),
      ).join("\n");
      state.line = last + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  md.renderer.rules.note_math = (tokens, index) =>
    renderMath(tokens[index].content, tokens[index].meta?.display === true);
  if (options.inertLinks) {
    md.renderer.rules.link_open = () => '<span class="snapshot-link">';
    md.renderer.rules.link_close = () => "</span>";
  }
  const original = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx],
      src = String(token.attrGet("src") || "");
    if (/^[a-z]+:/i.test(src))
      return `<span class="external-image">外部图片：${md.utils.escapeHtml(src)}</span>`;
    token.attrSet("src", assetUrl(resolvePath(src, current)));
    token.attrSet("loading", "lazy");
    return original(tokens, idx, options, env, self);
  };
  const rendered = text
    .replace(
      /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
      (_all, file: string, alt: string) => `![${alt || ""}](/${file})`,
    )
    .replace(
      /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_all, target: string, label: string) =>
        `[${label || target}](kb:${encodeURIComponent(target)})`,
    );
  md.validateLink = (url: string) =>
    !/^(javascript|vbscript|data|file):/i.test(url);
  return md.render(rendered);
}
export const renderMath = (tex: string, displayMode: boolean) =>
  katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 50,
  });
