import MarkdownIt from "markdown-it";
import type { LinkStyle } from "../shared/note-links.ts";

export type MarkdownLink = {
  style: LinkStyle;
  target: string;
  /** Destination only, excluding brackets, alias, heading and title. */
  from: number;
  to: number;
};
type Destination = { from: number; to: number; target: string };
type LinkEnvironment = {
  references?: Record<string, { href: string; title: string }>;
  definitions: Map<string, Destination>;
  definitionRanges: { from: number; to: number }[];
  links: MarkdownLink[];
  collect?: boolean;
  source?: string;
  sourceOffset: number;
};
const parser = new MarkdownIt({ html: true, linkify: false });
// Use the installed parser's own rules, never a second Markdown grammar. This
// assertion makes incompatible parser upgrades fail explicitly in regression tests.
for (const name of ["link", "image"]) {
  const rules = new MarkdownIt().inline.ruler;
  rules.enableOnly([name]);
  const original = rules.getRules("")[0];
  if (!original) throw new Error(`markdown-it is missing its ${name} rule`);
  parser.inline.ruler.at(name, (state, silent) => {
    const start = state.pos,
      tokenStart = state.tokens.length;
    const accepted = original(state, silent);
    const env = state.env as LinkEnvironment;
    if (
      !accepted ||
      silent ||
      !env.collect ||
      state.src !== env.source ||
      state.linkLevel > 0
    )
      return accepted;
    const token = state.tokens
      .slice(tokenStart)
      .find((t) => t.type === (name === "image" ? "image" : "link_open"));
    if (!token) return accepted;
    const label = token.meta?.label as string | undefined;
    if (label) {
      const destination = env.definitions.get(label);
      if (destination) env.links.push({ style: "markdown", ...destination });
    } else {
      const labelEnd = state.md.helpers.parseLinkLabel(
        state,
        start + (name === "image" ? 1 : 0),
        name === "link",
      );
      let from = labelEnd + 2;
      if (labelEnd < 0 || state.src[labelEnd + 1] !== "(") return accepted;
      while (/\s/.test(state.src[from] || "") && from < state.src.length)
        from++;
      const destination = state.md.helpers.parseLinkDestination(
        state.src,
        from,
        state.posMax,
      );
      if (destination.ok) {
        const angled = state.src[from] === "<";
        env.links.push({
          style: "markdown",
          target: destination.str,
          from: env.sourceOffset + from + (angled ? 1 : 0),
          to: env.sourceOffset + destination.pos - (angled ? 1 : 0),
        });
      }
    }
    return accepted;
  });
}
parser.inline.ruler.before("link", "vault_wiki_link", (state, silent) => {
  // Wiki-looking text inside a standard link label is plain label text.
  if (silent) return false;
  const start = state.pos,
    embedded = state.src.startsWith("![[", start);
  if (!embedded && !state.src.startsWith("[[", start)) return false;
  const from = start + (embedded ? 3 : 2),
    end = state.src.indexOf("]]", from);
  if (
    end < 0 ||
    end >= state.posMax ||
    /[\r\n]/.test(state.src.slice(from, end))
  )
    return false;
  const value = state.src.slice(from, end),
    target = value.split(/[|#]/)[0];
  if (!target || target.includes("[")) return false;
  if (!silent) {
    const env = state.env as LinkEnvironment;
    if (env.collect && state.src === env.source && state.linkLevel === 0)
      env.links.push({
        style: "wiki",
        target,
        from: env.sourceOffset + from,
        to: env.sourceOffset + from + target.length,
      });
    const token = state.push("text", "", 0);
    token.content = state.src.slice(start, end + 2);
  }
  state.pos = end + 2;
  return true;
});
const blockRules = new MarkdownIt().block.ruler;
blockRules.enableOnly(["reference"]);
const reference = blockRules.getRules("")[0];
if (!reference) throw new Error("markdown-it is missing its reference rule");
parser.block.ruler.at("reference", (state, startLine, endLine, silent) => {
  const from = state.bMarks[startLine] + state.tShift[startLine];
  const accepted = reference(state, startLine, endLine, silent);
  if (!accepted || silent) return accepted;
  const env = state.env as LinkEnvironment;
  const text = state.src.slice(from, state.bMarks[state.line]);
  const match = text.match(/^\[((?:\\.|[^\]\\])+)\]:\s*/);
  if (match) {
    const start = from + match[0].length;
    const destination = state.md.helpers.parseLinkDestination(
      state.src,
      start,
      state.src.length,
    );
    const label = state.md.utils.normalizeReference(match[1]);
    if (destination.ok && !env.definitions.has(label)) {
      const angled = state.src[start] === "<";
      env.definitions.set(label, {
        target: destination.str,
        from: start + (angled ? 1 : 0),
        to: destination.pos - (angled ? 1 : 0),
      });
    }
  }
  env.definitionRanges.push({
    from: state.bMarks[startLine],
    to: state.bMarks[state.line] ?? state.src.length,
  });
  return accepted;
});

/** Parse once for both indexing and refactoring; offsets refer to original bytes in JS UTF-16. */
export function markdownLinks(content: string): MarkdownLink[] {
  let normalized = content;
  let offsets: number[] | undefined;
  if (content.includes("\r")) {
    offsets = [];
    const characters: string[] = [];
    for (let i = 0; i < content.length; i++) {
      offsets.push(i);
      if (content[i] === "\r") {
        characters.push("\n");
        if (content[i + 1] === "\n") i++;
      } else characters.push(content[i]);
    }
    offsets.push(content.length);
    normalized = characters.join("");
  }
  const lineStarts = [0];
  for (let i = 0; i < normalized.length; i++)
    if (normalized[i] === "\n") lineStarts.push(i + 1);
  const env: LinkEnvironment = {
    definitions: new Map(),
    definitionRanges: [],
    links: [],
    sourceOffset: 0,
  };
  const blocks: ReturnType<typeof parser.parse> = [];
  parser.block.parse(normalized, parser, env, blocks);
  const literalRanges = [...env.definitionRanges];
  for (const token of blocks)
    if (token.map && ["fence", "code_block", "html_block"].includes(token.type))
      literalRanges.push({
        from: lineStarts[token.map[0]],
        to: lineStarts[token.map[1]] ?? normalized.length,
      });
  // Keep historically protected four-space examples intact, even where a
  // preceding paragraph means CommonMark would treat them as continuation.
  for (const match of normalized.matchAll(/^(?: {4}|\t)[^\n]*/gm))
    literalRanges.push({
      from: match.index!,
      to: match.index! + match[0].length,
    });
  let prose = normalized;
  if (literalRanges.length) {
    const masked = normalized.split("");
    for (const range of literalRanges)
      for (let i = range.from; i < range.to; i++)
        if (masked[i] !== "\n") masked[i] = " ";
    prose = masked.join("");
  }
  env.collect = true;
  // Parse only within actual block boundaries: an unmatched backtick in one
  // paragraph must not hide a real link in a later paragraph or heading.
  const ranges = new Map<string, [number, number]>();
  for (const token of blocks) {
    if (!token.map || !["inline", "tr_open"].includes(token.type)) continue;
    const from = lineStarts[token.map[0]],
      to = lineStarts[token.map[1]] ?? normalized.length;
    ranges.set(`${from}:${to}`, [from, to]);
  }
  for (const [from, to] of ranges.values()) {
    env.sourceOffset = from;
    env.source = prose.slice(from, to);
    parser.inline.parse(env.source, parser, env, []);
  }
  const unique = new Map<string, MarkdownLink>();
  for (const link of env.links) {
    const result = {
      ...link,
      from: offsets?.[link.from] ?? link.from,
      to: offsets?.[link.to] ?? link.to,
    };
    unique.set(`${result.from}:${result.to}`, result);
  }
  return [...unique.values()].sort((a, b) => a.from - b.from);
}
