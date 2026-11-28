import type { Actor, CompanionBlock, CustomMonster, PathStop, RoomState, Token, TokenPath, Viewer } from "../model.ts";
import { MAX_PATH_STOPS } from "../protocol.ts";
import { blockRollNumbers, type SrdRolls } from "../dice/bonus.ts";
import { blockEntries, nameParts, weaponReach } from "../dice/named.ts";
import type { SrdMonster, StatBlockMonster } from "../srd/monsters.ts";
import { monsterView, statBlockOf } from "../statBlock.ts";
import { carriedGroup, holderOf } from "./attach.ts";
import { legFeet, stepsBetween, tokenCellBox, type CellBox, type DistanceSettings } from "./distance.ts";
import { stopFootprint, type FootprintToken, type PlacedToken } from "./footprint.ts";
import { sceneGrid, type Grid } from "./grid.ts";
import { hexCenter } from "./hex.ts";
import { INCAPACITATING_KEYS } from "./hp.ts";
import { rowCharacter } from "./initiative.ts";
import { legSpots, reshapeLeg, type LegSpot, type Spot } from "./path.ts";
import { APART, AREAS, PIECE, contact, onSegment, orient } from "./segments.ts";
import { parseSenses } from "./vision.ts";
import { pieceTouches, sceneWalls, type WallSet } from "./walls.ts";

/**
 * Opportunity Attack notices (docs/design/design-v1-opportunity-attacks.md 4):
 * which enemies' reach a creature's move on its own turn leaves. Pure, and
 * shared by the drag's line, the turn card and the DM's toast, so the three
 * agree. Nothing here is stored: each device scans its own copy of the room,
 * so a player's answer reads only what their projection holds.
 *
 * A leave is a step from a spot within one of a creature's reaches to the
 * next spot beyond it. Walls and sight never make one: they are gates judged
 * at the departure spot, the last spot within that reach.
 */

/** One leg of the turn's path. `id` is the occurrence's (reconcileLegs). `provokes`: counted and not carried, read as a filter. */
export type ReachLeg = { id: number; from: PathStop; to: PathStop; provokes: boolean };

/**
 * A creature that could make an Opportunity Attack, as the scan reads it:
 * where it stands, its distinct reaches in feet, ascending, and what it
 * sees with. `known` is false where its reach was read as 5 ft for want of
 * its block. `extra` names the trait of its block that grants it more
 * Reactions ("Reactive Heads"), read once its block has loaded, else null.
 */
export type Reactor = {
  id: string;
  token: FootprintToken;
  reaches: readonly number[];
  blinded: boolean;
  blindsight: number;
  truesight: number;
  known: boolean;
  extra: string | null;
};

/**
 * One creature's reach left on a leg: `spot` is the index, in the leg's
 * walk (path.ts legSpots), of the first spot beyond `reach`, the spot before
 * it the departure spot. `extra` carries the reactor's trait for more
 * Reactions, so a row can stand with its Reaction used.
 */
export type ReachLeave = { id: string; spot: number; reach: number; extra?: string };

/** The SRD's monster blocks, once their chunk has loaded. */
export type SrdBlocks = readonly SrdMonster[];

/** The SRD chunks a scan reads, each passed in loaded or failed, never pending. */
export type Chunks = { rolls: SrdRolls | "failed"; monsters: SrdBlocks | "failed" };

/** The walls a scan's cover gate reads: the mover's scene's derived set (walls.ts sceneWalls). */
export type ReachWalls = WallSet;

/** What a scan is built from: this viewer's copy of the room, the DM's state or a player's projection. */
export type ReachView = Pick<RoomState, "meta" | "scenes" | "buildChunks" | "tokens" | "characters" | "companionBlocks" | "monsters" | "encounter">;

export type ScanInput = {
  grid: Grid;
  rules: DistanceSettings;
  walls: ReachWalls;
  /** The mover as it stands now, whose size a stop without a footprint was made at. */
  mover: PlacedToken & Partial<Pick<Token, "height">>;
  /** The mover is Invisible or has the Hidden status, so only Blindsight or Truesight sees it. */
  moverUnseen: boolean;
  reactors: readonly Reactor[];
};

/** A leg as one movement occurrence on this device. `parts`: the two records a join holds. */
export type LegRecord = { id: number; from: Spot; to: Spot; parts?: readonly LegRecord[] };

/** Work units a drag answer scans synchronously before it says the walk is checked after the drop. */
export const DRAG_WORK = 20_000;
/** Work units a stored leg's job scans between frames. */
export const SLICE_WORK = 20_000;
/** Work units past which one leg's scan stops: "Too many creatures here to check this walk." */
export const LEG_WORK_CAP = 2_000_000;
/** The longest reach a block's value is read as, in feet. */
export const MAX_REACH_FT = 120;

// ---------------------------------------------------------------------------
// Occurrences

function spotOf(p: Spot): Spot {
  return { x: p.x, y: p.y, elevation: p.elevation };
}

function same(a: Spot, b: Spot): boolean {
  return a.x === b.x && a.y === b.y && a.elevation === b.elevation;
}

/** The records a record stands for: itself, or a join's parts, all the way down. */
function leaves(record: LegRecord): LegRecord[] {
  return record.parts ? record.parts.flatMap(leaves) : [record];
}

/**
 * Matches a path update's legs to the previous ones by their from and to
 * spots (x, y and elevation, never footprints, corners or marks), so each
 * leg keeps its occurrence id through the reducer's rewrites (D-261128-057):
 *
 * - stops appended, any number at once: a new record and id each
 * - legs undone at the end: their records removed
 * - the oldest legs joined by `withStop` once the path is full, any number
 *   of joins at once: one record holding the two it joined as `parts`,
 *   with an id of its own, so a join of a join nests
 * - footprints filled, corners dropped, a mark changed: every id kept
 * - an Undo that reverses a join: its parts back with their ids
 *
 * Anything else it cannot match is matched in order where the spots agree,
 * and the rest is removed records and new legs, never a known leg scanned
 * again. `added` and `removed` list leaf records only: a join is neither
 * added nor removed, and a join gone is its parts removed.
 */
export function reconcileLegs(prev: readonly LegRecord[], next: readonly Pick<ReachLeg, "from" | "to">[], newId: () => number): { legs: LegRecord[]; added: LegRecord[]; removed: LegRecord[] } {
  const work = [...prev];
  const legs: LegRecord[] = [];
  const added: LegRecord[] = [];
  const removed: LegRecord[] = [];
  // withStop joins only once the path is full, so a shorter path's update never joins.
  const full = next.length >= MAX_PATH_STOPS - 1;
  let i = 0;
  let j = 0;
  while (i < work.length && j < next.length) {
    const was = work[i]!;
    const now = next[j]!;
    if (same(was.from, now.from) && same(was.to, now.to)) {
      legs.push(was);
      i++;
      j++;
      continue;
    }
    if (!same(was.from, now.from)) break;
    // Joins: the records from here that chain to the new leg's end, read as one, a join of a join keeping the first.
    let k = i;
    while (full && k + 1 < work.length && !same(work[k]!.to, now.to)) k++;
    if (full && k > i && same(work[k]!.to, now.to)) {
      let joined = was;
      for (let m = i + 1; m <= k; m++) joined = { id: newId(), from: spotOf(joined.from), to: spotOf(work[m]!.to), parts: [joined, work[m]!] };
      legs.push(joined);
      i = k + 1;
      j++;
      continue;
    }
    // An Undo that reverses a join: the join's parts take its place.
    if (was.parts) {
      work.splice(i, 1, ...was.parts);
      continue;
    }
    break;
  }
  // What is left: undone or rewritten records, and appended or rewritten legs, matched in order where their spots agree.
  const restPrev = work.slice(i).flatMap(leaves);
  const restNext = next.slice(j);
  const kept = inOrder(restPrev, restNext);
  restNext.forEach((leg, n) => {
    const match = kept.get(n);
    if (match !== undefined) {
      legs.push(restPrev[match]!);
      return;
    }
    const record: LegRecord = { id: newId(), from: spotOf(leg.from), to: spotOf(leg.to) };
    legs.push(record);
    added.push(record);
  });
  const used = new Set(kept.values());
  restPrev.forEach((record, n) => {
    if (!used.has(n)) removed.push(record);
  });
  return { legs, added, removed };
}

/** The longest in-order matching of `next` legs to `prev` records with the same spots, as a map from a next index to a prev index. */
function inOrder(prev: readonly LegRecord[], next: readonly Pick<ReachLeg, "from" | "to">[]): Map<number, number> {
  const out = new Map<number, number>();
  if (prev.length === 0 || next.length === 0) return out;
  const eq = (a: number, b: number) => same(prev[a]!.from, next[b]!.from) && same(prev[a]!.to, next[b]!.to);
  const w = next.length + 1;
  const table = new Uint16Array((prev.length + 1) * w);
  for (let a = prev.length - 1; a >= 0; a--) {
    for (let b = next.length - 1; b >= 0; b--) {
      table[a * w + b] = eq(a, b) ? table[(a + 1) * w + b + 1]! + 1 : Math.max(table[(a + 1) * w + b]!, table[a * w + b + 1]!);
    }
  }
  let a = 0;
  let b = 0;
  while (a < prev.length && b < next.length) {
    if (eq(a, b)) {
      out.set(b, a);
      a++;
      b++;
    } else if (table[(a + 1) * w + b]! >= table[a * w + b + 1]!) a++;
    else b++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scan

/** A cell under a creature for the cover gate: its center, and its own box for the distance within reach. */
type Cell = { cx: number; cy: number; box: CellBox };

type Prepared = { reactor: Reactor; index: number; box: CellBox; max: number; cells: Cell[] | null };

/** Work done, in units (section 5): a distance test between two boxes is 1 on squares and one per hex pair on hexes, a piece a gate line meets 1. */
type Work = { n: number };

/** How far a piece's end on hexes may lie from a gate line and still meet it at that end: past the rounding of hex corners to the 1/64 lattice (hex.ts cornerAt), short of anything a line between hex centers passes. */
const HEX_TOUCH = 1 / 80;
/** Reactors are bucketed in squares of this many cells. */
const BUCKET = 4;

/**
 * The distance a reach is judged by (D-261128-056): a neighbor, at most one
 * step away on every axis, is one cell's feet under every diagonal rule, so a
 * default-grid diagonal neighbor is 5 ft and a 10 ft grid's neighbor 10 ft.
 * Any other pair is the room's distance, edge to edge, height counted.
 */
function feetBetween(a: CellBox, b: CellBox, rules: DistanceSettings, work: Work): number {
  work.n += a.hexes && b.hexes ? a.hexes.at.length * b.hexes.at.length : 1;
  const { dx, dy, dz } = stepsBetween(a, b);
  if (dx <= 1 && dy <= 1 && dz <= 1) return dx + dy + dz === 0 ? 0 : rules.feetPerCell;
  const ft = legFeet(dx, dy, dz, rules.diagonal, rules.feetPerCell);
  return rules.diagonal === "euclid" ? Math.round(ft) : ft;
}

function cellsUnder(g: Grid, token: FootprintToken, feetPerCell: number): Cell[] {
  const whole = tokenCellBox(g, token, feetPerCell);
  const out: Cell[] = [];
  if (whole.hexes) {
    for (const h of whole.hexes.at) {
      const c = hexCenter(whole.hexes.g, h);
      out.push({ cx: c.x, cy: c.y, box: { ...whole, hexes: { g: whole.hexes.g, at: [h] } } });
    }
    return out;
  }
  for (let y = whole.y0; y < whole.y1; y++) for (let x = whole.x0; x < whole.x1; x++) out.push({ cx: x + 0.5, cy: y + 0.5, box: { x0: x, x1: x + 1, y0: y, y1: y + 1, z0: whole.z0, z1: whole.z1 } });
  return out;
}

function nearLine(x: number, y: number, px: number, py: number, qx: number, qy: number): boolean {
  const dx = qx - px;
  const dy = qy - py;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2));
  const ex = px + t * dx - x;
  const ey = py + t * dy - y;
  return ex * ex + ey * ey <= HEX_TOUCH * HEX_TOUCH;
}

/**
 * Whether the line between two cell centers is clear of everything that
 * stops an area (walls.ts blocksAreas: walls, windows, closed doors). A
 * line crossing a piece is stopped. A touch at a point stops it only when
 * the pieces meeting there lie on both sides of the line, or one runs on
 * through the point, so a straight joint, a corner crossed from inside to
 * outside and a wall beside a closed door stop it, and a bend's inner
 * corner, an outer corner and a free end let it pass. The stored walls are
 * read exactly, and a player's held pieces by `pieceTouches`, as the
 * client's other checks read them. On hexes a piece's end within HEX_TOUCH
 * of the line meets it there, since corners are rounded off the line's
 * exact path.
 */
function lineClear(walls: WallSet, hex: boolean, px: number, py: number, qx: number, qy: number, work: Work): boolean {
  const s = walls.stored;
  const pad = hex ? HEX_TOUCH : 0;
  const sides = new Map<string, number>();
  let blocked = false;
  const on = hex ? (x: number, y: number) => nearLine(x, y, px, py, qx, qy) : (x: number, y: number) => onSegment(x, y, px, py, qx, qy);
  walls.storedIndex.query(Math.min(px, qx) - pad, Math.min(py, qy) - pad, Math.max(px, qx) + pad, Math.max(py, qy) + pad, AREAS, (k) => {
    if (blocked) return;
    work.n++;
    const ax = s.xy[4 * k]!;
    const ay = s.xy[4 * k + 1]!;
    const bx = s.xy[4 * k + 2]!;
    const by = s.xy[4 * k + 3]!;
    if (s.free[k] === PIECE) {
      blocked = pieceTouches(px, py, qx, qy, 0, 0, ax, ay, bx, by);
      return;
    }
    const aOn = on(ax, ay);
    const bOn = on(bx, by);
    if (aOn && bOn) {
      blocked = true;
      return;
    }
    if (aOn || bOn) {
      const [tx, ty, ox, oy] = aOn ? [ax, ay, bx, by] : [bx, by, ax, ay];
      const side = orient(px, py, qx, qy, ox, oy);
      // A piece running on along the line from the point lies on neither side, and stops it as a piece along the line does.
      if (side === 0) {
        blocked = true;
        return;
      }
      const key = `${tx},${ty}`;
      sides.set(key, (sides.get(key) ?? 0) | (side > 0 ? 1 : 2));
      return;
    }
    // A crossing, or the line's own end on the piece's inside: the piece runs on through the point.
    if (contact(px, py, qx, qy, ax, ay, bx, by) !== APART) blocked = true;
  });
  if (blocked) return false;
  for (const mask of sides.values()) if (mask === 3) return false;
  return true;
}

/** The cover gate (D-261128-056): some pair of cells, one under each creature, within `reach` of each other, with a clear line between their centers. */
function coverClear(input: ScanInput, moverCells: readonly Cell[], target: Prepared, reach: number, work: Work): boolean {
  const { grid, rules } = input;
  target.cells ??= cellsUnder(grid, target.reactor.token, rules.feetPerCell);
  for (const m of moverCells) {
    for (const c of target.cells) {
      if (feetBetween(m.box, c.box, rules, work) > reach) continue;
      if (lineClear(input.walls, grid.shape === "hex", m.cx, m.cy, c.cx, c.cy, work)) return true;
    }
  }
  return false;
}

/** The sight gate (D-261128-058): a Blinded creature sees only by Blindsight, and an Invisible or Hidden mover only by Blindsight or Truesight. */
function sees(input: ScanInput, reactor: Reactor, feet: number): boolean {
  if (reactor.blinded) return reactor.blindsight >= feet;
  if (input.moverUnseen) return Math.max(reactor.blindsight, reactor.truesight) >= feet;
  return true;
}

function bucketKey(bx: number, by: number): number {
  return (bx + 2048) * 8192 + (by + 2048);
}

/**
 * The creatures whose reach `leg` leaves, first leave first, skipping those
 * in `skip` (section 4, "Distance first" and "Gates"). A leave is a step
 * from a spot within one of a creature's reaches to the next spot beyond
 * it, whose departure spot passes the cover and sight gates for that reach.
 * A crossing whose gates fail is no leave, and a later one of the same
 * creature may still be. A creature leaves once a leg, by the first reach
 * that passes, however many it crosses. A leg that does not provoke
 * reports nothing.
 *
 * Reactors are bucketed by their boxes grown by their longest reach and a
 * cell, so a spot tests only creatures that could be within reach, and
 * those it stood within reach of at the spot before. Yields the work done
 * so far every `slice` units, and returns "over" past LEG_WORK_CAP.
 */
export function* reachScan(input: ScanInput, leg: ReachLeg, skip: ReadonlySet<string>, slice: number = SLICE_WORK): Generator<number, ReachLeave[] | "over"> {
  if (!leg.provokes) return [];
  const { grid, rules } = input;
  const fpc = rules.feetPerCell;
  const prepared: Prepared[] = [];
  for (const reactor of input.reactors) {
    if (skip.has(reactor.id) || reactor.reaches.length === 0) continue;
    prepared.push({ reactor, index: prepared.length, box: tokenCellBox(grid, reactor.token, fpc), max: Math.max(...reactor.reaches), cells: null });
  }
  const out: ReachLeave[] = [];
  if (prepared.length === 0) return out;
  const buckets = new Map<number, Prepared[]>();
  for (const p of prepared) {
    const grow = Math.ceil(p.max / fpc) + 1;
    for (let bx = Math.floor((p.box.x0 - grow) / BUCKET); bx <= Math.floor((p.box.x1 - 1 + grow) / BUCKET); bx++) {
      for (let by = Math.floor((p.box.y0 - grow) / BUCKET); by <= Math.floor((p.box.y1 - 1 + grow) / BUCKET); by++) {
        const key = bucketKey(bx, by);
        const list = buckets.get(key);
        if (list) list.push(p);
        else buckets.set(key, [p]);
      }
    }
  }
  const spots = legSpots(grid, input.mover, leg.from, leg.to);
  const work: Work = { n: 0 };
  let nextYield = slice;
  const stamp = new Uint32Array(prepared.length);
  const left = new Uint8Array(prepared.length);
  let within = new Map<number, number>();
  let before: { spot: LegSpot; cells: Cell[] | null } | null = null;
  for (let k = 0; k < spots.length; k++) {
    const spot = spots[k]!;
    const standing: FootprintToken = input.mover.height === undefined ? spot : { ...spot, height: input.mover.height };
    const box = tokenCellBox(grid, standing, fpc);
    const candidates: Prepared[] = [];
    for (const i of within.keys()) {
      stamp[i] = k + 1;
      candidates.push(prepared[i]!);
    }
    for (let bx = Math.floor(box.x0 / BUCKET); bx <= Math.floor((box.x1 - 1) / BUCKET); bx++) {
      for (let by = Math.floor(box.y0 / BUCKET); by <= Math.floor((box.y1 - 1) / BUCKET); by++) {
        for (const p of buckets.get(bucketKey(bx, by)) ?? []) {
          if (stamp[p.index] === k + 1 || left[p.index]) continue;
          stamp[p.index] = k + 1;
          candidates.push(p);
        }
      }
    }
    candidates.sort((a, b) => a.index - b.index);
    const next = new Map<number, number>();
    for (const p of candidates) {
      const feet = feetBetween(box, p.box, rules, work);
      const was = spot.jump ? undefined : within.get(p.index);
      if (was !== undefined && before) {
        for (const reach of p.reactor.reaches) {
          if (!(was <= reach && feet > reach) || !sees(input, p.reactor, was)) continue;
          const departure: { spot: LegSpot; cells: Cell[] | null } = before;
          departure.cells ??= cellsUnder(grid, input.mover.height === undefined ? departure.spot : { ...departure.spot, height: input.mover.height }, fpc);
          if (!coverClear(input, departure.cells, p, reach, work)) continue;
          out.push(p.reactor.extra !== null ? { id: p.reactor.id, spot: k, reach, extra: p.reactor.extra } : { id: p.reactor.id, spot: k, reach });
          left[p.index] = 1;
          break;
        }
      }
      if (!left[p.index] && feet <= p.max) next.set(p.index, feet);
    }
    within = next;
    before = { spot, cells: null };
    if (work.n > LEG_WORK_CAP) return "over";
    if (work.n >= nextYield) {
      yield work.n;
      nextYield = work.n + slice;
    }
  }
  return out;
}

/** Runs a scan to its end without slices. */
function scanWhole(input: ScanInput, leg: ReachLeg, skip: ReadonlySet<string>): ReachLeave[] | "over" {
  const scan = reachScan(input, leg, skip, Infinity);
  for (;;) {
    const step = scan.next();
    if (step.done) return step.value;
  }
}

/**
 * The whole turn's scan at once: each leg in order with the creatures
 * earlier legs left as its `skip`, so a creature is reported once a turn.
 * A leg whose scan passes LEG_WORK_CAP reads "over" and adds nothing to the
 * skip. For tests and callers that need no slices.
 */
export function turnReach(input: ScanInput, legs: readonly ReachLeg[]): { id: number; leaves: ReachLeave[] | "over" }[] {
  const skip = new Set<string>();
  return legs.map((leg) => {
    const found = scanWhole(input, leg, skip);
    if (found !== "over") for (const leave of found) skip.add(leave.id);
    return { id: leg.id, leaves: found };
  });
}

// ---------------------------------------------------------------------------
// Reactors and their reaches

const FIVE: { reaches: number[]; known: boolean } = { reaches: [5], known: false };

function actorOf(view: Pick<RoomState, "characters">, token: Token): Actor | undefined {
  return "inline" in token.actor ? token.actor.inline : view.characters[token.actor.ref]?.actor;
}

/** Alive, and no condition that includes Incapacitated: dying and stable creatures are Unconscious. */
function standsReady(actor: Actor): boolean {
  return actor.life === "alive" && !(actor.effects ?? []).some((e) => INCAPACITATING_KEYS.has(e.key));
}

function opposed(a: Token["disposition"], b: Token["disposition"]): boolean {
  return (a === "ally" && b === "hostile") || (a === "hostile" && b === "ally");
}

/** Whether the view marks the creature's Reaction used: its own row's, or a companion's sharing its character's turn. */
function reactionUsed(view: Pick<RoomState, "tokens" | "encounter">, token: Token): boolean {
  const encounter = view.encounter;
  if (!encounter) return false;
  const companion = token.companion;
  if (companion && companion.turn !== "own") return companion.turn === "shared" && companion.reactionUsed === true;
  const character = "ref" in token.actor ? token.actor.ref : undefined;
  const row = encounter.entries.find((e) => e.tokenId === token.id || (character !== undefined && (e.characterId === character || rowCharacter(view, e) === character)));
  return row?.reactionUsed === true;
}

const roomViews = new WeakMap<object, StatBlockMonster>();
const roomNumbers = new WeakMap<object, number[] | undefined>();

function roomBlockView(block: CustomMonster | CompanionBlock, companion: boolean): StatBlockMonster {
  let view = roomViews.get(block);
  if (!view) {
    view = companion ? monsterView(block) : monsterView(statBlockOf(block as CustomMonster));
    roomViews.set(block, view);
  }
  return view;
}

function blockReaches(block: CustomMonster | CompanionBlock): number[] | undefined {
  if (!roomNumbers.has(block)) roomNumbers.set(block, blockRollNumbers(block).reaches);
  return roomNumbers.get(block);
}

function capped(reaches: readonly number[] | undefined): { reaches: number[]; known: boolean } {
  return { reaches: [...new Set((reaches ?? [5]).map((r) => Math.min(r, MAX_REACH_FT)))].sort((a, b) => a - b), known: true };
}

function srdReach(chunks: Chunks, srdId: string): { reaches: number[]; known: boolean } {
  if (chunks.rolls === "failed") return FIVE;
  const numbers = chunks.rolls[srdId];
  return numbers ? capped(numbers.reaches) : FIVE;
}

/**
 * A creature's distinct reaches in feet, ascending, and whether they were
 * read rather than taken as 5 ft (D-261128-054). A monster's or a
 * companion's block gives its melee attacks' reaches: an SRD one from the
 * rolls table, a room monster or a companion block read live. A character
 * has 5 ft, an Unarmed Strike, and 10 ft too when a weapon roll names a
 * Reach weapon, or in an SRD shape the shape's. Each value is capped at
 * MAX_REACH_FT. A block this view does not hold, or a chunk that failed,
 * reads [5] with `known` false. A player's copy holds no block of a
 * creature they do not own, so it reads every such creature at 5 ft.
 */
export function reachOf(view: ReachView, token: Token, chunks: Chunks): { reaches: number[]; known: boolean } {
  if ("ref" in token.actor) {
    const character = view.characters[token.actor.ref];
    if (!character) return FIVE;
    if (character.actor.srdId !== undefined) return srdReach(chunks, character.actor.srdId);
    if (!character.stats) return FIVE;
    return { reaches: character.stats.rolls.some((r) => r.kind === "weapon" && weaponReach(r.name)) ? [5, 10] : [5], known: true };
  }
  const actor = token.actor.inline;
  if (actor.blockId !== undefined) {
    const block = view.companionBlocks[actor.blockId];
    return block ? capped(blockReaches(block)) : FIVE;
  }
  if (actor.monsterId !== undefined) {
    const monster = view.monsters[actor.monsterId];
    return monster ? capped(blockReaches(monster)) : FIVE;
  }
  if (actor.srdId !== undefined) return srdReach(chunks, actor.srdId);
  return FIVE;
}

/** The block a scan reads a creature's traits from, as reachOf reads its reaches, or null where this view holds none or its chunk has not loaded. */
function blockOf(view: ReachView, token: Token, chunks: Chunks): StatBlockMonster | null {
  const srd = (srdId: string) => (chunks.monsters === "failed" ? null : (chunks.monsters.find((m) => m.srdId === srdId) ?? null));
  if ("ref" in token.actor) {
    const shape = view.characters[token.actor.ref]?.actor.srdId;
    return shape !== undefined ? srd(shape) : null;
  }
  const actor = token.actor.inline;
  if (actor.blockId !== undefined) {
    const block = view.companionBlocks[actor.blockId];
    return block ? roomBlockView(block, true) : null;
  }
  if (actor.monsterId !== undefined) {
    const monster = view.monsters[actor.monsterId];
    return monster ? roomBlockView(monster, false) : null;
  }
  return actor.srdId !== undefined ? srd(actor.srdId) : null;
}

/** The SRD id a creature's block or reaches come from, or undefined for none. */
function srdSource(view: ReachView, token: Token): string | undefined {
  if ("ref" in token.actor) return view.characters[token.actor.ref]?.actor.srdId;
  const actor = token.actor.inline;
  return actor.blockId === undefined && actor.monsterId === undefined ? actor.srdId : undefined;
}

/** The tokens linked to the mover either way (attach.ts carriedGroup): what it carries, and what carries it. */
function linkedTo(view: ReachView, mover: Token): Set<string> {
  const linked = new Set(carriedGroup(view.tokens, mover.id));
  let holder = holderOf(view.tokens, mover);
  while (holder && !linked.has(holder.id)) {
    linked.add(holder.id);
    holder = holderOf(view.tokens, holder);
  }
  return linked;
}

/**
 * The creatures that could make an Opportunity Attack against the mover
 * before their Reaction is judged (D-261128-053): other creatures, not
 * objects, on its scene, which is its floor, with the opposite ring (Ally
 * against Hostile, Neutral against neither), alive and not Incapacitated,
 * and not linked to it.
 */
function candidates(view: ReachView, mover: Token): { token: Token; actor: Actor }[] {
  const linked = linkedTo(view, mover);
  const out: { token: Token; actor: Actor }[] = [];
  for (const token of Object.values(view.tokens)) {
    if (token.sceneId !== mover.sceneId || token.kind === "object" || linked.has(token.id) || !opposed(mover.disposition, token.disposition)) continue;
    const actor = actorOf(view, token);
    if (actor && standsReady(actor)) out.push({ token, actor });
  }
  return out;
}

/**
 * Which SRD chunks a scan of the mover's walk in this view waits for: the
 * rolls table for a creature whose reaches it holds, and the blocks for the
 * traits that grant more Reactions, so neither is read as absent while it
 * loads (D-261128-057). A player's copy holds no SRD id of a creature they
 * do not own, so it waits for neither.
 */
export function chunksNeeded(view: ReachView, moverId: string): { rolls: boolean; monsters: boolean } {
  const mover = view.tokens[moverId];
  if (!mover) return { rolls: false, monsters: false };
  const srd = candidates(view, mover).some(({ token }) => srdSource(view, token) !== undefined);
  return { rolls: srd, monsters: srd };
}

/**
 * The scan's input and the path's legs on the mover's floor, or null where
 * there is nothing to scan: no mover, no scene or no path. Each leg's `id`
 * here is the index of its end stop in `path.stops`, which the caller maps
 * to the leg's occurrence id. A leg provokes unless it does not count
 * (Teleport, "Doesn't count"), was carried, or only changed the creature's
 * footprint where it stood. A creature whose Reaction is used is left out
 * unless its block grants more. A player's projection already holds only
 * what they may read, so the scan reads the view whole.
 */
export function reachInput(view: ReachView, moverId: string, path: TokenPath | null, chunks: Chunks, _viewer: Viewer): { input: ScanInput; legs: ReachLeg[] } | null {
  const mover = view.tokens[moverId];
  if (!mover || !path) return null;
  const scene = view.scenes[mover.sceneId];
  if (!scene) return null;
  const moverActor = actorOf(view, mover);
  const reactors: Reactor[] = [];
  for (const { token, actor } of candidates(view, mover)) {
    const block = blockOf(view, token, chunks);
    const extra = block ? extraReactions(block) : null;
    if (reactionUsed(view, token) && extra === null) continue;
    const senses = parseSenses(actor.senses);
    const { reaches, known } = reachOf(view, token, chunks);
    reactors.push({
      id: token.id,
      token: footprintOf(token),
      reaches,
      blinded: (actor.effects ?? []).some((e) => e.key === "blinded"),
      blindsight: senses.blindsight,
      truesight: senses.truesight,
      known,
      extra,
    });
  }
  const now = stopFootprint(mover);
  const legs: ReachLeg[] = [];
  for (let i = 1; i < path.stops.length; i++) {
    const from = path.stops[i - 1]!;
    const to = path.stops[i]!;
    legs.push({ id: i, from, to, provokes: to.uncounted !== true && to.carried !== true && !reshapeLeg(from, to, now) });
  }
  const placed: ScanInput["mover"] = { size: mover.size, x: mover.x, y: mover.y };
  if (mover.w !== undefined) placed.w = mover.w;
  if (mover.h !== undefined) placed.h = mover.h;
  if (mover.squeeze) placed.squeeze = mover.squeeze;
  if (mover.height !== undefined) placed.height = mover.height;
  const settings = view.meta.settings;
  return {
    input: {
      grid: sceneGrid(scene),
      rules: { feetPerCell: settings.feetPerCell, diagonal: settings.diagonal },
      walls: sceneWalls(scene, view.buildChunks),
      mover: placed,
      moverUnseen: (moverActor?.effects ?? []).some((e) => e.key === "invisible" || e.key === "hidden"),
      reactors,
    },
    legs,
  };
}

function footprintOf(token: Token): FootprintToken {
  const out: FootprintToken = { size: token.size, x: token.x, y: token.y, elevation: token.elevation };
  if (token.w !== undefined) out.w = token.w;
  if (token.h !== undefined) out.h = token.h;
  if (token.height !== undefined) out.height = token.height;
  if (token.squeeze) out.squeeze = token.squeeze;
  return out;
}

/**
 * Whether a cached leave still stands as a row (section 4, "Rows"): its
 * creature still in this viewer's copy, alive, not Incapacitated, and its
 * Reaction free or more granted by its block (`extra`). Later changes only
 * remove rows. The caller keeps only the leaves of legs that still provoke.
 */
export function rowStands(view: ReachView, leave: ReachLeave, _viewer: Viewer): boolean {
  const token = view.tokens[leave.id];
  if (!token) return false;
  const actor = actorOf(view, token);
  if (!actor || !standsReady(actor)) return false;
  return leave.extra !== undefined || !reactionUsed(view, token);
}

// ---------------------------------------------------------------------------
// Blocks and words

const AVOIDS = /provok\w* (an )?Opportunity Attacks?/i;
const EXTRA = /\bextra Reactions?\b|\bReaction on every turn\b/i;

/** The name of the block's first entry, in any section, that says the creature avoids Opportunity Attacks ("Flyby", "Engulf"), or null. */
export function avoidTrait(block: StatBlockMonster): string | null {
  const entry = blockEntries(block).find((e) => AVOIDS.test(e.text));
  return entry ? nameParts(entry.name).name : null;
}

/** The name of the block's first entry that grants extra Reactions ("Reactive Heads", "Reactive"), or null. */
export function extraReactions(block: StatBlockMonster): string | null {
  const entry = blockEntries(block).find((e) => EXTRA.test(e.text));
  return entry ? nameParts(entry.name).name : null;
}

/**
 * The words naming the creatures whose reach a walk leaves, the creature and
 * the full stop left to the caller: "Leaves Goblin 2's reach", "left the
 * reach of Goblin 2 and Goblin 3", past `max` names the first `max - 1` and
 * "2 more", and with `max` 1 "left 3 creatures' reach". `fiveFt` words a
 * player's line where every creature named was counted at 5 ft: "Leaves 5 ft
 * of Goblin 2".
 */
export function reachWords(names: readonly string[], verb: "Leaves" | "left", fiveFt: boolean, max: number): string {
  const n = names.length;
  if (n === 0) return "";
  const shown = n > max ? Math.max(0, max - 1) : n;
  if (shown === 0) return fiveFt ? `${verb} 5 ft of ${n} creatures` : `${verb} ${n} creatures' reach`;
  const list = shown < n ? [...names.slice(0, shown), `${n - shown} more`] : [...names];
  const joined = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]!}`;
  if (fiveFt) return `${verb} 5 ft of ${joined}`;
  return list.length === 1 ? `${verb} ${joined}'s reach` : `${verb} the reach of ${joined}`;
}

/** Whether the room's Opportunity Attack notices are on: absent reads on. Typed locally, so this builds before the room switch. */
export function opportunityNoticesOn(settings: { opportunityNotices?: boolean }): boolean {
  return settings.opportunityNotices !== false;
}
