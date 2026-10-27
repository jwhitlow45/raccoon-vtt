import { sightOf, viewMapsOf } from "#shared/keys.ts";
import type { Actor, PathStop, RoomState, Token, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { DiagonalCounter, DistanceSettings } from "#shared/rules/distance.ts";
import { footprintSize } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { isPreview, offKey, previewChunks, type Walker } from "#shared/rules/movement.ts";
import { pathThisTurn, publicCounters } from "#shared/rules/path.ts";
import { routeWalkers } from "#shared/rules/route.ts";
import { LegCheck, WalkSearch, WalkWorld, WorkBudget, worldUnits } from "#shared/rules/walk.ts";
import { groupWalkWorld, publicToken, seenWhereMoved, type WalkViewer } from "#shared/rules/walkWorld.ts";
import { cutForWalkers, dropMode, dropView, keyStep, moveOpsOf, planWalk, routeTarget, walkerOf, walkStart, type DropPlan, type DropView, type Found } from "../movement/drop.ts";
import { dragLead } from "../attach/groups.ts";
import { towingWord, walkersFor } from "../attach/walk.ts";
import type { RouteJob } from "../movement/routeWork.ts";
import { dragReading, extraWords, joinWords } from "./movement.ts";
import { formatFeet, tokenStop, type Point, type RulerStop } from "./ruler.ts";

/**
 * The ruler's walking mode (docs/design-v1-movement.md 3.3), kept free of
 * React and Konva so it is tested under plain Node: the walk through every
 * stop for one creature, the token the ruler starts on, or a Medium
 * creature on the ground when it starts on empty ground. Each later stop is
 * where that creature would stand if dragged there, and each leg is that
 * drag, worked out by the board's own drag code (planStep) in the room the
 * legs before it leave, with the 5-10-5 count running on across the stops:
 * searched from the counters of the stops its legs leave, as a drag's
 * search reads a turn's stops (walkWorld.ts publicCounters), and read by
 * the true count, as the reducer stores a leg. The stops are the ones the
 * reducer records on the room it simulates, with who saw each leg, while
 * the creature's turn is under way, else each leg seen whole.
 *
 * A ruler has no turn, so it leaves out other creatures' spaces, which will
 * move before anyone walks there, Speed changes, crawling and a dismount's
 * half Speed. It counts walls, doors, ledges, terrain, marks, the areas
 * that cost and the extra foot for what the creature tows. A shared or kept
 * walking ruler searches in the public world on every device and walks as a
 * player's drag does, so all read the same walk. Only the DM's own ruler,
 * before it is shared, may use everything the DM knows, and walks as the
 * DM's drop does.
 */

/** One leg as drawn: from where the walker stood to where its drag would leave it, through its route's corners, top-left as tokens are, and what it costs. No route: drawn as the drop goes, held at a wall or straight through, "No way through". Still searching: drawn straight to its stop, its cost unknown. */
export type WalkLeg = { from: Point; to: Point; corners: Point[]; ft: number; none: boolean; searching?: true };

export type WalkMeasure = {
  legs: WalkLeg[];
  totalFt: number;
  /** "+10 ft for difficult terrain", when terrain added any. */
  extra: string | null;
  /** The walker's footprint in cells, for drawing the legs between footprint centers. */
  size: { w: number; h: number };
  /** A leg's search ran out of its time slice: the walk is not known yet, and is asked for again next frame. */
  searching: boolean;
};

/** The creature a walking ruler walks: the token its first stop is on, or a Medium creature standing on the ground there. */
function walkerAt(view: RoomState, sceneId: string, first: RulerStop): Token | null {
  const on = first.tokenId ? view.tokens[first.tokenId] : undefined;
  if (on) return on;
  const x = Math.floor(first.x);
  const y = Math.floor(first.y);
  const stand = { sceneId, size: "medium" as const, x, y, elevation: 0 };
  const elevation = first.z ?? footprintGround(view.buildChunks, stand);
  return { id: "", rev: 0, kind: "pc", name: "", nameHidden: false, rotation: 0, disposition: "ally", visibility: "all", fogExempt: false, fogExemptAuto: false, locked: false, layer: "token", ownerIds: [], hpVisibility: "hidden", actor: { inline: NO_ACTOR }, ...stand, elevation } as Token;
}

const NO_ACTOR: Actor = { hp: { cur: 1, max: 1, temp: 0 }, life: "alive", ac: 10, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

/**
 * The parts of the room a ruler's walk reads (publicWorld, walkerAt). While each is the same object, the walks and searches kept for it still hold.
 * Who players see reads the sight a copy holds, and on a per-player scene the shared sight and fog
 * (docs/design-v1-per-player-vision.md 6.6), so a light or a holder's change that moves only those still walks the ruler again.
 */
type Basis = Pick<RoomState, "buildChunks" | "templates" | "tokens" | "fogTiles" | "exploredTiles" | "meta" | "members" | "characters"> & { scene: unknown; sight: unknown; sightAll: unknown; fogAll: unknown };

function basisOf(view: RoomState, sceneId: string): Basis {
  const { buildChunks, templates, tokens, fogTiles, exploredTiles, meta, members, characters } = view;
  const { sightAll, fogAll } = viewMapsOf(view);
  return { buildChunks, templates, tokens, fogTiles, exploredTiles, meta, members, characters, scene: view.scenes[sceneId], sight: sightOf(view), sightAll, fogAll };
}

function sameBasis(a: Basis, b: Basis): boolean {
  return (Object.keys(a) as (keyof Basis)[]).every((k) => a[k] === b[k]);
}

/*
 * Kept for the room as the walks read it, and dropped when a part of it
 * changes (as a drag's world is, stageHooks.ts), never for an op that
 * leaves those parts alone, such as a chat line or a die roll:
 * - searches for the legs of the rulers drawn, one per leg start, world and
 *   5-10-5 residue, so a stop dragged around reuses the search of its leg,
 *   as a drag's search serves every spot the finger visits, and two rulers
 *   from one spot share one. A later leg's world is the room the legs
 *   before it leave (simulated), so its search and its answer are kept by
 *   those legs too, which alone make that room from this one
 *   (reviews AT-ASTRA-26 and AT-SOL-6).
 * - Each leg worked out, by those legs and its stop, with the room it
 *   leaves, so a ruler whose last stop moves plans and simulates only that
 *   leg again (review AT-O-33).
 * - Each ruler's progress, by its stops and viewer: its legs answered and
 *   the search of the leg it is on. The shared caches above may let either
 *   go for room, but a ruler's own progress goes only with the ruler, so
 *   no number of rulers searching at once can undo each other's progress
 *   (review ASTRA-12).
 * - Each ruler's finished walk, by its stops and viewer, so a kept ruler
 *   is not walked again for every op.
 */
const MAX_SEARCHES = 32;
const MAX_LEGS = 4096;
/** Finished legs kept by the room they start in, each holding the room it leaves, so fewer than the answers. */
const MAX_STEPS = 512;
/** What simulating and planning a leg charges to the frame's budget: enough that the budget's clock is read after it. */
const STEP_UNITS = 16;

/** A ruler's walk so far: its legs worked out, and the search and open-ground check of the leg still searching. */
type Progress = { steps: Step[]; on: { leg: string; search: WalkSearch; check: LegCheck } | null };

/**
 * Where a ruler's walk stands before a leg: the room as the legs before it
 * leave it (`sim`, with who players see there, `seen`), the walker there,
 * the stops those legs leave as a turn's path holds them (stopLeft), the
 * true 5-10-5 count they ran up, and `history`, those legs by what each
 * planned, which with the view alone make `sim`.
 */
type Walked = { sim: RoomState; seen: DropView; walker: Token; left: PathStop[]; counter: DiagonalCounter; history: string };

/** A leg worked out: as drawn and read, what it adds to the walk's extra words, and where it leaves the walk. */
type Step = { key: string; leg: WalkLeg; words: string[]; extraFt: number; after: Walked };

type Kept = {
  basis: Basis;
  searches: Map<string, WalkSearch>;
  legs: Map<string, Found>;
  steps: Map<string, Step>;
  /** The tokens players do not see where this view stands, by viewer role (unseenAtStart). */
  unseen: Map<string, ReadonlySet<string>>;
  progress: WeakMap<readonly RulerStop[], Map<string, Progress>>;
  walks: WeakMap<readonly RulerStop[], Map<string, WalkMeasure>>;
};

let kept: Kept | null = null;

function keptFor(view: RoomState, sceneId: string): Kept {
  const basis = basisOf(view, sceneId);
  if (!kept || !sameBasis(kept.basis, basis)) kept = { basis, searches: new Map(), legs: new Map(), steps: new Map(), unseen: new Map(), progress: new WeakMap(), walks: new WeakMap() };
  return kept;
}

function searchKey(walker: Token, everything: boolean, counter: DiagonalCounter): string {
  return `${walker.id},${walker.size},${walker.w},${walker.h},${walker.x},${walker.y},${walker.elevation},${walker.squeeze === true},${(walker as { footing?: string }).footing ?? ""},${offKey(walker)},${counter.h},${counter.v},${everything}`;
}

/**
 * A leg start's search in the world a drag of the walker would search
 * (press.ts worldFor): its group's, with the extra foot while it drags or
 * carries a creature, built from the room the legs before it leave, and
 * without other creatures' spaces (3.3). Made when first asked for, its
 * world's build charged to the frame's budget as one step that cannot stop
 * partway (review MV-O-23). Over the cap the one asked for longest ago
 * goes: a ruler still searching holds its own (Progress).
 */
function searchFor(view: RoomState, at: Walked, walker: Token & Walker, input: WalkInput, key: string, budget: WorkBudget): WalkSearch {
  const kept = keptFor(view, walker.sceneId);
  let search = kept.searches.get(key);
  if (search) kept.searches.delete(key);
  else {
    // Who players see of the tokens the legs before moved, by where those legs left them, on every copy alike.
    const moved = new Set(Object.keys(at.sim.tokens).filter((id) => !samePose(at.sim.tokens[id], view.tokens[id])));
    // A shared or kept ruler keeps to the ground every player shares, never this player's own memory (docs/design-v1-per-player-vision.md 6.6).
    const world = groupWalkWorld(at.sim, walker, input.viewer, at.left, ownRuler(input) ? { creatures: false, everything: true, moved } : { creatures: false, seenGround: true, sharedGround: true, moved, unseen: unseenAtStart(view, input) });
    search = new WalkSearch(new WalkWorld({ ...world.input, prone: false }));
    budget.charge(worldUnits(search.world) + Math.ceil((search.world.nx * search.world.ny) / 400));
    if (kept.searches.size >= MAX_SEARCHES) kept.searches.delete(kept.searches.keys().next().value!);
  }
  kept.searches.set(key, search);
  return search;
}

/**
 * What a leg's search found, as a drag's search finds it (routeDrag.ts):
 * the straight leg on open ground, else the route, or none. Worked on the
 * frame's budget: null while it is still searching. Once the budget is
 * spent no leg begins, and none gets an allowance of its own: the frame's
 * work (routeWork.ts) gives the frame's first work its bit of progress,
 * once a frame (review ASTRA-14). Kept by the legs before it, its start,
 * 5-10-5 residue and spot, so a ruler of many legs needs a leg's search
 * only while that leg is searched (review ASTRA-07).
 */
function legFound(view: RoomState, at: Walked, walker: Token & Walker, input: WalkInput, target: Point, budget: WorkBudget, progress: Progress): { found: Found; search: () => WalkSearch } | null {
  const kept = keptFor(view, walker.sceneId);
  const key = `${at.history}#${searchKey(walker, input.everything, publicCounters(SQUARES, walker, at.left, rulesOf(view), input.viewer.role === "dm"))}`;
  const legKey = `${key}|${target.x},${target.y}`;
  const searchOf = () => searchFor(view, at, walker, input, key, budget);
  const known = kept.legs.get(legKey);
  if (known) return { found: known, search: searchOf };
  if (budget.spent) return null;
  const own = progress.on?.leg === legKey ? progress.on : null;
  const search = own ? own.search : searchOf();
  const check = own ? own.check : new LegCheck(search.world, target);
  const late = (units = 1) => {
    budget.charge(units);
    return budget.spent;
  };
  let found: Found;
  // The open-ground check, the search and its trace all share the budget: a ruler's frame never runs past it.
  if (!check.done && !check.run(late)) {
    progress.on = { leg: legKey, search, check };
    return null;
  }
  if (check.open) found = { kind: "open" };
  else {
    const settled = search.settle(target, budget);
    const traced = settled === "settled" ? search.traceTo(target, budget) : null;
    if (settled === "paused" || traced === "paused") {
      progress.on = { leg: legKey, search, check };
      return null;
    }
    found = traced ? { kind: "route", route: { pieces: traced.pieces } } : { kind: "none", capped: settled === "capped" };
  }
  progress.on = null;
  if (kept.legs.size >= MAX_LEGS) kept.legs.delete(kept.legs.keys().next().value!);
  kept.legs.set(legKey, found);
  return { found, search: () => search };
}

/**
 * Whether this is the DM's own ruler, before it is shared: it reads
 * everything the DM knows and walks as the DM's drop does, through walls.
 * Every other ruler, shared or kept, reads the public world and walks as a
 * player's drag does on every device, the DM's included: on ground players
 * have seen, held at a wall and cut where a creature it drags is stopped,
 * so all read the same walk (3.3).
 */
function ownRuler(input: WalkInput): boolean {
  return input.everything && input.viewer.role === "dm";
}

/**
 * The tokens players do not see where a shared ruler starts, by the rule
 * a drag's world reads (walkWorld.ts publicToken), kept for the view: on
 * the DM's device none of them is seen by any leg, as a player's copy,
 * which never held them, sees none (review AT-SOL-6).
 */
function unseenAtStart(view: RoomState, input: WalkInput): ReadonlySet<string> {
  const room = keptFor(view, input.sceneId);
  const role = input.viewer.role;
  let unseen = room.unseen.get(role);
  if (!unseen) {
    unseen = new Set(Object.values(view.tokens).flatMap((t) => (t && !publicToken(view, t, input.viewer) ? [t.id] : [])));
    room.unseen.set(role, unseen);
  }
  return unseen;
}

/**
 * The token a drag from `token` moves (groups.ts dragLead): the mount of a
 * rider of a controlled mount, or the holder of a token that covers it, up
 * the chain. Read by the links this ruler's world holds: every one for the
 * DM's own ruler, else only those every player sees, so a shared ruler
 * walks the same creature on every copy.
 */
function rulerLead(view: RoomState, input: WalkInput, token: Token): Token {
  if (!token.attached) return token;
  let tokens = view.tokens;
  if (!ownRuler(input)) {
    const seen = dropView(view, input.viewer.role).seen;
    if (!seen(token)) return token;
    tokens = Object.fromEntries(Object.entries(view.tokens).filter(([, t]) => t !== undefined && seen(t)));
  }
  return view.tokens[dragLead(tokens, token).id] ?? token;
}

/** A leg of the lead's walk as the ruler draws it, from the place of the token it starts on. */
function shiftLeg(leg: WalkLeg, by: Point): WalkLeg {
  const back = (p: Point) => ({ x: p.x - by.x, y: p.y - by.y });
  return { ...leg, from: back(leg.from), to: back(leg.to), corners: leg.corners.map(back) };
}

function rulesOf(view: RoomState): DistanceSettings {
  return { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal };
}

export type WalkInput = { view: RoomState; sceneId: string; stops: readonly RulerStop[]; viewer: WalkViewer; everything: boolean };

/**
 * The walk a walking ruler measures. `everything` is the DM's own ruler
 * before it is shared, and only then may the search read what players
 * cannot see. With a `budget`, the frame's (routeWork.ts), work stops
 * when it is spent, as a drag's does a frame at a time, and the walk
 * comes back `searching`: asked again, it goes on where it stopped. A
 * spent budget reads only what is known. A `deadline` (a
 * `performance.now()` time) is a budget of the caller's own, for tests and
 * the bench. With neither, the walk is measured to the end.
 */
export function measureWalk(input: WalkInput & { deadline?: number; budget?: WorkBudget }): WalkMeasure | null {
  const { stops } = input;
  const view = rulerRoom(input.view);
  const budget = input.budget ?? (input.deadline !== undefined ? WorkBudget.until(input.deadline) : WorkBudget.all());
  const room = keptFor(view, input.sceneId);
  const memo = room.walks;
  const memoKey = `${input.sceneId},${input.viewer.role},${input.everything}`;
  const known = memo.get(stops)?.get(memoKey);
  if (known) return known;
  const byRuler = room.progress.get(stops) ?? new Map<string, Progress>();
  room.progress.set(stops, byRuler);
  const progress = byRuler.get(memoKey) ?? { steps: [], on: null };
  byRuler.set(memoKey, progress);
  const first = stops[0];
  const anchor = first ? walkerAt(view, input.sceneId, first) : null;
  if (!anchor || stops.length < 2) return null;
  const size = footprintSize(anchor);
  // A drag from a rider of a controlled mount moves the mount (attach 4.2), so the legs walk the mount, offset by where the
  // rider sits on it, and are drawn from the rider's place.
  const start = rulerLead(view, input, anchor);
  const shift = { x: start.x - anchor.x, y: start.y - anchor.y };
  // The room as the legs so far leave it, each planned as the board plans a drag and applied by the room's own reducer
  // (planStep), so a later leg walks, lands and is seen as the token would after them (reviews AT-SOL-1, AT-SOL-3,
  // AT-ASTRA-25, AT-SOL-5 and AT-ASTRA-26).
  const sim: RoomState = view.tokens[start.id] ? view : { ...view, tokens: { ...view.tokens, [start.id]: start } };
  let at: Walked = { sim, seen: dropView(sim, input.viewer.role), walker: start, left: [{ x: start.x, y: start.y, elevation: start.elevation, seen: true }], counter: { h: 0, v: 0 }, history: `${start.id},${start.size},${start.w},${start.h},${start.x},${start.y},${start.elevation},${start.squeeze === true}` };
  const legs: WalkLeg[] = [];
  const words = new Set<string>();
  let totalFt = 0;
  let extraFt = 0;
  // Past a leg still searching, the legs are drawn straight between their stops, never searched or simulated until it is known: they would only push its search out.
  let waiting: Point | null = null;
  for (const [k, drawn] of stops.slice(1).entries()) {
    // A stop on a token is where that token stands now, as the straight ruler reads it. One this view cannot resolve stays where it was drawn.
    const on = drawn.tokenId ? view.tokens[drawn.tokenId] : undefined;
    // A walk is phase H2's on hexes, so a walking ruler reads squares: the ruler's row turns Walking off on a hex scene.
    const stop = on ? tokenStop(SQUARES, on) : drawn;
    const raw = { x: stop.x - size.w / 2 + shift.x, y: stop.y - size.h / 2 + shift.y };
    if (waiting) {
      legs.push({ from: waiting, to: raw, corners: [], ft: 0, none: false, searching: true });
      waiting = raw;
      continue;
    }
    const target = routeTarget(at.seen, at.walker, raw);
    const key = `${memoKey}${at.history}|${target.x},${target.y},${target.squeeze}`;
    const step = (progress.steps[k]?.key === key ? progress.steps[k] : undefined) ?? room.steps.get(key) ?? planStep(view, input, at, raw, target, key, budget, progress);
    if (!step) {
      legs.push({ from: { x: at.walker.x, y: at.walker.y }, to: { x: target.x, y: target.y }, corners: [], ft: 0, none: false, searching: true });
      waiting = { x: target.x, y: target.y };
      continue;
    }
    progress.steps[k] = step;
    if (!room.steps.has(key)) {
      if (room.steps.size >= MAX_STEPS) room.steps.delete(room.steps.keys().next().value!);
      room.steps.set(key, step);
    }
    legs.push(step.leg);
    totalFt += step.leg.ft;
    extraFt += step.extraFt;
    for (const w of step.words) words.add(w);
    at = step.after;
  }
  const searching = waiting !== null;
  const named = ["difficult terrain", "overgrowth", "swimming", "crawling", "dragging", "carrying"].filter((w) => words.has(w));
  const shown = shift.x === 0 && shift.y === 0 ? legs : legs.map((leg) => shiftLeg(leg, shift));
  const walk: WalkMeasure = { legs: shown, totalFt, extra: extraFt > 0 && named.length > 0 ? `+${formatFeet(extraFt)} for ${joinWords(named)}` : null, size, searching };
  if (!searching) {
    const byViewer = memo.get(stops) ?? new Map<string, WalkMeasure>();
    byViewer.set(memoKey, walk);
    memo.set(stops, byViewer);
  }
  return walk;
}

/**
 * One leg, worked out as the board works out a drag to its stop (press.ts
 * worldFor, stageHooks.ts dragStops): searched in the drag's world, planned
 * by the drop's own planner (drop.ts planWalk, with its straight leg's own
 * route and its cut where a creature the walker drags meets a wall), read
 * by the drag's own label (movement.ts dragReading) with the 5-10-5 count
 * running on from the legs before, and applied by the room's own reducer to
 * give the next leg its room. A ruler has no turn (3.3), so the reading
 * takes no dismount's half Speed, no Speed and no crawling. Null while the
 * leg is still searching. Its simulation and planning are charged to the
 * frame's budget (review AT-O-33).
 */
function planStep(view: RoomState, input: WalkInput, at: Walked, raw: Point, target: Point & { squeeze: boolean }, key: string, budget: WorkBudget, progress: Progress): Step | null {
  // Once the frame's budget is spent no leg begins, its search, planning and simulation alike.
  if (budget.spent) return null;
  const role = input.viewer.role;
  const walking: Token & Walker = walkerOf(at.seen, at.walker);
  const answer = legFound(view, at, walking, input, target, budget, progress);
  if (!answer) return null;
  budget.charge(STEP_UNITS);
  const rules = rulesOf(view);
  const token = at.seen.tokens[at.walker.id] ?? at.walker;
  const mode = dropMode(ownRuler(input) ? "dm" : "player", at.sim.scenes[token.sceneId]);
  const account = (to: Point) => {
    const own = new WalkWorld(answer.search().world.input);
    budget.charge(worldUnits(own));
    return keyStep(own, to, (units) => budget.charge(units));
  };
  const plan = cutForWalkers(at.seen, token, planWalk(at.seen, token, raw, mode, answer.found, rules.feetPerCell, account), walkersFor(at.seen, token.id, role, undefined, at.seen.seen), mode);
  const move = plan.moves.find((m) => m.tokenId === token.id);
  const from = { x: at.walker.x, y: at.walker.y };
  const elevation = move?.elevation ?? token.elevation;
  const route = move?.route;
  // Read as the move counts it, from its seat when it keeps it (drop.ts walkerOf).
  const reading: Token & Walker = move ? walkerOf(at.seen, at.walker, move) : walking;
  const trace = move ? routeWalkers(at.sim.buildChunks, reading, route ?? [[move.x, move.y, 0, 0]], elevation) : null;
  const towing = answer.search().world.input.drag === 1 ? towingWord(at.sim, token.id, role, at.seen.seen) : undefined;
  const read =
    move && trace
      ? dragReading({
          token: walkStart(at.sim, reading),
          // A walk is phase H2's on hexes: the walking ruler reads squares, and is off on a hex scene.
          grid: SQUARES,
          to: { x: move.x, y: move.y },
          encounter: null,
          activeTokenId: null,
          speeds: undefined,
          rules,
          role,
          walk: { route: route ? { points: trace.map(({ x, y, elevation }) => ({ x, y, elevation })), pieces: route } : null, build: at.sim, trace, halved: () => null, prone: false, ...(towing ? { towing } : {}) },
          ...(route ? {} : { landing: { elevation, ...(move.squeeze ? { squeeze: true as const } : {}) } }),
          counter: at.counter,
        })
      : null;
  const corners = trace ? trace.slice(1, -1).map(({ x, y }) => ({ x, y })) : [];
  const next = simulated(view, at.sim, role, token, plan, ownRuler(input) ? undefined : unseenAtStart(view, input));
  const left = [...at.left];
  if (move) left.push(stopLeft(next.sim, token.id, left, { x: move.x, y: move.y, elevation, ...(corners.length > 0 ? { via: corners.flatMap((c) => [c.x, c.y]) } : {}) }));
  const counter = read ? { h: at.counter.h + read.diag[0], v: at.counter.v + read.diag[1] } : at.counter;
  return {
    key,
    leg: { from, to: move ? { x: move.x, y: move.y } : from, corners, ft: read?.dragFt ?? 0, none: answer.found.kind === "none" },
    words: route ? extraWords(route, false, false, towing) : [],
    extraFt: read?.extra?.ft ?? 0,
    after: { ...next, left, counter, history: `${at.history}|${JSON.stringify(plan.moves)}` },
  };
}

/**
 * The stop a leg leaves at `drawn`: the one the reducer recorded on the
 * simulated room, which marks who saw the leg, the stop before it marked
 * so too, while the creature's turn is under way there. Else, as off a
 * turn or on a copy that cannot tell this turn's path, `drawn` seen whole,
 * since every device draws the whole ruler.
 */
function stopLeft(sim: RoomState, id: string, left: PathStop[], drawn: PathStop): PathStop {
  const token = sim.tokens[id];
  const stops = token ? pathThisTurn(sim.encounter, token)?.stops : undefined;
  const at = stops?.[stops.length - 1];
  const from = stops?.[stops.length - 2];
  const start = left[left.length - 1]!;
  if (!at || !from || at.x !== drawn.x || at.y !== drawn.y || from.x !== start.x || from.y !== start.y) return { ...drawn, seen: true, routeSeen: true };
  left[left.length - 1] = from;
  return at;
}

const rulerRooms = new WeakMap<RoomState, RoomState>();

/**
 * The room as a walking ruler reads it (docs/design-v1-map-discovery.md
 * 5.2): a ruler sends nothing, so the pieces of a player's held build stop
 * its walk anywhere within their band (movement.ts previewChunks), where
 * a drag's drop reads them by the gate test. One per view, so what the
 * ruler keeps by the room's identity still holds.
 */
function rulerRoom(view: RoomState): RoomState {
  if (isPreview(view.buildChunks)) return view;
  let out = rulerRooms.get(view);
  if (!out) rulerRooms.set(view, (out = { ...view, buildChunks: previewChunks(view.buildChunks) }));
  return out;
}

/** The ruler's actor and clock for the moves it simulates: no op is sent, so neither is anyone's. */
const RULER_ACTOR = (role: WalkViewer["role"]): Viewer => ({ memberId: "ruler", role });
const RULER_ENV = { seq: 1, at: "1970-01-01T00:00:00.000Z" };

/**
 * The room after the drag a ruler's leg reads (its plan's ops), applied by
 * the room's own reducer to this device's copy, as the client predicts an
 * op: the token's group moves with it and a link that no longer holds
 * comes loose by the link pass. Who sees a token it moved is judged where
 * it now stands by the rule the server judges every player's sight by
 * (walkWorld.ts seenWhereMoved), any other as this view's drops read it,
 * and for a shared ruler none players did not see where it starts
 * (`unseen`). A copy the reducer cannot apply it to, as a projection can
 * lack what the reducer assumes, moves the walker where the plan puts it
 * and no more.
 */
function simulated(view: RoomState, sim: RoomState, role: WalkViewer["role"], walker: Token, plan: DropPlan, unseen: ReadonlySet<string> | undefined): Pick<Walked, "sim" | "seen" | "walker"> {
  let next: RoomState | null = sim;
  try {
    for (const op of moveOpsOf(plan.moves)) {
      const out = applyOp(next, op as Op, RULER_ACTOR(role), RULER_ENV);
      next = out.ok ? out.state : null;
      if (!next) break;
    }
  } catch {
    next = null;
  }
  const move = plan.moves.find((m) => m.tokenId === walker.id);
  if (!next?.tokens[walker.id]) {
    const { squeeze: _squeeze, ...rest } = walker;
    const moved: Token = move ? { ...rest, x: move.x, y: move.y, elevation: move.elevation ?? walker.elevation, ...(move.squeeze ? { squeeze: true as const } : {}) } : walker;
    next = { ...sim, tokens: { ...sim.tokens, [walker.id]: moved } };
  }
  // The reducer may hand back the build in a collection of its own, which the ruler reads as its preview still.
  const room = rulerRoom(next);
  const drops = dropView(view, role);
  const moved = (id: string) => !samePose(room.tokens[id], view.tokens[id]);
  const seen: DropView = {
    ...room,
    seen: (t) => {
      const token = room.tokens[t.id];
      return token !== undefined && !unseen?.has(t.id) && (moved(t.id) ? seenWhereMoved(room, token) : drops.seen(t));
    },
  };
  return { sim: room, seen, walker: room.tokens[walker.id]! };
}

function samePose(a: Token | undefined, b: Token | undefined): boolean {
  if (!a || !b) return a === b;
  return a.sceneId === b.sceneId && a.x === b.x && a.y === b.y && a.elevation === b.elevation && a.squeeze === b.squeeze && a.attached?.to === b.attached?.to && a.attached?.kind === b.attached?.kind;
}

/**
 * A walk still searching as work for the board's turns (routeWork.ts): each
 * turn goes on with it on the frame's budget, `more` hears when a turn
 * answers another leg or the whole walk, and it is done once the walk is.
 */
export function walkJob(input: WalkInput, more: () => void): RouteJob {
  let answered = -1;
  return {
    run: (budget) => {
      const now = measureWalk({ ...input, budget });
      const done = now?.searching !== true;
      const count = now ? now.legs.filter((leg) => leg.searching !== true).length : 0;
      if (done || count !== answered) {
        answered = count;
        more();
      }
      return done;
    },
  };
}

/** "Walking 40 ft", with what terrain added under it. */
export function walkText(m: WalkMeasure): string {
  return m.extra ? `Walking ${formatFeet(m.totalFt)}\n${m.extra}` : `Walking ${formatFeet(m.totalFt)}`;
}

/** The last walk a ruler finished, and that ruler (heldKey), kept while a later walk of it searches (walkShown). */
export type HeldWalk = { ruler: string; walk: WalkMeasure } | null;

/**
 * Which ruler a held walk belongs to: its id and where it starts. A drag
 * that does not carry on from the last stop starts the ruler afresh under
 * the same id (ruler.ts dragTo), so the start tells a new ruler from the
 * old one (review LP2L2-OPUS-9). A start on a token is that token, wherever
 * it moves, so a kept ruler riding a creature that walks keeps its walk
 * while the walk is searched again (review LP2L2-OPUS-11).
 */
export function heldKey(id: string, stops: readonly RulerStop[]): string {
  const first = stops[0];
  if (!first) return id;
  return first.tokenId !== undefined ? `${id}|token:${first.tokenId}` : `${id}|${first.x},${first.y}`;
}

/**
 * The held walk after a render that measured `m` for `ruler`: a finished
 * walk is held, a searching one keeps the walk held for the same ruler, and
 * nothing measured (the ruler cleared or kept, a Straight measure, a single
 * stop) or another ruler (heldKey) lets it go. So a new ruler never reads
 * the last one's distance while its own first walk searches (review
 * LP2L2-ASTRA-1).
 */
export function nextHeld(prev: HeldWalk, m: WalkMeasure | null, ruler: string): HeldWalk {
  if (!m) return null;
  if (!m.searching) return { ruler, walk: m };
  return prev?.ruler === ruler ? prev : null;
}

/**
 * What a walking ruler's total and the Ruler's line say while its walk is
 * worked out, as a drag's label does (docs/design-v1-look-pass-2.md D16): a
 * walk still searching keeps the last walk's reading, and only once the
 * search has run past the shared loading delay (`slow`) does it wait grey,
 * "Finding the way…". So a ruler dragged over a large map never blinks.
 * `held` is the last walk this ruler finished (nextHeld), null before its first.
 */
export function walkShown(m: WalkMeasure, held: WalkMeasure | null, slow: boolean): { reading: WalkMeasure | null; finding: boolean } {
  if (!m.searching) return { reading: m, finding: false };
  if (slow) return { reading: null, finding: true };
  return { reading: held, finding: false };
}

/**
 * The leg whose cost a walking ruler's leg `i` labels, as walkShown keeps
 * its total: a found leg its own, and a leg still searching the held
 * walk's leg of the same index (review LP2L2-P3-4), so a multi-leg
 * ruler's last label never blinks while its stop is dragged. Past the
 * loading delay (`finding`) the leg waits grey with no label, as does a
 * leg the held walk did not have. `held` is a finished walk (nextHeld),
 * so its legs are all found.
 */
export function legReading(m: WalkMeasure, i: number, held: WalkMeasure | null, finding: boolean): WalkLeg | null {
  const leg = m.legs[i];
  if (!leg) return null;
  if (leg.searching !== true) return leg;
  return finding ? null : (held?.legs[i] ?? null);
}

const STORE_KEY = "rvtt.ruler.measure";

/** The ruler's Measure choice as this device remembers it, Straight when it remembers nothing or cannot (3.3). */
export function savedWalk(storage: () => Storage | undefined = () => globalThis.localStorage): boolean {
  try {
    return storage()?.getItem(STORE_KEY) === "walking";
  } catch {
    return false;
  }
}

export function saveWalk(walk: boolean, storage: () => Storage | undefined = () => globalThis.localStorage): void {
  try {
    storage()?.setItem(STORE_KEY, walk ? "walking" : "straight");
  } catch {
    // A private window or blocked storage: the choice lasts until the page closes.
  }
}
