import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, holderChunkKey, holderTileKey, keys, tileKey } from "../keys.ts";
import type { FogTile, Label, MemoryChunk, MemoryEntries, RoomState, Scene, Stamp } from "../model.ts";
import { projectEntity, projectState } from "../project.ts";
import type { MemoryEntriesInput, Op, OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { decodeTile, encodeTile, getBit, rasterizeFogOps } from "../rules/fog.ts";
import { DM, P1, apply, env, member, refused, room, scene } from "../testutil.ts";
import { derivedId } from "./duplicate.ts";

/**
 * Players' memory in the reducer (docs/design-v1-map-discovery.md 5.3 to
 * 5.5, lane MD1): the map step's `sys.remember` as stored, and everything
 * else that changes a layer's memory as bookkeeping: hides, Fog all,
 * forgetting tiles, vision or fog off, the shape switch, a scene's
 * deletion, a holder unticked or removed, the fold, a stamp made DM only
 * and Duplicate with Fog, beside the played marks.
 */

const WALL = { id: "abcdefghijkl", a: [1, 1.5] as [number, number], b: [3, 1.5] as [number, number], f: { kind: "wall" as const } };

/** A tile of a layer with these cell rectangles revealed. */
function tiles(sceneId: string, bounds: Scene["bounds"], rects: readonly { x: number; y: number; w: number; h: number }[]): Record<string, FogTile> {
  const changes = rasterizeFogOps({}, sceneId, bounds, rects.map((r, i) => ({ id: `r${i}`, mode: "reveal" as const, shape: { kind: "rect" as const, ...r } })));
  return Object.fromEntries(Object.entries(changes).filter((e): e is [string, FogTile] => e[1] !== null));
}

function chunk(sceneId: string, cx: number, cy: number, entries: MemoryEntries, memberId?: string): MemoryChunk {
  return { sceneId, cx, cy, rev: 0, ...(memberId === undefined ? {} : { memberId }), ...entries };
}

const label = (id: string, x: number, y: number, text = "Hall"): Label => ({ id, rev: 0, sceneId: "s1", x, y, text, size: 1 });
const stamp = (id: string, x: number, y: number, overrides: Partial<Stamp> = {}): Stamp => ({ id, rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x, y, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", ...overrides });

/**
 * A whole-party scene with fog and vision on, the party having explored
 * cells 0 to 9 by 0 to 4 (the north west of tile 0,0) and cells 20 to 23
 * by 0 to 1 in tile 1,0, and memory of some of it.
 */
function remembered(memory: MemoryChunk[] = []): RoomState {
  const s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
  const state = room({ scenes: { s1, s2: scene("s2", { order: 1 }) } });
  state.exploredTiles = tiles("s1", s1.bounds, [
    { x: 0, y: 0, w: 10, h: 5 },
    { x: 20, y: 0, w: 4, h: 2 },
  ]);
  state.memory = Object.fromEntries(memory.map((c) => [chunkKey(c.sceneId, c.cx, c.cy), c]));
  return state;
}

/**
 * A per-player scene where p1 and p2 see for themselves, in that order on
 * the list, p1's own layer holding cells 30 to 33 by 10 to 11 and p2's
 * cells 30 to 31 by 10 to 13, beside the party's layer of `remembered`.
 */
function perPlayer(memory: MemoryChunk[] = []): RoomState {
  const state = remembered(memory.filter((c) => c.memberId === undefined));
  const s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark" as const, perPlayer: true as const } };
  state.scenes.s1 = s1;
  state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  const own = (memberId: string, rect: { x: number; y: number; w: number; h: number }) =>
    Object.values(tiles("s1", s1.bounds, [rect])).map((t) => [holderTileKey("s1", memberId, t.tx, t.ty), { ...t, memberId }] as const);
  state.exploredBy = Object.fromEntries([...own("p1", { x: 30, y: 10, w: 4, h: 2 }), ...own("p2", { x: 30, y: 10, w: 2, h: 4 })]);
  state.memoryBy = Object.fromEntries(memory.filter((c) => c.memberId !== undefined).map((c) => [holderChunkKey(c.sceneId, c.memberId!, c.cx, c.cy), c]));
  return state;
}

const SERVER = DM;
const rememberOp = (fields: Partial<OpOf<"sys.remember">>): Op => ({ t: "sys.remember", sceneId: "s1", layers: [], ...fields });
const party = (state: RoomState, cx = 0, cy = 0) => state.memory?.[chunkKey("s1", cx, cy)];
const own = (state: RoomState, memberId: string, cx = 0, cy = 0) => state.memoryBy?.[holderChunkKey("s1", memberId, cx, cy)];
const entriesOf = (c: MemoryChunk | undefined): MemoryEntries | undefined => {
  if (!c) return undefined;
  const { sceneId: _s, cx: _x, cy: _y, rev: _r, memberId: _m, ...rest } = c;
  return rest;
};
/** Whether a layer's tile reveals the sub-cell at the middle of a cell. */
const explored = (tile: FogTile | undefined, x: number, y: number) => {
  const bits = tile ? decodeTile(tile.bits) : null;
  return bits !== null && getBit(bits, (x % 16) * 4 + 1, (y % 16) * 4 + 1);
};

describe("sys.remember (5.3)", () => {
  test("writes each layer's chunks as the step found them, in one stored form, as bookkeeping no undo takes back", () => {
    const start = perPlayer();
    const r = applyOp(
      start,
      rememberOp({
        layers: [
          { chunks: [{ cx: 0, cy: 0, set: { cells: { "1,1": "stone", "2,1": null }, edges: { "2,1,w": "auto" }, labels: { l1: label("l1", 2, 2) } } }] },
          { memberId: "p1", chunks: [{ cx: 1, cy: 0, set: { walls: {} as never, heights: { "31,10": 5 } } }] },
        ],
      }),
      SERVER,
      env(1),
    );
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.deepEqual(party(r.state), { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone", "2,1": null }, edges: { "2,1,w": "auto" }, labels: { l1: label("l1", 2, 2) } });
    // A kind that names nothing is not stored, so two chunks remembering the same are the same bytes.
    assert.deepEqual(own(r.state, "p1", 1, 0), { sceneId: "s1", cx: 1, cy: 0, rev: 1, memberId: "p1", heights: { "31,10": 5 } });
    assert.equal(r.inverse, null);
    assert.deepEqual(r.touched, [keys.memory("s1", 0, 0), keys.memoryBy("s1", "p1", 1, 0)]);
  });

  test("drops keys before it sets entries, and takes away a chunk left with none", () => {
    const start = remembered([chunk("s1", 0, 0, { cells: { "1,1": "stone", "2,1": "wood" }, rough: { "1,1": true } })]);
    const next = apply(start, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, drop: { cells: ["1,1", "2,1"] }, set: { cells: { "2,1": null } } }] }] }), SERVER);
    assert.deepEqual(entriesOf(party(next)), { cells: { "2,1": null }, rough: { "1,1": true } });
    const empty = apply(next, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, drop: { cells: ["2,1"], rough: ["1,1"] } }] }] }), SERVER);
    assert.equal(party(empty), undefined);
    assert.deepEqual(empty.memory, {});
    // Setting what a chunk holds already writes nothing.
    const same = applyOp(next, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, set: { cells: { "2,1": null } } }] }] }), SERVER, env(2));
    assert.ok(same.ok);
    assert.deepEqual(same.touched, []);
  });

  test("only on a scene with fog and party vision on, and a holder's only while they see for themselves", () => {
    const set = { cx: 0, cy: 0, set: { cells: { "1,1": null } } };
    const fogOnly = remembered();
    fogOnly.scenes.s1 = { ...fogOnly.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.equal(refused(fogOnly, rememberOp({ layers: [{ chunks: [set] }] }), SERVER).code, "invalid");
    const fogOff = remembered();
    fogOff.scenes.s1 = { ...fogOff.scenes.s1!, fogEnabled: false };
    assert.equal(refused(fogOff, rememberOp({ layers: [{ chunks: [set] }] }), SERVER).code, "invalid");
    assert.match(refused(remembered(), rememberOp({ layers: [{ memberId: "p1", chunks: [set] }] }), SERVER).message, /whole party/);
    const unticked = perPlayer();
    unticked.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: false }, { memberId: "p2", on: true }] };
    assert.match(refused(unticked, rememberOp({ layers: [{ memberId: "p1", chunks: [set] }] }), SERVER).message, /sees for themselves/);
    assert.match(refused(unticked, rememberOp({ forget: [{ memberId: "p1", tiles: [{ tx: 1, ty: 0 }] }] }), SERVER).message, /sees for themselves/);
    apply(unticked, rememberOp({ layers: [{ memberId: "p2", chunks: [set] }] }), SERVER);
  });

  test("files each entry where the build does, and keeps a DM-only stamp's art out of every memory", () => {
    const at = (entries: MemoryEntriesInput, cx = 0, cy = 0) => refused(remembered(), rememberOp({ layers: [{ chunks: [{ cx, cy, set: entries }] }] }), SERVER).message;
    assert.match(at({ cells: { "16,1": null } }), /outside its chunk/);
    assert.match(at({ edges: { "1,16,n": null } }), /outside its chunk/);
    assert.match(at({ heights: { "1,1": 5 } }, 1, 0), /outside its chunk/);
    assert.match(at({ walls: { zzzzzzzzzzzz: [{ wall: WALL, cells: ["1,1"] }] } }), /own id/);
    assert.match(at({ walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1"] }] } }, 1, 0), /own id in its own chunk/);
    assert.match(at({ walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1"] }, { wall: null, cells: ["1,1", "2,1"] }] } }), /cell twice/);
    assert.match(at({ labels: { l2: label("l1", 1, 1) } }), /own id/);
    assert.match(at({ labels: { l1: { ...label("l1", 1, 1), sceneId: "s2" } } }), /own scene/);
    const hidden = remembered();
    hidden.stamps.st1 = stamp("st1", 2, 2, { visibility: "dm" });
    assert.match(refused(hidden, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, set: { stamps: { st1: { ...stamp("st1", 2, 2), visibility: "all" } } } }] }] }), SERVER).message, /DM keeps/);
    // That it was absent then is no art, so it may be remembered.
    apply(hidden, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, set: { stamps: { st1: null } } }] }] }), SERVER);
    // A wall's versions cover its cells across the chunk border.
    apply(remembered(), rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, set: { walls: { abcdefghijkl: [{ wall: { ...WALL, a: [14, 1.5], b: [17, 1.5] }, cells: ["15,1", "16,1"] }] } } }] }] }), SERVER);
  });

  test("a label or stamp lies in one chunk of a layer only, so it is found by its id", () => {
    const start = remembered([chunk("s1", 0, 0, { labels: { l1: label("l1", 2, 2) } })]);
    assert.match(refused(start, rememberOp({ layers: [{ chunks: [{ cx: 1, cy: 0, set: { labels: { l1: label("l1", 21, 1) } } }] }] }), SERVER).message, /two chunks/);
    const moved = apply(start, rememberOp({ layers: [{ chunks: [{ cx: 0, cy: 0, drop: { labels: ["l1"] } }, { cx: 1, cy: 0, set: { labels: { l1: label("l1", 21, 1) } } }] }] }), SERVER);
    assert.equal(party(moved), undefined);
    assert.deepEqual(entriesOf(party(moved, 1, 0)), { labels: { l1: label("l1", 21, 1) } });
  });
});

describe("forgetting whole tiles past the cap (5.3)", () => {
  test("a tile keeps only the sub-cells of its keep that the layer held, and goes when none are left", () => {
    const start = remembered();
    const keep = Object.values(tiles("s1", start.scenes.s1!.bounds, [{ x: 0, y: 0, w: 2, h: 2 }, { x: 30, y: 10, w: 2, h: 2 }]));
    const next = apply(start, rememberOp({ forget: [{ tiles: [{ tx: 0, ty: 0, keep: keep.find((t) => t.tx === 0)!.bits }, { tx: 1, ty: 0 }, { tx: 2, ty: 1 }] }] }), SERVER);
    const kept = next.exploredTiles[tileKey("s1", 0, 0)];
    assert.ok(explored(kept, 1, 1) && !explored(kept, 5, 3), "the sight's sub-cells stay, the rest goes");
    assert.equal(next.exploredTiles[tileKey("s1", 1, 0)], undefined);
    assert.equal(next.exploredTiles[tileKey("s1", 2, 1)], undefined);
    // A keep wider than what the layer held never reveals more.
    const wide = apply(start, rememberOp({ forget: [{ tiles: [{ tx: 0, ty: 0, keep: encodeTile(new Uint8Array(512).fill(255)) }] }] }), SERVER);
    assert.deepEqual(wide.exploredTiles, start.exploredTiles);
  });

  test("drops the entries of every element the layer no longer holds, and keeps those still held through another tile", () => {
    const start = remembered([
      chunk("s1", 0, 0, { cells: { "1,1": "stone" }, edges: { "9,1,n": "auto" }, labels: { l1: label("l1", 15.8, 1, "Hallway") } }),
      chunk("s1", 1, 0, { cells: { "21,1": null }, walls: { abcdefghijkl: [{ wall: { ...WALL, a: [14, 1.5], b: [18, 1.5] }, cells: ["15,1", "16,1"] }, { wall: null, cells: ["21,1"] }] } }),
    ]);
    // The label's box runs from cell 14 into cell 16 (16 in tile 1,0), and the wall was filed in chunk 1,0 across both.
    start.memory![chunkKey("s1", 1, 0)]!.walls!.abcdefghijkl![0]!.wall = { ...WALL, a: [15, 1.5], b: [17, 1.5] };
    start.exploredTiles = tiles("s1", start.scenes.s1!.bounds, [{ x: 0, y: 0, w: 16, h: 5 }, { x: 16, y: 0, w: 8, h: 2 }]);
    const next = apply(start, rememberOp({ forget: [{ tiles: [{ tx: 1, ty: 0 }] }] }), SERVER);
    assert.deepEqual(entriesOf(party(next)), { cells: { "1,1": "stone" }, edges: { "9,1,n": "auto" }, labels: { l1: label("l1", 15.8, 1, "Hallway") } }, "the label is still held through cell 15");
    assert.deepEqual(entriesOf(party(next, 1, 0)), { walls: { abcdefghijkl: [{ wall: { ...WALL, a: [15, 1.5], b: [17, 1.5] }, cells: ["15,1"] }] } });
  });

  test("a holder forgets their own tiles and memory, never the party's", () => {
    const start = perPlayer([chunk("s1", 0, 0, { cells: { "1,1": null } }), chunk("s1", 1, 0, { cells: { "30,10": "wood" } }, "p1")]);
    const next = apply(start, rememberOp({ forget: [{ memberId: "p1", tiles: [{ tx: 1, ty: 0 }] }] }), SERVER);
    assert.equal(own(next, "p1", 1, 0), undefined);
    assert.equal(next.exploredBy[holderTileKey("s1", "p1", 1, 0)], undefined);
    assert.ok(next.exploredBy[holderTileKey("s1", "p2", 1, 0)]);
    assert.deepEqual(next.exploredTiles, start.exploredTiles);
    assert.deepEqual(party(next), party(start));
  });
});

describe("hides and Fog all (5.4)", () => {
  const hide = (rect: { x: number; y: number; w: number; h: number }): Op => ({ t: "fog.live", sceneId: "s1", ops: [{ id: "h", mode: "hide", shape: { kind: "rect", ...rect } }] });

  test("a hide drops an entry only once its element touches no cell its layer still holds", () => {
    const edges = { "5,1,w": { kind: "wall" as const }, "7,5,n": "auto" as const, "6,1,n": null };
    const start = remembered([chunk("s1", 0, 0, { cells: { "1,1": "stone", "8,1": "wood" }, edges, labels: { l1: label("l1", 4.5, 3, "Long hallway") }, stamps: { st1: stamp("st1", 8.5, 3.5) } })]);
    // Cells 0 to 4 go: cell 1 with them, and the edge west of cell 5 stays with cell 5, the label with what is left of it.
    const next = apply(start, hide({ x: 0, y: 0, w: 5, h: 5 }));
    assert.deepEqual(entriesOf(party(next)), { cells: { "8,1": "wood" }, edges, labels: { l1: label("l1", 4.5, 3, "Long hallway") }, stamps: { st1: stamp("st1", 8.5, 3.5) } });
    // An edge goes by either cell beside it: north of cell 7,5, which nobody explored, it stays with 7,4, and north of 6,1 with 6,0.
    const row = apply(next, hide({ x: 6, y: 1, w: 1, h: 1 }));
    assert.deepEqual(entriesOf(party(row))?.edges, edges);
    const all = apply(next, hide({ x: 0, y: 0, w: 10, h: 5 }));
    assert.equal(party(all), undefined);
  });

  test("a label or stamp is judged by the box remembered and the box it has now", () => {
    const start = remembered([chunk("s1", 0, 0, { labels: { l1: label("l1", 2, 2) }, stamps: { st1: null } })]);
    // The label moved out of sight to cell 8, and the stamp came there: each still touches ground the party holds.
    start.labels.l1 = label("l1", 8.5, 2);
    start.stamps.st1 = stamp("st1", 8.5, 3.5);
    const next = apply(start, hide({ x: 0, y: 0, w: 5, h: 5 }));
    assert.deepEqual(entriesOf(party(next)), { labels: { l1: label("l1", 2, 2) }, stamps: { st1: null } });
    assert.equal(party(apply(next, hide({ x: 5, y: 0, w: 5, h: 5 }))), undefined);
  });

  test("a hide takes the cells it hid off each free wall's versions", () => {
    const start = remembered([chunk("s1", 0, 0, { walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1", "2,1"] }, { wall: null, cells: ["3,1"] }] } })]);
    const next = apply(start, hide({ x: 2, y: 0, w: 2, h: 5 }));
    assert.deepEqual(entriesOf(party(next)), { walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1"] }] } });
  });

  test("a holder's memory follows their own layer, and a hide there leaves the party's", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "stone", "33,10": "wood" } }, "p1"), chunk("s1", 1, 0, { cells: { "31,13": null } }, "p2"), chunk("s1", 0, 0, { cells: { "1,1": null } })]);
    const next = apply(start, hide({ x: 32, y: 10, w: 2, h: 4 }));
    assert.deepEqual(entriesOf(own(next, "p1", 1, 0)), { cells: { "30,10": "stone" } });
    assert.deepEqual(entriesOf(own(next, "p2", 1, 0)), { cells: { "31,13": null } });
    assert.deepEqual(party(next), party(start));
  });

  test("a reveal leaves memory to the map step", () => {
    const start = remembered([chunk("s1", 0, 0, { cells: { "1,1": "stone" } })]);
    const next = apply(start, { t: "fog.live", sceneId: "s1", ops: [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 10, h: 10 } }] });
    assert.deepEqual(next.memory, start.memory);
  });

  test("Fog all forgets every layer's memory with the layers", () => {
    const start = perPlayer([chunk("s1", 0, 0, { cells: { "1,1": null } }), chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1")]);
    start.fogTiles = tiles("s1", start.scenes.s1!.bounds, [{ x: 0, y: 20, w: 4, h: 4 }]);
    const r = applyOp(start, { t: "fog.reset", sceneId: "s1", to: "hidden" }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual([r.state.memory, r.state.memoryBy, r.state.exploredTiles, r.state.exploredBy], [{}, {}, {}, {}]);
    // Undo puts the DM's fog back, never what players remembered.
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 2);
    assert.deepEqual([undone.memory, undone.memoryBy], [{}, {}]);
  });
});

describe("explored ground lost by any path (5.4)", () => {
  const bounds = (w: number): Op => ({ t: "scene.update", sceneId: "s1", patch: { bounds: { w, h: 30 } } });

  test("a per-player scene shrinking drops every layer's memory past its bounds, and keeps an element still held through a cell inside", () => {
    const start = perPlayer([
      chunk("s1", 0, 0, { cells: { "1,1": "wood" } }),
      chunk("s1", 1, 0, { cells: { "21,1": "stone" }, edges: { "16,1,w": { kind: "wall" } } }),
      chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1"),
      chunk("s1", 1, 0, { cells: { "31,13": null } }, "p2"),
    ]);
    // The party's ground runs from cell 12 to 23 across the line between tiles 0 and 1.
    start.exploredTiles = tiles("s1", start.scenes.s1!.bounds, [{ x: 0, y: 0, w: 10, h: 5 }, { x: 12, y: 0, w: 12, h: 2 }]);
    const r = applyOp(start, bounds(16), DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.state.exploredBy), []);
    // The edge west of cell 16 stays with cell 15, inside.
    assert.deepEqual(entriesOf(party(r.state, 1, 0)), { edges: { "16,1,w": { kind: "wall" } } });
    assert.deepEqual(party(r.state), party(start));
    assert.deepEqual(r.state.memoryBy, {});
    assert.ok(!r.inverse!.some((e) => e.key.startsWith("memory")), "outside the undo step");
    // Growing back by the undo brings back none of it.
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 2);
    assert.deepEqual([entriesOf(party(undone, 1, 0)), undone.memoryBy], [{ edges: { "16,1,w": { kind: "wall" } } }, {}]);
  });

  test("a whole-party scene keeps memory past its bounds with its tiles, until it turns per player", () => {
    const start = remembered([chunk("s1", 0, 0, { cells: { "1,1": "wood" } }), chunk("s1", 1, 0, { cells: { "21,1": "stone" } })]);
    const shrunk = apply(start, bounds(16));
    assert.deepEqual(shrunk.memory, start.memory);
    const split = apply(shrunk, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: true } } }, DM, 2);
    assert.deepEqual(Object.keys(split.memory!), [chunkKey("s1", 0, 0)]);
  });

  test("a restore that shrinks a per-player scene drops what lay past its new bounds", () => {
    const start = perPlayer();
    const small = apply(start, bounds(16));
    const grow = applyOp(small, bounds(40), DM, env(2));
    assert.ok(grow.ok);
    const bits = Object.values(tiles("s1", { w: 40, h: 30 }, [{ x: 30, y: 10, w: 4, h: 2 }]))[0]!.bits;
    let state = apply(grow.state, { t: "sys.explore", sceneId: "s1", tiles: [], members: [{ memberId: "p1", tiles: [{ tx: 1, ty: 0, bits }] }] }, SERVER, 3);
    state = apply(state, rememberOp({ layers: [{ memberId: "p1", chunks: [{ cx: 1, cy: 0, set: { cells: { "30,10": "stone" } } }] }] }), SERVER, 4);
    assert.ok(own(state, "p1", 1, 0));
    const undone = apply(state, { t: "sys.restore", entries: grow.inverse!, from: "undo" }, DM, 5);
    assert.equal(undone.scenes.s1!.bounds.w, 16);
    assert.deepEqual(undone.memoryBy, {});
  });
});

describe("a scene's settings (5.4)", () => {
  const memoryOf = (state: RoomState) => [Object.keys(state.memory ?? {}), Object.keys(state.memoryBy ?? {})];
  const start = () => {
    const state = perPlayer([chunk("s1", 0, 0, { cells: { "1,1": null } }), chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1")]);
    state.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    state.memoryShared = { s1: { sceneId: "s1", rev: 0 } };
    return state;
  };

  test("vision off forgets every layer's memory and the share mark, by an edit and by an undo alike", () => {
    for (const patch of [{ vision: { on: false, light: "dark" as const } }, { fogEnabled: false }]) {
      const r = applyOp(start(), { t: "scene.update", sceneId: "s1", patch }, DM, env(1));
      assert.ok(r.ok);
      assert.deepEqual(memoryOf(r.state), [[], []], JSON.stringify(patch));
      assert.deepEqual(r.state.memoryShared, {});
      assert.deepEqual(r.state.playedScenes, { s1: { sceneId: "s1", rev: 0 } }, "the played mark stays while the scene does");
      // An undo of turning it on, with memory gathered since, forgets it the same way.
      const back = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 2);
      const again = { ...back, memory: start().memory };
      const redo = apply(again, { t: "sys.restore", entries: [{ key: keys.scene("s1"), value: r.state.scenes.s1 }], from: "redo" }, DM, 3);
      assert.deepEqual(memoryOf(redo), [[], []], "the redo's restore forgets as the edit did");
    }
  });

  test("any other change keeps it", () => {
    const r = applyOp(start(), { t: "scene.update", sceneId: "s1", patch: { name: "Crypt", vision: { on: true, light: "dim" } } }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(memoryOf(r.state), memoryOf(start()));
    assert.deepEqual(r.state.memoryShared, start().memoryShared);
  });

  test("a grid shape switch forgets the scene's memory and the ground players explored there", () => {
    const state = start();
    const r = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexRows" } }, DM, env(1));
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.deepEqual(memoryOf(r.state), [[], []]);
    assert.deepEqual([r.state.exploredTiles, r.state.exploredBy], [{}, {}]);
    // An op stored before map discovery replays as it did then, its explored ground kept (MD-R6-1).
    const old = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexRows" } }, DM, { ...env(1), opVersion: 25 });
    assert.ok(old.ok);
    assert.deepEqual(old.state.exploredTiles, state.exploredTiles);
  });

  test("a scene that goes takes its memory and both marks with it", () => {
    const state = start();
    state.meta.playerSceneId = "s2";
    const r = applyOp(state, { t: "scene.delete", sceneId: "s1" }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(memoryOf(r.state), [[], []]);
    assert.deepEqual([r.state.playedScenes, r.state.memoryShared], [{}, {}]);
  });
});

describe("holders (5.4)", () => {
  test("unticking a holder forgets their memory with their layer, and leaves the others'", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1"), chunk("s1", 1, 0, { cells: { "31,13": null } }, "p2")]);
    const next = apply(start, { t: "vision.holders", sceneId: "s1", on: ["p2"] });
    assert.equal(own(next, "p1", 1, 0), undefined);
    assert.ok(own(next, "p2", 1, 0));
  });

  test("a member's removal forgets their memory, and so does their becoming a DM", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1"), chunk("s1", 1, 0, { cells: { "31,13": null } }, "p2")]);
    start.members.p3 = member("p3");
    const removed = apply(start, { t: "sys.memberRemove", memberId: "p1" });
    assert.deepEqual(Object.keys(removed.memoryBy ?? {}), ["s1:p2:1,0"]);
    const promoted = apply(start, { t: "sys.memberSetKind", memberId: "p2", kind: "dm" });
    assert.deepEqual(Object.keys(promoted.memoryBy ?? {}), ["s1:p1:1,0"]);
  });

  test("a holder with memory but no tile of their own left still loses it once they stop seeing for themselves", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1")]);
    for (const key of Object.keys(start.exploredBy)) if (key.includes(":p1:")) delete start.exploredBy[key];
    const next = apply(start, { t: "sys.memberSetKind", memberId: "p1", kind: "dm" });
    assert.deepEqual(next.memoryBy, {});
  });
});

describe("the fold to Whole party (5.4)", () => {
  const fold = (state: RoomState) => apply(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } });

  test("an element the party's layer held keeps the party's entry or none, whatever a holder remembers", () => {
    const start = perPlayer([
      chunk("s1", 0, 0, { cells: { "1,1": "stone" } }),
      chunk("s1", 0, 0, { cells: { "1,1": "wood", "2,1": "grass" } }, "p1"),
    ]);
    // p1's own layer holds cells 1 and 2 too, which the party held already.
    for (const t of Object.values(tiles("s1", start.scenes.s1!.bounds, [{ x: 0, y: 0, w: 4, h: 2 }]))) start.exploredBy[holderTileKey("s1", "p1", t.tx, t.ty)] = { ...t, memberId: "p1" };
    const next = fold(start);
    assert.deepEqual(entriesOf(party(next)), { cells: { "1,1": "stone" } });
    assert.deepEqual(next.memoryBy, {});
    assert.deepEqual(next.holders, {});
  });

  test("any other takes the first holder's in list order whose own layer holds it, or none", () => {
    const start = perPlayer([
      // Cell 30,10 both hold: p1 first on the list, who saw it as it is now. Cell 31,13 only p2 holds.
      chunk("s1", 1, 0, { cells: { "33,10": "stone" } }, "p1"),
      chunk("s1", 1, 0, { cells: { "30,10": "wood", "31,13": null } }, "p2"),
    ]);
    const next = fold(start);
    assert.deepEqual(entriesOf(party(next, 1, 0)), { cells: { "33,10": "stone", "31,13": null } });
    // The party's layer took both holders' ground.
    assert.ok(explored(next.exploredTiles[tileKey("s1", 1, 0)], 31, 13));
  });

  test("the list's order decides, not the members' ids", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "wood" } }, "p1"), chunk("s1", 1, 0, { cells: { "30,10": "grass" } }, "p2")]);
    start.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p2", on: true }, { memberId: "p1", on: true }] };
    assert.deepEqual(entriesOf(party(fold(start), 1, 0)), { cells: { "30,10": "grass" } });
  });

  test("a free wall pools per cell", () => {
    const wall = { ...WALL, id: "mnopqrstuvwx", a: [29, 10.5] as [number, number], b: [34, 10.5] as [number, number] };
    const window = { ...wall, f: { kind: "window" as const } };
    const start = perPlayer([
      // The party held none of these cells. p1 holds 30 to 33 and p2 30 and 31: p1, first, decides each.
      chunk("s1", 1, 0, { walls: { mnopqrstuvwx: [{ wall: window, cells: ["30,10", "31,10"] }] } }, "p1"),
      chunk("s1", 1, 0, { walls: { mnopqrstuvwx: [{ wall, cells: ["30,10", "31,10"] }, { wall: null, cells: ["29,10"] }] } }, "p2"),
    ]);
    // 29,10 no holder's layer holds, so it reads live.
    assert.deepEqual(entriesOf(party(fold(start), 1, 0)), { walls: { mnopqrstuvwx: [{ wall: window, cells: ["30,10", "31,10"] }] } });
    start.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p2", on: true }, { memberId: "p1", on: true }] };
    assert.deepEqual(entriesOf(party(fold(start), 1, 0)), { walls: { mnopqrstuvwx: [{ wall, cells: ["30,10", "31,10"] }] } });
  });

  test("a label pools by its id, in the chunk of the layer it reads from", () => {
    const start = perPlayer([chunk("s1", 0, 0, { labels: { l9: label("l9", 1, 1) } }), chunk("s1", 1, 0, { labels: { l1: label("l1", 31, 10.5) } }, "p2")]);
    const next = fold(start);
    assert.deepEqual(entriesOf(party(next, 1, 0)), { labels: { l1: label("l1", 31, 10.5) } });
    assert.deepEqual(entriesOf(party(next)), { labels: { l9: label("l9", 1, 1) } });
  });

  test("keeps the scene's share mark and its played mark: the scene still remembers, now in one layer (ASTRA-22)", () => {
    const start = perPlayer([chunk("s1", 1, 0, { cells: { "30,10": "wood" } }, "p1")]);
    start.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    start.memoryShared = { s1: { sceneId: "s1", rev: 0 } };
    const next = fold(start);
    assert.deepEqual([next.playedScenes, next.memoryShared], [start.playedScenes, start.memoryShared]);
  });

  test("a scene that was never per player has nothing to pool", () => {
    const start = remembered([chunk("s1", 0, 0, { cells: { "1,1": "stone" } })]);
    assert.deepEqual(apply(start, { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } }).memory, start.memory);
  });
});

describe("a stamp made DM only (5.4)", () => {
  test("drops from every layer's memory, so its art stops reaching players, by an edit or an undo", () => {
    const start = perPlayer([chunk("s1", 0, 0, { stamps: { st1: stamp("st1", 2, 2), st2: stamp("st2", 3, 3) } }), chunk("s1", 1, 0, { stamps: { st1: stamp("st1", 31, 10) } }, "p1")]);
    start.stamps = { st1: stamp("st1", 5, 5), st2: stamp("st2", 3, 3) };
    const next = apply(start, { t: "build.stamps", sceneId: "s1", put: [{ ...stamp("st1", 5, 5), visibility: "dm" }] });
    assert.deepEqual(entriesOf(party(next)), { stamps: { st2: stamp("st2", 3, 3) } });
    assert.equal(own(next, "p1", 1, 0), undefined);
    const restored = apply(start, { t: "sys.restore", entries: [{ key: keys.stamp("st2"), value: { ...stamp("st2", 3, 3), visibility: "dm" } }], from: "undo" });
    assert.deepEqual(entriesOf(party(restored)), { stamps: { st1: stamp("st1", 2, 2) } });
    // A stamp shown to players keeps its memory.
    assert.deepEqual(apply(start, { t: "build.stamps", sceneId: "s1", put: [{ ...stamp("st2", 4, 4) }] }).memory, start.memory);
  });
});

describe("the played mark (5.5)", () => {
  test("marks the scene a move of the players makes theirs, once, by any route", () => {
    const start = remembered();
    start.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    const r = applyOp(start, { t: "room.setPlayerScene", sceneId: "s2" }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.state.playedScenes!).sort(), ["s1", "s2"]);
    assert.ok(r.touched.includes(keys.played("s2")));
    // Outside the undo step: the move's undo moves the players back and the mark stays.
    assert.ok(!r.inverse!.some((e) => e.key === keys.played("s2")));
    const back = applyOp(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, env(2));
    assert.ok(back.ok);
    assert.deepEqual(Object.keys(back.state.playedScenes!).sort(), ["s1", "s2"]);
    assert.deepEqual(back.touched.filter((k) => k.startsWith("played:")), [], "s1 was marked already");
    // An undo that makes a scene theirs marks it too.
    const unmarked = { ...r.state, playedScenes: { s2: r.state.playedScenes!.s2! } };
    assert.ok(apply(unmarked, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 2).playedScenes!.s1);
    // A move to where they are already marks nothing.
    const same = applyOp(r.state, { t: "room.setPlayerScene", sceneId: "s2" }, DM, env(3));
    assert.ok(same.ok && !same.touched.some((k) => k.startsWith("played:")));
  });

  test("a deletion that moves the players marks where they land, whatever its settings", () => {
    const start = remembered();
    // Only an op stored before canApply refused the players' scene reaches this (reducer/room.ts), and it is marked as any other.
    const r = applyOp(start, { t: "scene.delete", sceneId: "s1" }, DM, env(1));
    assert.ok(r.ok);
    assert.equal(r.state.meta.playerSceneId, "s2");
    assert.deepEqual(r.state.playedScenes, { s2: { sceneId: "s2", rev: 1 } });
  });

  test("ops stored before map discovery replay without a mark, and later ones mark the scene they move the players to (MD-R6-1)", () => {
    const start = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
    const move: Op = { t: "room.setPlayerScene", sceneId: "s2" };
    const old = applyOp(start, move, DM, { ...env(1), opVersion: 25 });
    assert.ok(old.ok);
    assert.deepEqual(old.state.playedScenes, {});
    assert.ok(!old.touched.some((key) => key.startsWith("played:")));
    for (const opVersion of [26, undefined]) {
      const now = applyOp(start, move, DM, { ...env(1), ...(opVersion === undefined ? {} : { opVersion }) });
      assert.ok(now.ok);
      assert.deepEqual(now.state.playedScenes, { s2: { sceneId: "s2", rev: 1 } });
    }
  });
});

describe("Duplicate with Fog (5.4)", () => {
  test("copies every layer's memory onto the copy, its labels and stamps under the copies' ids, and the played mark", () => {
    const start = perPlayer([
      chunk("s1", 0, 0, { cells: { "1,1": null }, labels: { l1: label("l1", 2, 2), gone: null }, stamps: { st1: stamp("st1", 2, 2) } }),
      chunk("s1", 1, 0, { walls: { abcdefghijkl: [{ wall: null, cells: ["30,10"] }] } }, "p1"),
    ]);
    start.labels.l1 = label("l1", 2, 2);
    start.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    start.memoryShared = { s1: { sceneId: "s1", rev: 0 } };
    const op: Op = { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: false, characters: false, fog: true, drawings: false } };
    const r = applyOp(start, op, DM, env(1));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const id = (x: string) => derivedId("s9", x);
    assert.deepEqual(r.state.memory![chunkKey("s9", 0, 0)], {
      sceneId: "s9",
      cx: 0,
      cy: 0,
      rev: 1,
      cells: { "1,1": null },
      labels: { [id("gone")]: null, [id("l1")]: { ...label(id("l1"), 2, 2), sceneId: "s9" } },
      stamps: { [id("st1")]: { ...stamp(id("st1"), 2, 2), sceneId: "s9" } },
    });
    assert.ok(r.state.labels[id("l1")], "the remembered label names the copy's own label");
    assert.deepEqual(entriesOf(r.state.memoryBy![holderChunkKey("s9", "p1", 1, 0)]), { walls: { abcdefghijkl: [{ wall: null, cells: ["30,10"] }] } });
    assert.ok(r.state.playedScenes!.s9);
    assert.equal(r.state.memoryShared!.s9, undefined, "a copy reserves its memory whole");
    // Undo takes the copy away, and with the scene its memory and mark.
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 2);
    assert.deepEqual([Object.keys(undone.memory!), Object.keys(undone.memoryBy!), Object.keys(undone.playedScenes!)], [[chunkKey("s1", 0, 0)], [holderChunkKey("s1", "p1", 1, 0)], ["s1"]]);
    // Without the fog nothing of what players remember comes.
    const bare = apply(start, { ...op, include: { ...op.include, fog: false } } as Op);
    assert.deepEqual([Object.keys(bare.memory!), bare.playedScenes!.s9], [[chunkKey("s1", 0, 0)], undefined]);
  });
});

describe("what never reaches a projection (rule 3)", () => {
  test("memory and the marks are in no viewer's state or change", () => {
    const state = perPlayer([chunk("s1", 0, 0, { cells: { "1,1": null } }), chunk("s1", 1, 0, { cells: { "30,10": "stone" } }, "p1")]);
    state.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    state.memoryShared = { s1: { sceneId: "s1", rev: 0 } };
    for (const viewer of [DM, P1]) {
      const view = projectState(state, viewer, { sceneId: "s1" }) as Record<string, unknown>;
      for (const field of ["memory", "memoryBy", "playedScenes", "memoryShared"]) assert.equal(view[field], undefined, `${viewer.role} ${field}`);
      for (const key of [keys.memory("s1", 0, 0), keys.memoryBy("s1", "p1", 1, 0), keys.played("s1"), keys.memoryShared("s1")]) {
        assert.equal(projectEntity(key, state, viewer, { sceneId: "s1" }) ?? null, null, `${viewer.role} ${key}`);
      }
    }
  });
});

describe("the room's default for new scenes (8.2)", () => {
  test("is a setting a room update sets", () => {
    assert.equal(apply(room(), { t: "room.update", settings: { newScenePlayers: "reveal" } }).meta.settings.newScenePlayers, "reveal");
  });
});
