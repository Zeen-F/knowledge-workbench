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
