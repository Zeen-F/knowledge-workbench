import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export function preparePlugin({
  root,
  profileDir,
  executable,
  electron = false,
  preserveLaunch = false,
}) {
  const marketplace = path.join(profileDir, "plugin-marketplace");
  const plugin = path.join(marketplace, "plugins", "knowledge-workbench");
  if (
    !fs.existsSync(path.join(root, "plugins/knowledge-workbench/dist/mcp.cjs"))
  )
    throw new Error("插件尚未构建，请先运行 npm run build。");
  fs.mkdirSync(plugin, { recursive: true });
  function copy(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name),
        to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) throw new Error("插件包不能含有符号链接");
      if (entry.isDirectory()) copy(from, to);
      else fs.writeFileSync(to, fs.readFileSync(from));
    }
  }
  copy(path.join(root, "plugins/knowledge-workbench"), plugin);
  fs.mkdirSync(path.join(marketplace, ".agents/plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(marketplace, ".agents/plugins/marketplace.json"),
    fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json")),
  );
  const transport = {
    command: executable,
    args: [path.join(plugin, "dist/mcp.cjs")],
    env: {
      KWB_PROFILE: profileDir,
      ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
  fs.writeFileSync(
    path.join(plugin, "mcp.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { "knowledge-workbench": { type: "stdio", ...transport } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(plugin, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "knowledge-workbench": {
            ...transport,
            startup_timeout_sec: 30,
            tool_timeout_sec: 60,
          },
        },
      },
      null,
      2,
    ),
  );
  // Portable manifests require a bare command or a contained executable. The
  // documented Codex compatibility format supports the installed runtime's
  // absolute path, including spaces, without copying Electron into the plugin.
  const portable = JSON.parse(
    fs.readFileSync(path.join(plugin, "plugin.json"), "utf8"),
  );
  const compatibility = JSON.parse(
    fs.readFileSync(path.join(plugin, ".codex-plugin/plugin.json"), "utf8"),
  );
  compatibility.interface = portable.extensions["com.openai"].interface;
  fs.writeFileSync(
    path.join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify(compatibility, null, 2),
  );
  fs.unlinkSync(path.join(plugin, "plugin.json"));
  fs.unlinkSync(path.join(plugin, "mcp.json"));
  const packaged = root.endsWith(".asar");
  const launchExecutable = electron
    ? executable
    : createRequire(path.join(root, "package.json"))("electron");
  if (!preserveLaunch)
    fs.writeFileSync(
      path.join(profileDir, "launch.json"),
      JSON.stringify({
        executable: launchExecutable,
        args: packaged ? ["--background"] : [root, "--background"],
      }),
    );
  return {
    marketplace,
    message: `插件已准备。请在终端执行：\n\ncodex plugin marketplace add "${marketplace}"\ncodex plugin add knowledge-workbench@knowledge-workbench-local\n\n随后在 Codex 新对话中启用插件。软件必须保持打开。`,
  };
}
