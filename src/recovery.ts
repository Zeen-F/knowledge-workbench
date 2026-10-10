import { recoveryRecordSchema, type StoredRecovery } from "../shared/recovery";
// A volatile copy also survives route changes if browser storage is unavailable.
// Callers visibly distinguish this fallback from a durable recovery draft.
const memory = new Map<string, unknown>();
const volatile = new Set<string>();
type Transport = (
  method: string,
  route: string,
  body?: unknown,
) => Promise<any>;
let remote: { prefix: string; transport: Transport } | undefined;
const versions = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
const failed = new Map<string, Promise<void>>();
const operations = new Map<string, () => Promise<void>>();
function enqueue(key: string, operation: () => Promise<void>) {
  const work = (pending.get(key) || Promise.resolve())
    .catch(() => {})
    .then(operation)
    .then(() => {
      failed.delete(key);
    })
    .catch((error) => {
      failed.set(key, work);
      throw error;
    });
  pending.set(key, work);
  operations.set(key, operation);
  void work.catch(() => {}); // The UI and teardown explicitly observe failures.
  return work;
}
function identity(key: string) {
  if (!remote || !key.startsWith(remote.prefix))
    throw new Error("恢复草稿不属于此知识库");
  const [kind, encodedId = ""] = key.slice(remote.prefix.length).split(":");
  return { kind, id: decodeURIComponent(encodedId) };
}
export async function initializeRemoteRecovery(
  vault: string,
  transport: Transport,
) {
  const data = (await transport("GET", "/recovery")) as {
    records: StoredRecovery[];
  };
  remote = { prefix: `kwb-recovery:${encodeURIComponent(vault)}:`, transport };
  memory.clear();
  versions.clear();
  pending.clear();
  failed.clear();
  operations.clear();
  volatile.clear();
  for (const stored of data.records) {
    const record = recoveryRecordSchema.parse(stored.record);
    const key = recoveryKey(vault, record.kind, record.id);
    memory.set(key, record.value);
    versions.set(key, stored.hash);
  }
}
export async function flushRecovery(key?: string, retryFailed = false) {
  // A later explicit close can retry an acknowledged-safe recovery operation.
  // Conflicting versions still fail; formal note acceptance is never replayed here.
  if (retryFailed)
    for (const [id, failure] of failed) {
      if ((!key || key === id) && pending.get(id) === failure)
        enqueue(id, operations.get(id)!);
    }
  let work: Promise<void>[];
  do {
    work = key
      ? [pending.get(key) || Promise.resolve()]
      : [...pending.values()];
    await Promise.all(work);
  } while (
    key
      ? pending.has(key) && pending.get(key) !== work[0]
      : [...pending.values()].some((p) => !work.includes(p))
  );
}
export function recoveryKey(vault: string, kind: string, id = "") {
  return `kwb-recovery:${encodeURIComponent(vault)}:${kind}:${encodeURIComponent(id)}`;
}
export function readRecovery<T>(key: string): T | undefined {
  if (remote) return memory.get(key) as T;
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
  if (remote) {
    const snapshot = {
      ...identity(key),
      value: JSON.parse(JSON.stringify(value)),
    };
    const transport = remote.transport;
    void enqueue(key, async () => {
      const record = recoveryRecordSchema.parse(snapshot);
      const saved: StoredRecovery = await transport("PUT", "/recovery", {
        record,
        expectedHash: versions.get(key) || null,
      });
      versions.set(key, saved.hash);
    });
    return "pending" as const;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    volatile.delete(key);
    return true;
  } catch {
    volatile.add(key);
    return false;
  }
}
export async function clearRecovery(key: string, expected: unknown) {
  if (JSON.stringify(readRecovery(key)) !== JSON.stringify(expected))
    return false;
  if (remote) {
    const recordId = identity(key),
      transport = remote.transport;
    await enqueue(key, async () => {
      await transport("DELETE", "/recovery", {
        identity: recordId,
        expectedHash: versions.get(key) || null,
      });
      versions.delete(key);
    });
    if (JSON.stringify(readRecovery(key)) !== JSON.stringify(expected))
      return false;
    memory.delete(key);
    return true;
  }
  try {
    localStorage.removeItem(key);
    memory.delete(key);
    volatile.delete(key);
    return true;
  } catch {
    // Removal may be forbidden in an opaque origin. Clear only the acknowledged
    // memory version, keeping stale durable data hidden for this window's lifetime.
    memory.delete(key);
    volatile.add(key);
    return true;
  }
}
