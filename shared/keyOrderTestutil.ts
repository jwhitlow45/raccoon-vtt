/*
 * The same values with their keys in other orders, for the tests of the
 * order a socket's text lists keys in (shared/sortedJson.ts).
 */

function shuffle<T>(items: T[], r: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * `value` with each object's keys in a random order at every depth, as
 * making order, a delete put back and a room read back from storage each
 * leave them. Lists keep their order, but a build chunk's free walls, which
 * a player's copy sorts by their ends, are shuffled too.
 */
export function reordered<T>(value: T, r: () => number, walls = false): T {
  if (Array.isArray(value)) {
    const items = value.map((item) => reordered(item, r));
    return (walls ? shuffle(items, r) : items) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const chunk = "cx" in record && Array.isArray(record.walls);
  return Object.fromEntries(shuffle(Object.keys(record), r).map((name) => [name, reordered(record[name], r, chunk && name === "walls")])) as T;
}

/** A value as Postgres's jsonb gives it back: each object's keys shorter first, then by their bytes. */
export function asJsonb<T>(value: T): T {
  if (Array.isArray(value)) return value.map(asJsonb) as T;
  if (typeof value !== "object" || value === null) return value;
  const names = Object.keys(value).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(names.map((name) => [name, asJsonb((value as Record<string, unknown>)[name])])) as T;
}
