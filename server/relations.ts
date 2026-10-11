import path from "node:path";
import type { Vault } from "./vault.ts";
import { createNoteResolver, localLinkTarget } from "../shared/note-links.ts";

export function relatedNotes(vault: Vault, from: string) {
  const notes = vault.list().filter((n) => !n.missing);
  const resolve = createNoteResolver(notes.map((n) => n.path));
  const outgoing = new Map<string, any>(),
    incoming = new Map<string, any>();
  const rows = vault.db.prepare("SELECT * FROM relations").all() as any[];
  const assets = vault.db.prepare("SELECT * FROM assets").all() as any[];
  const sources = vault.db.prepare("SELECT ref FROM sources").all() as any[];
  for (const row of rows) {
    const resolved = resolve(
      row.to_ref,
      row.from_path,
      row.kind === "markdown" ? "markdown" : "wiki",
    );
    const target =
      resolved ||
      (row.kind === "markdown"
        ? localLinkTarget(row.to_ref, row.from_path, "markdown")
        : row.to_ref);
    if (!target) continue;
    if (row.from_path === from) {
      const asset = assets.find(
        (a) =>
          a.path === target ||
          a.path ===
            path.posix.normalize(
              path.posix.join(path.posix.dirname(from), target),
            ),
      );
      const key = asset?.path || target;
      const item = outgoing.get(key);
      if (item) {
        if (!item.kinds.includes(row.kind)) item.kinds.push(row.kind);
        continue;
      }
      const source =
        asset &&
        sources
          .map((s) => JSON.parse(s.ref))
          .find((s) => s.assetPath === asset.path);
      outgoing.set(key, {
        from_path: from,
        to_ref: key,
        kinds: [row.kind],
        kind: asset ? "asset" : "note",
        resolved: Boolean(resolved),
        label: asset
          ? `图片附件 · ${source?.title || "笔记中的图片"}`
          : notes.find((n) => n.path === target)?.title || target,
        ...(asset ? { sha256: asset.hash, assetPath: asset.path } : {}),
      });
    }
    if (
      target === from &&
      row.from_path !== from &&
      notes.some((n) => n.path === row.from_path)
    ) {
      const item = incoming.get(row.from_path);
      if (item) {
        if (!item.kinds.includes(row.kind)) item.kinds.push(row.kind);
      } else incoming.set(row.from_path, { ...row, kinds: [row.kind] });
    }
  }
  const note = vault.read(from);
  return {
    outgoing: [...outgoing.values()],
    incoming: [...incoming.values()],
    related: note.tags.length
      ? vault
          .search(note.tags[0])
          .filter((n) => n.path !== from)
          .slice(0, 8)
      : [],
  };
}
