import { createInitialState } from "#shared/initial.ts";
import type { AoeCoverage, AoeInclusion, CellRect, Member, RoomState, TerrainId, Trap, TrapZone } from "#shared/model.ts";
import { clientOpSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { trapHits } from "#shared/rules/traps.ts";
import { trapPreset, type LevelBand } from "#shared/srd/traps.ts";
import { boardTheme } from "../../lib/theme.ts";
import { builderScene } from "../scenes/create.ts";
import { blankToken } from "../tokens/factory.ts";
import type { Board } from "./layout.ts";
import type { PlanStamp, PlanTrap } from "./plan.ts";
import type { Stream } from "./random.ts";
import { MAX_STONES } from "./settings.ts";

/*
 * Where the SRD's example traps go (docs/design/design-v1-dungeon-generator.md
 * 5.3 step 10, and phase 2 5.4). Phase 1's four: a Hidden Pit or a Spiked
 * Pit on a room's doorway line or in a Wide corridor, a Falling Net's wire
 * across a Narrow corridor, and a Poisoned Needle on a locked door. Phase
 * 2's four: a Collapsing Roof's wire across a straight stretch, Poisoned
 * Darts on a long Narrow one, a Fire-Casting Statue against a room's wall
 * with its plate on a doorway line, and at the higher levels on Wide a
 * Rolling Stone at the end of a long straight stretch. Never in the
 * entrance room, never on a run, a dais or its stair, and 6 squares apart.
 * The landing lane turns each into a `trap.create` at the chosen band.
 */

export const HIDDEN_PIT = "hidden-pit";
export const SPIKED_PIT = "spiked-pit";
export const FALLING_NET = "falling-net";
export const POISONED_NEEDLE = "poisoned-needle";
export const COLLAPSING_ROOF = "collapsing-roof";
export const POISONED_DARTS = "poisoned-darts";
export const FIRE_STATUE = "fire-casting-statue";
export const ROLLING_STONE = "rolling-stone";

/** The statue's picture, which the Dungeon and Crypt props hold (D-261107-267). */
export const STATUE_STAMP = { key: "ph-statue", w: 1, h: 1.25 } as const;

/** Traps keep this many squares apart, between their middles. */
export const TRAP_SPACING = 6;
/** `statueReaches` runs on at most this many spots a dungeon. */
export const STATUE_TRIES = 20;
/** Rooms this size or larger may hold a Fire-Casting Statue. */
const STATUE_MIN_ROOM = 5;
/**
 * The straight roll a Rolling Stone needs beyond its squares, and where its
 * plate lies along it, in feet. The SRD's stone rolls 60 feet, but a Wide
 * corridor holds 60 straight feet in few dungeons at 5 ft a square, so the
 * stone takes a stretch holding its plate and 10 ft past it, and a wall
 * stops the rest of its roll (D-261108-170).
 */
const STONE_ROLL_FT = 35;
const STONE_PLATE_FT = 25;
/** Poisoned Darts' stretch: the plate and two squares each way. */
const DART_REACH = 2;

/** A pit preset's squares, as the Trap tool's preset has them (2 by 2). */
function pitSize(): { w: number; h: number } {
  const zone = trapPreset(HIDDEN_PIT, "1-4")!.zone;
  return zone.kind === "squares" ? { w: zone.w, h: zone.h } : { w: 2, h: 2 };
}

export type SpotKind = "pit" | "net" | "needle" | "roof" | "darts" | "statue" | "stone";
const KINDS: readonly SpotKind[] = ["pit", "net", "needle", "roof", "darts", "statue", "stone"];

export type Spot = {
  kind: SpotKind;
  zone: TrapZone;
  /** Its middle, doubled. */
  mid: [number, number];
  /** Squares it hits in place of its zone's. */
  hits?: CellRect[];
  cone?: { origin: [number, number]; yaw: number };
  /** A statue's block of whole squares, turned to face the room. */
  statue?: { x: number; y: number; w: number; h: number; rotation: 0 | 90 | 180 | 270 };
  /** A Rolling Stone's 2 by 2 squares, top left. */
  stone?: [number, number];
  /** Every square it takes, so no two traps share one. */
  squares: number[];
};

export type SpotInput = {
  board: Board;
  /** Kept rooms but the entrance. */
  rooms: readonly number[];
  /** Squares on a room's ordinary doorway lines: a secret doorway's are plain floor. */
  onLine: (k: number) => boolean;
  /** Dry plain floor a zone may cover: a room's or a corridor's, no overlay, run, dais, ordinary doorway square or secret doorway's outside square. */
  floorFree: (k: number) => boolean;
  /** Corridor squares a trap may hit: no run, doorway's outside square or the stub's stairs. */
  hitFree: (k: number) => boolean;
  /** Corridor squares, in path order, a trap may lie on. */
  corridor: readonly number[];
  painted: (k: number) => boolean;
  wide: boolean;
  /** Locked doors off the entrance room: one edge each. */
  locked: readonly string[];
  /** Rooms a Fire-Casting Statue may stand in: Dungeon's and Crypt's whose props hold the statue. */
  statueRooms: readonly number[];
  /** Squares of room `room` a statue's block may take: free floor at the room's own ground, off the ways and the pin square. */
  blockFree: (room: number, k: number) => boolean;
  /** Squares of room `room` its plate may take: a dry ordinary doorway line square at the room's ground, off the pin square. */
  plateFree: (room: number, k: number) => boolean;
  /** Whether Rolling Stones go: Wide, at levels 11 and up. */
  stones: boolean;
  feetPerCell: number;
};

/** Every spot each kind of trap may take, in a fixed order. */
export function trapSpots(input: SpotInput): Spot[] {
  const { board, wide } = input;
  const W = board.W;
  const out: Spot[] = [];
  const { w: pw, h: ph } = pitSize();
  const cellsOf = (r: CellRect) => {
    const cells: number[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push(y * W + x);
    return cells;
  };
  const pitAt = (x: number, y: number, needLine: boolean): Spot | null => {
    let line = false;
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const k = board.cell(x + i, y + j);
        if (!input.floorFree(k)) return null;
        if (input.onLine(k)) line = true;
      }
    }
    if (needLine && !line) return null;
    const rect = { x, y, w: pw, h: ph };
    return { kind: "pit", zone: { cells: [rect] }, mid: [2 * x + pw, 2 * y + ph], squares: cellsOf(rect) };
  };
  for (const i of input.rooms) {
    const r = board.rooms[i]!;
    for (let y = r.y; y + ph <= r.y + r.h; y++) {
      for (let x = r.x; x + pw <= r.x + r.w; x++) {
        const spot = pitAt(x, y, true);
        if (spot) out.push(spot);
      }
    }
  }
  const corridor = new Set(input.corridor);
  const at = (x: number, y: number) => board.inMap(x, y) && input.painted(y * W + x);
  /** Whether a straight stretch runs through x, y along x (or y), `lanes` across: its squares open to a trap, rock on both sides. */
  const straight: Straight = (x, y, alongX, lanes) => {
    for (let l = 0; l < lanes; l++) {
      const [cx, cy] = alongX ? [x, y + l] : [x + l, y];
      if (!board.inMap(cx, cy) || !corridor.has(cy * W + cx) || !input.hitFree(cy * W + cx)) return false;
    }
    return alongX ? !at(x, y - 1) && !at(x, y + lanes) : !at(x - 1, y) && !at(x + lanes, y);
  };
  if (wide) {
    const seen = new Set<number>();
    for (const k of input.corridor) {
      const x = k % W;
      const y = (k - x) / W;
      if (seen.has(k) || x + pw > W || y + ph > board.H) continue;
      seen.add(k);
      let all = true;
      for (let j = 0; j < ph && all; j++) for (let i = 0; i < pw; i++) if (!corridor.has(k + j * W + i)) all = false;
      if (!all) continue;
      const spot = pitAt(x, y, false);
      if (spot) out.push(spot);
    }
  } else {
    for (const k of input.corridor) {
      if (!input.floorFree(k)) continue;
      const x = k % W;
      const y = (k - x) / W;
      const at1 = (dx: number, dy: number) => at(x + dx, y + dy);
      // A straight stretch with rock on both sides: the wire runs between its walls' edge midpoints.
      if (!at1(-1, 0) && !at1(1, 0) && at1(0, -1) && at1(0, 1)) out.push({ kind: "net", zone: { wire: { a: [x, y + 0.5], b: [x + 1, y + 0.5] } }, mid: [2 * x + 1, 2 * y + 1], squares: [k] });
      else if (!at1(0, -1) && !at1(0, 1) && at1(-1, 0) && at1(1, 0)) out.push({ kind: "net", zone: { wire: { a: [x + 0.5, y], b: [x + 0.5, y + 1] } }, mid: [2 * x + 1, 2 * y + 1], squares: [k] });
    }
  }
  for (const edge of input.locked) {
    const [xs, ys, side] = edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    out.push({ kind: "needle", zone: { door: { edge } }, mid: side === "n" ? [2 * x + 1, 2 * y] : [2 * x, 2 * y + 1], squares: [] });
  }
  out.push(...roofSpots(input, straight), ...dartSpots(input, straight), ...statueSpots(input), ...(input.stones ? stoneSpots(input, straight) : []));
  return out;
}

type Straight = (x: number, y: number, alongX: boolean, lanes: number) => boolean;

/**
 * Collapsing Roof (5.4): a trip wire across a straight stretch between its
 * walls' edge midpoints, a square across on Narrow and two on Wide,
 * hitting the stretch's squares within a square of the wire along it.
 */
function roofSpots(input: SpotInput, straight: Straight): Spot[] {
  const W = input.board.W;
  const lanes = input.wide ? 2 : 1;
  const out: Spot[] = [];
  const seen = new Set<string>();
  for (const k of input.corridor) {
    const x = k % W;
    const y = (k - x) / W;
    for (const alongX of [true, false]) {
      // On Wide a square is either lane's, so the stretch's first lane is at it or the square before it.
      for (const back of input.wide ? [0, 1] : [0]) {
        const [sx, sy] = alongX ? [x, y - back] : [x - back, y];
        const id = `${sx},${sy},${alongX}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (![-1, 0, 1].every((t) => (alongX ? straight(sx + t, sy, true, lanes) : straight(sx, sy + t, false, lanes)))) continue;
        const wire = Array.from({ length: lanes }, (_, l) => (alongX ? (sy + l) * W + sx : sy * W + sx + l));
        if (!wire.every(input.floorFree)) continue;
        const zone: TrapZone = alongX ? { wire: { a: [sx + 0.5, sy], b: [sx + 0.5, sy + lanes] } } : { wire: { a: [sx, sy + 0.5], b: [sx + lanes, sy + 0.5] } };
        const hit: CellRect = alongX ? { x: sx - 1, y: sy, w: 3, h: lanes } : { x: sx, y: sy - 1, w: lanes, h: 3 };
        const mid: [number, number] = alongX ? [2 * sx + 1, 2 * sy + lanes] : [2 * sx + lanes, 2 * sy + 1];
        const squares: number[] = [];
        for (let yy = hit.y; yy < hit.y + hit.h; yy++) for (let xx = hit.x; xx < hit.x + hit.w; xx++) squares.push(yy * W + xx);
        out.push({ kind: "roof", zone, hits: [hit], mid, squares });
      }
    }
  }
  return out;
}

/** Poisoned Darts (5.4): a 1-square plate on a straight Narrow stretch of at least 5 squares, hitting the plate and 2 squares each way along it. */
function dartSpots(input: SpotInput, straight: Straight): Spot[] {
  if (input.wide) return [];
  const W = input.board.W;
  const out: Spot[] = [];
  const offsets = Array.from({ length: 2 * DART_REACH + 1 }, (_, i) => i - DART_REACH);
  for (const k of input.corridor) {
    if (!input.floorFree(k)) continue;
    const x = k % W;
    const y = (k - x) / W;
    for (const alongX of [true, false]) {
      if (!offsets.every((t) => (alongX ? straight(x + t, y, true, 1) : straight(x, y + t, false, 1)))) continue;
      const hit: CellRect = alongX ? { x: x - DART_REACH, y, w: 2 * DART_REACH + 1, h: 1 } : { x, y: y - DART_REACH, w: 1, h: 2 * DART_REACH + 1 };
      const squares = offsets.map((t) => (alongX ? y * W + x + t : (y + t) * W + x));
      out.push({ kind: "darts", zone: { cells: [{ x, y, w: 1, h: 1 }] }, hits: [hit], mid: [2 * x + 1, 2 * y + 1], squares });
    }
  }
  return out;
}

/** The statue's turn by the wall it stands against, so it faces into the room: its picture faces down unturned. */
const STATUE_TURN = { n: 0, e: 90, s: 180, w: 270 } as const;

/**
 * The yaw from a block's middle to a plate, in a 45 degree step, from
 * doubled coordinates: within about 22.5 degrees of an axis is the axis, so
 * the plan stays exact without trigonometry.
 */
export function stepYaw(dx2: number, dy2: number): number {
  const ax = Math.abs(dx2);
  const ay = Math.abs(dy2);
  // tan(22.5 degrees) is about 0.4142.
  if (ay * 10000 <= ax * 4142) return dx2 > 0 ? 0 : 180;
  if (ax * 10000 <= ay * 4142) return dy2 > 0 ? 90 : 270;
  if (dx2 > 0) return dy2 > 0 ? 45 : 315;
  return dy2 > 0 ? 135 : 225;
}

/**
 * Fire-Casting Statue (5.4, D-261107-267): in a room 5 by 5 or larger whose
 * props hold the statue, its block of whole squares against a wall as a
 * prop takes one, turned to face the room, and its plate a doorway line
 * square 1 or 2 squares from the block in one of 8 directions, the cone
 * pointing at it in a 45 degree step from the block's middle. Whether the
 * cone reaches the plate is `statueReaches`'s to say, once one is picked.
 */
function statueSpots(input: SpotInput): Spot[] {
  const { board } = input;
  const W = board.W;
  const out: Spot[] = [];
  for (const i of input.statueRooms) {
    const r = board.rooms[i]!;
    if (r.w < STATUE_MIN_ROOM || r.h < STATUE_MIN_ROOM) continue;
    for (const side of ["n", "e", "s", "w"] as const) {
      const rotation = STATUE_TURN[side];
      const [bw, bh] = rotation % 180 === 0 ? [Math.ceil(STATUE_STAMP.w), Math.ceil(STATUE_STAMP.h)] : [Math.ceil(STATUE_STAMP.h), Math.ceil(STATUE_STAMP.w)];
      const places: [number, number][] = [];
      if (side === "n" || side === "s") for (let x = r.x; x + bw <= r.x + r.w; x++) places.push([x, side === "n" ? r.y : r.y + r.h - bh]);
      else for (let y = r.y; y + bh <= r.y + r.h; y++) places.push([side === "w" ? r.x : r.x + r.w - bw, y]);
      for (const [bx, by] of places) {
        const block: number[] = [];
        for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) block.push(y * W + x);
        if (!block.every((k) => input.blockFree(i, k))) continue;
        for (let py = r.y; py < r.y + r.h; py++) {
          for (let px = r.x; px < r.x + r.w; px++) {
            const k = py * W + px;
            if (!input.plateFree(i, k)) continue;
            const gx = px < bx ? bx - px : px >= bx + bw ? px - (bx + bw - 1) : 0;
            const gy = py < by ? by - py : py >= by + bh ? py - (by + bh - 1) : 0;
            // In one of 8 directions: straight out from a side, or diagonal from a corner.
            const away = Math.max(gx, gy);
            if (away < 1 || away > 2 || (gx > 0 && gy > 0 && gx !== gy)) continue;
            const yaw = stepYaw(2 * px + 1 - (2 * bx + bw), 2 * py + 1 - (2 * by + bh));
            out.push({
              kind: "statue",
              zone: { cells: [{ x: px, y: py, w: 1, h: 1 }] },
              mid: [2 * px + 1, 2 * py + 1],
              cone: { origin: [bx + bw / 2, by + bh / 2], yaw },
              statue: { x: bx, y: by, w: bw, h: bh, rotation },
              squares: [...block, k],
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Rolling Stone (5.4, D-261107-265, D-261108-170): a straight Wide stretch
 * holding the stone's 2 by 2 squares at one end and 35 ft of its roll
 * beyond, the plate 25 ft along the roll, each in whole squares at the
 * room's feet per square, either way along the stretch.
 */
function stoneSpots(input: SpotInput, straight: Straight): Spot[] {
  const W = input.board.W;
  const roll = Math.max(1, Math.ceil(STONE_ROLL_FT / input.feetPerCell));
  const plate = Math.min(roll, Math.max(1, Math.ceil(STONE_PLATE_FT / input.feetPerCell)));
  const long = 2 + roll;
  const out: Spot[] = [];
  const seen = new Set<string>();
  for (const k of input.corridor) {
    const x = k % W;
    const y = (k - x) / W;
    for (const alongX of [true, false]) {
      const id = `${x},${y},${alongX}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let ok = true;
      for (let t = 0; t < long && ok; t++) ok = alongX ? straight(x + t, y, true, 2) : straight(x, y + t, false, 2);
      if (!ok) continue;
      const square = (t: number, lane: number) => (alongX ? (y + lane) * W + x + t : (y + t) * W + x + lane);
      const squares: number[] = [];
      for (let t = 0; t < long; t++) squares.push(square(t, 0), square(t, 1));
      // The stone at the start rolling on, or at the end rolling back.
      for (const [stoneAt, plateAt] of [
        [0, 2 + plate - 1],
        [long - 2, long - 2 - plate],
      ] as const) {
        const p = square(plateAt, 0);
        if (!input.floorFree(p)) continue;
        const s = square(stoneAt, 0);
        out.push({ kind: "stone", zone: { cells: [{ x: p % W, y: Math.floor(p / W), w: 1, h: 1 }] }, mid: [2 * (p % W) + 1, 2 * Math.floor(p / W) + 1], stone: [s % W, Math.floor(s / W)], squares });
      }
    }
  }
  return out;
}

const apart = (a: Spot, b: Spot) => Math.max(Math.abs(a.mid[0] - b.mid[0]), Math.abs(a.mid[1] - b.mid[1])) >= 2 * TRAP_SPACING;
const PRESET: Readonly<Record<Exclude<SpotKind, "pit">, string>> = { net: FALLING_NET, needle: POISONED_NEEDLE, roof: COLLAPSING_ROOF, darts: POISONED_DARTS, statue: FIRE_STATUE, stone: ROLLING_STONE };

/** The traps, each one's squares (its zone's, what it hits, a statue's block, a stone's stretch), and the statues' and stones' places. */
export type PickedTraps = { traps: PlanTrap[]; squares: number[][]; statues: PlanStamp[]; stones: [number, number][] };

/**
 * Picks up to `count` traps (5.4): each time a kind among those with a spot
 * left 6 squares from every trap so far and sharing no square with one,
 * then one of its spots. A pit is a Hidden Pit or a Spiked Pit, even odds.
 * A statue's spot is kept only where `reaches` says its cone reaches the
 * plate, asked of at most STATUE_TRIES spots, and a dungeon holds at most
 * MAX_STONES stones.
 */
export function pickTraps(rng: Stream, spots: readonly Spot[], count: number, reaches: (spot: Spot) => boolean = () => true): PickedTraps {
  const out: PickedTraps = { traps: [], squares: [], statues: [], stones: [] };
  let left = [...spots];
  let tries = 0;
  const taken = new Set<number>();
  while (out.traps.length < count) {
    const kinds = KINDS.filter((k) => left.some((s) => s.kind === k));
    if (kinds.length === 0) break;
    const kind = rng.pick(kinds);
    const spot = rng.pick(left.filter((s) => s.kind === kind));
    if (kind === "statue") {
      tries++;
      if (tries >= STATUE_TRIES) left = left.filter((s) => s.kind !== "statue");
      if (!reaches(spot)) {
        left = left.filter((s) => s !== spot);
        continue;
      }
    }
    for (const k of spot.squares) taken.add(k);
    left = left.filter((s) => apart(s, spot) && !s.squares.some((k) => taken.has(k)));
    const preset = kind === "pit" ? (rng.chance(1, 2) ? HIDDEN_PIT : SPIKED_PIT) : PRESET[kind];
    const trap: PlanTrap = { preset, zone: spot.zone };
    if (spot.hits) trap.hits = spot.hits;
    if (spot.cone) trap.cone = spot.cone;
    if (spot.statue) {
      const b = spot.statue;
      out.statues.push({ key: STATUE_STAMP.key, x: b.x + b.w / 2, y: b.y + b.h / 2, w: STATUE_STAMP.w, h: STATUE_STAMP.h, rotation: b.rotation });
    }
    if (spot.stone) {
      trap.stone = out.stones.length;
      out.stones.push(spot.stone);
      if (out.stones.length >= MAX_STONES) left = left.filter((s) => s.kind !== "stone");
    }
    out.traps.push(trap);
    out.squares.push(spot.squares);
  }
  return out;
}

// ------------------------------------------------------------ the statue's reach

const PROBE_SCENE = "statue-reach";
const PROBE = "probe";
// Nothing draws the probe room's only member, so any token's color will do, as long as it is plain hex as a member's color is.
const PROBE_DM: Member = { id: "reach-dm", rev: 1, name: "DM", color: boardTheme.color.text, kind: "dm", createdAt: "2026-01-01T00:00:00.000Z" };
const COVERAGES: readonly AoeCoverage[] = ["half", "any", "center"];
const INCLUSIONS: readonly AoeInclusion[] = ["anyCell", "center", "majority"];

export type Reach = {
  w: number;
  h: number;
  /** The room alone: each of its painted squares' terrain and ground. */
  terrain: ReadonlyMap<number, TerrainId>;
  ground: ReadonlyMap<number, number>;
  plate: [number, number];
  cone: { origin: [number, number]; yaw: number };
  band: LevelBand;
  feetPerCell: number;
};

/**
 * Whether a Fire-Casting Statue's cone reaches a creature on its plate
 * (5.4, D-261107-264): the room alone, its squares and heights, landed in a
 * scratch room, a Medium creature standing on the plate, and the trap's
 * own `trapHits` asked at the room's feet per square under every pair of
 * the area rules (`aoeCoverage` and `aoeInclusion`). A wall, a dais, a
 * scale whose cone is too short, or any pair that misses, and it does
 * not. So the plan reads no room setting but the feet per square, and the
 * trap still works after the DM changes the area rules.
 */
export function statueReaches(r: Reach): boolean {
  const preset = trapPreset(FIRE_STATUE, r.band);
  if (!preset || typeof preset.hits !== "object") return false;
  const base = createInitialState({ roomName: "Reach", dm: PROBE_DM, now: PROBE_DM.createdAt });
  let state: RoomState = { ...base, meta: { ...base.meta, playerSceneId: null }, scenes: {}, playedScenes: {} };
  const W = r.w;
  const key = (k: number) => `${k % W},${Math.floor(k / W)}`;
  const byTerrain = new Map<TerrainId, string[]>();
  for (const [k, t] of r.terrain) byTerrain.set(t, [...(byTerrain.get(t) ?? []), key(k)]);
  const byGround = new Map<number, string[]>();
  for (const [k, ft] of r.ground) if (ft !== 0) byGround.set(ft, [...(byGround.get(ft) ?? []), key(k)]);
  const [px, py] = r.plate;
  const plateGround = r.ground.get(py * W + px) ?? 0;
  const ops: ClientOp[] = [
    { t: "scene.create", scene: builderScene({ id: PROBE_SCENE, name: "Reach", w: r.w, h: r.h }) },
    ...[...byTerrain].map(([terrain, cells]): ClientOp => ({ t: "build.paint", sceneId: PROBE_SCENE, terrain, cells })),
    ...[...byGround].map(([height, cells]): ClientOp => ({ t: "build.height", sceneId: PROBE_SCENE, cells, height })),
    { t: "token.create", token: { ...blankToken({ id: PROBE, sceneId: PROBE_SCENE, kind: "monster", at: { x: px, y: py } }), elevation: plateGround } },
  ];
  for (const [seq, raw] of ops.entries()) {
    const parsed = clientOpSchema.safeParse(raw);
    if (!parsed.success) return false;
    const applied = applyOp(state, parsed.data as Op, { memberId: PROBE_DM.id, role: "dm" }, { seq: seq + 1, at: PROBE_DM.createdAt });
    if (!applied.ok) return false;
    state = applied.state;
  }
  const [ox, oy] = r.cone.origin;
  const trap: Trap = {
    id: "reach",
    rev: 1,
    sceneId: PROBE_SCENE,
    name: preset.name,
    zone: { cells: [{ x: px, y: py, w: 1, h: 1 }] },
    state: "armed",
    found: false,
    rig: { ...preset.rig, hits: { area: { shape: "cone", size: preset.hits.cone, origin: { x: ox, y: oy, z: originGround(r) }, yaw: r.cone.yaw, includeOrigin: false } } },
  };
  for (const aoeCoverage of COVERAGES) {
    for (const aoeInclusion of INCLUSIONS) {
      const moment: RoomState = { ...state, meta: { ...state.meta, settings: { ...state.meta.settings, feetPerCell: r.feetPerCell, aoeCoverage, aoeInclusion } } };
      if (!trapHits(trap, moment, []).includes(PROBE)) return false;
    }
  }
  return true;
}

/** The ground under a cone's origin, the block's middle: the square up and left of it, which the block always holds. */
export function originGround(r: Pick<Reach, "w" | "ground" | "cone">): number {
  const [ox, oy] = r.cone.origin;
  return r.ground.get(Math.floor(oy - 0.5) * r.w + Math.floor(ox - 0.5)) ?? 0;
}
