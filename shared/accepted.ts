import { isWritable } from "./writable.ts";

/**
 * Work a room keeps over the collections of its accepted state: the state
 * its last accepted op or server op left (server/rooms/actor.ts), never a
 * trial an op is checked on, which may be thrown away. A sum or an order
 * over a collection is kept with the entries it was taken over, and a
 * collection of any later state of the room is read from them by the
 * entries that differ: the op's own writes. Only the room's accepted states
 * move what is kept, so no trial, no other room and nothing read before
 * moves what a read costs.
 *
 * A room's states are found by their meta object, which each of them
 * shares until an op writes the meta: the op's own write, which then reads
 * whole sums as before. A state the room never accepted from, as a test's
 * or a deep copy, reads whole sums too.
 */
export type Accepted = { readonly fields: Map<string, Kept>; readonly metas: object[]; readonly named: Map<string, Named> };

/** A part the room made for the facts it read (`sign`), as the far widths read the room's widest ids, kept until the room's facts change. */
type Named = { readonly sign: string; readonly field: string; readonly part: Part<unknown> };

/** No entry under a key, apart from an entry whose value is undefined. */
export const ABSENT: unique symbol = Symbol("absent");

/** An entry that differs between what was kept and a record: its value on each side, ABSENT where that side lacks it. */
export type EntryChange<T = unknown> = { readonly key: string; readonly was: T | typeof ABSENT; readonly now: T | typeof ABSENT };

/**
 * A value worked out over a collection's entries: whole, or stepped from
 * its value over the kept entries by the entries that differ. Both read
 * only the entries, so a stepped value is the whole one.
 */
export type Part<V, T = unknown> = {
  whole(record: Readonly<Record<string, T>>, keys: readonly string[]): V;
  step(value: V, changes: readonly EntryChange<T>[], keys: readonly string[]): V;
};

/**
 * One field's kept entries as they stood when taken, which a part steps
 * from and never the record they came from: a room built in code may be
 * read, filled in place and only then replaced by a copy. `record` is the
 * last one taken, read without a diff.
 */
type Kept = { record: object; taken: Map<string, unknown>; parts: Map<Part<unknown>, unknown> };

/** Past this many entries that differ, a part is worked out whole, as for a record mostly replaced. */
export const MOST_CHANGED = 64;

/**
 * Keys read and entries a part read, whole or stepped, counted for tests
 * that hold a player's work alike whatever hidden work came before it.
 */
export const keptWork = { keys: 0, entries: 0 };

const byMeta = new WeakMap<object, Accepted>();

/** Each part's value over each record read, kept per record object, which is replaced and never changed (writable.ts). */
const values = new WeakMap<object, Map<Part<unknown>, unknown>>();

function remember(record: object, part: Part<unknown>, value: unknown): void {
  let kept = values.get(record);
  if (!kept) values.set(record, (kept = new Map()));
  kept.set(part, value);
}

export function newAccepted(): Accepted {
  return { fields: new Map(), metas: [], named: new Map() };
}

/** The room's accepted work for a state of it, if the room keeps any. */
export function acceptedOf(state: { readonly meta: object }): Accepted | undefined {
  return byMeta.get(state.meta);
}

/**
 * Finds the room's work by this accepted state's meta. A meta the room
 * wrote two writes back is let go, and its states read whole sums.
 */
export function markAccepted(accepted: Accepted, state: { readonly meta: object }): void {
  if (accepted.metas.includes(state.meta)) return;
  accepted.metas.push(state.meta);
  byMeta.set(state.meta, accepted);
  if (accepted.metas.length > 2) byMeta.delete(accepted.metas.shift()!);
}

/** The room is gone: its work goes with it. */
export function releaseAccepted(accepted: Accepted): void {
  for (const meta of accepted.metas) byMeta.delete(meta);
  accepted.metas.length = 0;
  accepted.fields.clear();
  accepted.named.clear();
}

/**
 * The part `name` of the room's `field` for the room's facts `sign`, made
 * by `make`: the one the room keeps while its accepted state's facts read
 * `sign`. An accepted state whose facts read otherwise (`take`) replaces
 * it, and the old part leaves what the field keeps, so no part of facts
 * the room no longer has is stepped again. Any other state whose facts
 * differ, and a state of no room, reads with a part of its own, worked out
 * whole, and moves nothing. So each room holds its own parts, whatever
 * other rooms read, and one part a name.
 */
export function roomPart<V, T>(state: { readonly meta: object }, field: string, name: string, sign: string, make: () => Part<V, T>, take = false): Part<V, T> {
  const accepted = acceptedOf(state);
  const held = accepted?.named.get(name);
  if (held?.sign === sign) return held.part as Part<V, T>;
  const part = make();
  if (accepted === undefined || !take) return part;
  if (held) accepted.fields.get(held.field)?.parts.delete(held.part);
  accepted.named.set(name, { sign, field, part: part as Part<unknown> });
  return part;
}

/** The entries of `next`, whose keys are `keys`, that differ from `taken` by value object, or null past MOST_CHANGED of them. */
function changesFrom(taken: Map<string, unknown>, next: Readonly<Record<string, unknown>>, keys: readonly string[]): EntryChange[] | null {
  keptWork.keys += keys.length;
  const out: EntryChange[] = [];
  let shared = 0;
  for (const key of keys) {
    const now = next[key];
    const held = taken.has(key);
    if (held) {
      shared++;
      if (taken.get(key) === now) continue;
    }
    if (out.length === MOST_CHANGED) return null;
    out.push({ key, was: held ? taken.get(key) : ABSENT, now });
  }
  if (shared < taken.size) {
    keptWork.keys += taken.size;
    for (const [key, was] of taken) {
      if (Object.hasOwn(next, key)) continue;
      if (out.length === MOST_CHANGED) return null;
      out.push({ key, was, now: ABSENT });
    }
  }
  return out;
}

function whole<V>(part: Part<V>, record: Readonly<Record<string, unknown>>, keys: readonly string[]): V {
  keptWork.entries += keys.length;
  return part.whole(record, keys);
}

function stepped<V>(part: Part<V>, value: V, changes: readonly EntryChange[], keys: readonly string[]): V {
  keptWork.entries += changes.length;
  return part.step(value, changes, keys);
}

/**
 * `part` over `record`, the room's `field` in `state`: read from what the
 * room keeps, or whole where it keeps nothing, the record may still be
 * written, or too much differs. `take` is for an accepted state alone: it
 * moves what the field keeps on to `record`, every part it keeps with it.
 */
export function keptPart<V, T>(state: { readonly meta: object }, field: string, record: Readonly<Record<string, T>>, part: Part<V, T>, take = false): V {
  const accepted = acceptedOf(state);
  const p = part as Part<unknown>;
  if (isWritable(record)) return whole(p, record, Object.keys(record)) as V;
  const known = values.get(record);
  if (!take && known?.has(p)) return known.get(p) as V;
  if (accepted === undefined) {
    const value = known?.has(p) ? known.get(p) : whole(p, record, Object.keys(record));
    remember(record, p, value);
    return value as V;
  }
  const kept = accepted.fields.get(field);
  if (kept?.record === record && kept.parts.has(p)) return kept.parts.get(p) as V;
  const keys = Object.keys(record);
  const changes = kept === undefined ? null : changesFrom(kept.taken, record, keys);
  const value = known?.has(p) ? known.get(p) : kept !== undefined && changes !== null && kept.parts.has(p) ? stepped(p, kept.parts.get(p), changes, keys) : whole(p, record, keys);
  remember(record, p, value);
  if (!take) return value as V;
  if (kept !== undefined && changes !== null) {
    for (const [other, was] of kept.parts) if (other !== p) kept.parts.set(other, stepped(other, was, changes, keys));
    for (const { key, now } of changes) {
      if (now === ABSENT) kept.taken.delete(key);
      else kept.taken.set(key, now);
    }
    kept.record = record;
    kept.parts.set(p, value);
  } else {
    accepted.fields.set(field, { record, taken: new Map(keys.map((key) => [key, record[key]])), parts: new Map([[p, value]]) });
  }
  return value as V;
}
