import path from "node:path";
import YAML from "yaml";
import { markdownLinks } from "./markdown-links.ts";
import { createNoteResolver, localLinkTarget } from "../shared/note-links.ts";
export { markdownLinks } from "./markdown-links.ts";

export function parseMarkdown(content: string, strict = true) {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata: Record<string, unknown> = {};
  if (match) {
    let value: unknown;
    try {
      value = YAML.parse(match[1], { maxAliasCount: 50 });
      if (value !== null && (typeof value !== "object" || Array.isArray(value)))
        throw new Error("YAML 属性必须为键值对象");
    } catch (error) {
      if (strict) throw error;
      return { metadata, body: content, frontmatter: "", error: String(error) };
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      metadata = value as Record<string, unknown>;
  }
  if (!match && /^\uFEFF?---\r?\n/.test(content) && strict)
    throw new Error("YAML 属性缺少结束标记 ---");
  const body = match ? content.slice(match[0].length) : content;
  return { metadata, body, frontmatter: match?.[0] || "" };
}
export function paperdeskBody(content: string) {
  return parseMarkdown(content, false)
    .body.replace(
      /(?:\r?\n){0,2}<!-- paperdesk-generated:start:v1 -->[\s\S]*?<!-- paperdesk-generated:end:v1 -->/g,
      "",
    )
    .replace(/<!-- paperdesk-library:[^>]*-->/g, "");
}
export function formatMarkdown(
  metadata: Record<string, unknown>,
  body: string,
) {
  return `---\n${YAML.stringify(metadata)}---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}
export function noteTitle(
  content: string,
  metadata: Record<string, unknown>,
  relative: string,
) {
  return String(
    metadata.title ||
      content.match(/^#\s+(.+)$/m)?.[1] ||
      path.posix.basename(relative, ".md"),
  );
}
export function links(content: string, current?: string) {
  return markdownLinks(content).flatMap((link) => {
    const target =
      link.style === "markdown"
        ? localLinkTarget(link.target, current || "", "markdown")
        : localLinkTarget(link.target, "", "wiki");
    return target ? [target] : [];
  });
}
export function rewriteLinks(
  content: string,
  from: string,
  to: string,
  current: string,
  paths: string[],
) {
  const resolve = createNoteResolver(paths),
    isMoving = current === from;
  const resolveAfter = createNoteResolver(
    paths.map((value) => (value === from ? to : value)),
  );
  const patches: { from: number; to: number; text: string }[] = [];
  for (const link of markdownLinks(content)) {
    const resolved = resolve(link.target, current, link.style);
    if (link.style === "wiki") {
      if (resolved === from)
        patches.push({ ...link, text: to.replace(/\.md$/i, "") });
      else if (
        isMoving &&
        resolved &&
        resolveAfter(link.target, to, "wiki") !== resolved
      )
        patches.push({ ...link, text: resolved.replace(/\.md$/i, "") });
      continue;
    }
    const local = localLinkTarget(link.target, current, "markdown");
    if (!local || (resolved !== from && !isMoving)) continue;
    // Relative assets and even currently missing local targets must retain their
    // destination when the containing note moves. Root-relative URLs stay rooted.
    const next = resolved === from ? to : local;
    const raw = content.slice(link.from, link.to);
    const anchor = raw.includes("#") ? raw.slice(raw.indexOf("#")) : "";
    const relative = link.target.startsWith("/")
      ? "/" + next
      : path.posix.relative(
          path.posix.dirname(isMoving ? to : current),
          next,
        ) || path.posix.basename(next);
    const text = relative.split("/").map(encodeURIComponent).join("/") + anchor;
    if (text !== raw) patches.push({ ...link, text });
  }
  for (const patch of patches.reverse())
    content =
      content.slice(0, patch.from) + patch.text + content.slice(patch.to);
  return content;
}
