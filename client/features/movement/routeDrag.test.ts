import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, TerrainId } from "#shared/model.ts";
import type { Point } from "#shared/rules/geom.ts";
import { findRoute, type WalkInput } from "#shared/rules/walk.ts";
import { tok, world } from "#shared/rules/testWorld.ts";
import { rebased } from "./drop.ts";
import { RouteDrag, type Frames, type Settled } from "./routeDrag.ts";

/**
 * The drag's search as a state machine (docs/design-v1-movement.md 12):
 * random runs of finger moves, often back to a spot visited before while
 * another spot's trace is under way, frames, drops, cancels, wall changes
 * and frames that fire late, against six invariants:
 * - a drop lands at most once,
 * - nothing lands after a cancel,
 * - a drop that waits is never lost: a flush (a new drag, a key press)
 *   lands it at once,
 * - a key press while a drop waits steps on from where the drop landed,
 *   never from where the board last drew the token,
 * - the route a drop lands with is the settled route to the drop's spot,
 *   as a fresh search finds it in the world as it is when it lands,
 * - no search state outlives its drag.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Frames run by hand. A cancelled frame stays in `late`, so a run can fire
 * it anyway, as a frame already under way when the drag ended would. The
 * clock never moves, so every slice is the search's smallest, a few hundred
 * states, and a run sees many slices.
 */
class HandFrames implements Frames {
  queue = new Map<number, () => void>();
  late: (() => void)[] = [];
  #next = 1;
  now(): number {
    return -Infinity;
  }
  request(run: () => void): number {
    const id = this.#next++;
    this.queue.set(id, run);
    return id;
  }
  cancel(handle: number): void {
    const run = this.queue.get(handle);
    if (run) this.late.push(run);
    this.queue.delete(handle);
  }
  runOne(): void {
    const first = this.queue.entries().next();
    if (first.done) return;
    this.queue.delete(first.value[0]);
    first.value[1]();
  }
}

type Scene = { cells: Record<string, TerrainId>; edges: Record<string, EdgeFeature> };

function randomScene(rand: () => number, W: number, H: number): Scene {
  const cells: Record<string, TerrainId> = {};
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = rand();
      if (x === 0 && y === 0) continue;
      if (r < 0.1) cells[`${x},${y}`] = "rubble";
      else if (r < 0.14) cells[`${x},${y}`] = "pillar";
      else if (r < 0.18) cells[`${x},${y}`] = "water";
      if (rand() < 0.15) edges[`${x},${y},w`] = { kind: "wall" };
      if (rand() < 0.15) edges[`${x},${y},n`] = { kind: "wall" };
    }
  }
  return { cells, edges };
}

/** One drag on a scene that may change under it. */
function run(seed: number): void {
  const rand = mulberry32(seed);
  const W = 10 + Math.floor(rand() * 8);
  const H = 10 + Math.floor(rand() * 8);
  let scene = randomScene(rand, W, H);
  const big = rand() < 0.3;
  const size = big ? ("large" as const) : ("medium" as const);
  const diagonal = rand() < 0.5 ? ("five" as const) : ("fiveTen" as const);
  const inputNow = (): WalkInput => {
    const state = world({ w: W, h: H, cells: scene.cells, edges: scene.edges });
    return { build: state, token: tok(state, { size, x: 0, y: 0 }), rules: { feetPerCell: 5, diagonal }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
  };
  // Each change builds a new world, a new scene id with it: the drag reads the one current when it builds.
  let current = inputNow();
  let built: WalkInput = current;
  const frames = new HandFrames();
  const drag = new RouteDrag(() => (built = current), frames);
  const step = big ? 0.5 : 1;
  const span = (n: number) => Math.floor(rand() * (n - (big ? 2 : 1)) / step) * step;
  const visited: Point[] = [];
  const spot = (): Point => {
    // Back to a spot visited before, whose trace was put aside for a later one's, or the finger on to a new one.
    if (visited.length > 0 && rand() < 0.4) return visited[Math.floor(rand() * visited.length)]!;
    const at = { x: span(W), y: span(H) };
    visited.push(at);
    return at;
  };
  const landings: { at: Point; answer: Settled; input: WalkInput }[] = [];
  // Where the room has the token: the drop's spot once it lands. The board draws it where the drag began.
  const drawn = { id: "t", sceneId: "s", size, x: 0, y: 0, elevation: 0 };
  let standing: Point = { x: 0, y: 0 };
  let cancelled = false;
  let dropped: Point | null = null;
  const events = 20 + Math.floor(rand() * 60);
  for (let e = 0; e < events && !drag.over; e++) {
    const r = rand();
    if (r < 0.35) drag.aim(spot());
    else if (r < 0.7) for (let k = Math.floor(rand() * 6); k > 0; k--) frames.runOne();
    else if (r < 0.8) {
      // A door shuts or opens, or the rubble moves: the drag is told, as a view change tells it.
      scene = randomScene(rand, W, H);
      current = inputNow();
      drag.rebuild();
    } else if (r < 0.9) {
      for (const late of frames.late.splice(0)) late();
    } else if (r < 0.94) {
      // A second drop while the first waits is the board's mistake to make: it is ignored, and the first lands.
      const at = spot();
      dropped ??= at;
      const land = (answer: Settled) => {
        landings.push({ at, answer, input: built });
        standing = at;
      };
      drag.drop(at, land);
    } else if (r < 0.97) {
      // A new drag starts, or an arrow key is pressed, while a drop may wait: as stageHooks' plan does, the drop lands, then the press reads where the token stands.
      const waiting = dropped !== null && !cancelled && landings.length === 0;
      drag.flush();
      if (waiting) assert.equal(landings.length, 1, `seed ${seed}: a flush lost the waiting drop`);
      const press = rebased({ t: { ...drawn, ...standing } }, drawn, { x: drawn.x + 1, y: drawn.y });
      if (waiting) assert.deepEqual([press.token.x, press.token.y, press.at.x, press.at.y], [standing.x, standing.y, standing.x + 1, standing.y], `seed ${seed}: the press stepped from where the board drew the token`);
    } else {
      cancelled = true;
      drag.cancel();
    }
  }
  // The drag ends: a pending drop lands once the search settles, as frames keep coming, or the board cancels it.
  for (let k = 0; k < 10_000 && frames.queue.size > 0; k++) frames.runOne();
  for (const late of frames.late.splice(0)) late();
  if (!drag.over) {
    cancelled = true;
    drag.cancel();
  }

  assert.ok(landings.length <= 1, `seed ${seed}: a drop landed ${landings.length} times`);
  if (cancelled && dropped === null) assert.equal(landings.length, 0, `seed ${seed}: landed after a cancel`);
  if (dropped !== null && !cancelled) assert.equal(landings.length, 1, `seed ${seed}: a drop never landed`);
  for (const { at, answer, input } of landings) {
    assert.deepEqual(at, dropped);
    const fresh = findRoute(input, at);
    const expected = fresh === null ? { kind: "open" } : fresh === "none" ? { kind: "none", capped: false } : { kind: "route", pieces: fresh.pieces };
    const got = answer.kind === "route" ? { kind: "route", pieces: answer.route.pieces } : answer;
    assert.deepEqual(got, expected, `seed ${seed}: the route landed is not the settled route to ${at.x}, ${at.y}`);
    // It was found in the scene as it stood when it landed, never in one a wall change replaced.
    assert.equal(input, current, `seed ${seed}: landed with a route from an old scene`);
  }
  assert.equal(drag.holding, false, `seed ${seed}: search state outlived the drag`);
  assert.equal(frames.queue.size, 0, `seed ${seed}: a frame is still asked for`);
}

describe("the drag's search as a state machine (12)", () => {
  test("random drags keep the six invariants", () => {
    for (let seed = 1; seed <= 400; seed++) run(seed);
  });

  test("a drop while searching waits for the route and lands with it, and a cancel drops the wait", () => {
    const walled: Record<string, EdgeFeature> = {};
    for (let y = 0; y < 28; y++) walled[`10,${y},w`] = { kind: "wall" };
    const state = world({ w: 30, h: 30, edges: walled });
    const input: WalkInput = { build: state, token: tok(state, { x: 2, y: 2 }), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
    const frames = new HandFrames();
    const drag = new RouteDrag(() => input, frames);
    const landed: Settled[] = [];
    drag.drop({ x: 20, y: 2 }, (a) => landed.push(a));
    assert.equal(drag.answer.kind, "searching");
    assert.equal(landed.length, 0, "it waits at the ghost");
    while (frames.queue.size > 0) frames.runOne();
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.kind, "route");
    assert.equal(drag.holding, false);

    const again = new RouteDrag(() => input, frames);
    again.drop({ x: 20, y: 2 }, (a) => landed.push(a));
    again.cancel();
    while (frames.queue.size > 0) frames.runOne();
    for (const late of frames.late.splice(0)) late();
    assert.equal(landed.length, 1, "a cancelled wait never lands");
    assert.equal(again.holding, false);
  });

  test("open ground needs no search, and no scene reads as the straight leg", () => {
    const state = world({ w: 20, h: 20 });
    const input: WalkInput = { build: state, token: tok(state, { x: 2, y: 2 }), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
    const frames = new HandFrames();
    const drag = new RouteDrag(() => input, frames);
    assert.deepEqual(drag.aim({ x: 9, y: 5 }), { kind: "open" });
    assert.equal(frames.queue.size, 0);
    const none = new RouteDrag(() => null, frames);
    assert.deepEqual(none.aim({ x: 9, y: 5 }), { kind: "open" });
  });
});
