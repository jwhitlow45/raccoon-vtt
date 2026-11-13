import { ID_TIME_REFUSED, idTime, uuidv7 } from "#shared/ids.ts";
import { ID_TIME } from "#shared/limits.ts";
import { mintedIds, type ClientOp, type RefusalCode } from "#shared/protocol.ts";
import type { HistoryCommand } from "./history.ts";

/**
 * The ids a device made for the new things of one op, as the room's id
 * gate reads them (shared/protocol.ts mintedIds). Undo and redo bring
 * back ids and mint none.
 */
export function mintedOf(op: ClientOp | HistoryCommand): string[] {
  return op.t === "undo" || op.t === "redo" ? [] : mintedIds(op);
}

/**
 * How far inside the room's id window an unsent op's id must sit to go as
 * it is after a reconnect. Wide, so an op sent just after it is never
 * refused on the way, and an id made a moment ago keeps its name, and
 * whatever on the page holds it, through a short drop.
 */
export const UNSENT_ID_MARGIN_MS = 5 * 60_000;

/**
 * Whether an id of an op never written to a socket must be made again
 * before it goes: the room would refuse it, or nearly, by its time
 * (shared/limits.ts ID_TIME), or it is not version 7. `now` is the
 * server's time as the device reckons it, which is never ahead of it.
 */
export function unsentIdStale(id: string, now: number): boolean {
  const t = idTime(id);
  return t === null || t > now + 1_000 || t < now - (ID_TIME.behindMs - UNSENT_ID_MARGIN_MS);
}

/**
 * Whether an id of an op already sent, whose answer never came, can never
 * be taken: it is not version 7 or is past the window behind the
 * server's clock, so the copy that went out is refused wherever it lands.
 * Only then is it safe to send that op under a new id: an id that could
 * still be taken keeps its name, or the op could land twice.
 */
export function sentIdDead(id: string, now: number): boolean {
  const t = idTime(id);
  return t === null || t < now - ID_TIME.behindMs - 5_000;
}

/** A refusal of an op for its id's time or version, which the device answers by making the ids again and sending once more. */
export function idTimeRefused(r: { code: RefusalCode; message: string }): boolean {
  return r.code === "invalid" && r.message === ID_TIME_REFUSED;
}

/** A fresh id for each of `ids`, dated `now`. */
export function freshIds(ids: readonly string[], now: number): Map<string, string> {
  return new Map(ids.map((id) => [id, uuidv7(now)]));
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
