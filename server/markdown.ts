import path from "node:path";
import YAML from "yaml";

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
export function links(content: string) {
  return [...content.matchAll(/!?\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(
    (m) => m[1],
  );
}
export function rewriteLinks(
  content: string,
  from: string,
  to: string,
  current: string,
  paths: string[],
) {
  // Literal examples and unknown HTML stay byte-for-byte intact on a move.
  // Apply the resolver only to prose, including YAML wiki-link properties.
  const literal =
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[^\S\n]*(?:\n|$)|(?![\s\S])))|(^ {4}[^\n]*(?:\n|$))|(`+)[\s\S]*?\4|<!--[\s\S]*?-->/gm;
  let result = "",
    cursor = 0;
  for (const match of content.matchAll(literal)) {
    result +=
      rewriteProse(
        content.slice(cursor, match.index),
        from,
        to,
        current,
        paths,
      ) + match[0];
    cursor = match.index! + match[0].length;
  }
  return result + rewriteProse(content.slice(cursor), from, to, current, paths);
}

function rewriteProse(
  content: string,
  from: string,
  to: string,
  current: string,
  paths: string[],
) {
  const isMoving = current === from,
    oldDir = path.posix.dirname(current),
    newDir = path.posix.dirname(isMoving ? to : current);
  const oldStem = from.replace(/\.md$/i, ""),
    base = path.posix.basename(oldStem);
  content = content.replace(
    /(!?)\[\[([^\]|#]+)([^\]]*)\]\]/g,
    (full, bang: string, name: string, tail: string) => {
      const n = name.replace(/\.md$/i, "");
      const exact =
        n === oldStem ||
        path.posix.normalize(path.posix.join(oldDir, n)) === oldStem;
      const unique =
        n === base &&
        paths.filter((p) => path.posix.basename(p, ".md") === base).length ===
          1;
      if (exact || unique)
        return `${bang}[[${to.replace(/\.md$/i, "")}${tail}]]`;
      return full;
    },
  );
  return content.replace(
    /(!?\[[^\]\n]*\]\()([^\s)]+)([^)]*\))/g,
    (full, pre: string, url: string, post: string) => {
      if (
        /^[a-z][\w+.-]*:/i.test(url) ||
        url.startsWith("#") ||
        url.startsWith("/")
      )
        return full;
      const cut = url.indexOf("#"),
        loc = cut < 0 ? url : url.slice(0, cut),
        anchor = cut < 0 ? "" : url.slice(cut);
      let decoded: string;
      try {
        decoded = decodeURIComponent(loc);
      } catch {
        return full;
      }
      const resolved = path.posix.normalize(path.posix.join(oldDir, decoded));
      const next = resolved === from ? to : resolved;
      if (resolved !== from && !isMoving) return full;
      const rel =
        path.posix.relative(newDir, next) || path.posix.basename(next);
      return `${pre}${rel.split("/").map(encodeURIComponent).join("/")}${anchor}${post}`;
    },
  );
}
