import type { Actor, RoomState, Token } from "#shared/model.ts";
import type { DiagonalCounter } from "#shared/rules/distance.ts";
import { footprintSize, snapStep } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { routeFeet, routePoints, straightCost, type LegCost, type RoutePiece } from "#shared/rules/route.ts";
import { LegCheck, WalkSearch, WalkWorld, WorkBudget, worldUnits } from "#shared/rules/walk.ts";
import { publicWorld, type WalkViewer } from "#shared/rules/walkWorld.ts";
import { dropLanding, dropView, routeTarget, walkerOf } from "../movement/drop.ts";
import type { RouteJob } from "../movement/routeWork.ts";
import { extraWords, joinWords } from "./movement.ts";
import { formatFeet, tokenStop, type Point, type RulerStop } from "./ruler.ts";

/**
 * The ruler's walking mode (docs/design-v1-movement.md 3.3), kept free of
 * React and Konva so it is tested under plain Node: the walk through every
 * stop for one creature, the token the ruler starts on, or a Medium
 * creature on the ground when it starts on empty ground. Each later stop is
 * where that creature would stand if dragged there, and each leg walks the
 * route a drag would, with the 5-10-5 count running on across the stops.
 *
 * A ruler has no turn, so it leaves out other creatures' spaces, which will
 * move before anyone walks there, Speed changes and crawling. It counts
 * walls, doors, ledges, terrain, marks and the areas that cost. A shared or
 * kept walking ruler searches in the public world on every device, so all
 * read the same walk. Only the DM's own ruler, before it is shared, may use
 * everything the DM knows.
 */

/** One leg as drawn: from where the walker stood to where it would stand, through its route's corners, top-left as tokens are, and what it costs. No route: drawn straight, "No way through". Still searching: drawn straight, its cost unknown. */
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

/** The parts of the room a ruler's walk reads (publicWorld, walkerAt). While each is the same object, the walks and searches kept for it still hold. */
type Basis = Pick<RoomState, "buildChunks" | "templates" | "tokens" | "fogTiles" | "exploredTiles" | "meta" | "members" | "characters"> & { scene: unknown };

function basisOf(view: RoomState, sceneId: string): Basis {
  const { buildChunks, templates, tokens, fogTiles, exploredTiles, meta, members, characters } = view;
  return { buildChunks, templates, tokens, fogTiles, exploredTiles, meta, members, characters, scene: view.scenes[sceneId] };
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
 *   from one spot share one.
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

/**
 * A leg's finished answer: the straight leg, the route's pieces, or none.
 * Kept by its start, 5-10-5 residue and spot, so a ruler of many legs needs
 * a leg's search only while that leg is searched (review ASTRA-07).
 */
type LegAnswer = { kind: "open" } | { kind: "route"; pieces: RoutePiece[] } | { kind: "none" };

/** A ruler's walk so far: each leg's answer by its place, and the search and open-ground check of the leg still searching. */
type Progress = { answers: LegAnswer[]; on: { leg: string; search: WalkSearch; check: LegCheck } | null };

type Kept = {
  basis: Basis;
  searches: Map<string, WalkSearch>;
  legs: Map<string, LegAnswer>;
  progress: WeakMap<readonly RulerStop[], Map<string, Progress>>;
  walks: WeakMap<readonly RulerStop[], Map<string, WalkMeasure>>;
};

let kept: Kept | null = null;

function keptFor(view: RoomState, sceneId: string): Kept {
  const basis = basisOf(view, sceneId);
  if (!kept || !sameBasis(kept.basis, basis)) kept = { basis, searches: new Map(), legs: new Map(), progress: new WeakMap(), walks: new WeakMap() };
  return kept;
}

function searchKey(walker: Token, everything: boolean, counter: DiagonalCounter): string {
  return `${walker.id},${walker.size},${walker.w},${walker.h},${walker.x},${walker.y},${walker.elevation},${walker.squeeze === true},${(walker as { footing?: string }).footing ?? ""},${counter.h},${counter.v},${everything}`;
}

/**
 * A leg start's search, made when first asked for, its world's build
 * charged to the frame's budget as one step that cannot stop partway
 * (review MV-O-23). Over the cap the one asked for longest ago goes: a
 * ruler still searching holds its own (Progress).
 */
function searchFor(view: RoomState, walker: Token, viewer: WalkViewer, everything: boolean, counter: DiagonalCounter, key: string, budget: WorkBudget): WalkSearch {
  const kept = keptFor(view, walker.sceneId);
  let search = kept.searches.get(key);
  if (search) kept.searches.delete(key);
  else {
    const world = publicWorld(view, walker, viewer, [], { creatures: false, everything, seenGround: !everything });
    search = new WalkSearch(new WalkWorld({ ...world.input, prone: false, counter }));
    budget.charge(worldUnits(search.world) + Math.ceil((search.world.nx * search.world.ny) / 400));
    if (kept.searches.size >= MAX_SEARCHES) kept.searches.delete(kept.searches.keys().next().value!);
  }
  kept.searches.set(key, search);
  return search;
}

/**
 * A leg's answer, worked on the frame's budget: null while it is still
 * searching. Once the budget is spent no leg begins, and none gets an
 * allowance of its own: the frame's work (routeWork.ts) gives the frame's
 * first work its bit of progress, once a frame (review ASTRA-14).
 */
function legAnswer(view: RoomState, walker: Token, input: WalkInput, counter: DiagonalCounter, target: Point, budget: WorkBudget, progress: Progress): LegAnswer | null {
  const kept = keptFor(view, walker.sceneId);
  const key = searchKey(walker, input.everything, counter);
  const legKey = `${key}|${target.x},${target.y}`;
  const known = kept.legs.get(legKey);
  if (known) return known;
  if (budget.spent) return null;
  const own = progress.on?.leg === legKey ? progress.on : null;
  const search = own ? own.search : searchFor(view, walker, input.viewer, input.everything, counter, key, budget);
  const check = own ? own.check : new LegCheck(search.world, target);
  const late = (units = 1) => {
    budget.charge(units);
    return budget.spent;
  };
  let answer: LegAnswer;
  // The open-ground check, the search and its trace all share the budget: a ruler's frame never runs past it.
  if (!check.done && !check.run(late)) {
    progress.on = { leg: legKey, search, check };
    return null;
  }
  if (check.open) answer = { kind: "open" };
  else {
    const settled = search.settle(target, budget);
    const traced = settled === "settled" ? search.traceTo(target, budget) : null;
    if (settled === "paused" || traced === "paused") {
      progress.on = { leg: legKey, search, check };
      return null;
    }
    answer = traced ? { kind: "route", pieces: traced.pieces } : { kind: "none" };
  }
  progress.on = null;
  if (kept.legs.size >= MAX_LEGS) kept.legs.delete(kept.legs.keys().next().value!);
  kept.legs.set(legKey, answer);
  return answer;
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
  const { view, stops } = input;
  const budget = input.budget ?? (input.deadline !== undefined ? WorkBudget.until(input.deadline) : WorkBudget.all());
  const room = keptFor(view, input.sceneId);
  const memo = room.walks;
  const memoKey = `${input.sceneId},${input.viewer.role},${input.everything}`;
  const known = memo.get(stops)?.get(memoKey);
  if (known) return known;
  const byRuler = room.progress.get(stops) ?? new Map<string, Progress>();
  room.progress.set(stops, byRuler);
  const progress = byRuler.get(memoKey) ?? { answers: [], on: null };
  byRuler.set(memoKey, progress);
  const first = stops[0];
  let walker = first ? walkerAt(view, input.sceneId, first) : null;
  if (!walker || stops.length < 2) return null;
  const size = footprintSize(walker);
  const seen = dropView(view, input.viewer.role);
  const rules = { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal };
  const counter: DiagonalCounter = { h: 0, v: 0 };
  const legs: WalkLeg[] = [];
  const pieces: [number, number, number, 0 | 1][] = [];
  let totalFt = 0;
  let extraFt = 0;
  let searching = false;
  for (const [k, drawn] of stops.slice(1).entries()) {
    // A stop on a token is where that token stands now, as the straight ruler reads it. One this view cannot resolve stays where it was drawn.
    const on = drawn.tokenId ? view.tokens[drawn.tokenId] : undefined;
    const stop = on ? tokenStop(on) : drawn;
    const from = { x: walker.x, y: walker.y };
    const target = routeTarget(seen, walker, { x: stop.x - size.w / 2, y: stop.y - size.h / 2 });
    // Where a drag would land it and how it would walk there: off a holder every player sees, by the holder (drop.ts dropLanding, walkerOf).
    const landing = dropLanding(seen, walker, target);
    const end = { x: target.x, y: target.y, elevation: landing };
    let taken: LegCost;
    let corners: Point[] = [];
    let none = false;
    // Past a leg still searching, the walker's later legs start from where it would land, never searched until it is known: they would only push its search out.
    const answer = progress.answers[k] ?? (searching ? null : legAnswer(view, walkerOf(seen, walker), input, counter, target, budget, progress));
    if (answer) progress.answers[k] = answer;
    if (!answer) {
      searching = true;
      legs.push({ from, to: { x: target.x, y: target.y }, corners, ft: 0, none, searching: true });
      walker = { ...walker, x: target.x, y: target.y, elevation: landing, ...(target.squeeze ? { squeeze: true as const } : { squeeze: undefined }) };
      continue;
    }
    if (answer.kind === "route") {
      const points = routePoints(view.buildChunks, walkerOf(seen, walker, target), answer.pieces, landing);
      taken = routeFeet(points, answer.pieces.map(([, , extra, swim]) => ({ extra, swim })), rules, counter, { swimSpeed: false, step: snapStep(walker) });
      corners = points.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
      pieces.push(...answer.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]));
      extraFt += taken.cost - taken.moved;
    } else {
      none = answer.kind === "none";
      taken = straightCost(walker, walker, end, rules, counter);
    }
    counter.h += taken.diag[0];
    counter.v += taken.diag[1];
    totalFt += taken.cost;
    legs.push({ from, to: { x: target.x, y: target.y }, corners, ft: taken.cost, none });
    walker = { ...walker, x: target.x, y: target.y, elevation: landing, ...(target.squeeze ? { squeeze: true as const } : { squeeze: undefined }) };
  }
  const words = extraWords(pieces, false, false);
  const walk: WalkMeasure = { legs, totalFt, extra: extraFt > 0 && words.length > 0 ? `+${formatFeet(extraFt)} for ${joinWords(words)}` : null, size, searching };
  if (!searching) {
    const byViewer = memo.get(stops) ?? new Map<string, WalkMeasure>();
    byViewer.set(memoKey, walk);
    memo.set(stops, byViewer);
  }
  return walk;
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
