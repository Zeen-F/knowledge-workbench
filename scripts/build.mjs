import { build } from "esbuild";
import fs from "node:fs";
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  legalComments: "eof",
};
// Ship one self-contained native resource; no nested local website or CDN.
const panel = await build({
  entryPoints: ["src/panel.tsx"],
  bundle: true,
  write: false,
  outdir: "build/panel",
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
});
const js = panel.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = panel.outputFiles.find((f) => f.path.endsWith(".css")).text;
fs.mkdirSync("plugins/knowledge-workbench/ui", { recursive: true });
fs.writeFileSync(
  "plugins/knowledge-workbench/ui/workbench.html",
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识工作台</title><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><div id="root" role="main">正在连接知识工作台…</div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
await build({
  ...common,
  entryPoints: ["server/entry.ts"],
  outfile: "build/service.cjs",
});
// CJS permits Electron's bundled Node runtime; wrap the sole top-level await.
const mcp = fs
  .readFileSync("server/mcp.ts", "utf8")
  .replace(
    "await server.connect(new StdioServerTransport());",
    "void server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });",
  );
await build({
  ...common,
  stdin: {
    contents: mcp,
    resolveDir: process.cwd() + "/server",
    sourcefile: "mcp.ts",
    loader: "ts",
  },
  outfile: "plugins/knowledge-workbench/dist/mcp.cjs",
});
