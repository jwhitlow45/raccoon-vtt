import { measureWalk, walkJob, type WalkInput } from "../client/features/measure/walkRuler.ts";
import { routeTarget } from "../client/features/movement/drop.ts";
import { worldFor } from "../client/features/movement/press.ts";
import { RouteDrag } from "../client/features/movement/routeDrag.ts";
import { RouteWork, SLICE_MS, type Frames } from "../client/features/movement/routeWork.ts";
import type { BuildChunk, EdgeFeature, RoomState } from "../shared/model.ts";
import { forgetStepCaches, WorkBudget } from "../shared/rules/walk.ts";
import { publicWorld } from "../shared/rules/walkWorld.ts";
import { reveal, room, scene, template, token } from "../shared/testutil.ts";
import type { RouteRow } from "./bench-route.ts";

/**
 * Building the public world a drag starts from (5.5, review MV-O-13): a
 * 200 x 200 scene under fog, half of it revealed, 300 creatures and four
 * areas that cost, on the DM's device for a party member, the room's chunk
 * collection new each run so the chunks as players hold them are built
 * again too.
 */
export function runPublicWorldRow(runs = 15): RouteRow {
  const state = closedRoom();
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
  reveal(state, "s1", { x: 0, y: 0, w: 200, h: 100 });
  for (let k = 0; k < 300; k++) state.tokens[`t${k}`] = token(`t${k}`, { x: (k * 37) % 197, y: (k * 53) % 197, disposition: k % 3 === 0 ? "ally" : "hostile" });
  state.tokens.hero = token("hero", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 50, y: 50 });
  for (let k = 0; k < 4; k++) state.templates[`a${k}`] = template(`a${k}`, { shape: "sphere", size: 20, origin: { x: 40 + 30 * k, y: 60, z: 0 }, ownerId: "dm1", slows: { kind: "difficult" } });
  const times: number[] = [];
  for (let r = 0; r < runs + 3; r++) {
    const view = { ...state, buildChunks: { ...state.buildChunks } };
    const t = performance.now();
    publicWorld(view, view.tokens.hero!, { role: "dm" });
    if (r >= 3) times.push(performance.now() - t);
  }
  return { row: "The public world on 200 x 200 under fog, 300 creatures and 4 areas, on the DM's device (settled holds the creatures)", settled: 300, ms: stats(times) };
}

/**
 * The walking ruler's worst case (docs/design-v1-movement.md 3.3, review
 * MV-O-5): a Large walker on a 200 x 200 map measuring to a stop inside a
 * closed room, so its search floods all the ground it can reach before it
 * says "No way through". Rows: the whole walk a slice a frame, its longest
 * slice, and the walk asked again after an op that leaves its inputs alone,
 * as a kept ruler is on every op.
 */


function closedRoom(): RoomState {
  const edges: Record<string, EdgeFeature> = {};
  for (let k = 190; k < 194; k++) Object.assign(edges, { [`${k},190,n`]: WALL, [`${k},194,n`]: WALL, [`190,${k},w`]: WALL, [`194,${k},w`]: WALL });
  const chunks: Record<string, BuildChunk> = {};
  for (const [key, f] of Object.entries(edges)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    (chunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} }).edges[key] = f;
  }
  const state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 }, autoWalls: "off", blockMovement: true }) }, buildChunks: chunks });
  state.tokens.ogre = token("ogre", { size: "large", x: 10, y: 10 });
  return state;
}

const WALL: EdgeFeature = { kind: "wall" };

function stats(times: number[]): { median: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

export function runRulerRows(runs = 15): RouteRow[] {
  const whole: number[] = [];
  const longest: number[] = [];
  const again: number[] = [];
  let slices = 0;
  for (let r = 0; r < runs + 3; r++) {
    forgetStepCaches();
    // A fresh room each run, so nothing is kept from the last.
    const view = closedRoom();
    const stops = [{ x: 11, y: 11, tokenId: "ogre" }, { x: 191.5, y: 191.5 }];
    const input = { view, sceneId: "s1", stops, viewer: { role: "player" as const }, everything: false };
    let total = 0;
    let worst = 0;
    let n = 0;
    for (let m = null as ReturnType<typeof measureWalk>; !m || m.searching; n++) {
      const t = performance.now();
      m = measureWalk({ ...input, deadline: t + SLICE_MS });
      const spent = performance.now() - t;
      total += spent;
      worst = Math.max(worst, spent);
    }
    const t = performance.now();
    measureWalk({ ...input, view: { ...view, log: [...view.log] } });
    if (r >= 3) {
      whole.push(total);
      longest.push(worst);
      again.push(performance.now() - t);
      slices = n;
    }
  }
  const row = "Walking ruler, Large, to a stop with no way through on 200 x 200";
  return [
    { row: `${row}: the whole walk, ${SLICE_MS} ms slices (settled holds the slices)`, settled: slices, ms: stats(whole) },
    { row: `${row}: its longest slice`, settled: slices, ms: stats(longest) },
    { row: `${row}: asked again after an op that leaves its inputs alone`, settled: 0, ms: stats(again) },
  ];
}

/** Frames on the real clock, each one's events and then its turn timed together. */
class TimedFrames implements Frames {
  queue: (() => void)[] = [];
  longest = 0;
  frames = 0;
  now(): number {
    return performance.now();
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(events: () => void = () => {}): void {
    const t = performance.now();
    events();
    for (const run of this.queue.splice(0)) run();
    this.longest = Math.max(this.longest, performance.now() - t);
    this.frames++;
    // The rest of a 60 Hz frame goes by, so the next events open the next frame's budget.
    const until = performance.now() + 12.5;
    while (performance.now() < until);
  }
}

/**
 * The board's route work as a frame pays it (review ASTRA-08, ASTRA-14 and
 * MV-O-23): every frame's events and its turn timed together, against a
 * frame's 4 ms of work and one step that cannot stop partway. Rows:
 * - a drag's whole aim path: a Large creature aimed by turns at the next
 *   square and the far side of an empty 200 x 200 map under true distance,
 *   its world built on the first aim
 * - 40 rulers from nearby starts into a closed room
 * - a drag round a wall with ten kept rulers searching
 * `settled` holds the frames.
 */
export function runFrameRows(runs = 3): RouteRow[] {
  const aim: number[] = [];
  const first: number[] = [];
  const many: number[] = [];
  const both: number[] = [];
  let frames = [0, 0, 0];
  for (let r = 0; r < runs + 1; r++) {
    forgetStepCaches();
    // A drag's aims, the first one cold.
    const open = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 }, autoWalls: "off", blockMovement: true }) } });
    open.meta = { ...open.meta, settings: { ...open.meta.settings, diagonal: "euclid" } };
    const ogre = token("ogre", { size: "large", x: 2, y: 2 });
    open.tokens.ogre = ogre;
    const board = new TimedFrames();
    const work = new RouteWork(board);
    const drag = new RouteDrag(() => worldFor(open, ogre, "dm").input, work);
    const t = performance.now();
    drag.aim(routeTarget(open, ogre, { x: 198, y: 100 }));
    const cold = performance.now() - t;
    for (let f = 0; f < 60; f++) board.frame(() => drag.aim(routeTarget(open, ogre, f % 2 === 0 ? { x: 3 + f / 2, y: 2 } : { x: 198, y: 100 - (f % 7) })));
    while (work.waiting) board.frame();
    // 40 rulers into a closed room.
    const view = closedRoom();
    const rulers = new TimedFrames();
    const shared = new RouteWork(rulers);
    const inputs = Array.from({ length: 40 }, (_, k): WalkInput => ({ view, sceneId: "s1", stops: [{ x: 10.5 + (k % 8) * 2, y: 10.5 + Math.floor(k / 8) * 2 }, { x: 191.5, y: 191.5 }], viewer: { role: "player" }, everything: false }));
    for (const input of inputs) shared.add(walkJob(input, () => {}));
    while (shared.waiting) rulers.frame(() => inputs.forEach((input) => measureWalk({ ...input, budget: WorkBudget.none() })));
    // A drag round a wall with ten kept rulers searching.
    const walled = closedRoom();
    const together = new TimedFrames();
    const mixed = new RouteWork(together);
    for (let k = 0; k < 10; k++) mixed.add(walkJob({ view: walled, sceneId: "s1", stops: [{ x: 30.5 + k * 2, y: 30.5 }, { x: 191.5, y: 191.5 }], viewer: { role: "player" }, everything: false }, () => {}));
    const mover = walled.tokens.ogre!;
    const around = new RouteDrag(() => worldFor(walled, mover, "dm").input, mixed);
    for (let f = 0; f < 30; f++) together.frame(() => around.aim(routeTarget(walled, mover, { x: 100 + f, y: 150 })));
    while (mixed.waiting) together.frame();
    if (r >= 1) {
      first.push(cold);
      aim.push(board.longest);
      many.push(rulers.longest);
      both.push(together.longest);
      frames = [board.frames, rulers.frames, together.frames];
    }
  }
  const budget = 2 * SLICE_MS;
  return [
    { row: "A drag's first aim, Large on an empty 200 x 200 map under true distance, at the far side: its world's build and the open-ground check", settled: 1, ms: stats(first) },
    { row: "The same drag aimed by turns at the next square and the far side: its longest frame", budget, settled: frames[0]!, ms: stats(aim) },
    { row: "40 rulers from nearby starts into a closed room, all searching: the longest frame", budget, settled: frames[1]!, ms: stats(many) },
    { row: "A drag round a wall with ten kept rulers searching: the longest frame", budget, settled: frames[2]!, ms: stats(both) },
  ];
}
