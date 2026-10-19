import MarkdownIt from "markdown-it";
import katex from "katex";

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
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
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
