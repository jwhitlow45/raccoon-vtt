import { ephCaps, isGroupFrame, MAX_DRAG_TOKENS, MAX_EPH_BYTES, MAX_PATH_NUMBERS, type EphEvent, type GroupFrame, type GroupRoster } from "#shared/protocol.ts";
import type { SentPreview } from "./connection.ts";
import { dragKey, gestureKey, MOST_PREVIEWS_SENT } from "./ephemeral.ts";

/*
 * What a socket's group drag frames keep on the server (design 7.6): each
 * gesture's rosters as immutable versions, and its frames in a compact form
 * while they wait for their tick (RoomActor.ephemeral). Everything is
 * charged by its parsed shape (ephCaps.charges), never by the bytes it was
 * sent in, and the store stores meaning, not text: ids in an array, numbers
 * in Float64Arrays.
 */

/** How long a gesture with no frame keeps its rosters, as a preview with no frame keeps its last one (ephemeral.ts PREVIEW_STALE_MS). */
export const GESTURE_STALE_MS = 10_000;
/** The most roster versions a socket retains, open, closed and pinned alike, and their charges. */
export const MAX_VERSIONS = 24;
export const MAX_VERSION_BYTES = 448 * 1024;
/** How often the server asks a gesture for its roster again (`need`). */
export const NEED_EVERY_MS = 1_000;

/**
 * One roster as it arrived: its gesture, its arrival, and the held frames
 * bound to it (`pins`). A version is closed when its gesture ends or a newer
 * roster of the gesture arrives, and goes once no held frame still needs it.
 */
export type RosterVersion = GroupRoster & {
  readonly g: number;
  readonly seq: number;
  readonly charge: number;
  pins: number;
  closed: boolean;
  /** When a frame last bound it, in binding order, for the least recently framed to go first. */
  framed: number;
};

/** A frame's roster as a version keeps it: its ids, and its starts in an array of doubles, 8 bytes each. */
function storedRoster(e: GroupFrame): GroupRoster | null {
  if (e.with === undefined || e.from === undefined) return null;
  const starts = new Array<number>(e.with.length * 2);
  for (const [i, m] of e.with.entries()) {
    starts[2 * i] = m.x;
    starts[2 * i + 1] = m.y;
  }
  return { from: { x: e.from.x, y: e.from.y }, ids: e.with.map((m) => m.tokenId), starts };
}

/** A version's charge: its own, and each member's. */
export function versionCharge(members: number): number {
  return ephCaps.charges.version + ephCaps.charges.member * members;
}

/** What one held message is charged while it waits: by its kind alone. */
export function heldCharge(e: EphEvent | GroupFrame): number {
  switch (e.k) {
    case "dragMove":
    case "groupEnd":
      return ephCaps.charges.move;
    case "ruler":
    case "aoe":
      return ephCaps.charges.measure;
    default:
      return ephCaps.charges.other;
  }
}

/*
 * What one receiver may be sent for a held message at the most (RoomActor's
 * room count and member shares, MAX_ROOM_HELD_SENDS), as JSON on the wire:
 * each message its kind's widest, never what the frame names. Its scene's
 * and its tokens' ids are 64 units that JSON escapes to 6 characters each,
 * every number 25 characters, every optional field present, and the
 * sender's member id 36 characters, as the server mints it
 * (auth/roomRecords.ts). A group frame sends each of its at most 100 tokens such a message, one of
 * them with the longest route. A lone drag, ruler or area is at its wire
 * cap (MAX_EPH_BYTES), anything else at its widest.
 */
const WIDEST_ID = "\u0001".repeat(64);
const WIDEST_NUMBER = -0.0000012345678901234567;
const MEMBER_ID = "0".repeat(36);

/** The widest event of each kind a held frame's routing may send but a capped one, every field its schema takes present (shared/protocol.ts ephUnion). */
export const WIDEST_EVENTS = {
  dragStart: { k: "dragStart", tokenId: WIDEST_ID, x: WIDEST_NUMBER, y: WIDEST_NUMBER },
  dragMove: { k: "dragMove", tokenId: WIDEST_ID, x: WIDEST_NUMBER, y: WIDEST_NUMBER, ft: WIDEST_NUMBER, squeeze: true, free: true },
  dragEnd: { k: "dragEnd", tokenId: WIDEST_ID, x: WIDEST_NUMBER, y: WIDEST_NUMBER, squeeze: true },
  dragCancel: { k: "dragCancel", tokenId: WIDEST_ID },
  rulerEnd: { k: "rulerEnd", id: WIDEST_ID },
  aoeEnd: { k: "aoeEnd", id: WIDEST_ID },
  ping: { k: "ping", x: WIDEST_NUMBER, y: WIDEST_NUMBER },
  laser: { k: "laser", x: WIDEST_NUMBER, y: WIDEST_NUMBER, on: false },
  focus: { k: "focus", x: WIDEST_NUMBER, y: WIDEST_NUMBER, zoom: WIDEST_NUMBER },
  view: { k: "view", x: WIDEST_NUMBER, y: WIDEST_NUMBER, w: WIDEST_NUMBER, h: WIDEST_NUMBER, iso: { turn: WIDEST_NUMBER, vw: WIDEST_NUMBER, vh: WIDEST_NUMBER } },
} as const;

/** One message's bytes as a receiver is sent it (ephemeral.ts Outbox.deliver). */
function sentBytes(e: object): number {
  return Buffer.byteLength(JSON.stringify({ t: "eph", from: MEMBER_ID, sceneId: WIDEST_ID, e }));
}

const WIDE = Object.fromEntries(Object.entries(WIDEST_EVENTS).map(([k, e]) => [k, sentBytes(e)])) as Record<keyof typeof WIDEST_EVENTS, number>;
/** What the longest route adds to the one token's message that carries it. */
const ROUTE = sentBytes({ ...WIDEST_EVENTS.dragMove, path: new Array<number>(MAX_PATH_NUMBERS).fill(WIDEST_NUMBER) }) - WIDE.dragMove;
/** A message whose event is at its wire cap: the envelope, less the `{}` of an empty event, and the cap. */
const CAPPED = sentBytes({}) - 2 + MAX_EPH_BYTES;

/** A preview's one cancel, a drag token's, a ruler's or an area's. */
export const CANCEL_SENDS = Math.max(WIDE.dragCancel, WIDE.rulerEnd, WIDE.aoeEnd);
/** Every token of a drag's entry cancelled at once: as a step names other tokens (ephemeral.ts endLeft), or as an entry goes to make room (keepSent). */
export const CANCELS_SENDS = MAX_DRAG_TOKENS * CANCEL_SENDS;

const GROUP_SENDS: Record<GroupFrame["k"], number> = {
  dragStart: MAX_DRAG_TOKENS * WIDE.dragStart,
  dragMove: MAX_DRAG_TOKENS * WIDE.dragMove + ROUTE,
  // A token with no landing ends as a cancel.
  groupEnd: MAX_DRAG_TOKENS * Math.max(WIDE.dragEnd, WIDE.dragCancel),
  dragCancel: MAX_DRAG_TOKENS * WIDE.dragCancel,
};

/** What one receiver may be sent for a held message's own tokens or event, by its kind alone. */
export function heldSends(e: EphEvent | GroupFrame): number {
  if (isGroupFrame(e)) return GROUP_SENDS[e.k];
  switch (e.k) {
    case "dragStart":
    case "dragMove":
    case "dragEnd":
    case "ruler":
    case "aoe":
      return CAPPED;
    default:
      return WIDE[e.k];
  }
}

/**
 * What a member's devices hold through a stall of RETAIN_MS at the most
 * when every frame they send is a device's own (D-261126-265), by the
 * charges above: a drag that changes floor and ends (its latest move on
 * the old floor, its cancel there, the new floor's move with its roster
 * and the latest one after it, and its end), the next drag started (its
 * start and latest move), a ruler and its end, and a laser and a camera
 * each sent 30 times a second, as a device sends a preview at the most.
 */
export const HONEST_MEMBER_SENDS =
  GROUP_SENDS.dragMove + GROUP_SENDS.dragCancel + GROUP_SENDS.dragMove + GROUP_SENDS.dragMove + GROUP_SENDS.groupEnd +
  GROUP_SENDS.dragStart + GROUP_SENDS.dragMove +
  CAPPED + WIDE.rulerEnd +
  60 * (WIDE.laser + WIDE.view);

/**
 * What a held frame's routing may send one receiver beyond its own
 * messages, added to its sends, read from its socket's entries and held
 * frames alone, never from the room: every token of its gesture's entry
 * cancelled when its pressed token or roster differs from the step before
 * it (ephemeral.ts endLeft), and an older entry's cancels when it may add
 * an entry past the socket's most (keepSent), a drag's tokens or one
 * preview's. `skip` is a held frame it takes the place of.
 */
export function chargeCancels(frame: HeldFrame, held: readonly HeldFrame[], entries: ReadonlyMap<string, SentPreview>, skip: HeldFrame | null): void {
  frame.leaves = frame.slot !== null && frame.slot.key.startsWith("drag#") && mayLeave(frame, held, entries.get(frame.slot.key), skip);
  frame.sends += (frame.leaves ? CANCELS_SENDS : 0) + mayEvict(frame, held, entries, skip);
}

/*
 * The step before a group frame's is its gesture's last held frame, or its
 * entry as it stands when none waits. A frame differs from a step by its
 * pressed token, or by its roster when it binds one, since a frame that
 * binds none keeps the step's. A step that ends its gesture leaves no entry
 * to differ from. Should that step not route, the entry may differ where
 * the step did not, and the router then sends the frame nowhere
 * (ephemeral.ts routeDrags), so what it sends stays within its charge.
 */
function mayLeave(frame: HeldFrame, held: readonly HeldFrame[], entry: SentPreview | undefined, skip: HeldFrame | null): boolean {
  const key = frame.slot!.key;
  for (let i = held.length - 1; i >= 0; i--) {
    const last = held[i]!;
    if (last === skip || last.slot?.key !== key) continue;
    return !last.slot.closes && (last.names !== frame.names || (frame.version !== null && last.version !== frame.version));
  }
  return entry !== undefined && (entry.id !== frame.names || (frame.version !== null && entry.members?.ids !== frame.version.ids));
}

/*
 * An entry goes to make room only when a frame adds one to a socket whose
 * entries are at their most. The entries as the frame routes are at most
 * those the socket has now and those its held frames before it may add.
 * The one that goes is never the frame's own, so it cancels a drag's
 * tokens only when one of the others is a group drag's.
 */
function mayEvict(frame: HeldFrame, held: readonly HeldFrame[], entries: ReadonlyMap<string, SentPreview>, skip: HeldFrame | null): number {
  const own = keptEntry(frame);
  if (own === null || entries.size + held.length + 1 <= MOST_PREVIEWS_SENT) return 0;
  const keys = new Set(entries.keys());
  for (const h of held) {
    const key = h === skip ? null : keptEntry(h);
    if (key !== null) keys.add(key);
  }
  keys.add(own);
  if (keys.size <= MOST_PREVIEWS_SENT) return 0;
  for (const key of keys) if (key !== own && key.startsWith("drag#")) return CANCELS_SENDS;
  return CANCEL_SENDS;
}

/** The entry a held frame keeps on its socket once it routes (Connection.previewsSent): its slot's unless it ends it, or a lone drag's token's. */
function keptEntry(h: HeldFrame): string | null {
  if (h.slot !== null) return h.slot.closes ? null : h.slot.key;
  return "k" in h.e && (h.e.k === "dragStart" || h.e.k === "dragMove") ? dragKey(h.e.tokenId) : null;
}

/**
 * Where a held message may take an older one's place (design 7.6, D-261126-208):
 * its gesture's, ruler's or area's slot, whether it is a newer frame of the
 * kind that replaces (a move, a ruler, an area), and whether a newer one
 * may replace it. A group move that carries a roster replaces but stays,
 * and starts, ends and cancels neither replace nor go. `opens` marks a
 * gesture's start and `closes` an end or a cancel that ends its slot's
 * preview. Read from the message's kind, gesture, id and whether it
 * carries a roster, never from its roster's members.
 */
export type HeldSlot = { readonly key: string; readonly replaces: boolean; readonly replaceable: boolean; readonly opens: boolean; readonly closes: boolean };

export function heldSlot(e: EphEvent | GroupFrame): HeldSlot | null {
  if (isGroupFrame(e)) {
    const move = e.k === "dragMove";
    return { key: gestureKey(e.g), replaces: move, replaceable: move && e.with === undefined, opens: e.k === "dragStart", closes: e.k === "groupEnd" || e.k === "dragCancel" };
  }
  switch (e.k) {
    case "ruler":
    case "aoe":
      return { key: `${e.k}:${e.id}`, replaces: true, replaceable: true, opens: false, closes: false };
    case "rulerEnd":
      return { key: `ruler:${e.id}`, replaces: false, replaceable: false, opens: false, closes: true };
    case "aoeEnd":
      return { key: `aoe:${e.id}`, replaces: false, replaceable: false, opens: false, closes: true };
    default:
      return null;
  }
}

/**
 * A gesture's rosters on one socket. A frame binds at arrival to its
 * gesture's open version and keeps it for its whole held life. A frame
 * that carries a roster makes a new version first, which becomes the open
 * one, and an end or a tagged cancel closes every version of its gesture.
 * To make room the least recently framed version no held frame pins goes,
 * open or closed. When every one is pinned the new version is refused, and
 * so is the frame that carried it: its gesture recovers by `need` once the
 * held frames route.
 */
export class GestureVersions {
  #open = new Map<number, RosterVersion>();
  #retained = new Set<RosterVersion>();
  #bytes = 0;
  #seq = 0;
  #framed = 0;
  /** Each gesture's last frame on the socket's clock, for the sweep. */
  #last = new Map<number, number>();
  #needAt = new Map<number, number>();

  /** How many versions the socket retains and what they are charged, for its tests and the pool's. */
  get retained(): { versions: number; bytes: number } {
    return { versions: this.#retained.size, bytes: this.#bytes };
  }

  /**
   * Binds a frame as it arrives at `at`: the version it routes with, pinned
   * until `release`, null when its gesture has none open, or "refused" when
   * its roster found no room.
   */
  arrive(e: GroupFrame, at: number): RosterVersion | null | "refused" {
    this.#last.delete(e.g);
    this.#last.set(e.g, at);
    const roster = storedRoster(e);
    if (roster !== null) {
      const charge = versionCharge(roster.ids.length);
      if (!this.#makeRoom(charge)) return "refused";
      const before = this.#open.get(e.g);
      if (before) this.#close(before);
      const version: RosterVersion = { ...roster, g: e.g, seq: ++this.#seq, charge, pins: 0, closed: false, framed: 0 };
      this.#retained.add(version);
      this.#bytes += charge;
      this.#open.set(e.g, version);
    }
    const bound = this.#open.get(e.g) ?? null;
    if (bound) {
      bound.pins++;
      bound.framed = ++this.#framed;
    }
    if (e.k === "dragCancel" || e.k === "groupEnd") {
      for (const v of [...this.#retained]) if (v.g === e.g) this.#close(v);
      this.#open.delete(e.g);
    }
    return bound;
  }

  /** A held frame bound to `version` routed or was dropped. */
  release(version: RosterVersion | null): void {
    if (version === null) return;
    version.pins--;
    this.#freeIfDone(version);
  }

  /** Whether the gesture may be asked for its roster at `at`, at most once every NEED_EVERY_MS, which then counts as asked. */
  mayAsk(g: number, at: number): boolean {
    const last = this.#needAt.get(g);
    if (last !== undefined && at - last < NEED_EVERY_MS) return false;
    this.#needAt.set(g, at);
    return true;
  }

  /** Every gesture with no frame for GESTURE_STALE_MS gives up its versions. A pinned one goes once its frames are gone. */
  sweep(now: number): void {
    for (const [g, last] of this.#last) {
      if (now - last < GESTURE_STALE_MS) break;
      this.#last.delete(g);
      this.#needAt.delete(g);
      this.#open.delete(g);
      for (const v of [...this.#retained]) if (v.g === g) this.#close(v);
    }
  }

  /** The socket went: its versions and asks go with it. */
  clear(): void {
    this.#open.clear();
    this.#retained.clear();
    this.#bytes = 0;
    this.#last.clear();
    this.#needAt.clear();
  }

  #close(v: RosterVersion): void {
    v.closed = true;
    if (this.#open.get(v.g) === v) this.#open.delete(v.g);
    this.#freeIfDone(v);
  }

  #freeIfDone(v: RosterVersion): void {
    if (!v.closed || v.pins > 0 || !this.#retained.delete(v)) return;
    this.#bytes -= v.charge;
  }

  #makeRoom(charge: number): boolean {
    while (this.#retained.size + 1 > MAX_VERSIONS || this.#bytes + charge > MAX_VERSION_BYTES) {
      let oldest: RosterVersion | null = null;
      for (const v of this.#retained) if (v.pins === 0 && (oldest === null || v.framed < oldest.framed)) oldest = v;
      if (oldest === null) return false;
      this.#retained.delete(oldest);
      this.#bytes -= oldest.charge;
      if (this.#open.get(oldest.g) === oldest) this.#open.delete(oldest.g);
    }
    return true;
  }
}

/**
 * A group frame as it waits for its tick, without its roster, which its
 * version holds. Every number is in one array of doubles: the point, the
 * cost and the lead's point and cost (NaN where absent, which no JSON
 * number can be), then the route, the members' costs (NaN for null) and
 * the landings, three a token (x, y, and 1 for a squeezed one, NaN for
 * none), whose counts follow.
 */
export type StoredGroupFrame = {
  readonly stored: "group";
  readonly k: GroupFrame["k"];
  readonly tokenId: string;
  readonly g: number;
  readonly nums: number[];
  readonly path: number;
  readonly fts: number;
  readonly at: number;
  /** The lead's roster index, or -1 for no lead. */
  readonly lead: number;
  /** 1 squeeze, 2 free, 4 the lead squeezes, 8 the route is the lead's. */
  readonly flags: number;
};

/** A ruler as it waits, as the UTF-8 bytes of its JSON in a one-byte string: never more than its 4 KiB cap and a header, whatever it names. */
export type StoredText = { readonly stored: "text"; readonly latin1: string };

/** A frame as it waits for its tick (actor.ts RoomActor.ephemeral): its kept form, the version it bound and its moments, and its charge. */
export type HeldFrame = {
  sceneId: string;
  e: EphEvent | StoredGroupFrame | StoredText;
  version: RosterVersion | null;
  arrived: number;
  a: number;
  at: number;
  bytes: number;
  /** Its pressed token or id, which a newer frame of its slot must name to take its place. */
  names: string;
  slot: HeldSlot | null;
  /** What one receiver may be sent for it at the most: its own messages (heldSends), and what its routing may cancel (chargeCancels). */
  sends: number;
  /** Whether its sends cover the cancels of its gesture's tokens it no longer names (chargeCancels). One whose do not, and that would send them, routes nowhere. */
  leaves: boolean;
};

/** A frame as it is put in its socket's held queue (RoomActor.ephemeral): its kept form, its charges and its slot. */
export function holdFrame(sceneId: string, e: EphEvent | GroupFrame, version: RosterVersion | null, arrived: number, a: number, at: number): HeldFrame {
  const names = "tokenId" in e ? e.tokenId : "id" in e ? e.id : "";
  return { sceneId, e: heldForm(e), version, arrived, a, at, bytes: heldCharge(e), names, slot: heldSlot(e), sends: heldSends(e), leaves: false };
}

const absent = (v: number | undefined): number => v ?? Number.NaN;
const present = (v: number): number | undefined => (Number.isNaN(v) ? undefined : v);

function push(out: number[], list: readonly (number | null)[] | undefined): number {
  if (list === undefined) return -1;
  for (const v of list) out.push(v ?? Number.NaN);
  return list.length;
}

/** Doubles in an array of their own kind, 8 bytes each, as JSON.parse's own may not be. */
function doubles(list: readonly number[]): number[] {
  const out = new Array<number>(list.length);
  for (let i = 0; i < list.length; i++) out[i] = list[i]!;
  return out;
}

/** What a frame keeps while it waits. A lone frame keeps its own form, a route in an array of doubles, and a ruler its bytes. */
export function heldForm(e: EphEvent | GroupFrame): HeldFrame["e"] {
  if ("g" in e) return storeGroupFrame(e);
  if (e.k === "ruler") return { stored: "text", latin1: Buffer.from(JSON.stringify(e), "utf8").toString("latin1") };
  if (e.k === "dragMove" && e.path) return { ...e, path: doubles(e.path) };
  return e;
}

/** A held frame back in the form the router reads. */
export function routedForm(e: HeldFrame["e"]): EphEvent | GroupFrame {
  if (!("stored" in e)) return e;
  if (e.stored === "text") return JSON.parse(Buffer.from(e.latin1, "latin1").toString("utf8")) as EphEvent;
  return loadGroupFrame(e);
}

export function storeGroupFrame(e: GroupFrame): StoredGroupFrame {
  const move = e.k === "dragMove" ? e : null;
  const nums: number[] = [];
  nums.push("x" in e ? e.x : Number.NaN, "y" in e ? e.y : Number.NaN, absent(move?.ft), absent(move?.lead?.x), absent(move?.lead?.y), absent(move?.lead?.ft));
  const path = push(nums, move?.lead?.path ?? move?.path);
  const fts = push(nums, move?.fts);
  let at = -1;
  if (e.k === "groupEnd") {
    at = e.at.length;
    for (const land of e.at) nums.push(land?.x ?? Number.NaN, land?.y ?? Number.NaN, land === null ? Number.NaN : land.squeeze ? 1 : 0);
  }
  const flags = (move?.squeeze ? 1 : 0) | (move?.free ? 2 : 0) | (move?.lead?.squeeze ? 4 : 0) | (move?.lead?.path !== undefined ? 8 : 0);
  return { stored: "group", k: e.k, tokenId: e.tokenId, g: e.g, nums: doubles(nums), path, fts, at, lead: move?.lead?.i ?? -1, flags };
}

/** The frame back as the schema gave it, without its roster, for expandGroup. */
export function loadGroupFrame(s: StoredGroupFrame): GroupFrame {
  const base = { tokenId: s.tokenId, g: s.g };
  const n = s.nums;
  let i = 6;
  const take = (count: number): number[] | undefined => {
    if (count < 0) return undefined;
    const out = n.slice(i, i + count);
    i += count;
    return out;
  };
  const route = take(s.path);
  const costs = take(s.fts);
  switch (s.k) {
    case "dragCancel":
      return { k: "dragCancel", ...base };
    case "dragStart":
      return { k: "dragStart", ...base, x: n[0]!, y: n[1]! };
    case "groupEnd": {
      const at: ({ x: number; y: number; squeeze?: true } | null)[] = [];
      for (let t = 0; t < s.at; t++, i += 3) {
        const flag = n[i + 2]!;
        at.push(Number.isNaN(flag) ? null : { x: n[i]!, y: n[i + 1]!, ...(flag === 1 ? { squeeze: true as const } : {}) });
      }
      return { k: "groupEnd", ...base, at };
    }
    case "dragMove": {
      const ownRoute = (s.flags & 8) === 0;
      const ft = present(n[2]!);
      const lead =
        s.lead < 0
          ? undefined
          : {
              i: s.lead,
              ...(present(n[3]!) !== undefined ? { x: n[3]! } : {}),
              ...(present(n[4]!) !== undefined ? { y: n[4]! } : {}),
              ...(!ownRoute && route ? { path: route } : {}),
              ...(present(n[5]!) !== undefined ? { ft: n[5]! } : {}),
              ...(s.flags & 4 ? { squeeze: true as const } : {}),
            };
      return {
        k: "dragMove",
        ...base,
        x: n[0]!,
        y: n[1]!,
        ...(ownRoute && route ? { path: route } : {}),
        ...(ft !== undefined ? { ft } : {}),
        ...(s.flags & 1 ? { squeeze: true as const } : {}),
        ...(s.flags & 2 ? { free: true as const } : {}),
        ...(costs ? { fts: costs.map((v) => (Number.isNaN(v) ? null : v)) } : {}),
        ...(lead ? { lead } : {}),
      };
    }
  }
}
