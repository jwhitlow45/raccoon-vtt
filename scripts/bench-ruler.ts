import { measureWalk } from "../client/features/measure/walkRuler.ts";
import type { BuildChunk, EdgeFeature, RoomState } from "../shared/model.ts";
import { forgetStepCaches } from "../shared/rules/walk.ts";
import { room, scene, token } from "../shared/testutil.ts";
import type { RouteRow } from "./bench-route.ts";

/**
 * The walking ruler's worst case (docs/design-v1-movement.md 3.3, review
 * MV-O-5): a Large walker on a 200 x 200 map measuring to a stop inside a
 * closed room, so its search floods all the ground it can reach before it
 * says "No way through". Rows: the whole walk a slice a frame, its longest
 * slice, and the walk asked again after an op that leaves its inputs alone,
 * as a kept ruler is on every op.
 */

const SLICE_MS = 4;

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
