import fs from "node:fs";
import path from "node:path";

// Keep note paths relative to the real Obsidian vault, even when the user
// chooses a narrower working folder. This preserves existing wiki links.
export function resolveVaultSelection(directory) {
  const scope = fs.realpathSync(directory);
  if (!fs.statSync(scope).isDirectory())
    throw new Error("请选择 Obsidian 知识库或其中的子文件夹");
  let root = scope;
  for (;;) {
    try {
      if (fs.statSync(path.join(root, ".obsidian")).isDirectory()) break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
    const parent = path.dirname(root);
    if (parent === root)
      throw new Error(
        "此文件夹不在 Obsidian 知识库中。请选择含 .obsidian 的库目录，或该库内的资料子文件夹。",
      );
    root = parent;
  }
  const scopePath = path.relative(root, scope).split(path.sep).join("/");
  if (
    scopePath
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") ||
          ["node_modules", "_templates", "_meta"].includes(part),
      )
  )
    throw new Error(
      "请选择保存笔记的资料文件夹，不能选择配置、模板或回收站目录",
    );
  return { root, scope, scopePath };
}
