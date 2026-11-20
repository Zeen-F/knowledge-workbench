import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { AppError } from "./files.ts";
import { markdownLinks } from "../shared/markdown-links.ts";
import { createNoteResolver, localLinkTarget } from "../shared/note-links.ts";
import { uncoloredHeading } from "../shared/note-outline.ts";
export { markdownLinks } from "../shared/markdown-links.ts";

const frontmatterPattern = /^\uFEFF?---\r?\n([\s\S]*?)(?<=\n)---(?:\r?\n|$)/;

export function parseMarkdown(content: string, strict = true) {
  const match = content.match(frontmatterPattern);
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
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  return String(
    metadata.title ||
      (heading && uncoloredHeading(heading)) ||
      path.posix.basename(relative, ".md"),
  );
}

export function withNoteTitle(content: string, title: string) {
  let previous: ReturnType<typeof parseMarkdown>;
  try {
    previous = parseMarkdown(content);
  } catch {
    throw new AppError("请先修复笔记的 YAML 属性，再修改标题。", 409);
  }
  const lineBreak = content.match(/\r?\n/)?.[0] || "\n";
  const value = JSON.stringify(title);
  const property = `title: ${value}${lineBreak}`;
  const match = previous.frontmatter.match(frontmatterPattern);
  if (!match) {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    return `${bom}---${lineBreak}${property}---${lineBreak}${content.slice(bom.length)}`;
  }

  // Patch the YAML source by node range so comments, custom properties, line
  // endings and Markdown heading anchors remain intact.
  const yaml = match[1];
  const doc = YAML.parseDocument(yaml);
  const node = doc.get("title", true);
  const range = YAML.isNode(node) ? node.range : undefined;
  let nextYaml: string;
  if (range) {
    const [start, end] = range;
    const before = yaml.slice(0, start);
    const after = yaml.slice(end);
    const separator = before.endsWith(":") ? " " : "";
    const suffix = yaml.slice(start, end).endsWith("\n")
      ? lineBreak
      : after.startsWith("#")
        ? " "
        : "";
    nextYaml = before + separator + value + suffix + after;
  } else if (YAML.isMap(doc.contents) && doc.contents.range) {
    const [start] = doc.contents.range;
    if (doc.contents.flow) {
      const separator = doc.contents.items.length ? ", " : "";
      nextYaml =
        yaml.slice(0, start + 1) +
        `title: ${value}${separator}` +
        yaml.slice(start + 1);
    } else {
      const lineStart = yaml.lastIndexOf("\n", start - 1) + 1;
      nextYaml = yaml.slice(0, start) + property + yaml.slice(lineStart);
    }
  } else {
    const empty = doc.contents?.range;
    nextYaml = empty
      ? yaml.slice(0, empty[0]) + `title: ${value}` + yaml.slice(empty[1])
      : yaml + property;
  }
  const yamlStart = match[0].indexOf("\n") + 1;
  const changed =
    content.slice(0, yamlStart) +
    nextYaml +
    content.slice(yamlStart + yaml.length);
  const { metadata, error } = parseMarkdown(changed, false);
  const { title: oldTitle, ...others } = previous.metadata;
  const { title: newTitle, ...nextOthers } = metadata;
  if (error || newTitle !== title || !isDeepStrictEqual(others, nextOthers))
    throw new AppError("标题属性与其他 YAML 内容关联，请在源码中修改。", 409);
  return changed;
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
/** Build one move's resolution indexes and reuse them across all note bodies. */
export function createLinkRewriter(
  from: string,
  to: string,
  paths: readonly string[],
) {
  const resolve = createNoteResolver(paths);
  const resolveAfter = createNoteResolver(
    paths.map((value) => (value === from ? to : value)),
  );
  return (content: string, current: string) => {
    const isMoving = current === from;
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
      const text =
        relative.split("/").map(encodeURIComponent).join("/") + anchor;
      if (text !== raw) patches.push({ ...link, text });
    }
    for (const patch of patches.reverse())
      content =
        content.slice(0, patch.from) + patch.text + content.slice(patch.to);
    return content;
  };
}

export function rewriteLinks(
  content: string,
  from: string,
  to: string,
  current: string,
  paths: readonly string[],
) {
  return createLinkRewriter(from, to, paths)(content, current);
}
