import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { NoteTree } from "../src/NoteTree.tsx";
const output = path.resolve(".local/tree-benchmark-baseline.mjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
const source = execFileSync("git", ["show", "baaa9ad:src/NoteTree.tsx"], {
  encoding: "utf8",
});
await build({
  stdin: { contents: source, loader: "tsx", resolveDir: path.resolve("src") },
  outfile: output,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  jsx: "automatic",
});
try {
  const { NoteTree: Before } = await import(pathToFileURL(output).href);
  const results = [];
  for (const count of [1000, 10000])
    for (const nested of [false, true]) {
      const notes = Array.from({ length: count }, (_, i) => ({
        path: `${nested ? `Folder-${Math.floor(i / 100)}/` : ""}Note-${i}.md`,
        title: `Synthetic note ${i}`,
      }));
      const samples = [];
      for (const [version, Component] of [
        ["before", Before],
        ["after", NoteTree],
      ]) {
        const times = [];
        let html = "";
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          html = renderToStaticMarkup(
            createElement(Component, {
              notes,
              active: notes.at(-1).path,
              dirty: () => false,
              onOpen: () => {},
            }),
          );
          times.push(performance.now() - start);
        }
        samples.push({
          version,
          medianMs: +times.sort((a, b) => a - b)[1].toFixed(2),
          buttons: (html.match(/<button/g) || []).length,
          htmlBytes: Buffer.byteLength(html),
        });
      }
      results.push({ count, nested, samples });
    }
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        measurement: "React server render only; excludes browser layout/paint",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(output, { force: true });
}
