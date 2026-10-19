import type { MemberId } from "#shared/model.ts";
import type { EphEvent } from "#shared/protocol.ts";
import { EMPTY_EPHEMERAL, type DragPreview, type Ephemeral, type LaserTrail, type Ping, type ViewRequest } from "./types.ts";

/**
 * The ephemeral channel's state on the receiving side (design section 7.6),
 * as pure functions over an immutable `Ephemeral`, so the store stays a thin
 * shell and the lifecycle rules are tested without timers.
 */

/** A remote preview with no frame for this long is dropped. */
export const PREVIEW_IDLE_MS = 3_000;
/** How long a dropped token's preview may wait for the `ev` that moves the token. */
export const DRAG_END_HOLD_MS = 1_000;
export const PING_MS = 3_000;
/** Laser points older than this have faded out. */
export const LASER_FADE_MS = 1_200;
const MAX_LASER_POINTS = 64;
const MAX_PINGS = 20;

const key = (from: MemberId, id: string) => `${from}|${id}`;

function without<T>(map: Readonly<Record<string, T>>, k: string): Readonly<Record<string, T>> {
  if (!(k in map)) return map;
  const next = { ...map };
  delete next[k];
  return next;
}

function filterMap<T>(map: Readonly<Record<string, T>>, keep: (value: T) => boolean): Readonly<Record<string, T>> {
  let out: Record<string, T> | null = null;
  for (const k in map) {
    if (keep(map[k] as T)) continue;
    out ??= { ...map };
    delete out[k];
  }
  return out ?? map;
}

let pingSeq = 0;
let focusSeq = 0;
let viewSeq = 0;

/**
 * One event from `from`. `local` marks this device's own echo. Drags are
 * never echoed locally, because Konva already shows the token under the
 * finger. A "look here" moves only players' cameras.
 */
export function applyEph(
  eph: Ephemeral,
  from: MemberId,
  e: EphEvent,
  now: number,
  opts: { local: boolean; role: "dm" | "player" },
): Ephemeral {
  const { local } = opts;
  switch (e.k) {
    case "dragStart":
    case "dragMove": {
      if (local) return eph;
      const preview: DragPreview = { from, tokenId: e.tokenId, x: e.x, y: e.y, ended: false, at: now };
      if (e.k === "dragMove" && e.path) preview.path = e.path;
      if (e.k === "dragMove" && e.ft !== undefined) preview.ft = e.ft;
      return { ...eph, drags: { ...eph.drags, [key(from, e.tokenId)]: preview } };
    }
    case "dragEnd": {
      if (local) return eph;
      return { ...eph, drags: { ...eph.drags, [key(from, e.tokenId)]: { from, tokenId: e.tokenId, x: e.x, y: e.y, ended: true, at: now } } };
    }
    case "dragCancel":
      return local ? eph : { ...eph, drags: without(eph.drags, key(from, e.tokenId)) };
    case "ruler":
      return {
        ...eph,
        rulers: { ...eph.rulers, [key(from, e.id)]: { from, id: e.id, points: e.points, shared: e.shared ?? false, local, at: now } },
      };
    case "rulerEnd":
      return { ...eph, rulers: without(eph.rulers, key(from, e.id)) };
    case "aoe": {
      const { k: _k, shared, ...geometry } = e;
      return { ...eph, aoes: { ...eph.aoes, [key(from, e.id)]: { ...geometry, from, shared: shared ?? false, local, at: now } } };
    }
    case "aoeEnd":
      return { ...eph, aoes: without(eph.aoes, key(from, e.id)) };
    case "ping": {
      const ping: Ping = { id: ++pingSeq, from, x: e.x, y: e.y, local, at: now };
      const pings = [...eph.pings, ping];
      return { ...eph, pings: pings.length > MAX_PINGS ? pings.slice(-MAX_PINGS) : pings };
    }
    case "laser": {
      const prev = eph.lasers[from];
      const kept = (prev?.points ?? []).filter((p) => now - p.at < LASER_FADE_MS);
      const points = e.on ? [...kept, { x: e.x, y: e.y, at: now }].slice(-MAX_LASER_POINTS) : kept;
      const trail: LaserTrail = { from, on: e.on, points, local, at: now };
      return { ...eph, lasers: { ...eph.lasers, [from]: trail } };
    }
    case "focus":
      if (local || opts.role !== "player") return eph;
      return { ...eph, focus: { id: ++focusSeq, from, x: e.x, y: e.y, zoom: e.zoom, at: now } };
    case "view": {
      // A DM's camera for table displays (docs/design-v1-dm-tools.md 3.1), which the display's own room follows.
      // The server sends it to displays only, whose stores hold the player role.
      if (local || opts.role !== "player") return eph;
      const view: ViewRequest = { id: ++viewSeq, from, x: e.x, y: e.y, w: e.w, h: e.h, at: now };
      return { ...eph, view };
    }
  }
}

function dragExpiry(d: DragPreview): number {
  return d.at + (d.ended ? DRAG_END_HOLD_MS : PREVIEW_IDLE_MS);
}

/** The oldest point fades first. A trail with no points left goes once it is off, or once a remote one has been quiet too long. */
function laserExpiry(t: LaserTrail): number {
  const first = t.points[0];
  if (first) return first.at + LASER_FADE_MS;
  if (!t.on) return t.at;
  return t.local ? Number.POSITIVE_INFINITY : t.at + PREVIEW_IDLE_MS;
}

/** When the next entry times out, or null when nothing will. */
export function nextExpiry(eph: Ephemeral): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const d of Object.values(eph.drags)) next = Math.min(next, dragExpiry(d));
  for (const r of Object.values(eph.rulers)) if (!r.local) next = Math.min(next, r.at + PREVIEW_IDLE_MS);
  for (const a of Object.values(eph.aoes)) if (!a.local) next = Math.min(next, a.at + PREVIEW_IDLE_MS);
  for (const p of eph.pings) next = Math.min(next, p.at + PING_MS);
  for (const t of Object.values(eph.lasers)) next = Math.min(next, laserExpiry(t));
  return Number.isFinite(next) ? next : null;
}

/** Drops everything that has timed out by `now`. Returns the same object when nothing did. */
export function sweepEph(eph: Ephemeral, now: number): Ephemeral {
  const drags = filterMap(eph.drags, (d) => dragExpiry(d) > now);
  const rulers = filterMap(eph.rulers, (r) => r.local || r.at + PREVIEW_IDLE_MS > now);
  const aoes = filterMap(eph.aoes, (a) => a.local || a.at + PREVIEW_IDLE_MS > now);
  const pings = eph.pings.some((p) => p.at + PING_MS <= now) ? eph.pings.filter((p) => p.at + PING_MS > now) : eph.pings;
  let lasers = eph.lasers;
  for (const [member, trail] of Object.entries(eph.lasers)) {
    const points = trail.points.filter((p) => now - p.at < LASER_FADE_MS);
    const alive = points.length > 0 || (trail.on && (trail.local || trail.at + PREVIEW_IDLE_MS > now));
    if (points.length === trail.points.length && alive) continue;
    if (lasers === eph.lasers) lasers = { ...eph.lasers };
    const next = lasers as Record<string, LaserTrail>;
    if (alive) next[member] = { ...trail, points };
    else delete next[member];
  }
  if (drags === eph.drags && rulers === eph.rulers && aoes === eph.aoes && pings === eph.pings && lasers === eph.lasers) return eph;
  return { ...eph, drags, rulers, aoes, pings, lasers };
}

/** Drops remote previews of tokens an `ev` settled or removed. */
export function clearTokens(eph: Ephemeral, tokenIds: ReadonlySet<string>): Ephemeral {
  if (tokenIds.size === 0) return eph;
  const drags = filterMap(eph.drags, (d) => !tokenIds.has(d.tokenId));
  return drags === eph.drags ? eph : { ...eph, drags };
}

/** Drops every preview from members who went offline (from `presence`). Local echoes stay. */
export function keepMembers(eph: Ephemeral, online: ReadonlySet<MemberId>): Ephemeral {
  const keep = (v: { from: MemberId; local?: boolean }) => v.local === true || online.has(v.from);
  const drags = filterMap(eph.drags, keep);
  const rulers = filterMap(eph.rulers, keep);
  const aoes = filterMap(eph.aoes, keep);
  const pings = eph.pings.every(keep) ? eph.pings : eph.pings.filter(keep);
  const lasers = filterMap(eph.lasers, keep);
  if (drags === eph.drags && rulers === eph.rulers && aoes === eph.aoes && pings === eph.pings && lasers === eph.lasers) return eph;
  return { ...eph, drags, rulers, aoes, pings, lasers };
}

/** What survives a reconnect to the same scene: this device's own previews. Anything else starts empty. */
export function keepLocal(eph: Ephemeral): Ephemeral {
  const local = (v: { local?: boolean }) => v.local === true;
  const rulers = filterMap(eph.rulers, local);
  const aoes = filterMap(eph.aoes, local);
  const lasers = filterMap(eph.lasers, local);
  if (Object.keys(rulers).length + Object.keys(aoes).length + Object.keys(lasers).length === 0) return EMPTY_EPHEMERAL;
  return { ...EMPTY_EPHEMERAL, rulers, aoes, lasers };
}

/**
 * One step of the smoothing that remote drag previews animate with: the
 * shown point closes most of the gap to the latest frame within about two
 * frame intervals, so 20 to 30 frames a second look continuous, and it
 * settles exactly on the target so the animation loop can stop.
 */
export function approach(
  pos: { x: number; y: number },
  target: { x: number; y: number },
  dtMs: number,
  tauMs = 50,
): { x: number; y: number; done: boolean } {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const x = pos.x + (target.x - pos.x) * k;
  const y = pos.y + (target.y - pos.y) * k;
  if (Math.abs(target.x - x) < 0.005 && Math.abs(target.y - y) < 0.005) return { x: target.x, y: target.y, done: true };
  return { x, y, done: false };
}
