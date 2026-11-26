import type { RoomState } from "#shared/model.ts";

/*
 * The states the views ring keeps (actor.ts #keepView), held as what each
 * differs by from the next view's. A batch copies each
 * collection it writes before its first write (shared/writable.ts), so two
 * views a tick apart hold their own copy of every record a batch touched,
 * each copy as large as the record: under full-rate play near the far line,
 * two seconds of them cost about 20 MiB a room. Here a view a newer one
 * follows keeps only the fields that differ, and of a record only the
 * entries that differ, with where the keys the newer view lost stood, so
 * the record reads back in its own key order. Its state is read back
 * through every newer view to the newest, which is whole, a field at a
 * time as a reader asks for it.
 */

/** One field of an older view: its whole value, or of a record the entries that differ from the newer view's. */
type FieldDelta =
  | { kind: "whole"; value: unknown }
  | {
      kind: "record";
      /** The older value of each entry that differs, those the newer record lacks included. */
      changed: Map<string, unknown>;
      /** Where each key the newer record lacks stood among the older record's keys, in key order. */
      lost: Array<readonly [index: number, key: string]>;
      /** Keys the newer record holds that the older lacks. */
      gained: Set<string>;
    };

/** An older view's state against the next view's: its fields in order, and those that differ. A field left out is the next view's. */
type StateDelta = { order: string[]; fields: Map<string, FieldDelta> };

/**
 * A view's state in the ring: whole while it is the newest, and once a
 * newer view follows, its delta against that one, through `next`.
 */
export type ViewLink = { whole: RoomState | null; delta: StateDelta | null; next: ViewLink | null };

export function wholeLink(state: RoomState): ViewLink {
  return { whole: state, delta: null, next: null };
}

/**
 * Keeps `link`, whole, as its delta against `newer`, whole too, and lets go
 * of its whole state. Returns the state readers take from it from now on,
 * which reads each field back as it is first asked for.
 */
export function compactLink(link: ViewLink, newer: ViewLink): RoomState {
  const older = link.whole;
  const next = newer.whole;
  if (older === null || next === null) throw new Error("only a whole view is kept against a whole newer one");
  const order = Object.keys(older);
  const fields = new Map<string, FieldDelta>();
  for (const field of order) {
    const was = (older as Record<string, unknown>)[field];
    const now = (next as Record<string, unknown>)[field];
    // A field left out is read from the newer view, and on through the views after it, so only one the newer view
    // holds as the same value is left out. One it lacks is kept whole, even as undefined: a later view may hold it again.
    if (was === now && Object.hasOwn(next, field)) continue;
    fields.set(field, recordDelta(was, now) ?? { kind: "whole", value: was });
  }
  link.delta = { order, fields };
  link.next = newer;
  link.whole = null;
  return stateOf(link);
}

/** The entries of record `was` that differ from record `now`, or null when either is not a plain record, the two do not keep their shared keys in one order, or the delta would save nothing. */
function recordDelta(was: unknown, now: unknown): FieldDelta | null {
  if (!plainRecord(was) || !plainRecord(now)) return null;
  const wasKeys = Object.keys(was);
  const nowKeys = Object.keys(now);
  const changed = new Map<string, unknown>();
  const lost: Array<readonly [number, string]> = [];
  const gained = new Set<string>();
  for (const key of nowKeys) if (!Object.hasOwn(was, key)) gained.add(key);
  let n = 0;
  for (let i = 0; i < wasKeys.length; i++) {
    const key = wasKeys[i]!;
    if (!Object.hasOwn(now, key)) {
      lost.push([i, key]);
      changed.set(key, was[key]);
      continue;
    }
    // The keys both hold come in one order in both, or the record could not be read back in its own.
    while (n < nowKeys.length && gained.has(nowKeys[n]!)) n++;
    if (nowKeys[n] !== key) return null;
    n++;
    if (was[key] !== now[key]) changed.set(key, was[key]);
  }
  if (2 * (changed.size + gained.size) > wasKeys.length) return null;
  return { kind: "record", changed, lost, gained };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A view's state: its whole one, or one that reads each field back through the newer views the first time it is asked for, and keeps it. */
export function stateOf(link: ViewLink): RoomState {
  if (link.whole !== null) return link.whole;
  const out: Record<string, unknown> = {};
  for (const field of link.delta!.order) {
    Object.defineProperty(out, field, {
      enumerable: true,
      configurable: true,
      get() {
        const value = fieldOf(link, field);
        Object.defineProperty(out, field, { value, enumerable: true, writable: true, configurable: true });
        return value;
      },
    });
  }
  return out as unknown as RoomState;
}

/** One field of a view, read back from the nearest newer view that holds it whole, through each delta between. */
function fieldOf(link: ViewLink, field: string): unknown {
  const deltas: FieldDelta[] = [];
  let at: ViewLink | null = link;
  let value: unknown;
  for (;;) {
    if (at === null) throw new Error("a view's delta leads past the newest view");
    if (at.whole !== null) {
      value = (at.whole as Record<string, unknown>)[field];
      break;
    }
    const delta = at.delta!.fields.get(field);
    if (delta?.kind === "whole") {
      value = delta.value;
      break;
    }
    if (delta) deltas.push(delta);
    at = at.next;
  }
  for (let i = deltas.length - 1; i >= 0; i--) value = applyRecord(deltas[i] as Extract<FieldDelta, { kind: "record" }>, value as Record<string, unknown>);
  return value;
}

/** The older record from the newer one and the delta between them, in the older record's key order. */
function applyRecord(delta: Extract<FieldDelta, { kind: "record" }>, now: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let lost = 0;
  let at = 0;
  const putLost = () => {
    while (lost < delta.lost.length && delta.lost[lost]![0] === at) {
      const key = delta.lost[lost++]![1];
      out[key] = delta.changed.get(key);
      at++;
    }
  };
  for (const key of Object.keys(now)) {
    if (delta.gained.has(key)) continue;
    putLost();
    out[key] = delta.changed.has(key) ? delta.changed.get(key) : now[key];
    at++;
  }
  putLost();
  return out;
}
