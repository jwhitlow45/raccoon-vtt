import { isWritable } from "./writable.ts";

/*
 * Objects whose keys are already in sorted order at every depth, so they
 * are sent as they are. Kept per object, as the fan-out keeps its hashes
 * (server/rooms/fanout.ts hashOf): a frame's values are the state's own
 * records or ones a projection built, and neither is changed after, except
 * an object a transaction may still write into, which is never kept.
 * Arrays are never kept, since only their items are checked.
 */
const inOrder = new WeakSet<object>();

/** Whether every object inside `value`, itself included, lists its keys in sorted order. */
function sorted(value: object): boolean {
  if (inOrder.has(value)) return true;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "object" && item !== null && !sorted(item)) return false;
    return true;
  }
  let last: string | undefined;
  for (const key of Object.keys(value)) {
    if (last !== undefined && !(last < key)) return false;
    last = key;
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "object" && item !== null && !sorted(item)) return false;
  }
  if (!isWritable(value)) inOrder.add(value);
  return true;
}

/**
 * `value` with every object's keys in sorted order (by UTF-16 code units,
 * as `sort` orders strings) at every depth and every list in its own
 * order: the value itself where that holds already, otherwise copies along
 * the paths where it does not. JSON.stringify then writes the same text for
 * the same value, however its maps and records were built: in which order
 * their keys were made, which were deleted and put back, or how a stored
 * room was read back. A key that reads as an array index still comes first,
 * as JavaScript lists those, so that order too follows from the keys alone.
 */
export function inSortedOrder(value: unknown, key = ""): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return inSortedOrder((value as { toJSON: (key: string) => unknown }).toJSON(key), key);
  if (sorted(value)) return value;
  if (Array.isArray(value)) return value.map((item, i) => inSortedOrder(item, String(i)));
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(value).sort()) out[name] = inSortedOrder((value as Record<string, unknown>)[name], name);
  return out;
}

/** JSON text of `value` as JSON.stringify writes it, with every object's keys in sorted order (inSortedOrder). */
export function sortedJson(value: unknown): string {
  return JSON.stringify(inSortedOrder(value)) ?? "null";
}
