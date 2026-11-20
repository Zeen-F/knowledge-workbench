import {
  childNoteDraftSchema,
  type ChildNoteDraft,
} from "../shared/contracts.ts";
import { noteOutline } from "../shared/note-outline.ts";
import { AppError, digest } from "./files.ts";
import { markdownLinks, parseMarkdown } from "./markdown.ts";
import { noteHref, type Vault } from "./vault.ts";

function childLinks(markdown: string) {
  return markdownLinks(markdown).filter(
    (link) =>
      link.style === "markdown" &&
      link.imageAt === undefined &&
      link.target.startsWith("child-note:"),
  );
}

export function legacyChildNotes(markdown: string) {
  const outline = noteOutline(markdown);
  const children: ChildNoteDraft[] = [];
  const changes: { offset: number; end: number; link: string }[] = [];
  for (const [index, heading] of outline.entries()) {
    const title = heading.title.match(
      /^子笔记草稿(?:[一二三四五六七八九十\d]+)?\s*[｜|：:]\s*(.+)$/,
    )?.[1];
    if (!title) continue;
    const end =
      outline.slice(index + 1).find((entry) => entry.level <= heading.level)
        ?.offset ?? markdown.length;
    const body = markdown.slice(heading.end, end).trim();
    if (!body) continue;
    const child = childNoteDraftSchema.safeParse({
      key: "legacy-" + (children.length + 1),
      title,
      markdown: body,
    });
    if (!child.success) continue;
    children.push(child.data);
    changes.push({
      offset: heading.offset,
      end,
      link:
        "[" +
        title.replace(/[\\[\]*_$~<>&]/g, "\\$&") +
        "](child-note:" +
        child.data.key +
        ")\n\n",
    });
  }
  let parent = markdown;
  for (const change of changes.reverse())
    parent =
      parent.slice(0, change.offset) + change.link + parent.slice(change.end);
  return { markdown: parent, children };
}

export function validateChildNotes(
  markdown: string,
  children: ChildNoteDraft[] = [],
  requireAll = true,
) {
  const byKey = new Map(children.map((child) => [child.key, child]));
  const references = childLinks(markdown);
  if (
    byKey.size !== children.length ||
    references.some(
      (link) => !byKey.has(link.target.slice("child-note:".length)),
    ) ||
    (requireAll &&
      children.some(
        (child) =>
          !references.some((link) => link.target === "child-note:" + child.key),
      ))
  )
    throw new AppError("子笔记的正文与链接未能对应，请核对后重试。", 409);
  for (const child of children)
    if (
      !parseMarkdown(child.markdown).body.trim() ||
      childLinks(child.markdown).length
    )
      throw new AppError("子笔记需要完整正文和有效的引用。", 409);
  return references;
}

export function prepareChildNotes(
  vault: Vault,
  proposalId: string,
  parent: string,
  markdown: string,
  declared?: ChildNoteDraft[],
  legacy = false,
) {
  const { markdown: text, children } = legacy
    ? legacyChildNotes(markdown)
    : { markdown, children: declared || [] };
  const references = validateChildNotes(text, children, false);
  const files = new Map(
    children
      .filter((child) =>
        references.some((link) => link.target === "child-note:" + child.key),
      )
      .map((child) => [
        child.key,
        vault.prepareChildNote(
          parent,
          child.title,
          child.markdown,
          digest(proposalId + ":" + child.key),
        ),
      ]),
  );
  let content = text;
  for (const link of references.reverse())
    content =
      content.slice(0, link.from) +
      noteHref(
        parent,
        files.get(link.target.slice("child-note:".length))!.path,
      ) +
      content.slice(link.to);
  return { markdown: content, children: [...files.values()] };
}

export function addNoteDirectory(markdown: string) {
  if (/^[ \t]*\[TOC\][ \t]*\r?$/m.test(markdown)) return markdown;
  const outline = noteOutline(markdown);
  if (outline.filter((item) => item.level > 1).length < 4) return markdown;
  const first = outline.find((item) => item.level === 1);
  if (!first) return "[TOC]\n\n" + markdown;
  return (
    markdown.slice(0, first.end) + "\n[TOC]\n\n" + markdown.slice(first.end)
  );
}
