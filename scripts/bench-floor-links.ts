/**
 * The stairs' half of the floor check at its worst (FL2-OPUS-3,
 * docs/design/design-v1-floors.md phase 2, 3): a tower of three 200 by 200
 * floors with 16 pairs of 4 by 4 stairs, 32 ends, and walls up to a
 * floor's cap, none of them near the stairs. The room actor runs
 * `floorProblem` after every op that names a floor of the scene, a
 * token's move too, on the one thread that serves every room, so each row
 * times one call and is gated at 3 ms.
 *
 * - Squares, 8,100 wall edges a floor.
 * - Squares, 3,900 free walls a floor.
 * - Hex rows, 3,900 free walls a floor, where each end tests a wall
 *   against 16 hexes.
 *
 * Before `wallInside` dropped the walls whose box misses an end's box,
 * these read 1.0, 0.6 and 72 ms. With it, about 0.7, 0.4 and 1.1 ms: what
 * is left is one pass over the walls for each end.
 *
 * Run it with `node scripts/bench-floor-links.ts`. It exits 1 when a gate
 * fails.
 */
import { ATTIC, GROUND, UPPER, tower } from "../shared/floorLinksTestutil.ts";
import type { RoomState } from "../shared/model.ts";
import { MAX_BUILD_EDGES, opSchema } from "../shared/protocol.ts";
import { applyOp } from "../shared/reducer.ts";
import { floorProblem } from "../shared/rules/floors.ts";
import { DM, env } from "../shared/testutil.ts";

const FLOORS = [GROUND, UPPER, ATTIC];
const GATE_MS = 3;
let seq = 1000;

function run(state: RoomState, op: unknown): RoomState {
  const r = applyOp(state, opSchema.parse(op), DM, env(seq++));
  if (!r.ok) throw new Error(`${(op as { t: string }).t}: ${r.message}`);
  return r.state;
}

/** The tower at 200 by 200, its walls put in batches, then 16 pairs of stairs in the corner the walls leave clear. */
function room(hex: boolean, walls: (sceneId: string) => unknown[]): RoomState {
  let state = tower();
  for (const id of FLOORS) state = { ...state, scenes: { ...state.scenes, [id]: { ...state.scenes[id]!, bounds: { w: 200, h: 200 }, ...(hex ? { gridShape: "hexRows" as const } : {}) } } };
  for (const id of FLOORS) for (const op of walls(id)) state = run(state, op);
  for (let i = 0; i < 16; i++) {
    const [from, to] = i % 2 === 0 ? [GROUND, UPPER] : [UPPER, ATTIC];
    state = run(state, { t: "floorLink.put", link: { id: `a${i}`, pairId: `b${i}`, sceneId: from, to, rect: { x: (i % 4) * 5, y: Math.floor(i / 4) * 5, w: 4, h: 4 }, kind: "stairs" } });
  }
  return state;
}

function batches<T>(all: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/** Every other square's west edge from 20, 20 on: 8,100 a floor. */
function edges(sceneId: string): unknown[] {
  const all: unknown[] = [];
  for (let y = 20; y < 200; y += 2) for (let x = 20; x < 200; x += 2) all.push({ key: `${x},${y},w`, feature: { kind: "wall" } });
  return batches(all, MAX_BUILD_EDGES).map((edges) => ({ t: "build.edge", sceneId, edges }));
}

/** 3,900 short free walls a floor, just under its cap. */
function free(sceneId: string): unknown[] {
  const all: unknown[] = [];
  for (let y = 30; y < 200 && all.length < 3900; y += 2) for (let x = 30; x < 198 && all.length < 3900; x += 2) all.push({ id: `w${String(all.length).padStart(11, "0")}`, a: [x, y], b: [x + 1, y], f: { kind: "wall" } });
  return batches(all, 400).map((put) => ({ t: "build.walls", sceneId, put }));
}

export type Row = { row: string; ms: number; gate: number };

function time(state: RoomState): number {
  if (floorProblem(state, GROUND) !== null) throw new Error("the bench's tower breaks a floor rule");
  const samples: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    floorProblem(state, GROUND);
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b)[samples.length >> 1]!;
}

export function runFloorLinkRows(): Row[] {
  return [
    { row: "squares, 8,100 wall edges a floor", ms: time(room(false, edges)), gate: GATE_MS },
    { row: "squares, 3,900 free walls a floor", ms: time(room(false, free)), gate: GATE_MS },
    { row: "hex rows, 3,900 free walls a floor", ms: time(room(true, free)), gate: GATE_MS },
  ];
}

const argv = (globalThis as { process?: { argv?: string[]; exitCode?: number } }).process;
if (argv?.argv?.[1] && import.meta.url.endsWith(argv.argv[1].replace(/^.*scripts\//, "scripts/"))) {
  const rows = runFloorLinkRows();
  console.log(["16 pairs of stairs, floorProblem once | ms (median) | gate", "--- | --- | ---", ...rows.map((r) => `${r.row} | ${r.ms.toFixed(3)} | ${r.gate}${r.ms <= r.gate ? " pass" : " FAIL"}`)].join("\n"));
  if (rows.some((r) => r.ms > r.gate)) argv.exitCode = 1;
}
