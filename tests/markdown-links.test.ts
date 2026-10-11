import test from "node:test";
import assert from "node:assert/strict";
import { links, markdownLinks, rewriteLinks } from "../server/markdown.ts";
import { createNoteResolver } from "../shared/note-links.ts";

test("indexing and refactoring share real Markdown boundaries", () => {
  const literal = [
    "````md\n[[A]] [a](A.md)\n`````",
    "~~~md\n[[A]]\n~~~~",
    "`[[A]]` and ``[a](A.md)``",
    "    [[A]]",
    "<!-- [[A]] -->",
    "<div>\n[[A]]\n</div>",
    "\\[\\[A]]",
  ].join("\n\n");
  const input = "[[A#标题|别名]] [normal](A.md#top)\n\n" + literal;
  assert.deepEqual(links(input), ["A", "A.md"]);
  assert.equal(
    rewriteLinks(input, "A.md", "新/B.md", "Index.md", ["A.md", "Index.md"]),
    "[[新/B#标题|别名]] [normal](%E6%96%B0/B.md#top)\n\n" + literal,
  );
  assert.deepEqual(links("```md\n[[A]]\n"), []);
});
test("Markdown links include nested destinations, images and reference definitions", () => {
  const input =
    '[A](<旧 目录/概念(1).md#原锚> "保留标题")\n![图](img.png)\n[Ref][note]\n[again][note]\n\n[note]: <旧 目录/概念(1).md#top> "Title"';
  const found = markdownLinks(input);
  assert.equal(found.length, 3);
  assert.equal(found[0].target, "旧 目录/概念(1).md#原锚");
  const next = rewriteLinks(
    input,
    "旧 目录/概念(1).md",
    "新/新名.md",
    "Index.md",
    ["旧 目录/概念(1).md", "Index.md"],
  );
  assert.match(
    next,
    /\[A\]\(<%E6%96%B0\/%E6%96%B0%E5%90%8D.md#原锚> "保留标题"\)/,
  );
  assert.match(
    next,
    /\[note\]: <%E6%96%B0\/%E6%96%B0%E5%90%8D.md#top> "Title"/,
  );
  assert.ok(next.includes("![图](img.png)"));
});
test("source offsets preserve BOM, CRLF, aliases, code and unrelated content", () => {
  const input =
    '\uFEFF---\r\nsource: "[[A#head|alias]]"\r\n---\r\n\r\n[**A**](A.md "label")\r\n\r\n~~~\r\n[[A]]\r\n~~~~\r\n';
  const next = rewriteLinks(input, "A.md", "B.md", "Index.md", ["A.md"]);
  assert.equal(
    next,
    input
      .replace("[[A#head|alias]]", "[[B#head|alias]]")
      .replace('(A.md "label")', '(B.md "label")'),
  );
});
test("relative links and unresolved local assets retain destinations when moving the containing note", () => {
  const input =
    "[[../B#heading|alias]] [B](../B.md#part) ![img](../Assets/missing%20image.png) [web](https://example.com/A.md) [local](#self)";
  assert.equal(
    rewriteLinks(input, "Old/A.md", "New/Deep/A.md", "Old/A.md", [
      "Old/A.md",
      "B.md",
    ]),
    "[[B#heading|alias]] [B](../../B.md#part) ![img](../../Assets/missing%20image.png) [web](https://example.com/A.md) [local](#self)",
  );
});
test("resolver shares deterministic ambiguity, Chinese, Windows-case and relative-path behavior", () => {
  const paths = ["One/A.md", "Two/A.md", "Folder/中文.MD", "Root.md"];
  const resolve = createNoteResolver(paths);
  assert.equal(resolve("A", "Index.md"), undefined);
  assert.equal(resolve("A", "One/Index.md"), "One/A.md");
  assert.equal(
    resolve("folder\\中文.md#锚|显示", "Index.md"),
    "Folder/中文.MD",
  );
  assert.equal(
    resolve("../Folder/%E4%B8%AD%E6%96%87.MD#h", "One/Index.md", "markdown"),
    "Folder/中文.MD",
  );
  assert.equal(resolve("../../Root.md", "Index.md", "markdown"), undefined);
  assert.equal(
    rewriteLinks(
      "[[folder/中文#h|a]]",
      "Folder/中文.MD",
      "Folder/中文-new.md",
      "Index.md",
      paths,
    ),
    "[[Folder/中文-new#h|a]]",
  );
  assert.equal(
    rewriteLinks("[[A]]", "One/A.md", "One/B.md", "Index.md", paths),
    "[[A]]",
  );
});
test("reference definitions in literal code and unused reference-looking text do not become relations", () => {
  assert.deepEqual(
    links("[unused]: A.md\n\n`[unused]`\n\n```\n[used]: B.md\n[used]\n```"),
    [],
  );
  assert.deepEqual(links("[x][a]\n\n[a]: ../A.md", "Folder/Note.md"), ["A.md"]);
});

test("image alt text and nested link labels never contribute wrong source offsets", () => {
  const input = "prefix ![label [[A]]](B.png) and [[[A]]](Other.md)";
  assert.deepEqual(links(input), ["B.png", "Other.md"]);
  assert.equal(
    rewriteLinks(input, "A.md", "NEW.md", "Index.md", ["A.md"]),
    input,
  );
});
test("unclosed inline code is bounded by Markdown blocks, including table rows", () => {
  const input =
    "# heading `\n\n[[A]] `\n\n| [[B]] | one |\n| --- | --- |\n| [[C]] | two |";
  assert.deepEqual(links(input), ["A", "B", "C"]);
  assert.equal(
    rewriteLinks(input, "A.md", "New.md", "Index.md", ["A.md"]),
    input.replace("[[A]]", "[[New]]"),
  );
});
