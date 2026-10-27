import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, holderChunkKey, holderTileKey } from "#shared/keys.ts";
import { LIMITS, MOST_SIGHT_HOLDERS } from "#shared/limits.ts";
import { migrateSnapshot } from "#shared/migrate.ts";
import type { FogTile, MemoryChunk, RememberedWall, RoomState } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { DM, env, member, room, scene } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Map discovery's stored fields (docs/design-v1-map-discovery.md 5.3 and
 * 5.5, lane MD1): each layer's memory, by the bounds the map step's ops
 * are held to, the scenes' marks, the room's default for new scenes and
 * the teleport line past what a player could not see. A stored chunk is
 * never a player's copy, so its player-only fields are refused.
 */
const WALL = { id: "abcdefghijkl", a: [1, 1] as [number, number], b: [3, 1] as [number, number], f: { kind: "wall" as const } };

function remembering(): RoomState {
  const s = room();
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  const chunk: MemoryChunk = {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 4,
    cells: { "1,1": "stone", "2,1": null },
    edges: { "1,1,n": "auto", "2,1,w": { kind: "door", state: "closed", secret: true, discovered: true }, "3,1,n": null },
    walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1", "2,1"] }, { wall: null, cells: ["3,1"] }] },
    heights: { "1,1": -5 },
    up: { "1,1": "a" },
    upDir: { "1,1": "w" },
    rough: { "1,1": false },
    labels: { l1: { id: "l1", rev: 1, sceneId: "s1", x: 1, y: 1, text: "Hall", size: 1 }, l2: null },
    stamps: { st1: { id: "st1", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" } },
  };
  s.memory = { "s1:0,0": chunk };
  s.memoryBy = { "s1:p1:0,0": { ...chunk, memberId: "p1" } };
  s.playedScenes = { s1: { sceneId: "s1", rev: 0 }, s2: { sceneId: "s2", rev: 1 } };
  s.memoryShared = { s1: { sceneId: "s1", rev: 0 } };
  s.meta.settings.newScenePlayers = "reveal";
  s.log = [{ id: "1:900000", at: "2026-10-26T20:00:00.000Z", kind: "event", data: { type: "teleport", tokenId: "t1", past: "unknown" } }];
  return s;
}

const parsed = (state: unknown) => parseRoomState(JSON.parse(JSON.stringify(state)));

describe("the stored-state schema and map discovery (lane MD1)", () => {
  test("takes each layer's memory, the marks, the default for new scenes and an unseen teleport, as stored", () => {
    const state = remembering();
    const out = parsed(state);
    assert.ok(out.ok, out.ok ? "" : out.message);
    assert.deepEqual(out.state, JSON.parse(JSON.stringify(state)));
  });

  test("a stored chunk refuses the fields only a player's copy carries (5.2)", () => {
    const s = room();
    for (const field of ["known", "auto", "upDir"]) {
      s.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: {}, [field]: "A" } as RoomState["buildChunks"][string] };
      assert.equal(parsed(s).ok, false, field);
    }
  });

  test("memory holds only what players saw, by the step's own bounds", () => {
    const bad = (change: (chunk: Record<string, unknown>) => void) => {
      const s = remembering();
      change(s.memory!["s1:0,0"] as unknown as Record<string, unknown>);
      return parsed(s).ok;
    };
    assert.equal(bad(() => {}), true);
    assert.equal(bad((c) => (c.edges = { "1,1,n": { kind: "door", state: "locked", secret: false, discovered: false } })), false);
    assert.equal(bad((c) => (c.edges = { "1,1,n": { kind: "door", state: "open", secret: true, discovered: false } })), false);
    assert.equal(bad((c) => (c.stamps = { st1: { ...remembering().memory!["s1:0,0"]!.stamps!.st1!, visibility: "dm" } })), false);
    assert.equal(bad((c) => (c.known = "A")), false);
    assert.equal(bad((c) => (c.cx = -1)), false);
    assert.equal(bad((c) => (c.walls = { abcdefghijkl: [{ wall: { ...WALL, b: WALL.a }, cells: ["1,1"] }] })), false, "a wall of no length");
  });

  test("files each chunk under its own scene, place and member, and each mark under its scene", () => {
    const ok = (change: (s: RoomState) => void) => {
      const s = remembering();
      change(s);
      return parsed(s).ok;
    };
    const party = (s: RoomState) => s.memory!["s1:0,0"]!;
    const own = (s: RoomState) => s.memoryBy!["s1:p1:0,0"]!;
    assert.equal(ok((s) => (s.memory = { "s1:1,0": party(s) })), false, "another place's key");
    assert.equal(ok((s) => (s.memory = { "s2:0,0": party(s) })), false, "another scene's key");
    assert.equal(ok((s) => (party(s).memberId = "p1")), false, "the party's chunk names no member");
    assert.equal(ok((s) => (s.memoryBy = { "s1:p2:0,0": own(s) })), false, "another member's key");
    assert.equal(ok((s) => (s.memoryBy = { "s1:0,0": { ...own(s), memberId: undefined } })), false, "a holder's chunk names its member");
    assert.equal(ok((s) => (s.playedScenes = { s2: { sceneId: "s1", rev: 0 } })), false);
    assert.equal(ok((s) => (s.memoryShared = { s2: { sceneId: "s1", rev: 0 } })), false);
    // Up to chunk 14, where a hex scene of the largest size files its memory.
    assert.equal(ok((s) => (s.memory = { "s1:14,14": { ...party(s), cx: 14, cy: 14 } })), true);
    assert.equal(ok((s) => (s.memory = { "s1:15,0": { ...party(s), cx: 15, cy: 0 } })), false);
  });

  test("a backup from before map discovery migrates in with none, and an import that names none starts with none", () => {
    const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...v26 } = room();
    const migrated = parsed(migrateSnapshot(structuredClone(v26), 26));
    assert.ok(migrated.ok && migrated.state.memory !== undefined);
    assert.deepEqual([migrated.state.memory, migrated.state.memoryBy, migrated.state.playedScenes, migrated.state.memoryShared], [{}, {}, {}, {}]);
    const bare = parsed(v26);
    assert.ok(bare.ok && bare.state.playedScenes !== undefined);
    assert.deepEqual(bare.state.playedScenes, {});
  });
});

describe("a fold of layers at their caps fits the stored schema (5.4, 5.5)", () => {
  const HOLDERS = Array.from({ length: MOST_SIGHT_HOLDERS }, (_, i) => `p${i + 1}`);
  const LAYERS = [null, ...HOLDERS];
  const ROWS = 11;
  const bytes = (value: unknown) => JSON.stringify(value).length;

  /**
   * A 200 by 200 per-player scene where the party and six holders each hold
   * a band of 11 rows of their own and remember, in chunk 0,0, as many
   * versions or walls as their cap holds, one cell each. `version(layer, i,
   * cell)` makes each layer's i-th entry.
   */
  function full(entry: (layer: number, i: number, cell: string) => [string, RememberedWall]): RoomState {
    const s1 = scene("s1", { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    const state = room({
      members: Object.fromEntries([["dm1", member("dm1", "dm")], ...HOLDERS.map((p) => [p, member(p)])]),
      scenes: { s1, s2: scene("s2", { order: 1 }) },
      holders: { s1: { sceneId: "s1", rev: 0, entries: HOLDERS.map((memberId) => ({ memberId, on: true })) } },
    });
    LAYERS.forEach((layer, n) => {
      const band = rasterizeFogOps({}, "s1", s1.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: n * ROWS, w: 200, h: ROWS } }]);
      for (const t of Object.values(band) as FogTile[]) {
        if (layer === null) state.exploredTiles[`s1:${t.tx},${t.ty}`] = t;
        else state.exploredBy[holderTileKey("s1", layer, t.tx, t.ty)] = { ...t, memberId: layer };
      }
      // Filled while the layer's entries, as JSON, stay within its cap, counted as each entry adds to it.
      const walls: Record<string, RememberedWall[]> = {};
      let size = 2;
      for (let i = 0; ; i++) {
        const [id, version] = entry(n, i, `${i % 200},${n * ROWS + Math.floor(i / 200)}`);
        const add = walls[id] ? 1 + bytes(version) : (size > 2 ? 1 : 0) + bytes(id) + 3 + bytes(version);
        if (size + add > LIMITS.memoryBytesPerLayer) break;
        (walls[id] ??= []).push(version);
        size += add;
      }
      assert.equal(bytes(walls), size);
      const chunk: MemoryChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 0, walls, ...(layer === null ? {} : { memberId: layer }) };
      if (layer === null) state.memory = { [chunkKey("s1", 0, 0)]: chunk };
      else state.memoryBy![holderChunkKey("s1", layer, 0, 0)] = chunk;
    });
    return state;
  }

  function foldsToSchema(state: RoomState): MemoryChunk {
    const before = parsed(state);
    assert.ok(before.ok, before.ok ? "" : before.message);
    const r = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }, DM, env(1));
    assert.ok(r.ok);
    const pooled = r.state.memory![chunkKey("s1", 0, 0)]!;
    assert.ok(bytes(pooled.walls) <= LAYERS.length * LIMITS.memoryBytesPerLayer, "a pooled chunk holds at most every layer's cap");
    const after = parsed(r.state);
    assert.ok(after.ok, after.ok ? "" : after.message);
    return pooled;
  }

  test("one wall's versions absent on a cell each join into one version over every layer's cells", () => {
    const pooled = foldsToSchema(full((_n, _i, cell) => ["abcdefghijkl", { wall: null, cells: [cell] }]));
    assert.equal(pooled.walls!.abcdefghijkl!.length, 1);
    assert.ok(pooled.walls!.abcdefghijkl![0]!.cells.length > 7 * 2_000);
  });

  test("one wall's versions, each a wall of its own, stay one each", () => {
    // Each version a different 2-cell wall in chunk 0,0, on the 1/64 lattice.
    const wall = (k: number) => ({ id: "abcdefghijkl", a: [1 + (k % 384) / 64, 1 + Math.floor(k / 384) / 64] as [number, number], b: [3 + (k % 384) / 64, 1 + Math.floor(k / 384) / 64] as [number, number], f: { kind: "wall" as const } });
    const pooled = foldsToSchema(full((n, i, cell) => ["abcdefghijkl", { wall: wall(n * 1_000 + i), cells: [cell] }]));
    assert.ok(pooled.walls!.abcdefghijkl!.length > 7 * 500);
  });

  test("many walls, each absent on one cell, stay one entry each", () => {
    const id = (n: number, i: number) => `w${n}${String(i).padStart(10, "0")}`;
    const pooled = foldsToSchema(full((n, i, cell) => [id(n, i), { wall: null, cells: [cell] }]));
    assert.ok(Object.keys(pooled.walls!).length > 7 * 1_300);
  });
});
