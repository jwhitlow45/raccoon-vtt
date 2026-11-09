import type { CellRect, StairDirection, TerrainId, TrapZone } from "#shared/model.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { bends, Router, TURN_COST } from "./corridors.ts";
import { daisClear, doorLines, doorStates, placePillars, placePits, placeRubble, roomFloors } from "./dress.ts";
import { DAIS_RISE, placeDais, raiseRooms, type Dais } from "./heights.ts";
import { Board, chooseEntrance, doorEdge, facingSides, loopLinks, placeDoorway, placeRooms, rockBetween, treeLinks, type Doorway, type Link, type Rect, type Side } from "./layout.ts";
import { seedStream } from "./random.ts";
import type { Seed } from "./seed.ts";
import { besideDoorway, bulgeTunnels, erodeRoom, placeColumns } from "./cave.ts";
import { deadEndCount, placeDeadEnds, type Spur } from "./deadEnds.ts";
import { furnish } from "./furnish.ts";
import { keyRooms, pinSquare } from "./keyRooms.ts";
import { placeLights } from "./lightSpots.ts";
import { chooseSecrets, secretCandidates, stillWhole, type Candidate } from "./secrets.ts";
import { clampContext, clampSettings, DEFAULT_CONTEXT, GENERATOR_VERSION, MAX_DOOR_EDGES, SEARCH_BUDGET, litCount, secretCount, trapCount, type DungeonSettings, type PlanContext, type Theme } from "./settings.ts";
import { channelWater, placeCisterns, type Channel } from "./sewer.ts";
import { THEME_SPECS } from "./themes.ts";
import { propsFor } from "./props.ts";
import { pickTraps, STATUE_STAMP, statueReaches, trapSpots, type PickedTraps } from "./trapSpots.ts";

/*
 * The dungeon a seed and the choices make (docs/design/design-v1-dungeon-generator.md
 * 5.3 and 5.4), as plain data the landing lane turns into ops. Pure: the
 * same seed and choices make the same plan on every device of one app
 * version.
 */

/**
 * A kept room: its rectangle, its ground in feet, its floor terrain,
 * whether it is the entrance, and whether it is a secret room (its only
 * doorway secret, phase 2 5.3). `pin` is the square its key pin stands on,
 * x and y, chosen whatever DM key says (5.6).
 */
export type PlanRoom = { x: number; y: number; w: number; h: number; ground: number; floor: TerrainId; pin: [number, number]; entrance?: true; secret?: true };

/** A door edge ("x,y,n" or "x,y,w"), a Wide doorway's two the same. A secret door is closed and hidden. */
export type PlanDoor = { edge: string; state: "closed" | "locked" | "secret" };

/** A stamp by its catalog key: its middle in cells, its size in cells, and its turn in degrees clockwise. Drawn in plan order. */
export type PlanStamp = { key: string; x: number; y: number; w: number; h: number; rotation: 0 | 90 | 180 | 270 };

/**
 * A light: its place in cells on the free wall lattice, its SRD preset
 * (vision/presets.ts `PLACED_LIGHTS`), its label, and the key of the stamp
 * that pictures it, which stands in `stamps` with its middle here.
 */
export type PlanLight = { x: number; y: number; preset: "Candle" | "Torch" | "Hooded Lantern"; label: string; stamp: string };

/**
 * A trap: its SRD preset and zone, and where the generator sets what it
 * hits: `hits` squares that replace the zone's own, a cone's origin in
 * cells and its yaw in 45 degree steps, and the index in `stones` of the
 * hidden token its one action shows.
 */
export type PlanTrap = { preset: string; zone: TrapZone; hits?: CellRect[]; cone?: { origin: [number, number]; yaw: number }; stone?: number };

/** A room's doorway as the key reads it: its side, the other room's number or the map's edge, and its door ("open" on Cave). */
export type KeyDoor = { side: "n" | "e" | "s" | "w"; to: number | "edge"; state: PlanDoor["state"] | "open" };

/**
 * A room as the key describes it: its number (1 for the entrance, breadth
 * first), its index in `rooms`, its doorways, its light's label, its traps'
 * names, an index into the SRD's trinket table (shared/srd/trinkets.ts
 * `TRINKETS`), and what else stands in it.
 */
export type KeyRoom = { n: number; room: number; doors: KeyDoor[]; light?: string; traps: string[]; trinket: number; secret?: true; dais?: true; pit?: true; cistern?: true };

export type DungeonPlan = {
  version: number;
  theme: Theme;
  w: number;
  h: number;
  /** Rooms asked for. `rooms.length` is how many fit, read after the drops. */
  asked: number;
  rooms: PlanRoom[];
  /** Every painted cell by terrain, "x,y", each cell under one terrain. */
  paint: Partial<Record<TerrainId, string[]>>;
  doors: PlanDoor[];
  /** Ground by value, merged, 0 left out. */
  heights: { ft: number; cells: string[] }[];
  stairs: { up: StairDirection; cells: string[] }[];
  /** Props, light stamps and statues, at most MAX_STAMPS. */
  stamps: PlanStamp[];
  lights: PlanLight[];
  /** Each Rolling Stone's hidden Large token: the top-left square of its 2 by 2. */
  stones: [number, number][];
  /** SRD preset ids and where each lies. */
  traps: PlanTrap[];
  /** The entrance room's rectangle, which the creating device frames. */
  entrance: { x: number; y: number; w: number; h: number };
  /** The DM key's rooms in number order, or null with DM key off. Never a seed (D-261102-023). */
  key: KeyRoom[] | null;
};

/**
 * Winding moves a link's doorways round to the rooms' other sides when the
 * rock between them is under this, by width: a gap that narrow holds only a
 * straight crossing or a Z, whatever the style.
 */
const WRAP_BELOW = { narrow: 8, wide: 10 } as const;
/** About one extra way round per this many rooms. */
const ROOMS_PER_LOOP = 4;

/*
 * The streams a seed starts (random.ts `seedStream`, phase 2 5.7): the main
 * one (lane 0) and the corridors' (1) as in phase 1, then one for each
 * choice that must keep what came before it. Secret doors and Dead ends
 * keep the rooms and the linked corridors. Lights, dressing and the key run
 * last, so Lit rooms, Dressing and DM key keep the rooms, corridors, doors
 * and traps.
 */
const LANE_SECRETS = 2;
const LANE_LIGHTS = 3;
const LANE_DRESSING = 4;
const LANE_KEY = 5;
const LANE_DEAD_ENDS = 6;

/** What the drops did, for the tests that drive each branch with a small budget. */
export type PlanTrace = {
  /** Tree links retried with their raised or sunk end rooms made flat. */
  retried: number[];
  /** Each tree link's first failure and why: no way through, an empty budget, or no doorway at an end. */
  failed: { link: number; why: "none" | "budget" | "doorway" }[];
  /** Tree links that failed twice, and the rooms each took with it. */
  dropped: { link: number; rooms: number[] }[];
  /** Links whose styled doorways moved to the plain sides for one more try. */
  replaced: number[];
  /** Loop links skipped, their doorways gone. */
  skipped: number[];
  /** Whether the entrance has no stub to the map's edge. */
  stubFailed: boolean;
  /** Budget left after the tree links, after the loops, and at the end, so a test can stop the search at each stage. */
  treeLeft: number;
  loopsLeft: number;
  budgetLeft: number;
};

/** A plan with the working the tests read: the board, the links and each built corridor's squares. */
export type Planned = {
  plan: DungeonPlan;
  trace: PlanTrace;
  board: Board;
  links: Link[];
  /** Each link's corridor squares in path order, or null where it was never built. */
  paths: (number[] | null)[];
  /** Each built link's search positions in order (a block's top-left on Wide), for reading its turns. */
  chains: (number[] | null)[];
  stub: Doorway | null;
  stubPath: number[] | null;
  entrance: number;
  daises: Map<number, Dais>;
  /** Kept rooms, by board index. */
  kept: number[];
  spurs: Spur[];
  /** Squares Cave's tunnels gained. */
  bulges: number[];
  secret: Candidate[];
  /** Room squares left unpainted: Cave's eroded ring squares and rock columns. */
  unpainted: Set<number>;
  /** Rooms holding a cistern. */
  cisterns: Set<number>;
  /** Each kept room's pin square, by board index. */
  pins: Map<number, number>;
};

export function generate(settings: DungeonSettings, seed: Seed, context: PlanContext, budget: number = SEARCH_BUDGET): DungeonPlan {
  return planDungeon(settings, seed, context, budget).plan;
}

/** The plan with its working. A caller with no room (a bench script) plans at the default 5 ft a square. */
export function planDungeon(input: DungeonSettings, seed: Seed, context: PlanContext = DEFAULT_CONTEXT, budget: number = SEARCH_BUDGET): Planned {
  const s = clampSettings(input);
  const ctx = clampContext(context);
  const theme = THEME_SPECS[s.theme];
  const { w: W, h: H } = s;
  const width = s.wide ? 2 : 1;
  const rng = seedStream(seed);
  const trace: PlanTrace = { retried: [], failed: [], dropped: [], replaced: [], skipped: [], stubFailed: false, treeLeft: budget, loopsLeft: budget, budgetLeft: budget };

  // Steps 1 to 3: rooms, the entrance, the tree and the extra ways around.
  const rects = placeRooms(rng, s);
  const board = new Board(W, H, rects);
  const entrance = rects.length > 0 ? chooseEntrance(rects, W, H) : { room: -1, side: "w" as Side };
  const tree = entrance.room >= 0 ? treeLinks(rects, entrance.room) : [];
  const doorEdges = (loops: number) => (2 * tree.length + 1 + 2 * loops) * width;
  const loops = s.loops ? loopLinks(rects, tree, Math.floor(rects.length / ROOMS_PER_LOOP), (n) => doorEdges(n) <= MAX_DOOR_EDGES) : [];
  const links = [...tree, ...loops];

  // Step 4: doorways, the stub's first so the way in always has its side.
  // The corridors' own stream: doorway aims and waypoints, so a change of style leaves the rooms where they are.
  const ways = seedStream(seed, GENERATOR_VERSION, 1);
  const style = s.corridors;
  // Straight aims each doorway at the other room's middle, so facing rooms join in a line. The others aim at a spot drawn along the side, so even a short crossing takes a Z.
  const aim = style === "straight" ? undefined : (last: number) => ways.int(1, last);
  const stub = entrance.room >= 0 ? placeDoorway(board, entrance.room, [entrance.side], rects[entrance.room]!, width, -1, true) : null;
  /** A link's two doorways on the first of each room's `sides` with a spot, or none. */
  const placeLink = (li: number, sides: (r: Rect, o: Rect) => readonly Side[], at?: (last: number) => number): { a: Doorway | null; b: Doorway | null } => {
    const l = links[li]!;
    const a = placeDoorway(board, l.a, sides(rects[l.a]!, rects[l.b]!), rects[l.b]!, width, li, false, at);
    const b = a ? placeDoorway(board, l.b, sides(rects[l.b]!, rects[l.a]!), rects[l.a]!, width, li, false, at) : null;
    if (a && !b) board.removeDoorway(a);
    return { a: b ? a : null, b };
  };
  const ends = links.map((_, li) => placeLink(li, facingSides, aim));
  // Winding then moves the doorways of rooms with little rock between them round to the other sides, so the corridor winds round a room rather than crossing the gap straight. A move that does not fit keeps the doorways where they were.
  if (style === "winding") {
    ends.forEach((e, li) => {
      const l = links[li]!;
      if (!e.a || !e.b || rockBetween(rects[l.a]!, rects[l.b]!) >= WRAP_BELOW[s.wide ? "wide" : "narrow"]) return;
      e.a.removed = e.b.removed = true;
      const moved = placeLink(li, (r, o) => [facingSides(r, o)[1]]);
      if (moved.a) ends[li] = moved;
      else e.a.removed = e.b.removed = false;
    });
  }

  // Step 5: heights, before any corridor, so every run is reserved first.
  if (entrance.room >= 0) raiseRooms(rng, board, entrance.room, s.heights);

  // Step 6: corridors, tree links in Prim's order, then the loops, then the stub.
  const bend = (a: readonly [number, number], b: readonly [number, number]) => bends(ways, s.corridors, a, b, width);
  const router = new Router(board);
  const options = { wide: s.wide, turn: TURN_COST, budget: { left: budget } };
  const paths: (number[] | null)[] = links.map(() => null);
  const chains: (number[] | null)[] = links.map(() => null);
  const routeLink = (li: number): "built" | "none" | "budget" | "doorway" => {
    const { a, b } = ends[li]!;
    if (!a || !b || a.removed || b.removed) return "doorway";
    const found = router.route(a, { anchor: board.anchor(b), side: b.side }, options, bend);
    if (!found.ok) return found.why;
    for (const k of found.cells) board.laid[k] = 1;
    paths[li] = found.cells;
    chains[li] = found.chain;
    return "built";
  };
  /**
   * Places a link's doorways afresh where Straight puts them, the sides
   * facing each other aimed at the other room's middle, for one more try
   * (D-261102-831). A way round a room or an off-center doorway can find no
   * path where the plain doorways would. Nor can a flattened run's, whose
   * corridor still starts from the old far landing, so Straight's links try
   * again too. Its rooms must be flat, since the new doorways have no runs.
   * False when a doorway no longer fits.
   */
  const replain = (li: number): boolean => {
    for (const d of [ends[li]!.a, ends[li]!.b]) if (d) board.removeDoorway(d);
    ends[li] = placeLink(li, facingSides);
    trace.replaced.push(li);
    return ends[li]!.a !== null;
  };
  const children = new Map<number, number[]>();
  for (const l of tree) children.set(l.a, [...(children.get(l.a) ?? []), l.b]);
  const branch = (room: number): number[] => [room, ...(children.get(room) ?? []).flatMap(branch)];
  tree.forEach((l, li) => {
    if (board.rooms[l.b]!.dropped) return;
    const first = routeLink(li);
    if (first === "built") return;
    trace.failed.push({ link: li, why: first });
    // Only a search that found no way can go through once a run is gone. No doorway stays none, and an empty budget stays empty.
    const raised = first === "none" ? [l.a, l.b].filter((i) => board.rooms[i]!.ground !== 0) : [];
    if (raised.length > 0) {
      trace.retried.push(li);
      for (const i of raised) board.flatten(i);
      if (routeLink(li) === "built") return;
    }
    // Both end rooms are flat by now, so their doorways can move without a run.
    if (first === "none" && replain(li) && routeLink(li) === "built") return;
    const gone = branch(l.b);
    // The failed link's doorway on the kept room goes in the sweep after routing, with every other unbuilt one.
    for (const i of gone) board.drop(i);
    trace.dropped.push({ link: li, rooms: gone });
  });
  trace.treeLeft = options.budget.left;
  loops.forEach((l, j) => {
    const li = tree.length + j;
    const first = routeLink(li);
    if (first === "built") return;
    if (first === "none" && board.rooms[l.a]!.ground === 0 && board.rooms[l.b]!.ground === 0 && replain(li) && routeLink(li) === "built") return;
    trace.skipped.push(li);
    for (const d of [ends[li]!.a, ends[li]!.b]) if (d) board.removeDoorway(d);
  });
  trace.loopsLeft = options.budget.left;
  let stubPath: number[] | null = null;
  let stubChain: number[] | null = null;
  if (stub) {
    const found = router.route(stub, { edge: entrance.side }, options);
    if (found.ok) {
      for (const k of found.cells) board.laid[k] = 1;
      stubPath = found.cells;
      stubChain = found.chain;
    }
  }
  if (!stubPath) trace.stubFailed = true;
  trace.budgetLeft = options.budget.left;
  // A doorway whose corridor was never built goes with its door and run, so no door opens onto rock.
  for (const d of board.doorways) if (!d.removed && (d.link < 0 ? stubPath === null : paths[d.link] === null)) board.removeDoorway(d);

  const kept = board.rooms.flatMap((r, i) => (r.dropped ? [] : [i]));
  const doorways = board.doorways.filter((d) => !d.removed);

  // The corridor squares: every built way, and each kept doorway's run or flattened run.
  const realRuns = new Set<number>();
  const runSquares = new Set<number>();
  const mouths = new Set<number>();
  for (const d of doorways) {
    for (const k of d.outside) mouths.add(k);
    if (d.run) for (const k of [...d.run.near, ...d.run.stairs.map((st) => st.cell), ...d.run.far]) realRuns.add(k);
    if (d.flat) for (const k of d.flat) runSquares.add(k);
  }
  for (const k of realRuns) runSquares.add(k);
  const edgeStairs = new Set<number>();
  if (stubPath) {
    for (const k of stubPath) {
      const x = k % W;
      const y = (k - x) / W;
      if ((entrance.side === "w" && x === 0) || (entrance.side === "e" && x === W - 1) || (entrance.side === "n" && y === 0) || (entrance.side === "s" && y === H - 1)) edgeStairs.add(k);
    }
  }
  const builtPaths = [...paths.filter((p): p is number[] => p !== null), ...(stubPath ? [stubPath] : [])];
  const builtChains = [...chains.filter((c): c is number[] => c !== null), ...(stubChain ? [stubChain] : [])];
  const corridor = new Set<number>([...builtPaths.flat(), ...runSquares]);
  const plainCorridor = (k: number) => !runSquares.has(k) && !mouths.has(k) && !edgeStairs.has(k);

  // Cave's tunnels bulge where a corridor could have gone (phase 2, 5.1), from the main stream.
  let bulges: number[] = [];
  if (theme.cave) {
    bulges = bulgeTunnels(rng, board, builtPaths, plainCorridor, router.openSquares(false));
    for (const k of bulges) {
      corridor.add(k);
      board.laid[k] = 1;
    }
  }

  // Dead ends (5.2), from their own stream, so the switch keeps the rooms and the linked corridors.
  let spurs: Spur[] = [];
  if (s.deadEnds && kept.length > 0) {
    const all = width === 1 ? [...new Set(builtPaths.flat())] : [...new Set(builtChains.flat())];
    const block = (k: number) => (width === 1 ? [k] : [k, k + 1, k + W, k + W + 1]);
    const starts = all.filter((k) => block(k).every((q) => corridor.has(q) && plainCorridor(q)));
    spurs = placeDeadEnds(seedStream(seed, GENERATOR_VERSION, LANE_DEAD_ENDS), { board, width, starts, corridor, open: router.openSquares(false), count: deadEndCount(kept.length) });
  }
  const spurPaths = spurs.map((sp) => sp.cells);

  // Step 8: doors, then the floors, both drawn before the secret doors, so whatever moves those keeps the locks and the floors.
  const states = doorStates(rng, doorways, theme, stub);
  const floors = roomFloors(rng, board, theme);

  // Secret doors (5.3), from their own stream, chosen before anything is placed round the doorways.
  let secret: Candidate[] = [];
  const secrets = theme.doors ? secretCount(s.secrets, kept.length) : 0;
  if (secrets > 0) {
    const painted = (k: number) => board.roomAt[k] !== 0 || corridor.has(k);
    const candidates = secretCandidates({ doorways, links, entrance: entrance.room, stub, locked: (d) => states.get(d.id) === "locked" });
    secret = chooseSecrets(seedStream(seed, GENERATOR_VERSION, LANE_SECRETS), candidates, secrets, (set) => stillWhole(board, painted, entrance.room, kept, set));
  }
  const secretIds = new Set(secret.map((c) => c.doorway.id));
  const isSecret = (d: Doorway) => secretIds.has(d.id);
  const secretRooms = new Set(secret.flatMap((c) => (c.kind === "leaf" ? [c.doorway.room] : [])));

  // Step 9: daises, floors and dressing, kept off the ways the party walks. A secret doorway's
  // lines are plain floor for what stands in a room (`openLines`), but daises and pits keep off
  // them all, so a Large creature walks in once it is found (D-261107-262).
  const lines = new Map(kept.map((i) => [i, doorLines(board, i)]));
  const openLines = new Map(kept.map((i) => [i, doorLines(board, i, isSecret)]));
  const onLine = (k: number) => {
    const room = board.roomAt[k]! - 1;
    return room >= 0 && (openLines.get(room)?.has(k) ?? false);
  };
  const daises = new Map<number, Dais>();
  for (const i of kept) {
    const dais = placeDais(rng, board, i, (k) => lines.get(i)!.has(k), (d) => !isSecret(d));
    if (dais) daises.set(i, dais);
  }
  const daisSquares = new Map<number, number>();
  const clear = new Set<number>();
  for (const [i, dais] of daises) {
    for (let y = dais.rect.y; y < dais.rect.y + dais.rect.h; y++) for (let x = dais.rect.x; x < dais.rect.x + dais.rect.w; x++) daisSquares.set(board.cell(x, y), board.rooms[i]!.ground + DAIS_RISE);
    for (const k of daisClear(dais)) clear.add(k);
  }

  // Cave rooms lose their corners and nibbles of their ring, never a doorway or its lines.
  const unpainted = new Set<number>();
  if (theme.cave) {
    for (const i of kept) {
      const keep = new Set<number>([...lines.get(i)!, ...clear]);
      for (const d of doorways) if (d.room === i) for (const k of [...d.inside, ...besideDoorway(board, d.inside, d.side)]) keep.add(k);
      for (const k of erodeRoom(rng, board, i, (k) => keep.has(k) || daisSquares.has(k))) unpainted.add(k);
    }
  }
  const inRoom = (k: number) => board.roomAt[k] !== 0 && !unpainted.has(k);

  const overlay = new Map<number, TerrainId>();
  const tunnels = [...builtPaths, ...spurPaths];
  if (theme.rubble) placeRubble(rng, tunnels, theme.rubble, plainCorridor, overlay);
  if (theme.pits) placePits(rng, board, kept, theme.pits, (i, k) => inRoom(k) && !lines.get(i)!.has(k) && !daisSquares.has(k) && !clear.has(k), overlay);
  // A Narrow ring may stand on a secret doorway's line, since a Medium creature steps round a pillar. A Wide one keeps off it for a Large one.
  if (theme.pillars) placePillars(board, kept, (i, k) => !(s.wide ? lines : openLines).get(i)!.has(k) && !clear.has(k), overlay);
  const cisterns = new Set<number>();
  if (theme.sewer) {
    const channels: Channel[] = [...builtChains.map((chain) => ({ chain })), ...spurs.map((sp) => ({ cells: sp.cells, side: sp.side }))];
    const ordinaryMouths = new Set(doorways.filter((d) => !isSecret(d)).flatMap((d) => d.outside));
    const dry = (k: number) => realRuns.has(k) || edgeStairs.has(k) || (!s.wide && ordinaryMouths.has(k));
    for (const k of channelWater(board, s.wide, corridor, channels, dry)) overlay.set(k, "water");
    for (const [i, water] of placeCisterns(rng, board, kept, (i) => daises.has(i), (i) => openLines.get(i)!)) {
      cisterns.add(i);
      for (const k of water) overlay.set(k, "water");
    }
  }

  // Pin squares (5.6), whatever DM key says: free floor nearest each room's middle, before columns,
  // lights and dressing keep off them.
  const pins = new Map<number, number>();
  for (const i of kept) pins.set(i, pinSquare(board, i, (k) => inRoom(k) && !overlay.has(k) && !daisSquares.has(k)));
  if (theme.cave) {
    for (const i of kept) {
      const near = (k: number) => lines.get(i)!.has(k) || daisSquares.has(k) || clear.has(k) || k === pins.get(i);
      for (const k of placeColumns(rng, board, i, near, inRoom)) unpainted.add(k);
    }
  }

  // Step 10: traps. A secret doorway's inside squares are plain floor, and its outside squares and edges take none.
  const inside = new Set(doorways.filter((d) => !isSecret(d)).flatMap((d) => d.inside));
  const secretMouths = new Set(secret.flatMap((c) => c.doorway.outside));
  const painted = (k: number) => inRoom(k) || corridor.has(k);
  // The pin is the DM's tap target for the room, so a trap zone must not cover it.
  const onPin = (k: number) => board.roomAt[k] !== 0 && k === pins.get(board.roomAt[k]! - 1);
  const floorFree = (k: number) =>
    painted(k) && !onPin(k) && !overlay.has(k) && !daisSquares.has(k) && !clear.has(k) && !inside.has(k) && !secretMouths.has(k) && (board.roomAt[k] !== 0 || plainCorridor(k));
  const ownFloor = (i: number, k: number) => board.roomAt[k] === i + 1 && inRoom(k) && k !== pins.get(i);
  const roomTerrain = (i: number) => {
    const r = board.rooms[i]!;
    const terrain = new Map<number, TerrainId>();
    const ground = new Map<number, number>();
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const k = board.cell(x, y);
        if (!inRoom(k)) continue;
        terrain.set(k, overlay.get(k) ?? floors[i]!);
        ground.set(k, daisSquares.get(k) ?? r.ground);
      }
    }
    return { terrain, ground };
  };
  const picked: PickedTraps =
    s.traps === 0
      ? { traps: [], squares: [], statues: [], stones: [] }
      : pickTraps(
          rng,
          trapSpots({
            board,
            rooms: kept.filter((i) => i !== entrance.room),
            onLine,
            floorFree,
            hitFree: (k) => corridor.has(k) && plainCorridor(k) && !secretMouths.has(k),
            corridor: [...new Set([...builtPaths.flat(), ...spurPaths.flat()])],
            painted,
            wide: s.wide,
            locked: doorways.filter((d) => d.room !== entrance.room && states.get(d.id) === "locked").map((d) => doorEdgeOf(board, d, 0)),
            statueRooms: kept.filter((i) => i !== entrance.room && propsFor(s.theme, floors[i]!).includes(STATUE_STAMP.key)),
            blockFree: (i, k) => ownFloor(i, k) && !overlay.has(k) && !daisSquares.has(k) && !clear.has(k) && !inside.has(k) && !openLines.get(i)!.has(k),
            plateFree: (i, k) => ownFloor(i, k) && openLines.get(i)!.has(k) && floorFree(k),
            stones: s.wide && (s.band === "11-16" || s.band === "17-20"),
            feetPerCell: ctx.feetPerCell,
          }),
          trapCount(s.traps, kept.length),
          (spot) => {
            const i = board.roomAt[spot.squares[0]!]! - 1;
            const [z] = "cells" in spot.zone ? spot.zone.cells : [];
            return i >= 0 && z !== undefined && spot.cone !== undefined && statueReaches({ w: W, h: H, ...roomTerrain(i), plate: [z.x, z.y], cone: spot.cone, band: s.band, feetPerCell: ctx.feetPerCell });
          },
        );
  const traps = picked.traps;

  // Lights (5.5), from their own stream after the traps, so Lit rooms keeps the rooms, corridors, doors and traps.
  const used = new Set(picked.squares.flat());
  const stampsIn = new Map<number, number>();
  const roomOf = (k: number) => board.roomAt[k]! - 1;
  for (const st of picked.statues) {
    const i = roomOf(Math.floor(st.y - 0.5) * W + Math.floor(st.x - 0.5));
    stampsIn.set(i, (stampsIn.get(i) ?? 0) + 1);
  }
  const own = (i: number, k: number) => k >= 0 && k < W * H && board.roomAt[k] === i + 1 && inRoom(k);
  const free = (i: number, k: number) => own(i, k) && !overlay.has(k) && !clear.has(k) && !inside.has(k) && !openLines.get(i)!.has(k) && k !== pins.get(i) && !used.has(k);
  const lit = placeLights(seedStream(seed, GENERATOR_VERSION, LANE_LIGHTS), board, kept, litCount(s.lit, kept.length), own, free, theme);
  for (const l of lit) {
    used.add(l.square);
    stampsIn.set(l.room, (stampsIn.get(l.room) ?? 0) + 1);
  }
  const groundAt = (k: number) => daisSquares.get(k) ?? board.rooms[roomOf(k)]?.ground ?? 0;

  // Dressing (5.5), from its own stream after the lights, so Dressing keeps everything before it.
  const props = furnish(seedStream(seed, GENERATOR_VERSION, LANE_DRESSING), {
    board,
    rooms: kept,
    dressing: s.dressing,
    props: (i) => propsFor(s.theme, floors[i]!),
    free,
    ground: groundAt,
    held: (i) => stampsIn.get(i) ?? 0,
    total: picked.statues.length + lit.length,
  });

  // The key (5.6), from its own stream, last: DM key moves nothing before it.
  const roomTraps = new Map<number, string[]>();
  const doorRoom = new Map<string, number>();
  for (const d of doorways) d.inside.forEach((_, j) => doorRoom.set(doorEdgeOf(board, d, j), d.room));
  picked.traps.forEach((t) => {
    const z = t.zone;
    const i = "door" in z ? ("edge" in z.door ? (doorRoom.get(z.door.edge) ?? -1) : -1) : "cells" in z ? roomOf(board.cell(z.cells[0]!.x, z.cells[0]!.y)) : -1;
    if (i >= 0) roomTraps.set(i, [...(roomTraps.get(i) ?? []), trapPreset(t.preset, s.band)?.name ?? t.preset]);
  });
  const lights = new Map(lit.map((l) => [l.room, l.light.label]));
  const pitRooms = new Set([...overlay].flatMap(([k, t]) => (t === "pit" && board.roomAt[k] !== 0 ? [roomOf(k)] : [])));
  const keyed = s.key
    ? keyRooms(seedStream(seed, GENERATOR_VERSION, LANE_KEY), {
        kept,
        links,
        entrance: entrance.room,
        doors: doorways.map((d) => ({ doorway: d, state: !theme.doors ? ("open" as const) : isSecret(d) ? ("secret" as const) : states.get(d.id)! })),
        traps: (i) => roomTraps.get(i) ?? [],
        light: (i) => lights.get(i),
        secret: (i) => secretRooms.has(i),
        dais: (i) => daises.has(i),
        pit: (i) => pitRooms.has(i),
        cistern: (i) => cisterns.has(i),
      })
    : null;

  // The plan.
  const terrain = new Map<number, TerrainId>();
  for (const i of kept) {
    const r = board.rooms[i]!;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inRoom(board.cell(x, y))) terrain.set(board.cell(x, y), floors[i]!);
  }
  for (const k of corridor) terrain.set(k, theme.corridor);
  for (const [k, t] of overlay) if (terrain.has(k)) terrain.set(k, t);

  const ground = new Map<number, number>();
  for (const i of kept) {
    const r = board.rooms[i]!;
    if (r.ground !== 0) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inRoom(board.cell(x, y))) ground.set(board.cell(x, y), r.ground);
  }
  for (const [k, ft] of daisSquares) ground.set(k, ft);
  const ups = new Map<number, Side>();
  for (const d of doorways) {
    if (!d.run) continue;
    for (const k of d.run.near) ground.set(k, d.run.ground);
    for (const st of d.run.stairs) {
      ground.set(st.cell, st.ground);
      ups.set(st.cell, st.up);
    }
  }
  for (const dais of daises.values()) ups.set(dais.stair, dais.up);
  for (const k of edgeStairs) ups.set(k, entrance.side);

  const key = (k: number) => `${k % W},${Math.floor(k / W)}`;
  const grouped = <V extends string | number>(m: Map<number, V>, order: (a: V, b: V) => number) => {
    const by = new Map<V, number[]>();
    for (const [k, v] of m) by.set(v, [...(by.get(v) ?? []), k]);
    return [...by.entries()].sort((a, b) => order(a[0], b[0])).map(([v, cells]) => ({ v, cells: cells.sort((a, b) => a - b).map(key) }));
  };
  const paint: Partial<Record<TerrainId, string[]>> = {};
  for (const { v, cells } of grouped(terrain, (a, b) => (a < b ? -1 : a > b ? 1 : 0))) paint[v] = cells;
  const DIR_ORDER = "nesw";
  const xy = (k: number): [number, number] => [k % W, Math.floor(k / W)];
  const plan: DungeonPlan = {
    version: GENERATOR_VERSION,
    theme: s.theme,
    w: W,
    h: H,
    asked: s.rooms,
    rooms: kept.map((i) => {
      const r = board.rooms[i]!;
      return {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        ground: r.ground,
        floor: floors[i]!,
        pin: xy(pins.get(i)!),
        ...(i === entrance.room ? { entrance: true as const } : {}),
        ...(secretRooms.has(i) ? { secret: true as const } : {}),
      };
    }),
    paint,
    doors: theme.doors ? doorways.flatMap((d) => d.inside.map((_, j) => ({ edge: doorEdgeOf(board, d, j), state: isSecret(d) ? ("secret" as const) : states.get(d.id)! }))) : [],
    heights: grouped(
      new Map([...ground].filter(([, ft]) => ft !== 0)),
      (a, b) => a - b,
    ).map(({ v, cells }) => ({ ft: v, cells })),
    stairs: grouped(ups, (a, b) => DIR_ORDER.indexOf(a) - DIR_ORDER.indexOf(b)).map(({ v, cells }) => ({ up: v, cells })),
    stamps: [...picked.statues, ...lit.map((l) => l.stamp), ...props.map((f) => f.stamp)],
    lights: lit.map((l) => l.light),
    stones: picked.stones,
    traps,
    entrance: entrance.room >= 0 ? { x: rects[entrance.room]!.x, y: rects[entrance.room]!.y, w: rects[entrance.room]!.w, h: rects[entrance.room]!.h } : { x: 0, y: 0, w: 0, h: 0 },
    key: keyed,
  };
  return {
    plan,
    trace,
    board,
    links,
    paths,
    chains,
    stub: stub && !stub.removed ? stub : null,
    stubPath,
    entrance: entrance.room,
    daises,
    kept,
    spurs,
    bulges,
    secret,
    unpainted,
    cisterns,
    pins,
  };
}

function doorEdgeOf(board: Board, d: Doorway, j: number): string {
  const k = d.inside[j]!;
  return doorEdge(k % board.W, Math.floor(k / board.W), d.side);
}
