import type { RoomState } from "#shared/model.ts";

/**
 * Structural sharing for the view (design section 7.4). The view is rebuilt
 * from `confirmed` and the pending ops whenever either changes, and every
 * replayed op makes new objects. Without this pass a token moved by a
 * pending op would get a new identity on every rebuild, and every selector
 * that reads it would re-render for nothing.
 *
 * So each entity of the new view is compared with the previous view's, and
 * an equal one keeps the old object. A collection whose entities all kept
 * their identity keeps its own, and a view where nothing changed is the
 * previous view itself. The comparison runs only where identities differ,
 * so its cost follows what changed, not the size of the room.
 */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let count = 0;
  for (const key in ao) {
    if (ao[key] === undefined) continue;
    count++;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  for (const key in bo) if (bo[key] !== undefined) count--;
  return count === 0;
}

function shareValue<T>(prev: T | undefined, next: T): T {
  return prev !== undefined && (prev === next || deepEqual(prev, next)) ? prev : next;
}

/** A record of entities by id: each entity keeps its old identity when equal, and so does the record. */
export function shareRecord<T>(prev: Readonly<Record<string, T>> | undefined, next: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  if (!prev || prev === next) return next;
  let out: Record<string, T> | null = null;
  let same = true;
  let count = 0;
  for (const key in next) {
    count++;
    const b = next[key] as T;
    const a = prev[key];
    const v = a === undefined ? b : shareValue(a, b);
    if (v !== b) {
      out ??= { ...next };
      out[key] = v;
    }
    if (v !== a) same = false;
  }
  if (same && count === Object.keys(prev).length) return prev;
  return out ?? next;
}

/** A list matched by `id` when its items have one (the log), by position otherwise (encounter history). */
export function shareList<T>(prev: readonly T[] | undefined, next: readonly T[]): readonly T[] {
  if (!prev || prev === next) return next;
  const idOf = (item: T): string | undefined => {
    const id = (item as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  };
  const byId = new Map<string, T>();
  for (const item of prev) {
    const id = idOf(item);
    if (id !== undefined) byId.set(id, item);
  }
  let same = prev.length === next.length;
  const out = next.map((b, i) => {
    const id = idOf(b);
    const a = id !== undefined ? byId.get(id) : prev[i];
    const v = a === undefined ? b : shareValue(a, b);
    if (v !== prev[i]) same = false;
    return v;
  });
  return same ? prev : out;
}

const LISTS = new Set<keyof RoomState>(["log", "encounterHistory"]);
const SINGLETONS = new Set<keyof RoomState>(["meta", "encounter"]);

export function shareState(prev: RoomState | null, next: RoomState): RoomState {
  if (!prev || prev === next) return next;
  const out: Record<string, unknown> = {};
  let same = Object.keys(prev).length === Object.keys(next).length;
  for (const key of Object.keys(next) as (keyof RoomState)[]) {
    const a = prev[key] as unknown;
    const b = next[key] as unknown;
    let v: unknown;
    if (a === b) v = a;
    else if (LISTS.has(key)) v = shareList(a as unknown[] | undefined, (b ?? []) as unknown[]);
    else if (SINGLETONS.has(key) || b === null || typeof b !== "object") v = shareValue(a, b);
    else v = shareRecord(a as Record<string, unknown> | undefined, b as Record<string, unknown>);
    out[key] = v;
    if (v !== a) same = false;
  }
  return same ? prev : (out as RoomState);
}
