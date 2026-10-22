import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import { CHUNK_CELLS, type BuildChunk, type RoomState, type Trap } from "../model.ts";
import { int, pick, rng, room, scene, trap } from "../testutil.ts";
import { sightPieces } from "../visionLimits.ts";
import { chunkHeights, encodeHeights } from "./heights.ts";
import { pitsMoved, pitTraps, withPitsCounted } from "./pitCount.ts";
import { sceneWalls } from "./walls.ts";

/** Sets one cell's ground, making its chunk when it has none. */
function setGround(state: RoomState, sceneId: string, x: number, y: number, feet: number): void {
  const cx = Math.floor(x / CHUNK_CELLS);
  const cy = Math.floor(y / CHUNK_CELLS);
  const key = chunkKey(sceneId, cx, cy);
  const chunk: BuildChunk = state.buildChunks[key] ?? { sceneId, cx, cy, rev: 0, cells: {}, edges: {} };
  const heights = Array.from(chunkHeights(chunk) ?? new Int16Array(CHUNK_CELLS * CHUNK_CELLS));
  heights[(y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS)] = feet;
  const encoded = encodeHeights(heights);
  const { heights: _old, ...rest } = chunk;
  state.buildChunks = { ...state.buildChunks, [key]: encoded === undefined ? rest : { ...rest, heights: encoded } };
}

/** The room with the given pits open, in that order: each square takes its pit's floor, a later pit's over an earlier one's. */
function opened(state: RoomState, pits: readonly Trap[]): RoomState {
  const out: RoomState = { ...state, buildChunks: { ...state.buildChunks } };
  for (const pit of pits) {
    if (!("cells" in pit.zone)) continue;
    for (const r of pit.zone.cells) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setGround(out, pit.sceneId, x, y, pit.rig!.pit!.floor);
  }
  return out;
}

function counts(state: Pick<RoomState, "scenes" | "buildChunks">): { sight: number; pairs: number; pieces: number } {
  const walls = sceneWalls(state.scenes.s1!, state.buildChunks);
  return { sight: sightPieces(state, "s1"), pairs: walls.count.pairs, pieces: walls.count.pieces };
}

function randomScene(seed: number): RoomState {
  const r = rng(seed);
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 20, h: 20 }, vision: { on: true } as never, blockMovement: true });
  // Rough ground: lone heights, terraces crossing each other, or blocks, so ledges run through and past the pits' corners.
  const pattern = int(r, 0, 2);
  if (pattern === 0) for (let i = 0; i < int(r, 0, 80); i++) setGround(state, "s1", int(r, 0, 19), int(r, 0, 19), pick(r, [5, 10, 10, -5, 20]));
  if (pattern === 1) {
    const row = int(r, 2, 17);
    const column = int(r, 2, 17);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) setGround(state, "s1", x, y, (y < row ? 10 : 0) + (x < column ? 5 : 0));
  }
  if (pattern === 2) {
    for (let by = 0; by < 20; by += 2) {
      for (let bx = 0; bx < 20; bx += 2) {
        const feet = pick(r, [0, 0, 5, 10]);
        for (let y = by; y < by + 2; y++) for (let x = bx; x < bx + 2; x++) setGround(state, "s1", x, y, feet);
      }
    }
  }
  // Stairs by terrain, which take their way up from the ground beside them, and drawn walls and doors.
  const first = chunkKey("s1", 0, 0);
  const base = state.buildChunks[first] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };
  const cells = { ...base.cells };
  const edges = { ...base.edges };
  const steps: [number, number, number][] = [];
  for (let i = 0; i < int(r, 0, 6); i++) {
    const x = int(r, 0, 15);
    const y = int(r, 0, 15);
    // A flight climbing north, so its cells take their way from the step at its top.
    for (let k = 0; k < int(r, 1, 4); k++) {
      cells[`${x},${y + k}`] = "stairs";
      if (r() < 0.5) steps.push([x, y + k, 5 - k]);
    }
  }
  for (let i = 0; i < int(r, 0, 6); i++) edges[`${int(r, 0, 15)},${int(r, 1, 15)},${pick(r, ["n", "w"])}`] = pick(r, [{ kind: "wall" }, { kind: "door", state: "closed", secret: false, discovered: false }, { kind: "window" }] as const);
  state.buildChunks[first] = { ...base, cells, edges };
  for (const [x, y, feet] of steps) setGround(state, "s1", x, y, feet);
  // A free wall now and then, so the split has something to cut.
  if (r() < 0.6) {
    const key = chunkKey("s1", 0, 0);
    const chunk = state.buildChunks[key] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };
    state.buildChunks[key] = { ...chunk, walls: [{ id: "freewall0001", a: [int(r, 0, 8) + 0.5, 0.5], b: [int(r, 9, 15) + 0.25, 15.5], f: { kind: "wall" } }] };
  }
  for (let i = 0; i < int(r, 1, 3); i++) {
    const cells = Array.from({ length: int(r, 1, 2) }, () => ({ x: int(r, 0, 15), y: int(r, 0, 15), w: int(r, 1, 4), h: int(r, 1, 4) }));
    const t = trap(`pit${i}`, { zone: { cells } });
    t.rig = { ...t.rig!, pit: { floor: pick(r, [-10, -20, 0, 5, 10]) } };
    state.traps[t.id] = t;
  }
  return state;
}

function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
  return out;
}

describe("the pit border counted ahead (docs/design-v1-traps.md 6.7)", () => {
  test("every set of opened pits, in either order, is within the counted geometry, and opening never raises the count", () => {
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const state = randomScene(seed);
      const counted = counts(withPitsCounted(state, "s1"));
      const pits = pitTraps(state, "s1");
      for (const set of subsets(pits)) {
        for (const order of [set, [...set].reverse()]) {
          const open = opened(state, order);
          const real = counts(open);
          assert.ok(real.sight <= counted.sight, `seed ${seed}, ${order.map((p) => p.id).join(" ")}: ${real.sight} sight pieces open, ${counted.sight} counted`);
          assert.ok(real.pairs <= counted.pairs, `seed ${seed}: pairs ${real.pairs} > ${counted.pairs}`);
          assert.ok(real.pieces <= counted.pieces, `seed ${seed}: pieces ${real.pieces} > ${counted.pieces}`);
          const after = counts(withPitsCounted(open, "s1"));
          assert.ok(after.sight <= counted.sight, `seed ${seed}: opening raised the counted sight pieces`);
          compared++;
        }
      }
    }
    assert.ok(compared > 1_000, `${compared} combinations`);
  });

  test("a scene without pit traps is read as stored, and pits on another scene change nothing here", () => {
    const state = randomScene(7);
    const plain = { ...state, traps: {} };
    assert.equal(withPitsCounted(plain, "s1").buildChunks, plain.buildChunks);
    const elsewhere = { ...state, traps: Object.fromEntries(Object.entries(state.traps).map(([id, t]) => [id, { ...t, sceneId: "s2" }])) };
    assert.deepEqual(counts(withPitsCounted(elsewhere, "s1")), counts(elsewhere));
  });

  test("on flat ground a 2 x 2 pit counts its 8 rim edges and the 8 that meet its sides at a corner, each one piece", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { bounds: { w: 20, h: 20 }, vision: { on: true } as never });
    assert.equal(sightPieces(state, "s1"), 0);
    const t = trap("pit", { zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] } });
    t.rig = { ...t.rig!, pit: { floor: -10 } };
    state.traps.pit = t;
    assert.equal(sightPieces(withPitsCounted(state, "s1"), "s1"), 16);
    const plate = trap("plate", { zone: { cells: [{ x: 10, y: 10, w: 2, h: 2 }] } });
    assert.equal(sightPieces(withPitsCounted({ ...state, traps: { ...state.traps, plate } }, "s1"), "s1"), 16, "a trap without a pit counts nothing");
  });

  test("a stair beside a pit can take its way up from the pit's floor, so its whole flight counts as pieces of its own", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { bounds: { w: 12, h: 12 }, vision: { on: true } as never });
    // A ledge along y = 6, the ground north of it lower, with a stair on it at (5, 6) and a pit south of the stair.
    for (let x = 0; x < 12; x++) setGround(state, "s1", x, 5, -5);
    const key = chunkKey("s1", 0, 0);
    state.buildChunks[key] = { ...state.buildChunks[key]!, cells: { "5,6": "stairs" } };
    const t = trap("pit", { zone: { cells: [{ x: 5, y: 7, w: 1, h: 1 }] } });
    // A pit's floor may lie above its lid: opened, it is the stair's one higher neighbor, so the stair points south.
    t.rig = { ...t.rig!, pit: { floor: 10 } };
    state.traps.pit = t;
    const open = counts(opened(state, [t]));
    const counted = counts(withPitsCounted(state, "s1"));
    assert.ok(open.sight <= counted.sight, `${open.sight} open, ${counted.sight} counted`);
  });

  test("the scenes an op's traps move: a pit made, deleted, moved or its pit set or cleared, and not a pit's other fields", () => {
    const pit = trap("pit", { zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] } });
    pit.rig = { ...pit.rig!, pit: { floor: -10 } };
    const none = { traps: {} };
    const one = { traps: { pit } };
    assert.deepEqual(pitsMoved(none, one, ["pit"]), ["s1"]);
    assert.deepEqual(pitsMoved(one, none, ["pit"]), ["s1"]);
    assert.deepEqual(pitsMoved(one, { traps: { pit: { ...pit, name: "Renamed", rig: { ...pit.rig!, pit: { floor: -20 } } } } }, ["pit"]), []);
    assert.deepEqual(pitsMoved(one, { traps: { pit: { ...pit, zone: { cells: [{ x: 5, y: 4, w: 2, h: 2 }] } } } }, ["pit"]), ["s1"]);
    const { pit: _pit, ...rig } = pit.rig!;
    assert.deepEqual(pitsMoved(one, { traps: { pit: { ...pit, rig } } }, ["pit"]), ["s1"]);
    assert.deepEqual(pitsMoved(none, { traps: { plate: trap("plate") } }, ["plate"]), []);
  });
});
