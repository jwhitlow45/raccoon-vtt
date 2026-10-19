import type { Actor, RoomState, Token } from "#shared/model.ts";
import type { DiagonalCounter } from "#shared/rules/distance.ts";
import { footprintSize, snapStep } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { routeFeet, routePoints, straightCost, type LegCost } from "#shared/rules/route.ts";
import { openLeg, WalkSearch, WalkWorld } from "#shared/rules/walk.ts";
import { publicWorld, type WalkViewer } from "#shared/rules/walkWorld.ts";
import { landedElevation, routeTarget } from "../movement/drop.ts";
import { extraWords, joinWords } from "./movement.ts";
import { formatFeet, type Point, type RulerStop } from "./ruler.ts";

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

/** One leg as drawn: from where the walker stood to where it would stand, through its route's corners, top-left as tokens are, and what it costs. No route: drawn straight, "No way through". */
export type WalkLeg = { from: Point; to: Point; corners: Point[]; ft: number; none: boolean };

export type WalkMeasure = {
  legs: WalkLeg[];
  totalFt: number;
  /** "+10 ft for difficult terrain", when terrain added any. */
  extra: string | null;
  /** The walker's footprint in cells, for drawing the legs between footprint centers. */
  size: { w: number; h: number };
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

/*
 * Searches kept for the legs of the ruler being drawn: one per leg start,
 * world and 5-10-5 residue, so a stop dragged around reuses the search of
 * its leg, as a drag's search serves every spot the finger visits. They go
 * when the room changes.
 */
let kept: { view: RoomState; searches: Map<string, WalkSearch> } | null = null;

function searchFor(view: RoomState, walker: Token, viewer: WalkViewer, everything: boolean, counter: DiagonalCounter): WalkSearch {
  if (kept?.view !== view) kept = { view, searches: new Map() };
  const key = `${walker.id},${walker.size},${walker.w},${walker.h},${walker.x},${walker.y},${walker.elevation},${walker.squeeze === true},${counter.h},${counter.v},${everything}`;
  let search = kept.searches.get(key);
  if (!search) {
    const world = publicWorld(view, walker, viewer, [], { creatures: false, everything, seenGround: !everything });
    search = new WalkSearch(new WalkWorld({ ...world.input, prone: false, counter }));
    if (kept.searches.size >= 16) kept.searches.delete(kept.searches.keys().next().value!);
    kept.searches.set(key, search);
  }
  return search;
}

/**
 * The walk a walking ruler measures. `everything` is the DM's own ruler
 * before it is shared, and only then may the search read what players
 * cannot see.
 */
export function measureWalk(input: { view: RoomState; sceneId: string; stops: readonly RulerStop[]; viewer: WalkViewer; everything: boolean }): WalkMeasure | null {
  const { view, stops } = input;
  const first = stops[0];
  let walker = first ? walkerAt(view, input.sceneId, first) : null;
  if (!walker || stops.length < 2) return null;
  const size = footprintSize(walker);
  const rules = { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal };
  const counter: DiagonalCounter = { h: 0, v: 0 };
  const legs: WalkLeg[] = [];
  const pieces: [number, number, number, 0 | 1][] = [];
  let totalFt = 0;
  let extraFt = 0;
  for (const stop of stops.slice(1)) {
    const from = { x: walker.x, y: walker.y };
    const target = routeTarget(view, walker, { x: stop.x - size.w / 2, y: stop.y - size.h / 2 });
    const landing = landedElevation(view.buildChunks, walker, target);
    const end = { x: target.x, y: target.y, elevation: landing };
    const search = searchFor(view, walker, input.viewer, input.everything, counter);
    let taken: LegCost;
    let corners: Point[] = [];
    let none = false;
    if (openLeg(search.world, target)) {
      taken = straightCost(walker, walker, end, rules, counter);
    } else {
      const route = search.settle(target) === "settled" ? search.routeTo(target) : null;
      if (route) {
        const points = routePoints(view.buildChunks, walker, route.pieces, landing);
        taken = routeFeet(points, route.pieces.map(([, , extra, swim]) => ({ extra, swim })), rules, counter, { swimSpeed: false, step: snapStep(walker) });
        corners = points.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
        pieces.push(...route.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]));
        extraFt += taken.cost - taken.moved;
      } else {
        none = true;
        taken = straightCost(walker, walker, end, rules, counter);
      }
    }
    counter.h += taken.diag[0];
    counter.v += taken.diag[1];
    totalFt += taken.cost;
    legs.push({ from, to: { x: target.x, y: target.y }, corners, ft: taken.cost, none });
    walker = { ...walker, x: target.x, y: target.y, elevation: landing, ...(target.squeeze ? { squeeze: true as const } : { squeeze: undefined }) };
  }
  const words = extraWords(pieces, false, false);
  return { legs, totalFt, extra: extraFt > 0 && words.length > 0 ? `+${formatFeet(extraFt)} for ${joinWords(words)}` : null, size };
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
