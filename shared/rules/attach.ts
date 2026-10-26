import { LIMITS } from "../limits.ts";
import type { AttachKind, Token } from "../model.ts";
import { isWritable } from "../writable.ts";
import { boxDistanceFt, tokenCellBox, type DistanceSettings } from "./distance.ts";
import { footprintRect, footprintSize, sizeCategory, snapStep, type FootprintToken, type PlacedToken, type SizeCategory } from "./footprint.ts";
import type { Point, Rect } from "./geom.ts";
import { footing, footprintGround } from "./heights.ts";
import { walksOffFromGround } from "../migrate.ts";
import type { Walker } from "./movement.ts";
import { SQUARES } from "./grid.ts";

/**
 * Attached tokens (docs/design-v1-attach.md): a rider on a mount, a
 * familiar on a shoulder, a torch in a hand, a grappled creature dragged
 * beside. The link lives on the carried token (`Token.attached`), and the
 * rules here are shared by the reducer, permissions and the client: which
 * kinds fit which pairs, where a carried token sits, how far a drag
 * reaches, which tokens move with which, and what every player may see of
 * a group.
 *
 * Every walk over the links keeps a visited set, so a loop the rules let
 * stand (one closed through a link not every player sees, 5.1) is walked
 * once, and every group is bounded by its scene's tokens.
 */

export const ATTACH_KINDS = ["ride", "perch", "carry", "drag"] as const satisfies readonly AttachKind[];

/** Whether the kind sits on its holder (5.1): inside its footprint, at its elevation, never walking on its own. */
export function onHolder(kind: AttachKind): boolean {
  return kind !== "drag";
}

/** A creature, as attaching reads it: anything but an object. */
export function isCreature(token: Pick<Token, "kind">): boolean {
  return token.kind !== "object";
}

const SIZE_RANK: Record<SizeCategory, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5 };

/** How many sizes `holder` is larger than `carried`, by movement's size categories (negative when smaller). */
export function sizesLarger(holder: Pick<PlacedToken, "size" | "w" | "h">, carried: Pick<PlacedToken, "size" | "w" | "h">): number {
  return SIZE_RANK[sizeCategory(holder)] - SIZE_RANK[sizeCategory(carried)];
}

/** The footprint links read: the full one, squeezed or not, so a mount squeezing through a corridor keeps its rider (5.1). */
export function fullRect(token: PlacedToken): Rect {
  return footprintRect(SQUARES, { size: token.size, x: token.x, y: token.y, ...(token.w !== undefined ? { w: token.w } : {}), ...(token.h !== undefined ? { h: token.h } : {}) });
}

const EPS = 1e-9;

/** Whether `carried`'s full footprint lies inside `holder`'s. */
export function insideHolder(carried: PlacedToken, holder: PlacedToken): boolean {
  const a = fullRect(carried);
  const b = fullRect(holder);
  return a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS;
}

/** Whether two full footprints share any area. */
export function overlaps(a: PlacedToken, b: PlacedToken): boolean {
  const ra = fullRect(a);
  const rb = fullRect(b);
  return ra.x < rb.x + rb.w - EPS && rb.x < ra.x + ra.w - EPS && ra.y < rb.y + rb.h - EPS && rb.y < ra.y + ra.h - EPS;
}

/** How far a drag reaches, and a player's attach: 5 ft, or one cell where a cell is wider, as a door's reach (design 9.8). */
export function attachReachFt(feetPerCell: number): number {
  return Math.max(5, feetPerCell);
}

/** The distance between two tokens' full footprints by the room's rule, elevation and height included. */
export function attachDistanceFt(settings: DistanceSettings, a: FootprintToken, b: FootprintToken): number {
  const full = (t: FootprintToken): FootprintToken => ({ ...t, squeeze: undefined });
  return boxDistanceFt(tokenCellBox(SQUARES, full(a), settings.feetPerCell), tokenCellBox(SQUARES, full(b), settings.feetPerCell), settings);
}

/** Whether two tokens are within reach of each other (attachReachFt). */
export function withinReach(settings: DistanceSettings, a: FootprintToken, b: FootprintToken): boolean {
  return attachDistanceFt(settings, a, b) <= attachReachFt(settings.feetPerCell);
}

type Sized = Pick<Token, "kind"> & PlacedToken;

/**
 * Whether the holder must be at least one size larger (5.1): a ride, and a
 * creature carried by a creature, as a grappled kobold under an arm. A
 * passenger on a cart only has to fit on it.
 */
function needsLarger(kind: AttachKind, carried: Pick<Token, "kind">, holder: Pick<Token, "kind">): boolean {
  return kind === "ride" || (kind === "carry" && isCreature(carried) && isCreature(holder));
}

/**
 * Whether a link of this kind still holds between the two as they stand
 * (5.2, "Links must hold"): on the same scene, and for what sits on its
 * holder the footprint inside the holder's and the holder large enough,
 * for a drag within reach. The kind itself is never worked out again.
 */
export function linkHolds(settings: DistanceSettings, kind: AttachKind, carried: Sized & FootprintToken & Pick<Token, "sceneId">, holder: Sized & FootprintToken & Pick<Token, "sceneId">): boolean {
  if (carried.sceneId !== holder.sceneId) return false;
  if (!onHolder(kind)) return withinReach(settings, carried, holder);
  return seatHolds(kind, carried, holder);
}

/** Whether what sits on its holder by a link of this kind still has its seat as they stand: inside the holder's footprint, the holder large enough. */
export function seatHolds(kind: AttachKind, carried: Sized & FootprintToken, holder: Sized & FootprintToken): boolean {
  if (!insideHolder(carried, holder)) return false;
  return !needsLarger(kind, carried, holder) || sizesLarger(holder, carried) >= 1;
}

/** The names a refusal speaks of, as the actor knows them. */
export type LinkNames = { carried: string; holder: string };

/**
 * Why this kind of link cannot join the two (5.1, 8.1), or null when it
 * can: who may ride, perch, carry or drag what, by token kind and size.
 * The seat or the reach is checked apart, since both depend on where the
 * carried token goes.
 */
export function kindRefusal(kind: AttachKind, carried: Sized, holder: Sized, names: LinkNames): string | null {
  switch (kind) {
    case "ride":
    case "perch":
      if (!isCreature(carried)) return "only a creature rides or perches";
      if (!isCreature(holder)) return `${names.holder} is not a creature to get on. Carry it instead`;
      if (kind === "ride" && sizeCategory(carried) === "tiny") return "a Tiny creature perches instead of riding";
      if (kind === "perch" && sizeCategory(carried) !== "tiny") return "only a Tiny creature perches";
      break;
    case "carry":
      break;
    case "drag":
      if (!isCreature(carried)) return "only a creature is dragged";
      if (!isCreature(holder)) return "only a creature drags";
      return null;
  }
  if (needsLarger(kind, carried, holder) && sizesLarger(holder, carried) < 1) return notBigEnough(names);
  if (!fitsInside(carried, holder)) return notBigEnough(names);
  return null;
}

function notBigEnough(names: LinkNames): string {
  return `${names.holder} is not big enough to carry ${names.carried}`;
}

/** Whether the carried footprint could lie inside the holder's anywhere, whatever its snap grid. */
function fitsInside(carried: PlacedToken, holder: PlacedToken): boolean {
  const a = footprintSize(carried);
  const b = footprintSize(holder);
  return a.w <= b.w + EPS && a.h <= b.h + EPS;
}

/**
 * Where a carried token sits on its holder (4.1): the spot on its own snap
 * grid inside the holder's full footprint nearest where it stands, ties to
 * the smaller y and then the smaller x, or null when none fits.
 */
export function seatSpot(carried: PlacedToken, holder: PlacedToken): Point | null {
  const size = footprintSize(carried);
  const step = snapStep(carried);
  const box = fullRect(holder);
  const from = fullRect(carried);
  const xs = gridSpots(box.x, box.x + box.w - size.w, step);
  const ys = gridSpots(box.y, box.y + box.h - size.h, step);
  let best: Point | null = null;
  let bestD = Infinity;
  for (const y of ys) {
    for (const x of xs) {
      const d = (x - from.x) ** 2 + (y - from.y) ** 2;
      if (d < bestD - EPS) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best;
}

/** The multiples of `step` from `lo` to `hi`, both inclusive, in order. */
function gridSpots(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - EPS) * step; v <= hi + EPS; v += step) out.push(v + 0);
  return out;
}

/** The rectangle a token would take at a spot, its full footprint. */
function at(token: PlacedToken, spot: Point): PlacedToken {
  return { size: token.size, x: spot.x, y: spot.y, ...(token.w !== undefined ? { w: token.w } : {}), ...(token.h !== undefined ? { h: token.h } : {}) };
}

/**
 * Whether a creature getting off may land at `spot` (4.3, 8.1): inside the
 * scene, within reach of its holder and clear of its footprint. Whether it
 * lands on another creature is the device's to judge, since the server's
 * answer would tell a player where a hidden one stands.
 */
export function getOffFits(settings: DistanceSettings, bounds: { w: number; h: number }, carried: FootprintToken, holder: FootprintToken, spot: Point & { elevation?: number }): boolean {
  const placed: FootprintToken = { ...at(carried, spot), elevation: spot.elevation ?? carried.elevation, ...(carried.height !== undefined ? { height: carried.height } : {}) };
  const r = fullRect(placed);
  if (r.x < -EPS || r.y < -EPS || r.x + r.w > bounds.w + EPS || r.y + r.h > bounds.h + EPS) return false;
  return !overlaps(placed, holder) && withinReach(settings, placed, holder);
}

/** A token as a walk reads it beside its link: what walkerFor needs of it and of its holder. */
type Walking = Sized & FootprintToken & Pick<Token, "id" | "sceneId" | "attached">;

/**
 * The token as it walks (4.3, reviews AT-ASTRA-13, AT-O-22, AT-O-26 and
 * AT-ASTRA-16): one that sits on a holder standing on the ground walks on
 * the ground, as it lands there, whatever the ground under its seat, and
 * every ledge stops it but those whose whole length lies strictly inside
 * the holder's footprint, until the walk first stands clear of the holder
 * (movement.ts MovingToken). So it crosses the step under a holder that
 * straddles two heights, and steps off no cliff at the holder's side and
 * climbs no ledge beyond it. The route search, every leg test, the walk's
 * points and its cost read it so, on the player's device and on the server
 * alike, wherever the walk ends, so both judge the one walk whatever cuts
 * it short. This reads only a link every player sees (`seen`, both
 * tokens): off a holder some player cannot see the token walks as itself,
 * as it does with no holder at all (8.0). So does one on a holder that
 * flies. The copy is for the walk alone and is never stored.
 *
 * A walk that leaves the holder, its move landing off it at `off.to`, starts
 * on the ground under its own footprint (movement.ts `groundStart`). One
 * whose move keeps its seat, a step to another seat on the holder or a
 * change of height there, starts at the seat, as it stays on the holder
 * (review FU20A-OP-7). With no `to`, as for a drag's search, which has
 * no end yet, the walk is taken to leave. An op stored before version 17
 * (migrate.ts walksOffFromGround) always starts at the seat.
 */
export function walkerFor<T extends Walking>(
  state: { tokens: Readonly<Record<string, Walking | undefined>>; buildChunks: Parameters<typeof footprintGround>[0] },
  token: T,
  seen: SeenByAll,
  off: WalkOff = {},
): T & Walker {
  const link = token.attached;
  // Off no holder, or one some player cannot see or that flies, the token walks as itself.
  if (!link || !onHolder(link.kind)) return token as T & Walker;
  const holder = holderOf(state.tokens, token) as Walking | undefined;
  if (!holder || !seen(token) || !seen(holder) || footing(state.buildChunks, holder) !== "ground") return token as T & Walker;
  const offHolder = { size: holder.size, x: holder.x, y: holder.y, ...(holder.w !== undefined ? { w: holder.w } : {}), ...(holder.h !== undefined ? { h: holder.h } : {}) };
  const leaves = walksOffFromGround(off.opVersion) && (off.to === undefined || !seatHolds(link.kind, { ...token, x: off.to.x, y: off.to.y }, holder));
  return { ...token, footing: "ground", offHolder, ...(leaves ? { groundStart: true as const } : {}) } as T & Walker;
}

/** What a walk off a holder reads of its move (walkerFor): the op version it replays at, none for a live one, and where the move lands. */
export type WalkOff = { opVersion?: number; to?: Point };

/**
 * Whether a token set down at `spot` lands as a walk lands (4.3): on the
 * ground there, under the footprint it lands with, or at its own height,
 * as a flier keeps it. A Get off place and a player's move of a dragged
 * creature they may not move take no other height, so neither lifts a
 * token any other way.
 */
export function landsAt(chunks: Parameters<typeof footprintGround>[0], token: PlacedToken & Pick<Token, "sceneId" | "elevation">, spot: Point & { elevation: number; squeeze?: boolean }): boolean {
  if (spot.elevation === token.elevation) return true;
  return spot.elevation === footprintGround(chunks, { ...token, x: spot.x, y: spot.y, squeeze: spot.squeeze === true ? true : undefined });
}

/**
 * The first place a creature may get off at (4.3): ring by ring around the
 * holder in the order new companions are spread (the east of the middle
 * first, then clockwise), each spot `getOffFits` takes and `accept`, the
 * device's own checks of creatures and walls, takes too. `landing` is the
 * height it would land at each spot, which reach is measured from, as the
 * server measures the op's: its own when not given. Null when none.
 */
export function getOffSpot(
  settings: DistanceSettings,
  bounds: { w: number; h: number },
  carried: FootprintToken,
  holder: FootprintToken,
  accept: (spot: Point) => boolean = () => true,
  landing?: (spot: Point) => number,
): Point | null {
  const size = footprintSize(carried);
  const step = snapStep(carried);
  const box = fullRect(holder);
  const center = { x: Math.round((box.x + box.w / 2 - size.w / 2) / step) * step + 0, y: Math.round((box.y + box.h / 2 - size.h / 2) / step) * step + 0 };
  // Every spot in reach lies within the holder's half width, the creature's, and the reach in cells and one more of the middle.
  const reachCells = attachReachFt(settings.feetPerCell) / settings.feetPerCell;
  const rings = Math.ceil((Math.max(box.w, box.h) / 2 + Math.max(size.w, size.h) / 2 + reachCells + 1) / step);
  for (let ring = 1; ring <= rings; ring++) {
    for (const spot of ringSpots(center, ring, step)) {
      if (getOffFits(settings, bounds, carried, holder, landing ? { ...spot, elevation: landing(spot) } : spot) && accept(spot)) return spot;
    }
  }
  return null;
}

/** The spots on the square ring at Chebyshev distance `ring`, from the east of the middle, clockwise (client/features/tokens/factory.ts). */
function* ringSpots(center: Point, ring: number, step: number): Generator<Point> {
  const d = ring * step;
  for (let i = -ring + 1; i <= ring; i++) yield { x: center.x + d, y: center.y + i * step };
  for (let i = ring - 1; i >= -ring; i--) yield { x: center.x + i * step, y: center.y + d };
  for (let i = ring - 1; i >= -ring; i--) yield { x: center.x - d, y: center.y + i * step };
  for (let i = -ring + 1; i <= ring; i++) yield { x: center.x + i * step, y: center.y - d };
}

// ---------------------------------------------------------------------------
// Groups

type Linked = Pick<Token, "id" | "sceneId" | "attached">;
type Tokens = Readonly<Record<string, Linked | undefined>>;

const indexes = new WeakMap<object, Map<string, string[]>>();

/**
 * What each holder carries directly, in token id order, from one pass over
 * the tokens: a link counts only between two tokens on one scene. Kept per
 * tokens record once no transaction can write into it (shared/writable.ts),
 * so a device's draw order, group line and drag share one index.
 */
export function carriedIndex(tokens: Tokens): ReadonlyMap<string, readonly string[]> {
  const cached = indexes.get(tokens);
  if (cached) return cached;
  const out = new Map<string, string[]>();
  for (const id of Object.keys(tokens).sort()) {
    const t = tokens[id];
    const to = t?.attached?.to;
    if (!t || to === undefined || to === t.id) continue;
    const holder = tokens[to];
    if (!holder || holder.sceneId !== t.sceneId) continue;
    let list = out.get(to);
    if (!list) out.set(to, (list = []));
    list.push(t.id);
  }
  if (!isWritable(tokens)) indexes.set(tokens, out);
  return out;
}

/** The holder a token is attached to, when it stands on the same scene. */
export function holderOf(tokens: Tokens, token: Linked): Linked | undefined {
  const to = token.attached?.to;
  if (to === undefined || to === token.id) return undefined;
  const holder = tokens[to];
  return holder && holder.sceneId === token.sceneId ? holder : undefined;
}

/**
 * The token and everything it carries, depth first in token id order, over
 * the whole link graph (8.2), stopping at any token in `named`: those move
 * where their own op says. `include(child, holder)` narrows the walk to some
 * links, as the public and check sets do.
 */
export function carriedGroup(tokens: Tokens, tokenId: string, named: ReadonlySet<string> = new Set(), include?: (child: Linked, holder: Linked) => boolean): string[] {
  const index = carriedIndex(tokens);
  const out: string[] = [];
  const seen = new Set<string>([tokenId]);
  const visit = (id: string) => {
    out.push(id);
    const holder = tokens[id];
    for (const child of index.get(id) ?? []) {
      if (seen.has(child) || named.has(child)) continue;
      const t = tokens[child];
      if (!t || !holder || (include && !include(t, holder))) continue;
      seen.add(child);
      visit(child);
    }
  };
  if (tokens[tokenId]) visit(tokenId);
  return out;
}

/**
 * An op's moving tokens, split by the tokens it names (8.2): each named
 * token with everything whose nearest named ancestor it is, the first named
 * token met walking up the links. Each named token's own list starts with
 * it. The split is the same whatever order the op lists them in, and for a
 * loop the rules let stand.
 */
export function moveGroups(tokens: Tokens, named: readonly string[]): Map<string, string[]> {
  const set = new Set(named);
  const out = new Map<string, string[]>();
  for (const id of named) if (!out.has(id)) out.set(id, carriedGroup(tokens, id, set));
  return out;
}

/** Whether every player sees a token: the reducer's `inSightOfNonOwners`, or a device's reading of its own copy. */
export type SeenByAll = (token: Linked) => boolean;

/**
 * A group's public members (8.0): the token, then the members and links
 * every player sees, a link being seen when both its ends are. Every input
 * another viewer can observe reads these and nothing else. `named` stops
 * the walk at other tokens an op names, as carriedGroup does.
 */
export function publicMembers(tokens: Tokens, tokenId: string, seen: SeenByAll, named: ReadonlySet<string> = new Set()): string[] {
  return carriedGroup(tokens, tokenId, named, (child, holder) => seen(child) && seen(holder));
}

/**
 * A group's check set (8.0): its public members and the tokens the op
 * names, with the links between them. Refusals, limits, loops, the seat
 * and get-off checks and the walls test read only these, since every
 * viewer misses an op that is refused. Traps' limits and refusals take it
 * as this list (docs/design-v1-traps.md). Attach's own checks take the
 * same set as a test over the link graph: the reducer's and the Attach
 * list's `inGraph`, the named tokens and every token all players see.
 */
export function checkSet(tokens: Tokens, tokenId: string, named: ReadonlySet<string>, seen: SeenByAll): string[] {
  const inSet = (t: Linked) => seen(t) || named.has(t.id);
  return carriedGroup(tokens, tokenId, named, (child, holder) => inSet(child) && inSet(holder));
}

/**
 * Why a new link would break the limits or close a loop (5.1, 8.1), or
 * null when it would not. It counts the links among the tokens `inGraph`
 * takes, both ends, with `carriedId`'s own link replaced by the new one:
 * the whole graph for the DM, the check set for a player.
 */
export function linkLimitRefusal(tokens: Tokens, carriedId: string, holderId: string, inGraph: (token: Linked) => boolean, names: LinkNames): string | null {
  const carried = tokens[carriedId];
  const holder = tokens[holderId];
  if (!carried || !holder) return null;
  const parent = (id: string): string | undefined => {
    if (id === carriedId) return holderId;
    const t = tokens[id];
    const up = t ? holderOf(tokens, t) : undefined;
    return t && up && inGraph(t) && inGraph(up) ? up.id : undefined;
  };
  // Walking up from the holder: a loop when it meets the carried token, and the chain above it otherwise.
  const above: string[] = [];
  const seenUp = new Set<string>();
  let up: string | undefined = holderId;
  while (up !== undefined && !seenUp.has(up)) {
    if (up === carriedId) return `${names.carried} would carry itself`;
    seenUp.add(up);
    above.push(up);
    up = parent(up);
  }
  const index = carriedIndex(tokens);
  const children = (id: string): string[] => {
    const out = (index.get(id) ?? []).filter((c) => c !== carriedId && parent(c) === id);
    if (id === holderId) out.push(carriedId);
    return out;
  };
  if (children(holderId).length > LIMITS.carriedPerToken) return `a token carries at most ${LIMITS.carriedPerToken} others`;
  const below = deepest(carriedId, children);
  if (above.length + below > LIMITS.attachDepth) return `a chain of carried tokens is at most ${LIMITS.attachDepth} deep`;
  const top = above[above.length - 1]!;
  if (subtreeSize(top, children) > LIMITS.groupTokens) return `a group moves at most ${LIMITS.groupTokens} tokens`;
  return null;
}

/** The longest chain down from a token, counted in tokens, with a visited set. */
function deepest(id: string, children: (id: string) => string[]): number {
  const seen = new Set<string>();
  const walk = (at: string): number => {
    seen.add(at);
    let most = 0;
    for (const c of children(at)) if (!seen.has(c)) most = Math.max(most, walk(c));
    return most + 1;
  };
  return walk(id);
}

function subtreeSize(id: string, children: (id: string) => string[]): number {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const c of children(stack.pop()!)) {
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return seen.size;
}

/**
 * The extra foot a holder pays for every foot it moves (7.3, Grappled's
 * "Movable"): 1 while it is a creature that drags a creature, or carries
 * one by a carry, that is neither Tiny nor two or more sizes smaller, by a
 * link every player sees (`seen`, for both ends). One however many. It
 * reads stored kinds, sizes, token kinds and what every player sees, never
 * a condition, so it is the same whoever moves the holder.
 */
export function dragExtra<T extends Linked & Sized>(tokens: Readonly<Record<string, T | undefined>>, holderId: string, seen: SeenByAll): 0 | 1 {
  const holder = tokens[holderId];
  if (!holder || !isCreature(holder) || !seen(holder)) return 0;
  for (const id of carriedIndex(tokens).get(holderId) ?? []) {
    const t = tokens[id];
    if (!t?.attached || !isCreature(t) || !seen(t)) continue;
    if (t.attached.kind !== "drag" && t.attached.kind !== "carry") continue;
    if (sizeCategory(t) === "tiny" || sizesLarger(holder, t) >= 2) continue;
    return 1;
  }
  return 0;
}
