import { ID_TIME_REFUSED, idTime, isUuidv7, sealedId, sealedTime, uuidv7, type IdKey } from "#shared/ids.ts";
import { ID_TIME } from "#shared/limits.ts";
import { mintedIds, newIdsOf, type ClientOp, type NewIds, type RefusalCode } from "#shared/protocol.ts";
import type { HistoryCommand } from "./history.ts";

/**
 * The ids a device made for the new things of one op, as the room's id
 * gate reads them (shared/protocol.ts mintedIds). Undo and redo bring
 * back ids and mint none.
 */
export function mintedOf(op: ClientOp | HistoryCommand): string[] {
  return op.t === "undo" || op.t === "redo" ? [] : mintedIds(op);
}

const NO_NEW_IDS: NewIds = { minted: [], recorded: [], keys: [], nested: [] };

/** Every field of one op that can hold a new thing's id (shared/protocol.ts newIdsOf). Undo and redo hold none. */
export function newIdsOfOp(op: ClientOp | HistoryCommand): NewIds {
  return op.t === "undo" || op.t === "redo" ? NO_NEW_IDS : newIdsOf(op);
}

/** Every id in those fields, each once: what a retry of the op may make again (store.ts retryOf). */
export function newIdsIn(op: ClientOp | HistoryCommand): string[] {
  const n = newIdsOfOp(op);
  return [...new Set([...n.minted, ...n.recorded, ...n.keys.map((k) => k.id), ...n.nested.map((k) => k.id)])];
}

/**
 * How far inside the room's id window an unsent op's id must sit to go as
 * it is after a reconnect. Wide, so an op sent just after it is never
 * refused on the way, and an id made a moment ago keeps its name, and
 * whatever on the page holds it, through a short drop.
 */
export const UNSENT_ID_MARGIN_MS = 5 * 60_000;

/**
 * The time this device reads an id at: under its key, a version 8 id's own
 * and never a version 7 one's, since the room takes none from a page with a
 * key. With no key, as before the first snapshot, a version 7 id's.
 */
export function ownIdTime(id: string, key: IdKey | null): number | null {
  if (key === null) return idTime(id);
  return isUuidv7(id) ? null : sealedTime(key, id);
}

/**
 * Whether an id of an op never written to a socket must be made again
 * before it goes: the room would refuse it, or nearly, by its time
 * (shared/limits.ts ID_TIME), or this device's key cannot read it, as a
 * version 7 id or one made under an earlier key. `now` is the server's time
 * as the device reckons it, which is never ahead of it.
 */
export function unsentIdStale(id: string, now: number, key: IdKey | null): boolean {
  const t = ownIdTime(id, key);
  return t === null || t > now + 1_000 || t < now - (ID_TIME.behindMs - UNSENT_ID_MARGIN_MS);
}

/**
 * Whether an id of an op already sent, whose answer never came, can never
 * be taken: this device's key, the one the room reads it under, cannot read
 * it, or it is past the window behind the server's clock, so the copy that
 * went out is refused wherever it lands. Only then is it safe to send that
 * op under a new id: an id that could still be taken keeps its name, or
 * the op could land twice.
 */
export function sentIdDead(id: string, now: number, key: IdKey | null): boolean {
  const t = ownIdTime(id, key);
  return t === null || t < now - ID_TIME.behindMs - 5_000;
}

/** A refusal of an op for its id's time or version, which the device answers by making the ids again and sending once more. */
export function idTimeRefused(r: { code: RefusalCode; message: string }): boolean {
  return r.code === "invalid" && r.message === ID_TIME_REFUSED;
}

/** A fresh id for each of `ids`, made at `now`: sealed under `key`, or version 7 while the device holds none. */
export function freshIds(ids: readonly string[], now: number, key: IdKey | null): Map<string, string> {
  return new Map(ids.map((id) => [id, key === null ? uuidv7(now) : sealedId(key, now)]));
}

/**
 * `value` with every string that is one of the renamed ids swapped for its
 * new one, object keys included. Ids are UUIDs, so no other string can
 * match one. Parts with nothing renamed are kept as they are.
 */
export function renamed<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (ids.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return ids.get(v) ?? v;
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (v && typeof v === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const key = ids.get(k) ?? k;
        const y = walk(x);
        if (key !== k || y !== x) changed = true;
        out[key] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(value) as T;
}
