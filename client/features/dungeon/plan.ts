import type { CellRect, RoomState, Scene, StairDirection, TerrainId, TrapZone } from "#shared/model.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { bends, Router, TURN_COST } from "./corridors.ts";
import { daisClear, doorLines, doorStates, placePillars, placePits, placeRubble, roomFloors } from "./dress.ts";
import { DAIS_RISE, placeDais, raiseRooms, type Dais } from "./heights.ts";
import { Board, chooseEntrance, doorEdge, facingSides, loopLinks, placeDoorway, placeRooms, rockBetween, SIDE_ORDER, treeLinks, type Doorway, type Link, type Rect, type Side } from "./layout.ts";
import { seedStream } from "./random.ts";
import type { Seed } from "./seed.ts";
import { besideDoorway, bulgeTunnels, erodeRoom, placeColumns } from "./cave.ts";
import { deadEndCount, placeDeadEnds, type Spur } from "./deadEnds.ts";
import { furnish, furnishHex, HexStamps, STAMP_DOOR_STEPS } from "./furnish.ts";
import { CORRIDOR_SPACE, directionTo, hexSide, hexWalls, NO_SPACE, RUN_SPACE, type HexWalls, type WallDoorway } from "./hexWalls.ts";
import { latticeFor, type Lattice } from "./lattice.ts";
import { corridorTraps, keyRooms, numberRooms, pinSquare } from "./keyRooms.ts";
import { placeLights, placeLightsHex, type LitRoom } from "./lightSpots.ts";
import { doorKey, editsHold, REPORTS, SECRET_OFF, type DoorPin, type DungeonEdits, type RoomEdit, type RoomFacts } from "./edits.ts";
import { fitRooms, NEW_SCENE, withinAllowance, type Allowance, type FitFailure } from "./fit.ts";
import { chooseSecrets, secretCandidates, stillWhole, type Candidate } from "./secrets.ts";
import { clampContext, clampSettings, DEFAULT_CONTEXT, GENERATOR_VERSION, isHexGrid, MAX_DOOR_EDGES, MAX_LIGHTS, MAX_SECRET_DOORS, MAX_STAMPS, MAX_TRAPS, SEARCH_BUDGET, litCount, secretCount, trapCount, type DungeonSettings, type GridKind, type PlanContext, type Theme } from "./settings.ts";
import { channelWater, placeCisterns, type Channel } from "./sewer.ts";
import { THEME_SPECS } from "./themes.ts";
import { propsFor, stampSize } from "./props.ts";
import { FIRE_STATUE, HIDDEN_PIT, hexTrapSpots, pickTraps, POISONED_NEEDLE, SPIKED_PIT, presetKind, spotsApart, STATUE_STAMP, statueReaches, statueStamp, trapAt, trapSpots, type PickedTraps, type Spot } from "./trapSpots.ts";
import { wallChunk } from "#shared/keys.ts";

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
export type PlanTrap = { preset: string; zone: TrapZone; hits?: CellRect[]; cone?: { origin: [number, number]; yaw: number }; stone?: number; leaf?: number };

/**
 * A free wall on a hex side (phase 3, 2.2): its ends on the 1/64 lattice
 * and what it is, a wall or a door leaf in its doorway's state. Make gives
 * each a fresh id. One per side, so a hidden leaf reaches players as a wall
 * of its own ends, like every other piece.
 */
export type PlanWall = { a: [number, number]; b: [number, number]; f: "wall" | "closed" | "locked" | "secret" };

/** A room's doorway as the key reads it: its side, the other room's number or the map's edge, and its door ("open" on Cave). */
export type KeyDoor = { side: "n" | "e" | "s" | "w"; to: number | "edge"; state: PlanDoor["state"] | "open" };

/**
 * A room as the key describes it: its number (1 for the entrance, breadth
 * first), its index in `rooms`, its doorways, its light's label, its traps'
 * names, an index into the SRD's trinket table (shared/srd/trinkets.ts
 * `TRINKETS`), and what else stands in it.
 */
export type KeyRoom = { n: number; room: number; doors: KeyDoor[]; light?: string; traps: string[]; trinket: number; secret?: true; dais?: true; pit?: true; cistern?: true };

/**
 * A trap in the corridors as the key reads it (LP33-B-KEY-1): its name, and
 * where it lies: between two rooms' numbers (the second "edge" on the way in's
 * stub), in a dead end, or null on no built way.
 */
export type KeyCorridorTrap = { name: string; between: readonly [number, number | "edge"] | "deadEnd" | null };

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
  /** The traps no room holds, for the key's closing part: present only with DM key on and a trap in a corridor. */
  corridorTraps?: KeyCorridorTrap[];
  /*
   * Phase 3's fields, each absent on squares and after the keys above, so
   * every square plan and its golden hash stay as they were (5).
   *
   * On hexes `w` and `h` are the scene's bounds in cells, rooms, their pins
   * and the entrance are on the rows lattice (lattice.ts), and every cell
   * key, stamp, light and trap zone is the scene's own, mirrored on Hex
   * columns. `paint` and `doors` are empty: walls show the rooms.
   */
  grid?: GridKind;
  /** Every wall and door leaf, sorted by their ends. */
  walls?: PlanWall[];
  /** Difficult ground, as scene keys: rubble and water on hexes and on a "floor" wing. */
  rough?: string[];
  /** A wing's join as planned, which its asks carry for the server's check. */
  join?: JoinExpect;
};

/**
 * What a wing is planned on (phase 3, 3.3 and 3.4): the scene, the parts of
 * the room that can stand in the way, the area dragged in the scene's own
 * keys, the join, and a hash of the geometry, which edits freeze.
 */
export type WingBase = {
  scene: Scene;
  state: Pick<RoomState, "buildChunks" | "traps" | "stamps" | "lights" | "labels" | "pins" | "tokens" | "floorLinks">;
  area: CellRect;
  join: JoinExpect;
  hash: string;
};

/**
 * Winding moves a link's doorways round to the rooms' other sides when the
 * rock between them is under this, by width: a gap that narrow holds only a
 * straight crossing or a Z, whatever the style.
 */
const WRAP_BELOW = { narrow: 8, wide: 10 } as const;
/** About one extra way round per this many rooms. */
const ROOMS_PER_LOOP = 4;
/** The first of the lanes a pinned room's own props are drawn from, 16 a room (phase 3, 4.3): lane 64 + 16 x room + propsDraw. */
const LANE_ROOM_PROPS = 64;
/** A pit or a mine shaft on hexes, in feet below its room's floor (phase 3, 2.4). */
const PIT_DROP = 10;

/** What a plan takes besides the choices (phase 3): the room count to ask for, and the rooms' edits by board index. */
export type PlanOptions = { rooms?: number; edits?: Readonly<Record<number, RoomEdit>>; allowance?: Allowance };

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
  /** The room count the plan asked `placeRooms` for: the Rooms asked, or fewer where a hex plan stepped down (phase 3, 2.5). */
  fitted: number;
  /** The lattice the board lies on. */
  lattice: Lattice;
  /** On hexes, each cell's space for the wall pass (hexWalls.ts), and each kept doorway's leaves in `plan.walls`, in `doorways` order. Empty on squares. */
  space: Int32Array;
  leaves: number[][];
  /** Each kept room as the room panel shows it, in number order (phase 3, 4.1). */
  facts: RoomFacts[];
  /** What the edits did not do, by board index, a room gone among them. */
  reports: ReadonlyMap<number, readonly string[]>;
  /** Why the fit gave up, or null when the plan fits its allowance (phase 3, 2.5). */
  overBudget: FitFailure | null;
};

export function generate(settings: DungeonSettings, seed: Seed, context: PlanContext, budget: number = SEARCH_BUDGET): DungeonPlan {
  return planDungeon(settings, seed, context, budget).plan;
}

/**
 * The plan a dialog or a wing pane shows (phase 3, 2.5 and 4.2): on hexes
 * the first plan within the wall budget, stepping the room count down, and
 * with edits exactly the room count they froze, the edits applied.
 */
export function planFitted(settings: DungeonSettings, seed: Seed, context: PlanContext, extras: { edits?: DungeonEdits; wing?: WingBase } = {}): Planned {
  const ctx = clampContext(context);
  const s = clampSettings(settings, ctx.grid);
  const allowance = NEW_SCENE;
  // Squares hold no free walls, so only a hex plan has a wall budget to fit.
  const fits = (p: Planned) => !isHexGrid(ctx.grid) || withinAllowance(p.plan, allowance);
  const edits = extras.edits && editsHold(extras.edits, s, seed, null) ? extras.edits : undefined;
  if (edits) {
    // Edits freeze the room count, so a plan over budget is not fitted again: the edit that took it over is undone (4.2).
    const planned = planDungeon(s, seed, ctx, SEARCH_BUDGET, { rooms: edits.layout.fitted, edits: edits.rooms, allowance });
    return fits(planned) ? planned : { ...planned, overBudget: "edits" };
  }
  const { planned, failed } = fitRooms(s.rooms, (rooms) => planDungeon(s, seed, ctx, SEARCH_BUDGET, { rooms, allowance }), fits);
  return failed ? { ...planned, overBudget: failed } : planned;
}

/** The plan with its working. A caller with no room (a bench script) plans at the default 5 ft a square. */
export function planDungeon(input: DungeonSettings, seed: Seed, context: PlanContext = DEFAULT_CONTEXT, budget: number = SEARCH_BUDGET, extras: PlanOptions = {}): Planned {
  const ctx = clampContext(context);
  const grid: GridKind = ctx.grid ?? "squares";
  const hex = isHexGrid(grid);
  const s = clampSettings(input, ctx.grid);
  const theme = THEME_SPECS[s.theme];
  // On hexes the plan works on the rows lattice of the scene's bounds, larger than the bounds by about a seventh down the rows.
  const lattice = latticeFor(grid, { w: s.w, h: s.h });
  const { W, H } = lattice;
  const fitted = extras.rooms ?? s.rooms;
  const edits = extras.edits;
  // What each pinned room's edits did not do, by board index (4.1).
  const reports = new Map<number, string[]>();
  const report = (room: number, line: string) => reports.set(room, [...(reports.get(room) ?? []), line]);
  const grounds = new Map(Object.entries(edits ?? {}).flatMap(([i, e]) => (e.ground === undefined ? [] : [[Number(i), e.ground] as [number, number]])));
  const width = s.wide ? 2 : 1;
  const rng = seedStream(seed);
  const trace: PlanTrace = { retried: [], failed: [], dropped: [], replaced: [], skipped: [], stubFailed: false, treeLeft: budget, loopsLeft: budget, budgetLeft: budget };

  // Steps 1 to 3: rooms, the entrance, the tree and the extra ways around.
  const rects = placeRooms(rng, { w: W, h: H, rooms: fitted, density: s.density, wide: s.wide });
  const board = new Board(W, H, rects, lattice);
  // On hexes the way in leaves by the west or east edge, and on Wide by the west alone: the Wide block's east goal lands on an odd row's missing hex (2.3, D-261110-240).
  const sides: readonly Side[] = hex ? (s.wide ? ["w"] : ["w", "e"]) : SIDE_ORDER;
  const entrance = rects.length > 0 ? chooseEntrance(rects, W, H, sides) : { room: -1, side: sides[0]! };
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
  if (entrance.room >= 0) raiseRooms(rng, board, entrance.room, s.heights, grounds);

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
  // On hexes the way in's stair stands on the edge hex whose border side opens off the map: an even row's, so a Wide stub's odd lane ends against a wall (2.3).
  const outward = entrance.side === "w" ? 3 : 0;
  // Only the stub's last position counts on hexes: a stub can run along the edge column on its way, and those hexes keep their outer walls.
  const stubEnd = new Set(stubChain && stubChain.length > 0 ? [0, 1, W, W + 1].slice(0, width === 1 ? 1 : 4).map((o) => stubChain.at(-1)! + o) : []);
  if (stubPath) {
    for (const k of stubPath) {
      const x = k % W;
      const y = (k - x) / W;
      if (hex) {
        if (stubEnd.has(k) && lattice.border(k, outward)) edgeStairs.add(k);
      } else if ((entrance.side === "w" && x === 0) || (entrance.side === "e" && x === W - 1) || (entrance.side === "n" && y === 0) || (entrance.side === "s" && y === H - 1)) edgeStairs.add(k);
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
  // Door pins (phase 3, 4.3, D-261110-238): Closed and Locked replace the drawn door and leave the random secret choice.
  const doorPin = (d: Doorway): DoorPin | undefined => edits?.[d.room]?.doors?.[doorKey(d.link)];
  if (theme.doors) {
    for (const d of doorways) {
      const pin = doorPin(d);
      if (pin === "closed" || pin === "locked") states.set(d.id, pin);
    }
  }

  // Secret doors (5.3), from their own stream, chosen before anything is placed round the doorways.
  let secret: Candidate[] = [];
  const secrets = theme.doors ? secretCount(s.secrets, kept.length) : 0;
  const wayPainted = (k: number) => board.roomAt[k] !== 0 || corridor.has(k);
  // A Secret pin replaces a drawn lock, so its door is judged as if unlocked.
  const candidates = theme.doors ? secretCandidates({ doorways, links, entrance: entrance.room, stub, locked: (d) => doorPin(d) !== "secret" && states.get(d.id) === "locked" }) : [];
  if (secrets > 0) {
    const open = candidates.filter((c) => doorPin(c.doorway) !== "closed" && doorPin(c.doorway) !== "locked");
    secret = chooseSecrets(seedStream(seed, GENERATOR_VERSION, LANE_SECRETS), open, secrets, (set) => stillWhole(board, wayPainted, entrance.room, kept, set));
  }
  // Each Secret pin then applies whatever Secret doors says, where its door may be secret and every room is still reached.
  if (theme.doors && edits) {
    for (const d of doorways) {
      if (doorPin(d) !== "secret" || secret.some((c) => c.doorway === d)) continue;
      const c = candidates.find((q) => q.doorway === d);
      if (d.run) {
        states.set(d.id, "closed");
        report(d.room, REPORTS.secretOnStairs);
      } else if (!c || !stillWhole(board, wayPainted, entrance.room, kept, [...secret, c])) report(d.room, REPORTS.secretBreaksReach);
      else if (secret.length >= MAX_SECRET_DOORS) report(d.room, REPORTS.noRoom("secret door"));
      else secret.push(c);
    }
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

  // On hexes the walls come before the traps, so a Poisoned Needle can name its leaf (2.2).
  const doorState = (d: Doorway): WallDoorway["state"] => (!theme.doors ? "open" : isSecret(d) ? "secret" : states.get(d.id)!);
  const space = new Int32Array(hex ? W * H : 0).fill(NO_SPACE);
  let walled: HexWalls = { walls: [], leaves: [] };
  if (hex) {
    for (const i of kept) {
      const r = board.rooms[i]!;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const k = board.cell(x, y);
          if (inRoom(k) && overlay.get(k) !== "pillar") space[k] = i;
        }
      }
    }
    for (const k of corridor) space[k] = CORRIDOR_SPACE;
    for (const d of doorways) if (d.run) for (const k of [...d.run.near, ...d.run.stairs.map((st) => st.cell), ...d.run.far]) space[k] = RUN_SPACE + d.id;
    walled = hexWalls({
      lattice,
      space,
      doorways: doorways.map((d) => ({ inside: d.inside, outside: d.outside, state: doorState(d) })),
      far: new Set(doorways.flatMap((d) => d.run?.far ?? [])),
      wayIn: [...edgeStairs].map((cell) => ({ cell, dir: outward })),
    });
  }
  // A scene's own keys for a rectangle of lattice cells: the same on Hex rows, mirrored on Hex columns.
  const sceneRect = (r: CellRect): CellRect => (grid === "hexColumns" ? { x: r.y, y: r.x, w: r.h, h: r.w } : r);

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
  const doorIndex = new Map(doorways.map((d, j) => [d.id, j]));
  const trapRooms = kept.filter((i) => i !== entrance.room);
  const reaches = (spot: Spot) => {
    const i = board.roomAt[spot.squares[0]!]! - 1;
    const [z] = "cells" in spot.zone ? spot.zone.cells : [];
    return i >= 0 && z !== undefined && spot.cone !== undefined && statueReaches({ w: W, h: H, ...roomTerrain(i), plate: [z.x, z.y], cone: spot.cone, band: s.band, feetPerCell: ctx.feetPerCell });
  };
  // Edits read every spot a room has, so the spots are found with Traps None too. Finding them draws nothing.
  const spots: Spot[] =
    s.traps === 0 && !edits
      ? []
      : hex
        ? hexTrapSpots({
            board,
            lattice,
            rooms: trapRooms,
            onLine,
            floorFree,
            hitFree: (k) => corridor.has(k) && plainCorridor(k) && !secretMouths.has(k),
            corridor: [...new Set([...builtPaths.flat(), ...spurPaths.flat()])],
            painted,
            wide: s.wide,
            feetPerCell: ctx.feetPerCell,
            rect: sceneRect,
            side: (k, dir) => hexSide(lattice, k, dir),
            needles: doorways.flatMap((d) => {
              if (d.room === entrance.room || doorState(d) !== "locked") return [];
              const leaf = walled.leaves[doorIndex.get(d.id)!]?.[0];
              if (leaf === undefined) return [];
              const { cx, cy } = wallChunk(walled.walls[leaf]!);
              const [i, o] = [d.inside[0]!, d.outside[0]!];
              return [{ leaf, cx, cy, mid: [(i % W) + (o % W) + 1, Math.floor(i / W) + Math.floor(o / W) + 1] as [number, number] }];
            }),
          })
        : trapSpots({
            board,
            rooms: trapRooms,
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
          });
  let picked: PickedTraps = s.traps === 0 ? { traps: [], squares: [], statues: [], stones: [], picks: [] } : pickTraps(rng, spots, trapCount(s.traps, kept.length), hex ? () => false : reaches);

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
  // On hexes a stamp's box keeps to its own room's floor, more than 2 steps from every doorway (2.4, D-261110-178).
  const hexStamps = hex ? new HexStamps(lattice) : null;
  const nearDoor = new Set<number>();
  if (hex) {
    let ring = doorways.flatMap((d) => d.inside);
    for (const k of ring) nearDoor.add(k);
    for (let step = 0; step < STAMP_DOOR_STEPS; step++) {
      ring = ring.flatMap((k) => lattice.halo(k).filter((n) => !nearDoor.has(n)));
      for (const k of ring) nearDoor.add(k);
    }
  }
  const stampHex = (i: number, k: number) => space[k] === i && !nearDoor.has(k) && !overlay.has(k) && !clear.has(k) && !daisSquares.has(k) && k !== pins.get(i) && !used.has(k);
  const lightStream = seedStream(seed, GENERATOR_VERSION, LANE_LIGHTS);
  let lit = hexStamps
    ? placeLightsHex(lightStream, board, kept, litCount(s.lit, kept.length), own, free, theme, (i, stamp) => hexStamps.fits(stamp, (k) => stampHex(i, k)))
    : placeLights(lightStream, board, kept, litCount(s.lit, kept.length), own, free, theme);
  let litStamps = lit.flatMap((l) => (l.stamp ? [l.stamp] : []));
  for (const l of lit) {
    used.add(l.square);
    if (hexStamps && l.stamp) for (const k of hexStamps.touched(l.stamp)) used.add(k);
    if (l.stamp) stampsIn.set(l.room, (stampsIn.get(l.room) ?? 0) + 1);
  }
  const groundAt = (k: number) => daisSquares.get(k) ?? board.rooms[roomOf(k)]?.ground ?? 0;

  // Dressing (5.5), from its own stream after the lights, so Dressing keeps everything before it.
  const dressing = {
    board,
    rooms: kept,
    dressing: s.dressing,
    props: (i: number) => propsFor(s.theme, floors[i]!),
    free,
    held: (i: number) => stampsIn.get(i) ?? 0,
    total: picked.statues.length + litStamps.length,
  };
  const dressStream = seedStream(seed, GENERATOR_VERSION, LANE_DRESSING);
  let props = hexStamps ? furnishHex(dressStream, { ...dressing, stamps: hexStamps, lattice, allowed: stampHex }) : furnish(dressStream, { ...dressing, ground: groundAt });

  // Which room a trap or a spot stands in: a door's room for a Poisoned Needle, else the room of the first square it takes, -1 in the corridors.
  const doorRoom = new Map<string, number>();
  for (const d of doorways) d.inside.forEach((_, j) => doorRoom.set(doorEdgeOf(board, d, j), d.room));
  const leafRoom = new Map<number, number>();
  walled.leaves.forEach((leaves, j) => leaves.forEach((leaf) => leafRoom.set(leaf, doorways[j]!.room)));
  const spotRoom = (sp: Pick<Spot, "zone" | "squares" | "leaf">): number =>
    sp.leaf !== undefined ? (leafRoom.get(sp.leaf) ?? -1) : "door" in sp.zone ? ("edge" in sp.zone.door ? (doorRoom.get(sp.zone.door.edge) ?? -1) : -1) : sp.squares.length > 0 ? roomOf(sp.squares[0]!) : -1;

  // Trap, Lit and Dressing pins reconcile after the whole pipeline, one room at a time in board order, over each room's
  // whole contents, so nothing in any other room moves, and every allowance is checked again after each room (phase 3,
  // 4.3, D-261110-237, 242 and 243).
  if (edits) {
    const allowance = extras.allowance ?? NEW_SCENE;
    const caps = { traps: Math.min(MAX_TRAPS, allowance.traps), stamps: Math.min(MAX_STAMPS, allowance.stamps), lights: Math.min(MAX_LIGHTS, allowance.lights) };
    type TrapEntry = { trap: PlanTrap; squares: number[]; statue: PlanStamp | null; stone: [number, number] | null; spot: Spot };
    let entries: TrapEntry[] = picked.traps.map((trap, ti) => {
      const spot = picked.picks[ti]!;
      return { trap, squares: picked.squares[ti]!, statue: spot.statue ? statueStamp(spot.statue) : null, stone: trap.stone !== undefined ? picked.stones[trap.stone]! : null, spot };
    });
    const lights = [...lit];
    let dressed = [...props];
    const stampCount = () => entries.filter((e) => e.statue).length + lights.filter((l) => l.stamp).length + dressed.length;
    const stampSquares = (stamp: PlanStamp | undefined, square: number) => (hexStamps && stamp ? [square, ...hexStamps.touched(stamp)] : [square]);
    // Floor a reconciled light or prop may take: free of the pipeline's ways, and of every trap and light standing now.
    const takenNow = () => new Set([...entries.flatMap((e) => e.squares), ...lights.flatMap((l) => stampSquares(l.stamp, l.square))]);
    const freeOf = (taken: ReadonlySet<number>) => (i: number, k: number) => own(i, k) && !overlay.has(k) && !clear.has(k) && !inside.has(k) && !openLines.get(i)!.has(k) && k !== pins.get(i) && !taken.has(k);
    const hexAllowed = (taken: ReadonlySet<number>) => (i: number, k: number) => space[k] === i && !nearDoor.has(k) && !overlay.has(k) && !clear.has(k) && !daisSquares.has(k) && k !== pins.get(i) && !taken.has(k);
    /**
     * A Lit pin's light (4.3): at the room's free edge square nearest a
     * corner, corners taken north-west, north-east, south-east, south-west,
     * ties by row then column, with no stream draw. On hexes the nearest
     * free hex where its stamp keeps the stamp rule, else the light alone
     * at the edge hex, as `placeLightsHex` places one.
     */
    const fixedLight = (i: number, taken: ReadonlySet<number>): LitRoom | null => {
      const r = board.rooms[i]!;
      const corners: [number, number][] = [
        [r.x, r.y],
        [r.x + r.w - 1, r.y],
        [r.x + r.w - 1, r.y + r.h - 1],
        [r.x, r.y + r.h - 1],
      ];
      const freeHere = freeOf(taken);
      const size = stampSize(theme.light.stamp) ?? { w: 1, h: 1 };
      const stampAt = (k: number): PlanStamp => {
        const [x, y] = lattice.pointOf(k % W, Math.floor(k / W));
        return { key: theme.light.stamp, x, y, w: size.w, h: size.h, rotation: 0 };
      };
      const edge = (k: number) => lattice.halo(k).length < (hex ? 6 : 4) || lattice.halo(k).some((n) => !own(i, n));
      const first = (pass: (k: number) => boolean): number | null => {
        let best: number | null = null;
        let bestRank: number[] = [];
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const k = board.cell(x, y);
            if (!freeHere(i, k) || !pass(k)) continue;
            const far = corners.map(([cx, cy]) => Math.max(Math.abs(x - cx), Math.abs(y - cy)));
            const d = Math.min(...far);
            const rank = [d, far.indexOf(d), y, x];
            if (best === null || ranksBefore(rank, bestRank)) {
              best = k;
              bestRank = rank;
            }
          }
        }
        return best;
      };
      const pictured = hexStamps ? first((k) => hexStamps.fits(stampAt(k), (q) => hexAllowed(taken)(i, q))) : first(edge);
      const k = pictured ?? (hexStamps ? first(edge) : null);
      if (k === null) return null;
      const stamp = stampAt(k);
      const light: PlanLight = { x: stamp.x, y: stamp.y, preset: theme.light.preset, label: theme.light.label, stamp: theme.light.stamp };
      return pictured !== null ? { room: i, square: k, light, stamp } : { room: i, square: k, light };
    };
    const rooms = Object.keys(edits)
      .map(Number)
      .sort((a, b) => a - b);
    for (const i of rooms) {
      const e = edits[i]!;
      if (!kept.includes(i)) continue;
      if (e.trap !== undefined) {
        const at = entries.findIndex((x) => spotRoom(x.spot) === i);
        const rest = entries.filter((x) => spotRoom(x.spot) !== i);
        const place = (entry: TrapEntry) => {
          const next = [...rest];
          next.splice(at >= 0 ? at : next.length, 0, entry);
          return next;
        };
        if (e.trap === null) entries = rest;
        else {
          const kind = presetKind(e.trap);
          const taken = new Set(rest.flatMap((x) => x.squares));
          const off = new Set([...lights.filter((l) => l.room === i).flatMap((l) => stampSquares(l.stamp, l.square)), ...dressed.filter((f) => f.room === i).flatMap((f) => f.squares)]);
          const spot = spots.find(
            (sp) => sp.kind === kind && spotRoom(sp) === i && rest.every((x) => spotsApart(x.spot, sp)) && !sp.squares.some((k) => taken.has(k) || off.has(k)) && (sp.kind !== "statue" || reaches(sp)),
          );
          if (!spot) {
            entries = rest;
            report(i, REPORTS.noTrapSpot);
          } else {
            const entry: TrapEntry = { trap: trapAt(spot, e.trap), squares: spot.squares, statue: spot.statue ? statueStamp(spot.statue) : null, stone: null, spot };
            const next = place(entry);
            const statues = (list: TrapEntry[]) => list.filter((x) => x.statue).length;
            if (next.length > caps.traps) report(i, REPORTS.noRoom("trap"));
            else if (stampCount() - statues(entries) + statues(next) > caps.stamps) report(i, REPORTS.noRoom("stamp"));
            else entries = next;
          }
        }
      }
      if (e.lit !== undefined) {
        const was = lights.findIndex((l) => l.room === i);
        if (!e.lit && was >= 0) lights.splice(was, 1);
        else if (e.lit && was < 0) {
          const spot = fixedLight(i, takenNow());
          if (!spot || lights.length + 1 > caps.lights) report(i, REPORTS.noRoom("light"));
          else if (spot.stamp && stampCount() + 1 > caps.stamps) report(i, REPORTS.noRoom("stamp"));
          else {
            lights.push(spot);
            // A pinned light that lands on one of its room's props takes that prop's place.
            const under = new Set(stampSquares(spot.stamp, spot.square));
            dressed = dressed.filter((f) => f.room !== i || !f.squares.some((k) => under.has(k)));
          }
        }
      }
      if (e.dressing !== undefined || e.propsDraw !== undefined) {
        const level = e.dressing ?? s.dressing;
        const others = dressed.filter((f) => f.room !== i);
        const held = entries.filter((x) => x.statue && spotRoom(x.spot) === i).length + lights.filter((l) => l.room === i && l.stamp).length;
        const left = caps.stamps - (stampCount() - (dressed.length - others.length));
        const taken = new Set([...takenNow(), ...others.flatMap((f) => f.squares)]);
        const stream = seedStream(seed, GENERATOR_VERSION, LANE_ROOM_PROPS + 16 * i + ((e.propsDraw ?? 0) % 16));
        // The dungeon's stamp total stands in for what is left, so the room's draws stop at the allowance.
        const base = { board, rooms: [i], dressing: level, props: (r: number) => propsFor(s.theme, floors[r]!), free: freeOf(taken), held: () => held, total: MAX_STAMPS - Math.max(0, left) };
        const fresh = hexStamps ? furnishHex(stream, { ...base, stamps: hexStamps, lattice, allowed: hexAllowed(taken) }) : furnish(stream, { ...base, ground: groundAt });
        if (left <= 0 && level !== "none") report(i, REPORTS.noRoom("stamp"));
        else dressed = [...others, ...fresh].sort((a, b) => kept.indexOf(a.room) - kept.indexOf(b.room));
      }
    }
    const stones: [number, number][] = [];
    const traps = entries.map((x) => {
      const { stone: _old, ...trap } = x.trap;
      if (!x.stone) return trap;
      stones.push(x.stone);
      return { ...trap, stone: stones.length - 1 };
    });
    picked = { traps, squares: entries.map((x) => x.squares), statues: entries.flatMap((x) => (x.statue ? [x.statue] : [])), stones, picks: entries.map((x) => x.spot) };
    lit = lights;
    litStamps = lit.flatMap((l) => (l.stamp ? [l.stamp] : []));
    props = dressed;
  }

  // The key (5.6), from its own stream, last: DM key moves nothing before it.
  const roomTraps = new Map<number, string[]>();
  const inRoomTrap = new Set<number>();
  picked.traps.forEach((t, ti) => {
    const z = t.zone;
    // On hexes a zone is in the scene's keys, mirrored on Hex columns, so the room is read from the lattice squares the trap took.
    const i =
      t.leaf !== undefined
        ? (leafRoom.get(t.leaf) ?? -1)
        : "door" in z
          ? "edge" in z.door
            ? (doorRoom.get(z.door.edge) ?? -1)
            : -1
          : "cells" in z
            ? hex
              ? roomOf(picked.squares[ti]![0]!)
              : roomOf(board.cell(z.cells[0]!.x, z.cells[0]!.y))
            : -1;
    if (i >= 0) {
      roomTraps.set(i, [...(roomTraps.get(i) ?? []), trapPreset(t.preset, s.band)?.name ?? t.preset]);
      inRoomTrap.add(ti);
    }
  });
  const inCorridors = s.key
    ? corridorTraps({
        traps: picked.traps.map((t, ti) => ({ name: trapPreset(t.preset, s.band)?.name ?? t.preset, squares: picked.squares[ti] ?? [], inRoom: inRoomTrap.has(ti) })),
        links,
        paths,
        stubPath,
        entrance: entrance.room,
        spurPaths,
        numbers: numberRooms(links, kept, entrance.room),
      })
    : [];
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

  // What the pins left undone that no step above saw: a room or door gone, a height with no room for its stairs.
  if (edits) {
    for (const [index, e] of Object.entries(edits)) {
      const i = Number(index);
      if (!kept.includes(i)) {
        report(i, REPORTS.roomGone);
        continue;
      }
      if (e.ground !== undefined && e.ground !== 0 && board.rooms[i]!.ground === 0) report(i, REPORTS.flat);
      const keys = new Set(doorways.filter((d) => d.room === i).map((d) => doorKey(d.link)));
      for (const key of Object.keys(e.doors ?? {})) if (!keys.has(key)) report(i, REPORTS.doorGone);
    }
  }
  // The room panel's facts (4.1), numbered as the key numbers rooms, whatever DM key says.
  const numbers = numberRooms(links, kept, entrance.room);
  const mayBeSecret = theme.doors ? secretCandidates({ doorways, links, entrance: entrance.room, stub, locked: () => false }) : [];
  const ROOM_PRESETS: Readonly<Record<string, readonly string[]>> = { pit: [HIDDEN_PIT, SPIKED_PIT], needle: [POISONED_NEEDLE], statue: [FIRE_STATUE] };
  const facts: RoomFacts[] = kept
    .map((i): RoomFacts => {
      const kinds = new Set(spots.filter((sp) => spotRoom(sp) === i).map((sp) => sp.kind));
      const held = picked.traps.filter((_, ti) => spotRoom(picked.picks[ti]!) === i);
      return {
        n: numbers.get(i) ?? 0,
        room: i,
        ground: board.rooms[i]!.ground,
        doors: doorways
          .filter((d) => d.room === i)
          .sort((a, b) => "nesw".indexOf(a.side) - "nesw".indexOf(b.side) || a.at - b.at)
          .map((d) => {
            const link = d.link >= 0 ? links[d.link]! : null;
            const other = link ? (link.a === i ? link.b : link.a) : -1;
            return {
              key: doorKey(d.link),
              side: d.side,
              to: other >= 0 ? (numbers.get(other) ?? "edge") : "edge",
              state: !theme.doors ? "open" : isSecret(d) ? "secret" : states.get(d.id)!,
              secretOk: !theme.doors ? SECRET_OFF.cave : d.run ? SECRET_OFF.stairs : mayBeSecret.some((c) => c.doorway === d) ? null : SECRET_OFF.notCandidate,
            };
          }),
        traps: ["pit", "needle", "statue"].flatMap((k) => (kinds.has(k as Spot["kind"]) ? ROOM_PRESETS[k]! : [])),
        trap: held[0]?.preset ?? null,
        dressing: edits?.[i]?.dressing ?? s.dressing,
        lit: lit.some((l) => l.room === i),
        reports: reports.get(i) ?? [],
      };
    })
    .sort((a, b) => a.n - b.n);

  // The plan. On hexes nothing is painted: the walls show the rooms (D-261110-160).
  const terrain = new Map<number, TerrainId>();
  if (!hex) {
    for (const i of kept) {
      const r = board.rooms[i]!;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inRoom(board.cell(x, y))) terrain.set(board.cell(x, y), floors[i]!);
    }
    for (const k of corridor) terrain.set(k, theme.corridor);
    for (const [k, t] of overlay) if (terrain.has(k)) terrain.set(k, t);
  }
  // A cell that is floor: on hexes a pillar is a walled hex, so it holds no ground.
  const isFloor = (k: number) => (hex ? space[k] !== NO_SPACE : inRoom(k));

  const ground = new Map<number, number>();
  for (const i of kept) {
    const r = board.rooms[i]!;
    if (r.ground !== 0) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isFloor(board.cell(x, y))) ground.set(board.cell(x, y), r.ground);
  }
  for (const [k, ft] of daisSquares) ground.set(k, ft);
  // On hexes a pit or a shaft is its hexes sunk 10 ft below the room's floor (2.4).
  if (hex) for (const [k, t] of overlay) if (t === "pit" && board.roomAt[k] !== 0) ground.set(k, board.rooms[board.roomAt[k]! - 1]!.ground - PIT_DROP);
  const ups = new Map<number, StairDirection>();
  for (const d of doorways) {
    if (!d.run) continue;
    for (const k of d.run.near) ground.set(k, d.run.ground);
    for (const st of d.run.stairs) {
      ground.set(st.cell, st.ground);
      ups.set(st.cell, st.up);
    }
  }
  // On hexes a dais's stair faces the dais hex it touches (2.3), and the way in's stair faces off the map along its row.
  for (const dais of daises.values()) ups.set(dais.stair, hex ? (String(directionTo(lattice, dais.stair, dais.top)) as StairDirection) : dais.up);
  for (const k of edgeStairs) ups.set(k, hex ? (String(outward) as StairDirection) : entrance.side);

  const key = (k: number) => (hex ? lattice.keyOf(k) : `${k % W},${Math.floor(k / W)}`);
  const grouped = <V extends string | number>(m: Map<number, V>, order: (a: V, b: V) => number) => {
    const by = new Map<V, number[]>();
    for (const [k, v] of m) by.set(v, [...(by.get(v) ?? []), k]);
    return [...by.entries()].sort((a, b) => order(a[0], b[0])).map(([v, cells]) => ({ v, cells: cells.sort((a, b) => a - b).map(key) }));
  };
  const paint: Partial<Record<TerrainId, string[]>> = {};
  for (const { v, cells } of grouped(terrain, (a, b) => (a < b ? -1 : a > b ? 1 : 0))) paint[v] = cells;
  const DIR_ORDER = "nesw012345";
  const xy = (k: number): [number, number] => [k % W, Math.floor(k / W)];
  const plan: DungeonPlan = {
    version: GENERATOR_VERSION,
    theme: s.theme,
    w: s.w,
    h: s.h,
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
    doors: theme.doors && !hex ? doorways.flatMap((d) => d.inside.map((_, j) => ({ edge: doorEdgeOf(board, d, j), state: isSecret(d) ? ("secret" as const) : states.get(d.id)! }))) : [],
    heights: grouped(
      new Map([...ground].filter(([, ft]) => ft !== 0)),
      (a, b) => a - b,
    ).map(({ v, cells }) => ({ ft: v, cells })),
    stairs: grouped(ups, (a, b) => DIR_ORDER.indexOf(a) - DIR_ORDER.indexOf(b)).map(({ v, cells }) => ({ up: v, cells })),
    stamps: [...picked.statues, ...litStamps, ...props.map((f) => f.stamp)],
    lights: lit.map((l) => l.light),
    stones: picked.stones,
    traps: picked.traps,
    entrance: entrance.room >= 0 ? { x: rects[entrance.room]!.x, y: rects[entrance.room]!.y, w: rects[entrance.room]!.w, h: rects[entrance.room]!.h } : { x: 0, y: 0, w: 0, h: 0 },
    key: keyed,
    ...(inCorridors.length > 0 ? { corridorTraps: inCorridors } : {}),
    ...(hex
      ? {
          grid,
          walls: walled.walls,
          rough: [...overlay].flatMap(([k, t]) => (t === "rubble" || t === "water") && isFloor(k) ? [k] : []).sort((a, b) => a - b).map(key),
        }
      : {}),
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
    fitted,
    lattice,
    space,
    leaves: walled.leaves,
    facts,
    reports,
    overBudget: null,
  };
}

/** Whether one rank comes before another, compared element by element. */
function ranksBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return a[j]! < b[j]!;
  return false;
}

function doorEdgeOf(board: Board, d: Doorway, j: number): string {
  const k = d.inside[j]!;
  return doorEdge(k % board.W, Math.floor(k / board.W), d.side);
}
