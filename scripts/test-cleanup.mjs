import fs from "node:fs";
import path from "node:path";

// Explicit traversal avoids the native Windows recursive-removal failure with
// non-ASCII workspace paths. Never follow junctions or remove outside the test base.
export async function removeTestDirectory(directory, base) {
  const relative = path.relative(path.resolve(base), path.resolve(directory));
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
