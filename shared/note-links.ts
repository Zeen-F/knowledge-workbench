/** Canonical vault-relative resolution, shared by navigation, relations and moves. */
export type LinkStyle = "wiki" | "markdown";
export function normalizeNotePath(value: string) {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}
export function localLinkTarget(
  target: string,
  current: string,
  style: LinkStyle,
) {
  let name = target.replace(/^!?\[\[|\]\]$/g, "").split(/[|#]/)[0];
  if (!name || /^[a-z][\w+.-]*:/i.test(name) || name.startsWith("//"))
    return undefined;
  if (style === "markdown") {
    try {
      name = decodeURIComponent(name);
    } catch {
      return undefined;
    }
  }
  if (style === "wiki") return name.replaceAll("\\", "/").replace(/^\//, "");
  return normalizeNotePath(
    !name.startsWith("/")
      ? current.split("/").slice(0, -1).concat(name).join("/")
      : name,
  );
}
export function createNoteResolver(paths: readonly string[]) {
  const stem = (value: string) => value.replace(/\.md$/i, "");
  const exact = new Map<string, string[]>(),
    folded = new Map<string, string[]>(),
    bases = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) =>
    map.set(key, [...(map.get(key) || []), value]);
  for (const value of paths) {
    const key = stem(normalizeNotePath(value) || value);
    add(exact, key, value);
    add(folded, key.toLowerCase(), value);
    add(bases, key.split("/").at(-1)!.toLowerCase(), value);
  }
  const unique = (values?: string[]) =>
    values?.length === 1 ? values[0] : undefined;
  const lookup = (key: string) =>
    unique(exact.get(stem(key))) || unique(folded.get(stem(key).toLowerCase()));
  return (target: string, current: string, style: LinkStyle = "wiki") => {
    const name = localLinkTarget(target, current, style);
    if (!name) return undefined;
    if (style === "markdown") return lookup(name);
    const normalized = normalizeNotePath(name);
    const direct = normalized ? lookup(normalized) : undefined;
    if (direct) return direct;
    const local = normalizeNotePath(
      current.split("/").slice(0, -1).concat(name).join("/"),
    );
    if (local) {
      const found = lookup(local);
      if (found) return found;
    }
    return !name.includes("/")
      ? unique(bases.get(stem(name).toLowerCase()))
      : undefined;
  };
}
