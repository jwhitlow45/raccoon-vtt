import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { migrateSnapshot } from "#shared/migrate.ts";
import type { MemoryChunk, RoomState } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
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
