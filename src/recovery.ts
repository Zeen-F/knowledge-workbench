// A volatile copy also survives route changes if browser storage is unavailable.
// Callers visibly distinguish this fallback from a durable recovery draft.
const memory = new Map<string, unknown>();
const volatile = new Set<string>();
export function recoveryKey(vault: string, kind: string, id = "") {
  return `kwb-recovery:${encodeURIComponent(vault)}:${kind}:${encodeURIComponent(id)}`;
}
export function readRecovery<T>(key: string): T | undefined {
  if (volatile.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw);
      memory.set(key, value);
      return value;
    }
    memory.delete(key);
  } catch {
    return memory.get(key) as T;
  }
}
export function writeRecovery(key: string, value: unknown) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
    volatile.delete(key);
    return true;
  } catch {
    volatile.add(key);
    return false;
  }
}
export function clearRecovery(key: string, expected: unknown) {
  if (JSON.stringify(readRecovery(key)) !== JSON.stringify(expected))
    return false;
  try {
    localStorage.removeItem(key);
    memory.delete(key);
    volatile.delete(key);
    return true;
  } catch {
    return false;
  }
}
