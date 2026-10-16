import { countsAsLitTokenLight, LIMITS, utf8Bytes } from "../limits.ts";
import {
  CHUNK_CELLS,
  FOG_SUBCELLS,
  MAX_LIGHT_FT,
  type Actor,
  type BuildChunk,
  type LightLevel,
  type RoomState,
  type Scene,
  type SceneId,
  type SightTile,
  type Token,
  type TokenLight,
} from "../model.ts";
import type { PartySight, SightProbe } from "../ruleHooks.ts";
import { footprintSize, isSqueezed, squeezedRect, storedCenter, tokenHeightFt } from "./footprint.ts";
import type { Bounds } from "./geom.ts";
import { footprintGround, groundAt, standing } from "./heights.ts";
import { boundsOf, clipToBox, crossingsAt, indexPolygon, orient, SIGHT, stepOffWalls, type Polygon } from "./segments.ts";
import type { SightSet, WallSet } from "./walls.ts";
import { isWritable } from "../writable.ts";

/**
 * Party vision (docs/design-v1-maps-vision.md section 4.3): who lends the
 * party sight, what each source sees by its senses and the light around it,
 * and the union of it all as 2-bit levels per fog sub-cell, encoded as the
 * sight tiles players receive. Computed on the server only.
 *
 * The "seen" marks the reducer stores are decided from this, and replay
 * rebuilds them, so everything here uses only +, -, *, / and comparisons
 * (plus Math.floor, ceil, round, abs, min and max), which IEEE 754 rounds
 * the same way in every engine. No atan2, sin, cos, sqrt, hypot, pow or exp,
 * here or in anything this file imports (segments.test.ts checks). That is
 * why the wall set comes in through a `VisionWorld` rather than an import of
 * walls.ts, whose areas sweep uses atan2: walls.ts derives it with integer
 * and lattice arithmetic only, and ruleHooks.ts hands its `sceneWalls` over.
 *
 * Coordinates are cells. A sub-cell is a quarter cell, the fog's resolution,
 * and its center is what every test reads: column i's center is at
 * (2i + 1) / 8 cells, which is never a whole or half cell.
 */

/** Sub-cells per cell side. */
const SUB = FOG_SUBCELLS;
/** Sub-cells per tile side: a sight tile covers a fog tile. */
const TILE = CHUNK_CELLS * SUB;
const TILE_AREA = TILE * TILE;
/** Bytes of one tile's levels at 2 bits per sub-cell. */
export const SIGHT_TILE_BYTES = TILE_AREA / 4;

/** Levels, as section 4.3.2 orders them. */
export const NOT_SEEN = 0;
export const GREY = 1;
export const DIM = 2;
export const BRIGHT = 3;

/** What the server needs beyond the state: the scene's derived walls (shared/rules/walls.ts `sceneWalls`). */
export type VisionWorld = {
  walls(scene: Scene, buildChunks: Readonly<Record<string, BuildChunk>>): WallSet;
};

// ---------------------------------------------------------------------------
// Footprints

/**
 * The rectangle sight judges a creature by (section 4.3.2): its footprint
 * at its stored position, where the map draws it, never snapped. While it
 * squeezes, the squeezed footprint centered on the same point (footprint.ts).
 */
export function sightRect(probe: SightProbe): Bounds {
  if (isSqueezed(probe)) {
    const r = squeezedRect(probe);
    return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  }
  const { w, h } = footprintSize(probe);
  return { x0: probe.x, y0: probe.y, x1: probe.x + w, y1: probe.y + h };
}

/** The first sub-cell column (or row) whose center is at or past `x` cells. Exact: SUB is a power of two. */
function firstCenterFrom(x: number): number {
  return Math.ceil((2 * SUB * x - 1) / 2);
}

// ---------------------------------------------------------------------------
// Senses

/** Feet, each at most LIMITS.senseMaxFt. */
export type Senses = { darkvision: number; blindsight: number; truesight: number };

const SENSE_RE = /\b(darkvision|blindsight|truesight)\b[\s:(]*(\d+(?:\.\d+)?)/gi;

/**
 * The senses that see, read from an actor's senses line (section 4.3.2):
 * "darkvision 60 ft.", "Blindsight 10 ft. (blind beyond this radius)" and
 * "truesight 120 ft", case-insensitive, in feet, the largest of each kind,
 * capped at the SRD's longest darkvision. Tremorsense is not sight.
 */
export function parseSenses(line: unknown): Senses {
  const out: Senses = { darkvision: 0, blindsight: 0, truesight: 0 };
  if (typeof line !== "string") return out;
  for (const m of line.matchAll(SENSE_RE)) {
    const kind = m[1]!.toLowerCase() as keyof Senses;
    const ft = Math.min(Number(m[2]), LIMITS.senseMaxFt);
    if (Number.isFinite(ft) && ft > out[kind]) out[kind] = ft;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Party members and sources

function actorOf(state: Pick<RoomState, "characters">, token: Token): Actor | undefined {
  const a = token.actor;
  if (!a) return undefined;
  return "inline" in a ? a.inline : state.characters[a.ref]?.actor;
}

function playerOwned(state: Pick<RoomState, "characters">, token: Token): boolean {
  if ((token.ownerIds?.length ?? 0) > 0) return true;
  const a = token.actor;
  return a !== undefined && "ref" in a && (state.characters[a.ref]?.ownerIds?.length ?? 0) > 0;
}

/**
 * A party member (section 4.3.2): owned by a player, directly or through its
 * character (project.ts `playerOwned`), or marked by the DM as lending the
 * party its sight. Every party member is shown to players, whatever its
 * state and the source cap.
 */
export function partyMember(state: Pick<RoomState, "characters">, token: Token): boolean {
  return token.partyVision === true || playerOwned(state, token);
}

/** Why a party member lends no sight. */
export type NoSightReason =
  /** The DM hid its token. */
  | "hidden"
  /** An object, not marked to lend sight. */
  | "object"
  /** Dead, dying, stable or unconscious, or its actor is gone. */
  | "down"
  /** Below the ground under it: no eye (section 4.2). */
  | "ground"
  /** Past the first LIMITS.partySourcesPerScene sources. */
  | "cap"
  /** Its eye could not be stepped off a wall (section 4.3.2). */
  | "wall";

export type MemberReport = {
  tokenId: string;
  /** Lends sight now. */
  lends: boolean;
  reason?: NoSightReason;
  senses: Senses;
  /** The light it carries, when it gives any. */
  light?: TokenLight;
};

function hasEffect(actor: Actor, key: string): boolean {
  return Array.isArray(actor.effects) && actor.effects.some((e) => e.key === key);
}

type Candidate = { token: Token; actor: Actor | undefined; group: number; reason?: NoSightReason };

/*
 * Every party member on the scene, sources first in the cap's order (player
 * characters, other player-owned creatures, creatures the DM marked, then
 * companions, each by token ID), with why each other one lends no sight.
 * Companions come last so a party's familiars never push out a DM's
 * lantern bearer (docs/design-v1-combat-flow.md 3.6.5). The cap is taken
 * here, before the step off a wall, so a source standing on a wall keeps
 * its place.
 */
function candidatesOf(state: RoomState, tokens: readonly Token[]): Candidate[] {
  const out: Candidate[] = [];
  for (const token of tokens) {
    if (!partyMember(state, token)) continue;
    const owned = playerOwned(state, token);
    const actor = actorOf(state, token);
    const group = token.companion ? 3 : owned && token.kind === "pc" ? 0 : owned ? 1 : 2;
    let reason: NoSightReason | undefined;
    if (token.visibility !== "all") reason = "hidden";
    // An effect companion has no eyes, whatever party mark it carries (docs/design-v1-combat-flow.md 3.6.5). Its mark
    // stays stored, so a companion made a creature again lends sight as the DM marked it.
    else if (token.kind === "object" && (token.companion !== undefined || token.partyVision !== true)) reason = "object";
    else if (!actor || actor.life !== "alive" || hasEffect(actor, "unconscious")) reason = "down";
    else if (standing(token.elevation, footprintGround(state.buildChunks, token)) === "inside") reason = "ground";
    out.push({ token, actor, group, reason });
  }
  out.sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || a.group - b.group || (a.token.id < b.token.id ? -1 : a.token.id > b.token.id ? 1 : 0));
  let lending = 0;
  for (const c of out) {
    if (c.reason) continue;
    if (++lending > LIMITS.partySourcesPerScene) c.reason = "cap";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base64, for sight tiles

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < n ? bytes[i + 1]! : 0;
    const c = i + 2 < n ? bytes[i + 2]! : 0;
    const v = (a << 16) | (b << 8) | c;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + (i + 1 < n ? B64[(v >> 6) & 63]! : "=") + (i + 2 < n ? B64[v & 63]! : "=");
  }
  return out;
}

/** Decodes base64 of exactly `length` bytes, or null for anything else. */
function decodeBase64(text: string, length: number): Uint8Array | null {
  if (typeof text !== "string" || text.length !== Math.ceil(length / 3) * 4) return null;
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const v: number[] = [0, 0, 0, 0];
    let pad = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text.charCodeAt(i + k);
      if (ch === 61 && i + 4 === text.length && k >= 2) {
        pad++;
        continue;
      }
      if (pad > 0) return null;
      const d = ch < 128 ? B64_INDEX[ch]! : -1;
      if (d < 0) return null;
      v[k] = d;
    }
    const bits = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    const take = 3 - pad;
    for (let k = 0; k < take; k++) {
      if (o >= length) return null;
      out[o++] = (bits >> (16 - 8 * k)) & 255;
    }
  }
  return o === length ? out : null;
}

// ---------------------------------------------------------------------------
// Sight tiles

/*
 * A tile's levels packed 2 bits per sub-cell in row order: sub-cell i of the
 * tile (row * 64 + column) is bits 2(i mod 4) and up of byte i / 4. One
 * shared array per uniform level, so a tile all at one level costs nothing.
 */
const UNIFORM: readonly Uint8Array[] = [0, 1, 2, 3].map((v) => new Uint8Array(SIGHT_TILE_BYTES).fill(v * 0x55));

function levelIn(packed: Uint8Array, i: number): number {
  return (packed[i >> 2]! >> ((i & 3) << 1)) & 3;
}

/** A tile as players and DMs receive it: `{f}` for a tile all at one level, else 1,368 base64 characters. */
function tileOf(packed: Uint8Array, uniform: number): SightTile {
  if (uniform === 1 || uniform === 2 || uniform === 3) return { f: uniform };
  return { b: encodeBase64(packed) };
}

/** A tile's 4,096 levels, row by row, or null for a tile that cannot be read (which counts as nothing seen). */
export function sightTileLevels(tile: SightTile): Uint8Array | null {
  const packed = packedOf(tile);
  if (!packed) return null;
  const out = new Uint8Array(TILE_AREA);
  for (let i = 0; i < TILE_AREA; i++) out[i] = levelIn(packed, i);
  return out;
}

const packedCache = new WeakMap<object, Uint8Array | null>();

function packedOf(tile: SightTile | undefined): Uint8Array | null {
  if (!tile || typeof tile !== "object") return null;
  if ("f" in tile) {
    const f = tile.f;
    return f === 1 || f === 2 || f === 3 ? UNIFORM[f]! : null;
  }
  let hit = packedCache.get(tile);
  if (hit === undefined) {
    hit = "b" in tile ? decodeBase64(tile.b, SIGHT_TILE_BYTES) : null;
    packedCache.set(tile, hit);
  }
  return hit;
}

/**
 * What a tile shows as seen, in the fog tile's bit layout (shared/rules/fog.ts,
 * 1 = seen, LSB first): every sub-cell with a level above 0. The explore step
 * adds these to the explored layer (section 4.3.3).
 */
export function seenFogBits(tile: SightTile): Uint8Array {
  const out = new Uint8Array(TILE_AREA / 8);
  const packed = packedOf(tile);
  if (!packed) return out;
  for (let i = 0; i < TILE_AREA; i++) if (levelIn(packed, i) !== 0) out[i >> 3] = out[i >> 3]! | (1 << (i & 7));
  return out;
}

/**
 * The most bytes one sight tile entry can take in a projected state's `sight`
 * map, its key and the comma after it included (section 4.3.4): the key of
 * the scene's farthest tile as JSON, a colon, `{"b":"` with 1,368 base64
 * characters and `"}`, and a comma. The size guard reserves this per tile.
 */
export function sightEntryMaxBytes(sceneId: string): number {
  const valueBytes = JSON.stringify({ b: "A".repeat(Math.ceil(SIGHT_TILE_BYTES / 3) * 4) }).length;
  return utf8Bytes(JSON.stringify(`${sceneId}:12,12`)) + 1 + valueBytes + 1;
}

/** Whether any sub-cell center inside the rectangle has a level above 0, reading levels through `level`. */
function rectSeen(r: Bounds, level: (sx: number, sy: number) => number): boolean {
  const c0 = Math.max(0, firstCenterFrom(r.x0));
  const c1 = firstCenterFrom(r.x1);
  const r0 = Math.max(0, firstCenterFrom(r.y0));
  const r1 = firstCenterFrom(r.y1);
  for (let sy = r0; sy < r1; sy++) for (let sx = c0; sx < c1; sx++) if (level(sx, sy) !== 0) return true;
  return false;
}

/** Party sight over packed tiles, by tile coordinates. */
class TileSight implements PartySight {
  readonly tiles: ReadonlyMap<string, SightTile>;
  readonly #packed: (tx: number, ty: number) => Uint8Array | null;

  constructor(tiles: ReadonlyMap<string, SightTile>, packed: (tx: number, ty: number) => Uint8Array | null) {
    this.tiles = tiles;
    this.#packed = packed;
  }

  /** The level of one sub-cell, 0 outside every tile. */
  levelAt(sx: number, sy: number): number {
    if (sx < 0 || sy < 0) return NOT_SEEN;
    const tx = Math.floor(sx / TILE);
    const ty = Math.floor(sy / TILE);
    const packed = this.#packed(tx, ty);
    return packed ? levelIn(packed, (sy - ty * TILE) * TILE + (sx - tx * TILE)) : NOT_SEEN;
  }

  seesToken(probe: SightProbe): boolean {
    return rectSeen(sightRect(probe), (sx, sy) => this.levelAt(sx, sy));
  }
}

const EMPTY_TILES: ReadonlyMap<string, SightTile> = new Map();
/** The party seeing nothing. */
export const NO_PARTY_SIGHT: PartySight = new TileSight(EMPTY_TILES, () => null);

const fromTilesCache = new WeakMap<object, Map<string, PartySight>>();

/**
 * The party's sight on a client, from the tiles the server sent, keyed
 * `"<sceneId>:<tx>,<ty>"` (section 4.3.4). A scene with none, and a tile
 * that cannot be read, count as nothing seen.
 */
export function sightFromTiles(tiles: Readonly<Record<string, SightTile>>, sceneId: SceneId): PartySight {
  let byScene = fromTilesCache.get(tiles);
  if (!byScene) fromTilesCache.set(tiles, (byScene = new Map()));
  const hit = byScene.get(sceneId);
  if (hit) return hit;
  const mine = new Map<string, SightTile>();
  const prefix = `${sceneId}:`;
  for (const [key, tile] of Object.entries(tiles)) {
    if (!key.startsWith(prefix) || !tile) continue;
    const rest = key.slice(prefix.length);
    if (!/^\d{1,3},\d{1,3}$/.test(rest)) continue;
    mine.set(rest, tile);
  }
  const sight = mine.size === 0 ? NO_PARTY_SIGHT : new TileSight(mine, (tx, ty) => packedOf(mine.get(`${tx},${ty}`)));
  byScene.set(sceneId, sight);
  return sight;
}

// ---------------------------------------------------------------------------
// The exact sweep

/**
 * Everything visible from (ox, oy) inside `box`, through segments that may
 * reach past it: the sweep of section 4.3.4, which the design asks to use
 * only exact decisions. Segments are clipped to the box first (segments.ts
 * `clipToBox`), so none crosses the box's own sides. They must not cross
 * each other, which the split guarantees for any subset of a wall set.
 *
 * Endpoints are ordered by angle with a half-plane test and the exact
 * orientation predicate rather than atan2, and the segments a ray crosses
 * are kept nearest first by orientation tests alone. Only the polygon's
 * vertices are computed, by solving the ray and segment equations, and each
 * from a ray through an endpoint of a segment on the boundary, so a segment
 * hidden behind it never changes them. The output depends only on the set
 * of segments, not their order.
 *
 * Returns null when a segment passes through the point: the source fails
 * closed rather than seeing both sides of it (section 4.3.2). The point must
 * lie strictly inside the box.
 */
/*
 * The sort's keys: pseudo-angles in [0, 4) cut to multiples of 2^-30, a
 * whole number below 2^32. Two pseudo-angles further apart than SURE_APART
 * are in the right order whatever the cut and the rounding (each is within
 * a few units in the last place, some 1e-15, of the true pseudo-angle).
 */
const KEY_SCALE = 1_073_741_824;
const SURE_APART = 1e-8;

/** Scratch for the radix sort, grown as needed and reused by every sweep. */
let radix = { keys: new Uint32Array(0), keys2: new Uint32Array(0), order2: new Int32Array(0), counts: new Int32Array(2049) } as { keys: Uint32Array<ArrayBuffer>; keys2: Uint32Array<ArrayBuffer>; order2: Int32Array<ArrayBuffer>; counts: Int32Array<ArrayBuffer> };

/*
 * Sorts `order` (0 to n - 1) by `keys`, least significant 11 bits first,
 * three passes for 32-bit keys. Stable, and linear in n.
 */
function radixSort(keys: Uint32Array<ArrayBuffer>, order: Int32Array<ArrayBuffer>, n: number): void {
  if (radix.keys2.length < n) radix = { ...radix, keys2: new Uint32Array(n), order2: new Int32Array(n) };
  const { counts } = radix;
  let srcK = keys;
  let srcO = order;
  let dstK = radix.keys2;
  let dstO = radix.order2;
  for (let shift = 0; shift < 32; shift += 11) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[((srcK[i]! >>> shift) & 2047) + 1]!++;
    for (let d = 0; d < 2048; d++) counts[d + 1]! += counts[d]!;
    for (let i = 0; i < n; i++) {
      const at = counts[(srcK[i]! >>> shift) & 2047]!++;
      dstK[at] = srcK[i]!;
      dstO[at] = srcO[i]!;
    }
    [srcK, dstK] = [dstK, srcK];
    [srcO, dstO] = [dstO, srcO];
  }
  // Three passes leave the result in the scratch arrays.
  if (srcO !== order) order.set(srcO.subarray(0, n));
}

export function visibleFrom(ox: number, oy: number, segments: Float64Array, box: Bounds): Polygon | null {
  if (!(ox > box.x0 && ox < box.x1 && oy > box.y0 && oy < box.y1)) return null;
  const clipped = clipInto(near(segments, box), box);
  const given = clipped.length >> 2;
  const cap = given + 4;
  const SX = new Float64Array(cap);
  const SY = new Float64Array(cap);
  const EX = new Float64Array(cap);
  const EY = new Float64Array(cap);
  let n = 0;
  const add = (ax: number, ay: number, bx: number, by: number): boolean => {
    const o = orient(ax, ay, bx, by, ox, oy);
    if (o === 0) {
      // On the segment's line: through the point fails closed, beside it the segment shows no width.
      return !(ox >= Math.min(ax, bx) && ox <= Math.max(ax, bx) && oy >= Math.min(ay, by) && oy <= Math.max(ay, by));
    }
    // Store each segment counterclockwise around the point (y up): from the end the sweep meets first.
    if (o > 0) {
      SX[n] = ax;
      SY[n] = ay;
      EX[n] = bx;
      EY[n] = by;
    } else {
      SX[n] = bx;
      SY[n] = by;
      EX[n] = ax;
      EY[n] = ay;
    }
    n++;
    return true;
  };
  for (let k = 0; k < given; k++) {
    if (!add(clipped[4 * k]!, clipped[4 * k + 1]!, clipped[4 * k + 2]!, clipped[4 * k + 3]!)) return null;
  }
  const { x0, y0, x1, y1 } = box;
  add(x0, y0, x1, y0);
  add(x1, y0, x1, y1);
  add(x1, y1, x0, y1);
  add(x0, y1, x0, y0);

  // Events: 2k is segment k's start, 2k + 1 its end.
  const count = 2 * n;
  const EVX = new Float64Array(count);
  const EVY = new Float64Array(count);
  for (let k = 0; k < n; k++) {
    EVX[2 * k] = SX[k]!;
    EVY[2 * k] = SY[k]!;
    EVX[2 * k + 1] = EX[k]!;
    EVY[2 * k + 1] = EY[k]!;
  }
  /*
   * Exact angular order from the +x direction, counterclockwise with y up:
   * first the half-plane (above the point's row, or on it to the right),
   * then the orientation of the two directions.
   */
  const half = (x: number, y: number) => (y > oy || (y === oy && x > ox) ? 0 : 1);
  const compareDir = (ax: number, ay: number, bx: number, by: number): number => {
    const ha = half(ax, ay);
    const hb = half(bx, by);
    if (ha !== hb) return ha - hb;
    return -orient(ox, oy, ax, ay, bx, by);
  };
  /*
   * Sorted first by a pseudo-angle in [0, 4), monotone in the true angle,
   * which costs one division and is off by far less than SURE_APART, cut to
   * a 32-bit whole number for a radix sort. Then an insertion pass with the
   * exact comparison fixes the order of events whose pseudo-angles are too
   * close to tell apart, the only ones the cut or rounding can have
   * misplaced. So the order is exact.
   */
  const keys = new Float64Array(count);
  if (radix.keys.length < count) radix = { ...radix, keys: new Uint32Array(count) };
  const cut = radix.keys;
  for (let e = 0; e < count; e++) {
    const dx = EVX[e]! - ox;
    const dy = EVY[e]! - oy;
    const key =
      dy > 0 || (dy === 0 && dx > 0)
        ? dx >= 0
          ? dy / (dx + dy)
          : 1 - dx / (dy - dx)
        : dx <= 0
          ? 2 - dy / (-dx - dy)
          : 3 + dx / (dx - dy);
    keys[e] = key;
    cut[e] = Math.floor(key * KEY_SCALE);
  }
  const events = new Int32Array(count);
  for (let e = 0; e < count; e++) events[e] = e;
  radixSort(cut, events, count);
  for (let i = 1; i < count; i++) {
    const e = events[i]!;
    const ex = EVX[e]!;
    const ey = EVY[e]!;
    const ke = keys[e]!;
    let j = i - 1;
    while (j >= 0) {
      const f = events[j]!;
      if (ke - keys[f]! > SURE_APART || compareDir(EVX[f]!, EVY[f]!, ex, ey) <= 0) break;
      events[j + 1] = f;
      j--;
    }
    events[j + 1] = e;
  }
  const sameDir = (e: number, f: number) => keys[f]! - keys[e]! <= SURE_APART && compareDir(EVX[e]!, EVY[e]!, EVX[f]!, EVY[f]!) === 0;

  /*
   * Whether segment p is nearer the point than q along the rays they share.
   * Segments that do not cross keep one order over their shared angles: q
   * lies on one side of p's line, and p is nearer when that is the side away
   * from the point. If q straddles p's line, p lies on one side of q's.
   * Every segment runs counterclockwise around the point, so the point is
   * on the positive side of each one's line.
   */
  const nearer = (p: number, q: number): boolean => {
    const pax = SX[p]!;
    const pay = SY[p]!;
    const pbx = EX[p]!;
    const pby = EY[p]!;
    const s1 = orient(pax, pay, pbx, pby, SX[q]!, SY[q]!);
    const s2 = orient(pax, pay, pbx, pby, EX[q]!, EY[q]!);
    if (s1 * s2 >= 0) return (s1 !== 0 ? s1 : s2) === -1;
    const qax = SX[q]!;
    const qay = SY[q]!;
    const qbx = EX[q]!;
    const qby = EY[q]!;
    const t1 = orient(qax, qay, qbx, qby, pax, pay);
    return (t1 !== 0 ? t1 : orient(qax, qay, qbx, qby, pbx, pby)) === 1;
  };
  const active: number[] = [];
  // The group in which each segment was last inserted, so a vertex on an arriving segment is its own endpoint.
  const arrived = new Int32Array(n).fill(-1);
  const insert = (p: number) => {
    let lo = 0;
    let hi = active.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nearer(p, active[mid]!)) hi = mid;
      else lo = mid + 1;
    }
    active.splice(lo, 0, p);
  };
  // Segments that span the +x direction are active before the first event.
  for (let k = 0; k < n; k++) if (compareDir(SX[k]!, SY[k]!, EX[k]!, EY[k]!) > 0) insert(k);

  const out: number[] = [];
  const push = (x: number, y: number) => {
    const len = out.length;
    if (len >= 2 && out[len - 2] === x && out[len - 1] === y) return;
    out.push(x, y);
  };
  /*
   * Where the ray through (rx, ry) meets segment k. An axis-aligned segment
   * keeps its fixed coordinate exactly, so its hits do not depend on where
   * the split cut it.
   */
  const hit = (k: number, rx: number, ry: number) => {
    const ax = SX[k]!;
    const ay = SY[k]!;
    const bx = EX[k]!;
    const by = EY[k]!;
    if (rx === ax && ry === ay) return push(ax, ay);
    if (rx === bx && ry === by) return push(bx, by);
    const dx = rx - ox;
    const dy = ry - oy;
    if (ay === by) return push(ox + ((ay - oy) * dx) / dy, ay);
    if (ax === bx) return push(ax, oy + ((ax - ox) * dy) / dx);
    const ex = bx - ax;
    const ey = by - ay;
    const t = ((ax - ox) * ey - (ay - oy) * ex) / (dx * ey - dy * ex);
    push(ox + t * dx, oy + t * dy);
  };

  for (let i = 0; i < count; ) {
    const first = events[i]!;
    let j = i + 1;
    while (j < count && sameDir(first, events[j]!)) j++;
    const before = active.length > 0 ? active[0]! : -1;
    for (let k = i; k < j; k++) {
      const e = events[k]!;
      if ((e & 1) === 1) {
        const at = active.indexOf(e >> 1);
        if (at >= 0) active.splice(at, 1);
      }
    }
    for (let k = i; k < j; k++) {
      const e = events[k]!;
      if ((e & 1) === 0) {
        insert(e >> 1);
        arrived[e >> 1] = i;
      }
    }
    const after = active.length > 0 ? active[0]! : -1;
    if (before !== after && before >= 0 && after >= 0) {
      /*
       * The boundary turns at this angle because the nearest segment left or
       * a nearer one arrived, so one of the two has its endpoint here. That
       * endpoint is a vertex as it is, and the ray through it finds the other.
       */
      const leaving = !active.includes(before);
      const arriving = arrived[after] === i;
      if (leaving) push(EX[before]!, EY[before]!);
      else hit(before, SX[after]!, SY[after]!);
      if (arriving) push(SX[after]!, SY[after]!);
      else hit(after, EX[before]!, EY[before]!);
    }
    i = j;
  }
  if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return Float64Array.from(out);
}

/** Cells per side of the blocks the piece index files pieces in. */
const BLOCK = 8;

/** Pieces filed by the blocks their boxes cover, for finding those near a light's box. */
type BlockIndex = { bx0: number; by0: number; across: number; down: number; off: Int32Array; items: Int32Array; stamp: Uint32Array; query: number; area: number };

const pieceIndexes = new WeakMap<Float64Array, BlockIndex>();

function blockIndex(segs: Float64Array): BlockIndex {
  const hit = pieceIndexes.get(segs);
  if (hit) return hit;
  const n = segs.length >> 2;
  const b = boundsOf(segs) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const bx0 = Math.floor(b.x0 / BLOCK);
  const by0 = Math.floor(b.y0 / BLOCK);
  const across = Math.floor(b.x1 / BLOCK) - bx0 + 1;
  const down = Math.floor(b.y1 / BLOCK) - by0 + 1;
  const off = new Int32Array(across * down + 1);
  const each = (k: number, fn: (cell: number) => void) => {
    const c0 = Math.floor(Math.min(segs[4 * k]!, segs[4 * k + 2]!) / BLOCK) - bx0;
    const c1 = Math.floor(Math.max(segs[4 * k]!, segs[4 * k + 2]!) / BLOCK) - bx0;
    const r0 = Math.floor(Math.min(segs[4 * k + 1]!, segs[4 * k + 3]!) / BLOCK) - by0;
    const r1 = Math.floor(Math.max(segs[4 * k + 1]!, segs[4 * k + 3]!) / BLOCK) - by0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * across + c);
  };
  for (let k = 0; k < n; k++) each(k, (cell) => off[cell + 1]!++);
  for (let cell = 0; cell < across * down; cell++) off[cell + 1]! += off[cell]!;
  const items = new Int32Array(off[across * down]!);
  const fill = off.slice(0, across * down);
  for (let k = 0; k < n; k++) each(k, (cell) => (items[fill[cell]!++] = k));
  const index = { bx0, by0, across, down, off, items, stamp: new Uint32Array(n), query: 0, area: (b.x1 - b.x0) * (b.y1 - b.y0) };
  pieceIndexes.set(segs, index);
  return index;
}

/*
 * The segments that may meet a box: all of them for a box about as large
 * as their own, else those filed in the blocks the box covers, which a
 * light's sweep box, a quarter of a large scene, makes far fewer. The clip
 * that follows decides exactly, and the sweep does not depend on the order,
 * so this changes only the work.
 */
function near(segs: Float64Array, box: Bounds): Float64Array {
  const ix = blockIndex(segs);
  if ((box.x1 - box.x0) * (box.y1 - box.y0) * 2 > ix.area) return segs;
  const c0 = Math.max(0, Math.floor(box.x0 / BLOCK) - ix.bx0);
  const c1 = Math.min(ix.across - 1, Math.floor(box.x1 / BLOCK) - ix.bx0);
  const r0 = Math.max(0, Math.floor(box.y0 / BLOCK) - ix.by0);
  const r1 = Math.min(ix.down - 1, Math.floor(box.y1 / BLOCK) - ix.by0);
  const stamp = ++ix.query;
  const found: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * ix.across + c;
      for (let p = ix.off[cell]!; p < ix.off[cell + 1]!; p++) {
        const k = ix.items[p]!;
        if (ix.stamp[k] === stamp) continue;
        ix.stamp[k] = stamp;
        found.push(k);
      }
    }
  }
  const out = new Float64Array(found.length * 4);
  for (let m = 0; m < found.length; m++) out.set(segs.subarray(4 * found[m]!, 4 * found[m]! + 4), 4 * m);
  return out;
}

/*
 * Segments clipped to a sweep's box (segments.ts `clipToBox`). A segment
 * strictly inside the box comes out of the clip as it went in, so only the
 * ones that reach a side go through it: in a sweep over the whole scene,
 * almost none.
 */
function clipInto(segs: Float64Array, box: Bounds): Float64Array {
  const { x0, y0, x1, y1 } = box;
  const inside = new Float64Array(segs.length);
  let kept = 0;
  const edge: number[] = [];
  for (let k = 0; k + 3 < segs.length; k += 4) {
    const ax = segs[k]!;
    const ay = segs[k + 1]!;
    const bx = segs[k + 2]!;
    const by = segs[k + 3]!;
    if (ax > x0 && ax < x1 && bx > x0 && bx < x1 && ay > y0 && ay < y1 && by > y0 && by < y1) {
      if (ax === bx && ay === by) continue;
      inside[kept++] = ax;
      inside[kept++] = ay;
      inside[kept++] = bx;
      inside[kept++] = by;
    } else edge.push(ax, ay, bx, by);
  }
  if (edge.length === 0) return inside.subarray(0, kept);
  const cut = clipToBox(Float64Array.from(edge), box);
  const out = new Float64Array(kept + cut.length);
  out.set(inside.subarray(0, kept));
  out.set(cut, kept);
  return out;
}

// ---------------------------------------------------------------------------
// Scanlines

/** A half-open box of sub-cells. */
type SubBox = { c0: number; r0: number; c1: number; r1: number };

/** Spans per sub-cell row: row `r0 + k` has the pairs `xs[off[k]]` to `xs[off[k + 1]]`, each `[x0, x1)` in columns. */
type RowSpans = { r0: number; off: Int32Array; xs: Int16Array; box: SubBox | null };

/*
 * The sub-cells whose centers a polygon holds, row by row, by the crossings
 * of each row's center line (segments.ts `crossingsAt`): a center at x is
 * inside when it lies at or past an even crossing and before the next odd
 * one, the rule `pointInPolygon` uses. Cost grows with the crossings per
 * row, not with the sub-cells covered.
 */
function polygonSpans(poly: Polygon, rows: SubBox, W: number): RowSpans {
  const cellRow0 = Math.floor(rows.r0 / SUB);
  const cellRows = Math.floor((rows.r1 - 1) / SUB) - cellRow0 + 1;
  const index = indexPolygon(poly, cellRow0, cellRows);
  const off = new Int32Array(rows.r1 - rows.r0 + 1);
  const xs: number[] = [];
  let box: SubBox | null = null;
  for (let j = rows.r0; j < rows.r1; j++) {
    const cr = crossingsAt(index, (2 * j + 1) / (2 * SUB));
    for (let k = 0; k + 1 < cr.length; k += 2) {
      const a = Math.max(rows.c0, firstCenterFrom(cr[k]!));
      const b = Math.min(rows.c1, W, firstCenterFrom(cr[k + 1]!));
      if (a >= b) continue;
      xs.push(a, b);
      if (!box) box = { c0: a, r0: j, c1: b, r1: j + 1 };
      else {
        if (a < box.c0) box.c0 = a;
        if (b > box.c1) box.c1 = b;
        box.r1 = j + 1;
      }
    }
    off[j - rows.r0 + 1] = xs.length;
  }
  return { r0: rows.r0, off, xs: Int16Array.from(xs), box };
}

/** Spans covering the whole of `rows`, for a light walls do not block. */
function boxSpans(rows: SubBox): RowSpans {
  const count = rows.r1 - rows.r0;
  const off = new Int32Array(count + 1);
  const xs = new Int16Array(count * 2);
  for (let k = 0; k < count; k++) {
    xs[2 * k] = rows.c0;
    xs[2 * k + 1] = rows.c1;
    off[k + 1] = 2 * (k + 1);
  }
  return { r0: rows.r0, off, xs, box: count > 0 && rows.c0 < rows.c1 ? { ...rows } : null };
}

/**
 * The columns of row `j` whose centers lie within the circle, by the integer
 * search of section 4.3.4: the squared distance of each center is compared
 * with the squared radius, and the first and last columns that pass are
 * found by binary search on each side of the center's own column, where the
 * distance only grows. Writes `[a, b)` at `out[at]`, empty as `[0, 0)`.
 */
function circleColumns(cx: number, cy: number, r2: number, j: number, W: number, out: Int16Array | Int32Array, at: number): void {
  out[at] = 0;
  out[at + 1] = 0;
  const dy = (2 * j + 1) / (2 * SUB) - cy;
  const dy2 = dy * dy;
  if (!(dy2 <= r2) || W <= 0) return;
  const inside = (i: number) => {
    const dx = (2 * i + 1) / (2 * SUB) - cx;
    return dx * dx + dy2 <= r2;
  };
  let m = Math.floor(cx * SUB);
  if (m < 0) m = 0;
  if (m > W - 1) m = W - 1;
  if (!inside(m)) return;
  let lo = 0;
  let hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inside(mid)) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;
  lo = m;
  hi = W - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (inside(mid)) lo = mid;
    else hi = mid - 1;
  }
  out[at] = first;
  out[at + 1] = lo + 1;
}

// ---------------------------------------------------------------------------
// Sight sets

/** Raised edges in a wall set's stored segments (walls.ts RAISED, which a test keeps equal). */
export const RAISED_TAG = 16;

const topsByWalls = new WeakMap<WallSet, Int16Array>();

/** The distinct tops of a wall set's raised edges, ascending. */
function raisedTops(walls: WallSet): Int16Array {
  let hit = topsByWalls.get(walls);
  if (!hit) {
    const seen = new Set<number>();
    const s = walls.stored;
    for (let k = 0; k < s.n; k++) if (s.tags[k]! & RAISED_TAG) seen.add(walls.storedTops[k]!);
    hit = Int16Array.from([...seen].sort((a, b) => a - b));
    topsByWalls.set(walls, hit);
  }
  return hit;
}

/** What an eye sweeps over, and a key that two eyes share exactly when every raised edge either set holds blocks both or neither. */
type EyeSet = { set: SightSet; key: string };

/*
 * The sight set of an eye `eyeFt` feet up (walls.ts `sight`): the sight
 * pieces and every raised edge whose top is above the eye. Its key is the
 * pair of raised tops around the eye. An eye moving within that pair, even
 * across two wall sets, keeps every raised edge they share on the same side
 * of it, so its polygon's only changes come from pieces that differ, which
 * the reuse rule reads separately.
 */
function eyeSet(walls: WallSet, eyeFt: number): EyeSet {
  const tops = raisedTops(walls);
  let lo = 0;
  let hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! <= eyeFt) lo = mid + 1;
    else hi = mid;
  }
  const below = lo > 0 ? tops[lo - 1]! : "-";
  const above = lo < tops.length ? tops[lo]! : "+";
  return { set: walls.sight(eyeFt), key: `${below}/${above}` };
}

/*
 * The pieces in one wall set and not the other, either way. Two flat lists
 * of up to some 10,000 pieces each, matched through a hash of their four
 * coordinates, so this costs a pass over each.
 */
function pieceDiff(a: Float64Array, b: Float64Array): Float64Array {
  const nb = b.length >> 2;
  let cap = 16;
  while (cap < nb * 2) cap *= 2;
  const table = new Int32Array(cap).fill(-1);
  const used = new Uint8Array(nb);
  const words = new Uint32Array(new Float64Array(b.buffer, b.byteOffset, b.length).buffer, b.byteOffset, b.length * 2);
  const hashOf = (w: Uint32Array, k: number) => {
    let h = 2166136261;
    for (let i = 8 * k; i < 8 * k + 8; i++) h = Math.imul(h ^ w[i]!, 16777619);
    return (h >>> 0) & (cap - 1);
  };
  for (let k = 0; k < nb; k++) {
    let s = hashOf(words, k);
    while (table[s] !== -1) s = (s + 1) & (cap - 1);
    table[s] = k;
  }
  const wa = new Uint32Array(a.buffer, a.byteOffset, a.length * 2);
  const out: number[] = [];
  for (let k = 0; k < a.length >> 2; k++) {
    let s = hashOf(wa, k);
    let found = -1;
    while (table[s] !== -1) {
      const m = table[s]!;
      if (used[m] === 0 && b[4 * m] === a[4 * k] && b[4 * m + 1] === a[4 * k + 1] && b[4 * m + 2] === a[4 * k + 2] && b[4 * m + 3] === a[4 * k + 3]) {
        found = m;
        break;
      }
      s = (s + 1) & (cap - 1);
    }
    if (found >= 0) used[found] = 1;
    else out.push(a[4 * k]!, a[4 * k + 1]!, a[4 * k + 2]!, a[4 * k + 3]!);
  }
  for (let m = 0; m < nb; m++) if (used[m] === 0) out.push(b[4 * m]!, b[4 * m + 1]!, b[4 * m + 2]!, b[4 * m + 3]!);
  return Float64Array.from(out);
}

/**
 * Where two wall sets differ, by cell, with a prefix sum so a box asks in
 * constant time whether it meets a changed piece. The grid reaches a cell
 * past the scene on every side, as sweep boxes do.
 */
class ChangedCells {
  readonly #w: number;
  readonly #h: number;
  readonly #sum: Int32Array;
  readonly any: boolean;

  constructor(changed: Float64Array, w: number, h: number) {
    this.#w = w + 3;
    this.#h = h + 3;
    const grid = new Int32Array((this.#w + 1) * (this.#h + 1));
    const W1 = this.#w + 1;
    for (let k = 0; k + 3 < changed.length; k += 4) {
      const c0 = this.#col(Math.min(changed[k]!, changed[k + 2]!));
      const c1 = this.#col(Math.max(changed[k]!, changed[k + 2]!));
      const r0 = this.#row(Math.min(changed[k + 1]!, changed[k + 3]!));
      const r1 = this.#row(Math.max(changed[k + 1]!, changed[k + 3]!));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[(r + 1) * W1 + c + 1] = 1;
    }
    for (let r = 1; r <= this.#h; r++) for (let c = 1; c <= this.#w; c++) grid[r * W1 + c]! += grid[(r - 1) * W1 + c]! + grid[r * W1 + c - 1]! - grid[(r - 1) * W1 + c - 1]!;
    this.#sum = grid;
    this.any = changed.length > 0;
  }

  #col(x: number): number {
    const c = Math.floor(x) + 1;
    return c < 0 ? 0 : c >= this.#w ? this.#w - 1 : c;
  }

  #row(y: number): number {
    const r = Math.floor(y) + 1;
    return r < 0 ? 0 : r >= this.#h ? this.#h - 1 : r;
  }

  /** Whether a changed piece's box meets the closed box `b`, in cells. */
  meets(b: Bounds): boolean {
    if (!this.any) return false;
    const c0 = this.#col(b.x0);
    const c1 = this.#col(b.x1);
    const r0 = this.#row(b.y0);
    const r1 = this.#row(b.y1);
    const W1 = this.#w + 1;
    const s = this.#sum;
    return s[(r1 + 1) * W1 + c1 + 1]! - s[r0 * W1 + c1 + 1]! - s[(r1 + 1) * W1 + c0]! + s[r0 * W1 + c0]! > 0;
  }
}

// ---------------------------------------------------------------------------
// Sources and lights as the cache holds them

/** The box of a polygon, in cells. */
function polygonBounds(poly: Polygon): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i]!;
    const y = poly[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** The sub-cell rows and columns whose centers a box in cells can hold, within the scene. */
function subRows(b: Bounds, W: number, H: number): SubBox {
  return {
    c0: Math.max(0, firstCenterFrom(b.x0)),
    r0: Math.max(0, firstCenterFrom(b.y0)),
    c1: Math.min(W, firstCenterFrom(b.x1) + 1),
    r1: Math.min(H, firstCenterFrom(b.y1) + 1),
  };
}

function boxesMeet(a: SubBox | null, b: SubBox | null): boolean {
  return a !== null && b !== null && a.c0 < b.c1 && b.c0 < a.c1 && a.r0 < b.r1 && b.r0 < a.r1;
}

/*
 * The wall set and the sight pieces an entry was computed from, held weakly
 * (W4-DATA-04). Entries only compare against them, and the wall cache
 * (walls.ts) bounds how long they live, so the vision cache never keeps a
 * scene's geometry alive past it, and its byte cap counts only what vision
 * builds. Pieces that are gone are walls that can no longer be compared, so
 * whatever was swept over them is computed again, which gives the same bits.
 */
type Held<T extends object> = WeakRef<T>;

type SourceEntry = {
  id: string;
  /** What its polygon came from: the stepped eye, its sight set and its box. Equal keys over equal pieces give equal polygons. */
  polyKey: string;
  /** The sight pieces the polygon was swept over, to find what changed when the walls do. */
  pieces: Held<Float64Array> | null;
  /** The polygon's box in cells, or the eye alone when its sweep failed closed. */
  polyBox: Bounds | null;
  spans: RowSpans | null;
  /** What its levels come from beyond the polygon: Blinded and its senses. */
  levelKey: string;
  blind: boolean;
  /** Per row of `spans`, `[a, b)` for darkvision, truesight and blindsight. */
  senses: Int16Array | null;
  /** Set when it lends no sight after all: its eye is on a wall. */
  reason?: NoSightReason;
};

type LightEntry = {
  key: string;
  /** What its runs came from: position, radii, whether walls cast shadows, its sight set and its stepped position. */
  inputKey: string;
  pieces: Held<Float64Array> | null;
  polyBox: Bounds | null;
  /** Per row, `[x0, x1, level]` triples, dim (2) or bright (3). */
  runs: { r0: number; off: Int32Array; data: Int16Array; box: SubBox | null };
};

/** One row of the light level: runs from `starts[k]` to the next start at `levels[k]`. Null rows are the scene's base level throughout. */
type LightRow = { starts: Int16Array; levels: Uint8Array } | null;

type SceneEntry = {
  walls: Held<WallSet>;
  w: number;
  h: number;
  level: LightLevel;
  fpc: number;
  /** Everything the result came from, to answer a repeat without work. */
  signature: string;
  sources: Map<string, SourceEntry>;
  lights: Map<string, LightEntry>;
  lightRows: LightRow[] | null;
  packed: (Uint8Array | null)[];
  tiles: Map<string, SightTile>;
  sight: TileSight;
  bytes: number;
};

/** Base light level: what a point has where no light reaches. */
function baseLevel(level: LightLevel): number {
  return level === "bright" ? BRIGHT : level === "dim" ? DIM : NOT_SEEN;
}

/*
 * A sub-cell's level from one source (section 4.3.2's table), indexed by the
 * light there (0, 2 or 3) plus 4 when Blinded, 8 within darkvision, 16
 * within truesight and 32 within blindsight.
 */
const LEVEL_TABLE = (() => {
  const t = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const light = i & 3;
    const blind = (i & 4) !== 0;
    let v = 0;
    if (!blind) {
      v = light;
      if (i & 8) v = light === 0 ? GREY : BRIGHT;
      if (i & 16 && v < (light === BRIGHT ? BRIGHT : DIM)) v = light === BRIGHT ? BRIGHT : DIM;
    }
    if (i & 32 && v < GREY) v = GREY;
    t[i] = v;
  }
  return t;
})();

/** Rounds a box outward to whole cells. */
function cellBox(x0: number, y0: number, x1: number, y1: number): Bounds {
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

function unionBox(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function intersectBox(a: Bounds, b: Bounds): Bounds | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
}

function clampFt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? (v < 0 ? 0 : v > MAX_LIGHT_FT ? MAX_LIGHT_FT : v) : 0;
}

/** The scene box a sweep may use: a cell past the scene on every side, so a point inside the scene is strictly inside it. */
function sceneBox(w: number, h: number): Bounds {
  return { x0: -1, y0: -1, x1: w + 1, y1: h + 1 };
}

const tokensByScene = new WeakMap<object, Map<string, Token[]>>();

/**
 * The tokens on a scene, grouped once per token collection, except one an
 * op is still writing into (writable.ts), which is read as it is now.
 */
function tokensOn(state: RoomState, sceneId: string): Token[] {
  let byScene = tokensByScene.get(state.tokens);
  if (!byScene) {
    byScene = new Map();
    for (const t of Object.values(state.tokens)) {
      if (!t) continue;
      let list = byScene.get(t.sceneId);
      if (!list) byScene.set(t.sceneId, (list = []));
      list.push(t);
    }
    if (!isWritable(state.tokens)) tokensByScene.set(state.tokens, byScene);
  }
  return byScene.get(sceneId) ?? [];
}

function feetPerCellOf(state: RoomState): number {
  const f = state.meta?.settings?.feetPerCell;
  return typeof f === "number" && Number.isFinite(f) && f > 0 ? f : 5;
}

/** A light as one computation sees it: its sweep, where it stands after the step off a wall, and what it lights. */
type LightPlan = {
  key: string;
  inputKey: string;
  /** Null for a light walls do not stop. */
  eye: EyeSet | null;
  /** Its center: the stepped position for a light walls stop, null when no step qualified. */
  at: { x: number; y: number } | null;
  /** Its lit box in cells, clipped to the scene, and the box its sweep uses. */
  litBox: Bounds;
  sweepBox: Bounds;
  walls: boolean;
  /** Bright and outer radii in cells. */
  rb: number;
  rd: number;
};

/** A source as one computation sees it, before its polygon is swept. */
type SourcePlan = {
  id: string;
  polyKey: string;
  levelKey: string;
  eye: { x: number; y: number } | null;
  set: EyeSet;
  box: Bounds | null;
  blind: boolean;
  /** Squared radii in cells. */
  dv2: number;
  ts2: number;
  bs2: number;
  reason?: NoSightReason;
};

/** Everything one computation reads, gathered once. */
type Inputs = {
  scene: Scene;
  walls: WallSet;
  w: number;
  h: number;
  W: number;
  H: number;
  level: LightLevel;
  fpc: number;
  members: Candidate[];
  sources: SourcePlan[];
  lights: LightPlan[];
  /** Everything the result is a function of, as one string. */
  signature: string;
};

/*
 * The lights that change the party's sight on a scene below Bright: free
 * lights that are on, and the lights tokens carry, except a token the DM
 * hid (section 4.3.2), at most the cap's number (carriedLights). A token
 * withheld only because the party cannot see it still lights its
 * surroundings. A free light sits 5 ft above the ground
 * under it and a carried one at its bearer's eye.
 */
function planLights(state: RoomState, scene: Scene, tokens: readonly Token[], walls: WallSet, fpc: number): LightPlan[] {
  const { w, h } = scene.bounds;
  const out: LightPlan[] = [];
  const plan = (key: string, x: number, y: number, brightFt: unknown, dimFt: unknown, shadows: boolean, heightFt: number) => {
    const bright = clampFt(brightFt);
    const dim = clampFt(dimFt);
    if ((bright <= 0 && dim <= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const { rb, rd } = lightCells(bright, dim, fpc);
    const around = cellBox(x - rd, y - rd, x + rd, y + rd);
    const litBox = intersectBox(around, { x0: 0, y0: 0, x1: w, y1: h });
    const sweepBox = intersectBox(around, sceneBox(w, h));
    if (!litBox || !sweepBox) return;
    const eye = shadows ? eyeSet(walls, heightFt) : null;
    const at = eye ? stepOffWalls(x, y, eye.set.stored, SIGHT) : { x, y };
    const inputKey = `${x},${y},${bright},${dim},${shadows ? `${eye!.key},${at ? `${at.x},${at.y}` : "-"}` : "open"}`;
    out.push({ key, inputKey, eye, at, litBox, sweepBox, walls: shadows, rb, rd });
  };
  for (const light of Object.values(state.lights)) {
    if (!light || light.sceneId !== scene.id || light.on !== true) continue;
    plan(`l:${light.id}`, light.x, light.y, light.bright, light.dim, light.walls !== false, groundAt(state.buildChunks, scene.id, Math.floor(light.x), Math.floor(light.y)) + 5);
  }
  for (const token of carriedLights(state, tokens)) {
    const c = storedCenter(token);
    plan(`t:${token.id}`, c.x, c.y, token.light!.bright, token.light!.dim, true, token.elevation + tokenHeightFt(token, fpc));
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/*
 * The carried lights that light the party's sight: those the cap counts
 * (countsAsLitTokenLight), at most LIMITS.litTokenLightsPerScene. The cap
 * refuses only the DM's ops (shared/limits.ts), so a player's torch or a
 * hidden combatant revealed on its turn can pass it. Then the first lights
 * in a fixed order light, as the source cap takes its sources: the party's
 * own in the source cap's order (player characters, other player-owned
 * creatures, then creatures the DM marked), then every other token, each
 * group by token ID. So a player's torch always lights, and a monster's
 * never puts out the party's.
 */
function carriedLights(state: RoomState, tokens: readonly Token[]): Token[] {
  const lit = tokens.filter(countsAsLitTokenLight);
  if (lit.length <= LIMITS.litTokenLightsPerScene) return lit;
  const rank = (t: Token) => {
    const owned = playerOwned(state, t);
    return owned && t.kind === "pc" ? 0 : owned ? 1 : t.partyVision === true ? 2 : 3;
  };
  return lit
    .map((token) => ({ token, rank: rank(token) }))
    .sort((a, b) => a.rank - b.rank || (a.token.id < b.token.id ? -1 : a.token.id > b.token.id ? 1 : 0))
    .slice(0, LIMITS.litTokenLightsPerScene)
    .map((e) => e.token);
}

/*
 * A light's bright radius and the outer edge of its dim band, in cells.
 * Each radius stops at LIMITS.lightRadiusMaxCells as well as at 120 ft,
 * which binds only on a grid finer than 5 ft per cell (section 2.4). A
 * light under it keeps its outer edge as (bright + dim) / fpc, the same
 * arithmetic as before the cap, so sight on every coarser grid is the same
 * to the last bit.
 */
export function lightCells(bright: number, dim: number, fpc: number): { rb: number; rd: number } {
  const rb = bright / fpc;
  const band = dim / fpc;
  const cap = LIMITS.lightRadiusMaxCells;
  if (rb <= cap && band <= cap) return { rb, rd: (bright + dim) / fpc };
  const capped = Math.min(rb, cap);
  return { rb: capped, rd: capped + Math.min(band, cap) };
}

/** A sense's range in cells: its feet, and at most LIMITS.senseMaxCells on a grid finer than 5 ft per cell (section 2.4). */
export function senseCells(ft: number, fpc: number): number {
  return Math.min(ft / fpc, LIMITS.senseMaxCells);
}

function planSource(walls: WallSet, scene: Scene, level: LightLevel, fpc: number, litBounds: Bounds | null, c: Candidate): SourcePlan {
  const { token } = c;
  const { w, h } = scene.bounds;
  const center = storedCenter(token);
  const set = eyeSet(walls, token.elevation + tokenHeightFt(token, fpc));
  const senses = parseSenses(c.actor?.senses);
  const blind = c.actor !== undefined && hasEffect(c.actor, "blinded");
  const dv = blind ? 0 : senseCells(senses.darkvision, fpc);
  const ts = blind ? 0 : senseCells(senses.truesight, fpc);
  const bs = senseCells(senses.blindsight, fpc);
  const base = { id: token.id, levelKey: `${blind ? 1 : 0},${dv},${ts},${bs}`, set, blind, dv2: dv * dv, ts2: ts * ts, bs2: bs * bs };
  const stepped = stepOffWalls(center.x, center.y, set.set.stored, SIGHT);
  if (!stepped) return { ...base, polyKey: "wall", eye: null, box: null, reason: "wall" };
  const { x: ex, y: ey } = stepped;
  /*
   * The sweep's box bounds everything the source could see (section
   * 4.3.4): the whole scene where plain sight sees, otherwise its senses
   * and every lit area, and always the cells around the eye so the eye is
   * strictly inside. It depends only on these inputs, never on what was
   * computed before, so the polygon does too.
   */
  let box: Bounds | null;
  if (!blind && level !== "dark") box = sceneBox(w, h);
  else {
    box = cellBox(ex - 1, ey - 1, ex + 2, ey + 2);
    for (const r of [dv, ts, bs]) if (r > 0) box = unionBox(box, cellBox(ex - r, ey - r, ex + r, ey + r));
    if (!blind && litBounds) box = unionBox(box, litBounds);
    box = intersectBox(box, sceneBox(w, h));
  }
  const seesAnything = blind ? bs > 0 : level !== "dark" || dv > 0 || ts > 0 || bs > 0 || litBounds !== null;
  if (!seesAnything || !box) return { ...base, polyKey: "none", eye: { x: ex, y: ey }, box: null };
  return { ...base, polyKey: `${ex},${ey},${set.key},${box.x0},${box.y0},${box.x1},${box.y1}`, eye: { x: ex, y: ey }, box };
}

function gather(state: RoomState, scene: Scene, world: VisionWorld): Inputs {
  const walls = world.walls(scene, state.buildChunks);
  const { w, h } = scene.bounds;
  const level: LightLevel = scene.vision?.light === "dim" || scene.vision?.light === "dark" ? scene.vision.light : "bright";
  const fpc = feetPerCellOf(state);
  const tokens = tokensOn(state, scene.id);
  const members = candidatesOf(state, tokens);
  // In a Bright scene lights change nothing and are skipped (section 4.3.2).
  const lights = level === "bright" ? [] : planLights(state, scene, tokens, walls, fpc);
  let litBounds: Bounds | null = null;
  for (const l of lights) litBounds = unionBox(litBounds, l.litBox);
  const sources = members.filter((c) => !c.reason).map((c) => planSource(walls, scene, level, fpc, litBounds, c));
  const parts: string[] = [`${w},${h},${level},${fpc}`];
  for (const p of sources) parts.push(`${p.id}|${p.polyKey}|${p.levelKey}`);
  for (const l of lights) parts.push(`${l.key}|${l.inputKey}`);
  return { scene, walls, w, h, W: w * SUB, H: h * SUB, level, fpc, members, sources, lights, signature: parts.join(";") };
}

function buildSource(inp: Inputs, plan: SourcePlan, reuse: SourceEntry | null): SourceEntry {
  let spans: RowSpans | null = null;
  let polyBox: Bounds | null = null;
  let pieces: Held<Float64Array> | null = null;
  let reason = plan.reason;
  if (reuse && reuse.polyKey === plan.polyKey) {
    ({ spans, polyBox, pieces, reason } = reuse);
  } else if (plan.eye && plan.box) {
    pieces = new WeakRef(plan.set.set.pieces);
    const poly = visibleFrom(plan.eye.x, plan.eye.y, plan.set.set.pieces, plan.box);
    if (!poly) {
      reason = "wall";
      polyBox = { x0: plan.eye.x, y0: plan.eye.y, x1: plan.eye.x, y1: plan.eye.y };
    } else {
      polyBox = polygonBounds(poly);
      spans = polygonSpans(poly, subRows(polyBox, inp.W, inp.H), inp.W);
    }
  }
  let senses: Int16Array | null = null;
  if (spans?.box && plan.eye && (plan.dv2 > 0 || plan.ts2 > 0 || plan.bs2 > 0)) {
    const rows = spans.off.length - 1;
    senses = new Int16Array(rows * 6);
    for (let k = 0; k < rows; k++) {
      const j = spans.r0 + k;
      if (plan.dv2 > 0) circleColumns(plan.eye.x, plan.eye.y, plan.dv2, j, inp.W, senses, 6 * k);
      if (plan.ts2 > 0) circleColumns(plan.eye.x, plan.eye.y, plan.ts2, j, inp.W, senses, 6 * k + 2);
      if (plan.bs2 > 0) circleColumns(plan.eye.x, plan.eye.y, plan.bs2, j, inp.W, senses, 6 * k + 4);
    }
  }
  return { id: plan.id, polyKey: plan.polyKey, pieces, polyBox, spans, levelKey: plan.levelKey, blind: plan.blind, senses, ...(reason ? { reason } : {}) };
}

/** A light's lit runs per row (section 4.3.2): inside its own polygon when walls cast shadows, bright within its bright radius, dim in the band beyond. */
function buildLight(inp: Inputs, plan: LightPlan): LightEntry {
  const rows = subRows(plan.litBox, inp.W, inp.H);
  const empty = (pieces: Float64Array | null, polyBox: Bounds | null): LightEntry => ({
    key: plan.key,
    inputKey: plan.inputKey,
    pieces: pieces ? new WeakRef(pieces) : null,
    polyBox,
    runs: { r0: rows.r0, off: new Int32Array(1), data: new Int16Array(0), box: null },
  });
  let spans: RowSpans;
  let polyBox: Bounds | null = null;
  let pieces: Float64Array | null = null;
  if (plan.walls) {
    // No step qualified: the light fails closed and lights nothing (section 4.3.2).
    if (!plan.at || !plan.eye) return empty(plan.eye?.set.pieces ?? null, null);
    pieces = plan.eye.set.pieces;
    const poly = visibleFrom(plan.at.x, plan.at.y, pieces, plan.sweepBox);
    if (!poly) return empty(pieces, { x0: plan.at.x, y0: plan.at.y, x1: plan.at.x, y1: plan.at.y });
    polyBox = polygonBounds(poly);
    spans = polygonSpans(poly, rows, inp.W);
  } else spans = boxSpans(rows);
  const { x: cx, y: cy } = plan.at!;
  const count = spans.off.length - 1;
  const off = new Int32Array(count + 1);
  const data: number[] = [];
  const circ = new Int32Array(4);
  let box: SubBox | null = null;
  const put = (j: number, a: number, b: number, v: number) => {
    if (a >= b) return;
    data.push(a, b, v);
    if (!box) box = { c0: a, r0: j, c1: b, r1: j + 1 };
    else {
      if (a < box.c0) box.c0 = a;
      if (b > box.c1) box.c1 = b;
      if (j + 1 > box.r1) box.r1 = j + 1;
    }
  };
  for (let k = 0; k < count; k++) {
    const j = spans.r0 + k;
    circleColumns(cx, cy, plan.rd * plan.rd, j, inp.W, circ, 0);
    circ[2] = 0;
    circ[3] = 0;
    if (plan.rb > 0) circleColumns(cx, cy, plan.rb * plan.rb, j, inp.W, circ, 2);
    const d0 = circ[0]!;
    const d1 = circ[1]!;
    const b0 = circ[2]!;
    const b1 = circ[3]!;
    if (d0 < d1) {
      for (let p = spans.off[k]!; p < spans.off[k + 1]!; p += 2) {
        const a = Math.max(spans.xs[p]!, d0);
        const b = Math.min(spans.xs[p + 1]!, d1);
        if (a >= b) continue;
        if (b0 >= b1) put(j, a, b, DIM);
        else {
          put(j, a, Math.min(b, b0), DIM);
          put(j, Math.max(a, b0), Math.min(b, b1), BRIGHT);
          put(j, Math.max(a, b1), b, DIM);
        }
      }
    }
    off[k + 1] = data.length;
  }
  return { key: plan.key, inputKey: plan.inputKey, pieces: pieces ? new WeakRef(pieces) : null, polyBox, runs: { r0: spans.r0, off, data: Int16Array.from(data), box } };
}

/** The light level along one row: the base, raised by every light's runs, ascending so each sub-cell keeps its highest. */
function lightRow(j: number, W: number, base: number, lights: readonly LightEntry[], buf: Uint8Array): LightRow {
  let touched = false;
  for (const pass of [DIM, BRIGHT]) {
    if (pass <= base) continue;
    for (const l of lights) {
      const k = j - l.runs.r0;
      if (k < 0 || k >= l.runs.off.length - 1) continue;
      for (let p = l.runs.off[k]!; p < l.runs.off[k + 1]!; p += 3) {
        if (l.runs.data[p + 2] !== pass) continue;
        if (!touched) {
          buf.fill(base, 0, W);
          touched = true;
        }
        buf.fill(pass, l.runs.data[p]!, l.runs.data[p + 1]!);
      }
    }
  }
  if (!touched) return null;
  const starts: number[] = [0];
  const levels: number[] = [buf[0]!];
  for (let x = 1; x < W; x++) {
    if (buf[x] !== buf[x - 1]) {
      starts.push(x);
      levels.push(buf[x]!);
    }
  }
  return { starts: Int16Array.from(starts), levels: Uint8Array.from(levels) };
}

/** Growable list of `[start, end)` pairs into a tile's level array. */
class Runs {
  data = new Int32Array(1024);
  length = 0;
  push(a: number, b: number): void {
    if (this.length + 2 > this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }
}

/** Scratch reused across tiles: the levels of one tile, and its runs by level. */
const scratch = { levels: new Uint8Array(TILE_AREA), runs: [new Runs(), new Runs(), new Runs(), new Runs()] as const };

/*
 * One tile's levels: every source's contribution, each run of sub-cells at
 * the level section 4.3.2's table gives it, filled lowest level first so
 * each sub-cell ends at the best level any source has there. Packed 2 bits
 * per sub-cell. Returns the packed tile and the level it holds throughout,
 * or -1 when it varies.
 */
function renderTile(inp: Inputs, tx: number, ty: number, sources: readonly SourceEntry[], lightRows: readonly LightRow[] | null): { packed: Uint8Array; uniform: number } {
  const { levels, runs } = scratch;
  levels.fill(0);
  for (const r of runs) r.length = 0;
  const base = baseLevel(inp.level);
  const c0 = tx * TILE;
  const r0 = ty * TILE;
  const c1 = Math.min(c0 + TILE, inp.W);
  const r1 = Math.min(r0 + TILE, inp.H);
  const tileBox: SubBox = { c0, r0, c1, r1 };
  for (const src of sources) {
    const spans = src.spans;
    if (!spans || !boxesMeet(spans.box, tileBox)) continue;
    const blindBit = src.blind ? 4 : 0;
    const ja = Math.max(r0, spans.r0);
    const jb = Math.min(r1, spans.r0 + spans.off.length - 1);
    for (let j = ja; j < jb; j++) {
      const k = j - spans.r0;
      const rowAt = (j - r0) * TILE - c0;
      const sv = src.senses;
      const d0 = sv ? sv[6 * k]! : 0;
      const d1 = sv ? sv[6 * k + 1]! : 0;
      const t0 = sv ? sv[6 * k + 2]! : 0;
      const t1 = sv ? sv[6 * k + 3]! : 0;
      const b0 = sv ? sv[6 * k + 4]! : 0;
      const b1 = sv ? sv[6 * k + 5]! : 0;
      const lrow = lightRows ? (lightRows[j] ?? null) : null;
      for (let p = spans.off[k]!; p < spans.off[k + 1]!; p += 2) {
        let x = Math.max(spans.xs[p]!, c0);
        const end = Math.min(spans.xs[p + 1]!, c1);
        if (x >= end) continue;
        if (!lrow && base === BRIGHT && blindBit === 0) {
          runs[BRIGHT].push(rowAt + x, rowAt + end);
          continue;
        }
        // The light run holding x.
        let li = 0;
        if (lrow) {
          let lo = 0;
          let hi = lrow.starts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lrow.starts[mid]! <= x) lo = mid;
            else hi = mid - 1;
          }
          li = lo;
        }
        while (x < end) {
          let light = base;
          let next = end;
          if (lrow) {
            light = lrow.levels[li]!;
            const lend = li + 1 < lrow.starts.length ? lrow.starts[li + 1]! : inp.W;
            if (lend < next) next = lend;
          }
          let bits = light | blindBit;
          if (x >= d0 && x < d1) {
            bits |= 8;
            if (d1 < next) next = d1;
          } else if (d0 > x && d0 < next) next = d0;
          if (x >= t0 && x < t1) {
            bits |= 16;
            if (t1 < next) next = t1;
          } else if (t0 > x && t0 < next) next = t0;
          if (x >= b0 && x < b1) {
            bits |= 32;
            if (b1 < next) next = b1;
          } else if (b0 > x && b0 < next) next = b0;
          const v = LEVEL_TABLE[bits]!;
          if (v > 0) runs[v as 1 | 2 | 3].push(rowAt + x, rowAt + next);
          if (lrow && li + 1 < lrow.starts.length && next >= lrow.starts[li + 1]!) li++;
          x = next;
        }
      }
    }
  }
  for (let v = 1; v <= 3; v++) {
    const r = runs[v as 1 | 2 | 3];
    for (let p = 0; p < r.length; p += 2) levels.fill(v, r.data[p]!, r.data[p + 1]!);
  }
  const first = levels[0]!;
  let uniform = first;
  const packed = new Uint8Array(SIGHT_TILE_BYTES);
  for (let i = 0, b = 0; i < TILE_AREA; i += 4, b++) {
    const a0 = levels[i]!;
    const a1 = levels[i + 1]!;
    const a2 = levels[i + 2]!;
    const a3 = levels[i + 3]!;
    if (uniform >= 0 && (a0 !== first || a1 !== first || a2 !== first || a3 !== first)) uniform = -1;
    packed[b] = a0 | (a1 << 2) | (a2 << 4) | (a3 << 6);
  }
  return uniform >= 0 ? { packed: UNIFORM[uniform]!, uniform } : { packed, uniform };
}

function subOf(b: Bounds | null, W: number, H: number): SubBox | null {
  if (!b) return null;
  const s = subRows(b, W, H);
  return s.c0 < s.c1 && s.r0 < s.r1 ? s : null;
}

/** Marks every tile a box of sub-cells meets. */
function markTiles(dirty: Uint8Array, across: number, b: SubBox | null): void {
  if (!b || b.c0 >= b.c1 || b.r0 >= b.r1) return;
  const tx0 = Math.floor(b.c0 / TILE);
  const tx1 = Math.floor((b.c1 - 1) / TILE);
  const ty0 = Math.floor(b.r0 / TILE);
  const ty1 = Math.floor((b.r1 - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (tx >= 0 && tx < across && ty >= 0 && ty * across + tx < dirty.length) dirty[ty * across + tx] = 1;
}

function sameTile(a: SightTile, b: SightTile): boolean {
  return "f" in a ? "f" in b && a.f === b.f : "b" in b && a.b === b.b;
}

/*
 * One computation, cold or from the scene's last one. Section 4.3.4's rule
 * decides what is reused: a source's or light's polygon is recomputed only
 * when its own inputs changed (its stepped eye, sight set and box, which
 * the polygon is a function of) or a sight piece that differs between the
 * set it was swept over and the one it would be swept over now meets its
 * bounding box. A piece outside that box lies behind the polygon's
 * boundary, and the sweep's output does not depend on hidden pieces, so the
 * result equals a cold computation bit for bit. That is finer than the
 * design's changed chunks grown by 5 cells, and never coarser: a long wall
 * run split where a free wall far away crossed it changes pieces the chunk
 * rule would not look at.
 */
function compute(inp: Inputs, prev: SceneEntry | null): SceneEntry {
  const { W, H, w, h } = inp;
  const across = Math.max(1, Math.ceil(w / CHUNK_CELLS));
  const down = Math.max(1, Math.ceil(h / CHUNK_CELLS));
  const base = prev !== null && prev.w === w && prev.h === h && prev.level === inp.level && prev.fpc === inp.fpc ? prev : null;
  const dirty = new Uint8Array(across * down);
  if (!base) dirty.fill(1);
  const dirtySub = (b: SubBox | null) => markTiles(dirty, across, b);
  const diffs = new Map<Float64Array, Map<Float64Array, ChangedCells>>();
  const stale = (held: Held<Float64Array> | null, now: Float64Array | null, polyBox: Bounds | null): boolean => {
    const was = held === null ? null : held.deref();
    if (was === undefined) return true;
    if (was === now) return false;
    if (was === null || now === null || polyBox === null) return true;
    let row = diffs.get(was);
    if (!row) diffs.set(was, (row = new Map()));
    let changed = row.get(now);
    if (!changed) row.set(now, (changed = new ChangedCells(pieceDiff(was, now), w, h)));
    return changed.meets(polyBox);
  };

  // Sources.
  const sources = new Map<string, SourceEntry>();
  for (const plan of inp.sources) {
    const old = base?.sources.get(plan.id) ?? null;
    const now = plan.eye && plan.box ? plan.set.set.pieces : null;
    const reuse = old && old.polyKey === plan.polyKey && !stale(old.pieces, now, old.polyBox) ? old : null;
    const entry = reuse && reuse.levelKey === plan.levelKey ? reuse : buildSource(inp, plan, reuse);
    sources.set(plan.id, entry);
    if (entry !== old) {
      dirtySub(old?.spans?.box ?? null);
      dirtySub(entry.spans?.box ?? null);
    }
  }
  if (base) for (const [id, old] of base.sources) if (!sources.has(id)) dirtySub(old.spans?.box ?? null);

  /*
   * Lights, lazily (section 4.3.4): a light is computed only when some
   * source's sight reaches its lit box. One already held stays while its
   * inputs and walls hold, needed or not: where no source sees, its light
   * changes no level. One that changed and that no source needs is dropped.
   */
  const lights = new Map<string, LightEntry>();
  if (inp.level !== "bright") {
    const seen: SubBox[] = [];
    for (const s of sources.values()) if (s.spans?.box) seen.push(s.spans.box);
    for (const plan of inp.lights) {
      const old = base?.lights.get(plan.key) ?? null;
      const now = plan.walls && plan.eye ? plan.eye.set.pieces : null;
      const valid = old !== null && old.inputKey === plan.inputKey && !stale(old.pieces, now, old.polyBox);
      if (valid) {
        lights.set(plan.key, old);
        continue;
      }
      const litSub = subOf(plan.litBox, W, H);
      if (seen.some((b) => boxesMeet(b, litSub))) {
        const entry = buildLight(inp, plan);
        lights.set(plan.key, entry);
        dirtySub(entry.runs.box);
      }
      dirtySub(old?.runs.box ?? null);
    }
    if (base) for (const [key, old] of base.lights) if (!lights.has(key)) dirtySub(old.runs.box);
  }

  // The light level, row by row, wherever a tile is redrawn.
  let lightRows: LightRow[] | null = null;
  if (inp.level !== "bright") {
    lightRows = base?.lightRows ? base.lightRows.slice() : new Array<LightRow>(H).fill(null);
    const held = [...lights.values()];
    const buf = new Uint8Array(W);
    const base0 = baseLevel(inp.level);
    for (let ty = 0; ty < down; ty++) {
      let rowDirty = false;
      for (let tx = 0; tx < across && !rowDirty; tx++) if (dirty[ty * across + tx] === 1) rowDirty = true;
      if (!rowDirty) continue;
      for (let j = ty * TILE; j < Math.min(H, (ty + 1) * TILE); j++) lightRows[j] = lightRow(j, W, base0, held, buf);
    }
  }

  // The union over every tile that may have changed.
  const packed = base ? base.packed.slice() : new Array<Uint8Array | null>(across * down).fill(null);
  const tiles = base ? new Map(base.tiles) : new Map<string, SightTile>();
  const lending = [...sources.values()];
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      if (dirty[ty * across + tx] !== 1) continue;
      const { packed: p, uniform } = renderTile(inp, tx, ty, lending, lightRows);
      const key = `${tx},${ty}`;
      if (uniform === 0) {
        packed[ty * across + tx] = null;
        tiles.delete(key);
        continue;
      }
      packed[ty * across + tx] = p;
      const tile = tileOf(p, uniform);
      const before = tiles.get(key);
      if (!before || !sameTile(before, tile)) tiles.set(key, tile);
    }
  }
  const sight = new TileSight(tiles, (tx, ty) => (tx >= 0 && tx < across && ty >= 0 && ty < down ? (packed[ty * across + tx] ?? null) : null));
  /*
   * What the entry holds, for the cache's byte cap: each array's contents
   * plus about 160 bytes for the array itself, which measured at the caps
   * (about 1 MB for a dark scene) shows is not small next to them.
   */
  const ARRAY = 160;
  let bytes = 4096 + 2 * inp.signature.length + 8 * packed.length;
  for (const p of packed) if (p && !UNIFORM.includes(p)) bytes += SIGHT_TILE_BYTES + 1400 + ARRAY;
  for (const s of sources.values()) bytes += (s.spans ? s.spans.xs.byteLength + s.spans.off.byteLength + 2 * ARRAY : 0) + (s.senses ? s.senses.byteLength + ARRAY : 0) + 200;
  for (const l of lights.values()) bytes += l.runs.data.byteLength + l.runs.off.byteLength + 2 * ARRAY + 200;
  if (lightRows) for (const r of lightRows) bytes += r ? r.starts.byteLength + r.levels.byteLength + 2 * ARRAY : 8;
  return { walls: new WeakRef(inp.walls), w, h, level: inp.level, fpc: inp.fpc, signature: inp.signature, sources, lights, lightRows, packed, tiles, sight, bytes };
}

// ---------------------------------------------------------------------------
// The cache

/*
 * Each scene keeps at most two computations, the committed state's and the
 * staged one's (section 2.1), and every computation starts from the newest:
 * the reuse rule above makes any starting point give the cold answer, so
 * which one it is only changes the work. Scenes are dropped least recently
 * used past 64 MB in all (section 4.3.6). Scene IDs are chosen by clients,
 * so two rooms may share one, which costs work and never a wrong answer.
 * The design also keeps each room to its 4 most recent vision scenes. The
 * state carries no room ID, so the byte cap alone bounds the cache.
 */
const PER_SCENE = 2;
export const VISION_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, SceneEntry[]>();
let cacheBytes = 0;
const results = new WeakMap<RoomState, Map<string, PartySight>>();

function remember(sceneId: string, entry: SceneEntry, others: readonly SceneEntry[]): void {
  const old = cache.get(sceneId) ?? [];
  for (const e of old) cacheBytes -= e.bytes;
  cache.delete(sceneId);
  const kept = [entry, ...others.filter((e) => e !== entry)].slice(0, PER_SCENE);
  for (const e of kept) cacheBytes += e.bytes;
  cache.set(sceneId, kept);
  while (cacheBytes > VISION_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value!;
    for (const e of cache.get(oldest)!) cacheBytes -= e.bytes;
    cache.delete(oldest);
  }
}

/** Drops every cached computation. Tests use it to compare against cold. */
export function clearVisionCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/**
 * The party's sight on a scene whose vision is on (section 4.3), on the
 * server: from the scene's last computation where its inputs allow,
 * otherwise cold, and always equal to the cold answer. A scene without
 * vision, or one the state lacks, sees nothing.
 */
export function partySight(state: RoomState, sceneId: SceneId, world: VisionWorld): PartySight {
  const scene = state.scenes[sceneId];
  if (!scene || scene.vision?.on !== true) return NO_PARTY_SIGHT;
  const finished = !writes(state);
  let byScene = finished ? results.get(state) : undefined;
  const hit = byScene?.get(sceneId);
  if (hit) return hit;
  const inp = gather(state, scene, world);
  const held = cache.get(sceneId) ?? [];
  let entry = held.find((e) => e.walls.deref() === inp.walls && e.signature === inp.signature);
  if (!entry) entry = compute(inp, held[0] ?? null);
  remember(sceneId, entry, held);
  if (finished) {
    if (!byScene) results.set(state, (byScene = new Map()));
    byScene.set(sceneId, entry.sight);
  }
  return entry.sight;
}

/*
 * Whether an op may still write into the state or a collection sight reads
 * (writable.ts): then its answer is not kept by the state's identity, which
 * would outlive the writes. The scene cache above is safe either way, since
 * it matches what the state holds, not which object holds it.
 */
function writes(state: RoomState): boolean {
  return isWritable(state) || isWritable(state.tokens) || isWritable(state.lights) || isWritable(state.characters) || isWritable(state.buildChunks) || isWritable(state.scenes);
}

/** The same answer computed from nothing, ignoring and leaving the cache. For tests and benchmarks. */
export function coldPartySight(state: RoomState, sceneId: SceneId, world: VisionWorld): PartySight {
  const scene = state.scenes[sceneId];
  if (!scene || scene.vision?.on !== true) return NO_PARTY_SIGHT;
  return compute(gather(state, scene, world), null).sight;
}

/**
 * Every party member on a scene and whether it lends sight, with its senses
 * and light, for the DM's Vision settings (section 4.3.1, where the DM sees
 * what owners set). `overCap` counts sources past the cap.
 *
 * Whether the party can see at all before players move there is not asked
 * here: a DM's view holds the creatures and lights of the scene in view
 * only, whose sight tiles already answer it (client/features/vision/moveWarning.ts).
 */
export function visionReport(state: RoomState, sceneId: SceneId, world: VisionWorld): { members: MemberReport[]; overCap: number } {
  const scene = state.scenes[sceneId];
  if (!scene) return { members: [], overCap: 0 };
  // The scene's light level counts whether or not vision is on yet, so the DM can check before turning it on.
  const inp = gather(state, scene, world);
  const onWall = new Set(inp.sources.filter((p) => p.reason === "wall").map((p) => p.id));
  let overCap = 0;
  const members = inp.members.map((c): MemberReport => {
    const reason = c.reason ?? (onWall.has(c.token.id) ? "wall" : undefined);
    if (reason === "cap") overCap++;
    const light = c.token.light && (c.token.light.bright > 0 || c.token.light.dim > 0) ? { bright: c.token.light.bright, dim: c.token.light.dim } : undefined;
    return { tokenId: c.token.id, lends: reason === undefined, ...(reason ? { reason } : {}), senses: parseSenses(c.actor?.senses), ...(light ? { light } : {}) };
  });
  return { members, overCap };
}

/** The sight polygon of one source as the cache would compute it, or null when it sees nothing. For tests. */
export function sourcePolygon(state: RoomState, sceneId: SceneId, tokenId: string, world: VisionWorld): { eye: { x: number; y: number }; box: Bounds; polygon: Polygon } | null {
  const scene = state.scenes[sceneId];
  if (!scene) return null;
  const plan = gather(state, scene, world).sources.find((p) => p.id === tokenId);
  if (!plan?.eye || !plan.box) return null;
  const polygon = visibleFrom(plan.eye.x, plan.eye.y, plan.set.set.pieces, plan.box);
  return polygon ? { eye: plan.eye, box: plan.box, polygon } : null;
}
