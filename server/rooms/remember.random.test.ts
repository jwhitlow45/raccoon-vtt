import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, paint, wall } from "#shared/discoveryTestutil.ts";
import { chunkKey, holderChunkKey, type EntityKey } from "#shared/keys.ts";
import { CHUNK_CELLS, type EdgeFeature, type FreeWall, type MemoryChunk, type RoomState, type TerrainId, type Viewer, type WallFeature } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { shownEdge, shownFreeWall, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { layerHeld, type Layer } from "#shared/reducer/memory.ts";
import { autoWallsOf } from "#shared/rules/autoWalls.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { groundOf, wallSpans } from "#shared/rules/held.ts";
import { chance, DM, env, int, pick, rng, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { mapStepOps } from "./remember.ts";

/**
 * MX2 end to end through the map step (docs/design-v1-map-discovery.md 13):
 * over random rooms and random batches, each run as the actor runs it (the
 * ops, the explore, then the map step's `sys.remember`, applied as stored),
 * every element a layer holds out of its sight reads, by memory where an
 * entry covers it and the build elsewhere, as it was at that layer's last
 * sight of it: terrain, edges and free walls per cell, for the party and
 * each sight holder. An oracle records each layer's last sight after every
 * batch by its own live ground. Sight is perPlayerTestutil.ts's stub, whole
 * cells 3 out. The batches are the DM's alone, so no player touches a door,
 * and no layer reaches its cap, so nothing is forgotten (the accepted
 * exceptions of MX2 the step's unit tests cover).
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };
const W = 40;
const H = 24;
const TERRAINS: (TerrainId | null)[] = ["stone", "wood", "grass", null];

const q64 = (v: number) => Math.round(v * 64) / 64;

function randomFeature(r: () => number): EdgeFeature | null {
  return pick(r, [
    { kind: "wall" },
    { kind: "window" },
    { kind: "door", state: "closed", secret: false, discovered: false },
    { kind: "door", state: "open", secret: false, discovered: false },
    { kind: "door", state: "closed", secret: true, discovered: false },
    null,
  ] as (EdgeFeature | null)[]);
}

/** Free walls players see cut per cell: walls, windows and hidden secret doors. A visible door goes whole by decision 2 and is not judged here. */
function randomWallFeature(r: () => number): WallFeature {
  return pick(r, [{ kind: "wall" }, { kind: "window" }, { kind: "door", state: "closed", secret: true, discovered: false }] as WallFeature[]);
}

function randomWall(r: () => number, id: string): FreeWall {
  for (;;) {
    const a: [number, number] = [q64(int(r, 0, (W - 1) * 64) / 64), q64(int(r, 0, (H - 1) * 64) / 64)];
    const b: [number, number] = [q64(a[0] + int(r, -6 * 64, 6 * 64) / 64), q64(a[1] + int(r, -6 * 64, 6 * 64) / 64)];
    if (b[0] < 0 || b[1] < 0 || b[0] > W || b[1] > H || (a[0] === b[0] && a[1] === b[1])) continue;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 8) continue;
    return { id, a, b, f: randomWallFeature(r) };
  }
}

function randomRoom(r: () => number): RoomState {
  const perPlayer = chance(r, 0.5);
  const state = fogRoom({ vision: true, perPlayer, bounds: { w: W, h: H }, scene: { autoWalls: pick(r, ["off", "floor"] as const) } });
  for (let i = 0; i < int(r, 2, 5); i++) paint(state, { x: int(r, 0, W - 6), y: int(r, 0, H - 6), w: int(r, 2, 6), h: int(r, 2, 6) }, pick(r, ["stone", "wood"] as const));
  for (let i = 0; i < int(r, 4, 12); i++) {
    const f = randomFeature(r);
    if (f) edge(state, `${int(r, 1, W - 1)},${int(r, 1, H - 1)},${pick(r, ["n", "w"])}`, f);
  }
  for (let i = 0; i < int(r, 0, 6); i++) {
    const w = randomWall(r, `w${String(i).padStart(11, "0")}`);
    wall(state, w.id, w.a, w.b, w.f);
  }
  state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: int(r, 0, W - 1), y: int(r, 0, H - 1) });
  // Bree lends the party her sight on a per-player scene, so the party's layer has sight of its own.
  state.tokens.bree = token("bree", { kind: "pc", ownerIds: ["p2"], x: int(r, 0, W - 1), y: int(r, 0, H - 1), ...(perPlayer ? { partyVision: true } : {}) });
  if (perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
}

function wallsOn(state: RoomState): FreeWall[] {
  return Object.values(state.buildChunks).flatMap((c) => (c.sceneId === "s1" ? (c.walls ?? []) : []));
}

function randomOp(r: () => number, state: RoomState, n: number): Op {
  const roll = r();
  if (roll < 0.3) return { t: "token.move", tokenId: pick(r, ["ayla", "bree"]), x: int(r, 0, W - 1), y: int(r, 0, H - 1) };
  if (roll < 0.5) {
    const x = int(r, 0, W - 3);
    const y = int(r, 0, H - 3);
    const cells = Array.from({ length: int(r, 1, 6) }, (_, i) => `${x + (i % 3)},${y + Math.floor(i / 3)}`);
    const terrain = pick(r, TERRAINS);
    return terrain ? { t: "build.paint", sceneId: "s1", terrain, cells } : { t: "build.erase", sceneId: "s1", cells };
  }
  if (roll < 0.7) {
    const edges = Array.from({ length: int(r, 1, 3) }, () => ({ key: `${int(r, 1, W - 1)},${int(r, 1, H - 1)},${pick(r, ["n", "w"])}`, feature: randomFeature(r) }));
    return { t: "build.edge", sceneId: "s1", edges: [...new Map(edges.map((e) => [e.key, e])).values()] };
  }
  if (roll < 0.93) {
    const walls = wallsOn(state);
    const old = walls.length > 0 && chance(r, 0.6) ? pick(r, walls) : null;
    if (old && chance(r, 0.35)) {
      const { cx, cy } = { cx: Math.floor(((old.a[0] + old.b[0]) / 2) / CHUNK_CELLS), cy: Math.floor(((old.a[1] + old.b[1]) / 2) / CHUNK_CELLS) };
      const at = Object.values(state.buildChunks).find((c) => c.sceneId === "s1" && c.walls?.some((w) => w.id === old.id));
      return { t: "build.walls", sceneId: "s1", remove: [{ cx: at?.cx ?? cx, cy: at?.cy ?? cy, id: old.id }] };
    }
    // A new wall, or an old one moved or changed: the same id put again.
    const next = old ? (chance(r, 0.5) ? { ...old, f: randomWallFeature(r) } : { ...randomWall(r, old.id) }) : randomWall(r, `n${String(n).padStart(11, "0")}`);
    const at = old ? Object.values(state.buildChunks).find((c) => c.sceneId === "s1" && c.walls?.some((w) => w.id === old.id)) : undefined;
    return { t: "build.walls", sceneId: "s1", put: [next], ...(at ? { remove: [{ cx: at.cx, cy: at.cy, id: old!.id }] } : {}) };
  }
  return { t: "view.blackout", blackout: state.meta.view?.blackout !== true };
}

/** One batch as the actor runs it: the ops, the explore, the map step. */
function batch(state: RoomState, ops: readonly Op[], seq: number): RoomState {
  const before = state;
  let s = state;
  const touched: EntityKey[] = [];
  let n = seq * 10;
  const run = (op: Op, by: Viewer) => {
    const r = applyOp(s, op, by, env(n++));
    if (!r.ok) return false;
    touched.push(...r.touched);
    s = r.state;
    return true;
  };
  let applied = 0;
  for (const op of ops) if (run(op, DM)) applied++;
  if (applied === 0) return state;
  const explore = exploreOp(s);
  if (explore) assert.ok(run(explore, SERVER), "the explore applies");
  for (const op of mapStepOps({ before, after: s, touched, cap: () => MEMORY_CAP })) {
    assert.equal(op.forget, undefined, "no layer here reaches its cap");
    assert.ok(run(op, SERVER), "the map step applies");
  }
  return s;
}

function layersOf(state: RoomState): Layer[] {
  return state.scenes.s1!.vision?.perPlayer ? [null, "p1"] : [null];
}

/** A layer's memory chunks of the scene. */
function memoryOf(state: RoomState, layer: Layer): MemoryChunk[] {
  if (layer === null) return Object.values(state.memory ?? {}).filter((c) => c.sceneId === "s1");
  return Object.values(state.memoryBy ?? {}).filter((c) => c.sceneId === "s1" && c.memberId === layer);
}

function memoryChunk(state: RoomState, layer: Layer, x: number, y: number): MemoryChunk | undefined {
  const cx = Math.floor(x / CHUNK_CELLS);
  const cy = Math.floor(y / CHUNK_CELLS);
  return layer === null ? state.memory?.[chunkKey("s1", cx, cy)] : state.memoryBy?.[holderChunkKey("s1", layer, cx, cy)];
}

/** What a layer saw of a cell at its last sight: its terrain, its four edges, and each free wall crossing it. */
type Seen = { cell: TerrainId | null; edges: Map<string, string>; walls: Map<string, string> };

const shape = (w: FreeWall | null) => (w ? stableStringify({ a: w.a, b: w.b, f: shownFreeWall(w).f }) : "none");

function edgesOf(x: number, y: number): string[] {
  return [`${x},${y},n`, `${x},${y},w`, `${x + 1},${y},w`, `${x},${y + 1},n`];
}

function liveCell(state: RoomState, x: number, y: number): TerrainId | null {
  return state.buildChunks[chunkKey("s1", Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS))]?.cells[`${x},${y}`] ?? null;
}

function liveEdge(state: RoomState, key: string): string {
  return stableStringify(shownEdge(state.buildChunks, "s1", autoWallsOf(state.scenes.s1!), key));
}

function crossing(state: RoomState, x: number, y: number): Map<string, string> {
  const grid = sceneGrid(state.scenes.s1!);
  const out = new Map<string, string>();
  for (const w of wallsOn(state)) if (wallSpans(grid, w).some((s) => s.cell === `${x},${y}`)) out.set(w.id, shape(w));
  return out;
}

/** The cell as the layer reads it now: memory where an entry covers it, the build elsewhere. */
function read(state: RoomState, layer: Layer, x: number, y: number): Seen {
  const here = memoryChunk(state, layer, x, y);
  const cellKey = `${x},${y}`;
  const cell = here?.cells && cellKey in here.cells ? here.cells[cellKey]! : liveCell(state, x, y);
  const edges = new Map<string, string>();
  for (const key of edgesOf(x, y)) {
    const [ex, ey] = key.split(",").map(Number) as [number, number];
    const filed = memoryChunk(state, layer, ex, ey);
    edges.set(key, filed?.edges && key in filed.edges ? stableStringify(filed.edges[key]) : liveEdge(state, key));
  }
  const walls = new Map<string, string>();
  const live = crossing(state, x, y);
  const versions = new Map<string, string>();
  for (const chunk of memoryOf(state, layer)) {
    for (const [id, list] of Object.entries(chunk.walls ?? {})) {
      const covering = list.find((v) => v.cells.includes(cellKey));
      if (covering) versions.set(id, shape(covering.wall));
    }
  }
  for (const id of new Set([...live.keys(), ...versions.keys()])) {
    const value = versions.get(id) ?? live.get(id) ?? "none";
    if (value !== "none") walls.set(id, value);
  }
  return { cell, edges, walls };
}

function look(state: RoomState, x: number, y: number): Seen {
  const edges = new Map<string, string>();
  for (const key of edgesOf(x, y)) edges.set(key, liveEdge(state, key));
  return { cell: liveCell(state, x, y), edges, walls: crossing(state, x, y) };
}

/** Whether an edge lies beside a cell the layer sees now. */
function edgeLive(live: (x: number, y: number) => boolean, key: string): boolean {
  const [x, y, side] = key.split(",") as [string, string, string];
  const ex = Number(x);
  const ey = Number(y);
  return live(ex, ey) || (side === "n" ? live(ex, ey - 1) : live(ex - 1, ey));
}

function run(seed: number, batches: number, counts: { remembered: number; judged: number }): void {
  const r = rng(seed);
  let state = randomRoom(r);
  // Each layer's last sight, per cell, and per edge on its own.
  const lastCell = new Map<Layer, Map<string, Seen>>(layersOf(state).map((l) => [l, new Map()]));
  const lastEdge = new Map<Layer, Map<string, string>>(layersOf(state).map((l) => [l, new Map()]));
  for (let b = 0; b < batches; b++) {
    const ops = Array.from({ length: int(r, 1, 3) }, (_, i) => randomOp(r, state, b * 10 + i));
    state = batch(state, ops, b + 1);
    const scene = state.scenes.s1!;
    for (const layer of layersOf(state)) {
      const ground = groundOf(state, "s1", layer)!;
      const held = layerHeld(state, scene, layer);
      const live = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && ground.live(x, y);
      const cells = lastCell.get(layer)!;
      const edges = lastEdge.get(layer)!;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!live(x, y)) continue;
          const seen = look(state, x, y);
          cells.set(`${x},${y}`, seen);
          for (const [key, value] of seen.edges) edges.set(key, value);
        }
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (live(x, y) || !held.key(`${x},${y}`)) continue;
          const where = `seed ${seed}, batch ${b}, layer ${layer ?? "party"}, cell ${x},${y}`;
          const seen = cells.get(`${x},${y}`);
          assert.ok(seen, `${where}: a held cell was seen once`);
          const now = read(state, layer, x, y);
          counts.judged++;
          if (stableStringify([now.cell, [...now.walls]]) !== stableStringify([liveCell(state, x, y), [...crossing(state, x, y)]])) counts.remembered++;
          assert.equal(now.cell, seen.cell, `${where}: terrain`);
          for (const key of edgesOf(x, y)) {
            if (edgeLive(live, key)) continue;
            assert.equal(now.edges.get(key), edges.get(key), `${where}: edge ${key}`);
          }
          assert.deepEqual([...now.walls].sort(), [...seen.walls].sort(), `${where}: free walls`);
        }
      }
    }
  }
}

describe("each held element is its layer's last sight of it (MX2, through the map step)", () => {
  test("terrain, edges and free walls per cell, for the party and a sight holder, over random rooms and batches", () => {
    withCellVision(() => {
      const counts = { remembered: 0, judged: 0 };
      for (let seed = 1; seed <= 60; seed++) run(seed, 30, counts);
      // The runs must judge many remembered cells, or they test nothing.
      assert.ok(counts.judged > 100_000, `judged ${counts.judged}`);
      assert.ok(counts.remembered > 2_000, `remembered ${counts.remembered}`);
    });
  });
});
