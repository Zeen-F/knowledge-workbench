import fs from "node:fs";
import path from "node:path";

// Explicit traversal avoids the native Windows recursive-removal failure with
// non-ASCII workspace paths. Never follow junctions or remove outside the test base.
export async function removeTestDirectory(directory, base) {
  // macOS exposes the same temp directory through /var and /private/var.
  // Resolve the parent, never the final entry: a final symlink is unlinked,
  // while a parent symlink that escapes the test base must still be rejected.
  const resolved = path.resolve(directory);
  const canonicalBase = fs.realpathSync.native(base);
  const canonicalDirectory = path.join(
    fs.realpathSync.native(path.dirname(resolved)),
    path.basename(resolved),
  );
  const relative = path.relative(canonicalBase, canonicalDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Unsafe test cleanup path");
  function remove(target) {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(target))
        remove(path.join(target, name));
      fs.rmdirSync(target);
    } else {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (error.code !== "EPERM") throw error;
        fs.chmodSync(target, 0o600);
        fs.unlinkSync(target);
      }
    }
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!fs.existsSync(directory)) return;
    try {
      remove(directory);
      return;
    } catch (error) {
      if (
        attempt === 59 ||
        !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
