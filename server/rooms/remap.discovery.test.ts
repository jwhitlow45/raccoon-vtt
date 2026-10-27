import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, holderChunkKey } from "#shared/keys.ts";
import type { Label, MemoryChunk, RoomState, Stamp } from "#shared/model.ts";
import { member, room, scene } from "#shared/testutil.ts";
import { remapState, type ImportedAsset } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A room import carries players' memory and both marks
 * (docs/design-v1-map-discovery.md 5.4 and 5.5): under the new scene and
 * member ids, a holder's only where their entry is on (ASTRA-5), labels
 * and stamps under the ids the live ones take or fresh ones, and a
 * remembered stamp's art mapped as a live stamp's, or dropped.
 */

const WALL = "abcdefghijkl";
const label = (id: string, sceneId: string, x = 1): Label => ({ id, rev: 0, sceneId, x, y: 1, text: "Hall", size: 1 });
const stamp = (id: string, sceneId: string, art: Stamp["art"], overrides: Partial<Stamp> = {}): Stamp => ({ id, rev: 0, sceneId, art, x: 1.5, y: 1.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", ...overrides });

function remembering(): RoomState {
  const state = room();
  state.members.p3 = member("p3");
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  // Fog on and party vision off: a scene that keeps no memory.
  state.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: false, light: "dark" } });
  state.scenes.s3 = scene("s3", { order: 2, fogEnabled: true, vision: { on: true, light: "dim" } });
  state.meta.playerSceneId = "s3";
  state.holders = {
    s1: {
      sceneId: "s1",
      rev: 1,
      entries: [
        { memberId: "p1", on: true },
        { memberId: "p2", on: false },
        { memberId: "gone", on: true },
        { memberId: "p3", on: true },
      ],
    },
  };
  state.labels = { L1: label("L1", "s1", 4) };
  state.stamps = {
    T1: stamp("T1", "s1", { assetId: "a-token" }, { x: 5.5 }),
    T2: stamp("T2", "s1", { key: "oak-tree" }, { visibility: "dm" }),
    // Its image did not come through, so the live stamp goes, and a remembered one of the same image with it.
    T3: stamp("T3", "s1", { assetId: "a-lost" }),
  };
  const party: MemoryChunk = {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 3,
    cells: { "1,1": "stone" },
    edges: { "2,1,w": "auto" },
    walls: { [WALL]: [{ wall: null, cells: ["1,1"] }] },
    labels: { L1: label("L1", "s1"), Lm: label("Lm", "s1"), Ln: null },
    stamps: {
      T1: stamp("T1", "s1", { assetId: "a-token" }),
      Tm: stamp("Tm", "s1", { assetId: "a-token" }),
      Tk: stamp("Tk", "s1", { key: "oak-tree" }),
      Tx: stamp("Tx", "s1", { assetId: "a-map" }),
      T3: stamp("T3", "s1", { assetId: "a-lost" }),
      T2: stamp("T2", "s1", { key: "oak-tree" }),
      Tn: null,
    },
  };
  const holder = (memberId: string, cx: number): MemoryChunk => ({
    sceneId: "s1",
    memberId,
    cx,
    cy: 0,
    rev: 1,
    cells: { [`${cx * 16 + 1},1`]: "wood" },
    labels: { Lm: label("Lm", "s1", cx * 16 + 2) },
    stamps: { Tm: stamp("Tm", "s1", { assetId: "a-token" }, { x: cx * 16 + 2.5 }) },
  });
  state.memory = {
    [chunkKey("s1", 0, 0)]: party,
    [chunkKey("s2", 0, 0)]: { sceneId: "s2", cx: 0, cy: 0, rev: 0, cells: { "1,1": "dirt" } },
    [chunkKey("s3", 1, 0)]: { sceneId: "s3", cx: 1, cy: 0, rev: 0, cells: { "17,1": "grass" } },
    [chunkKey("zz", 0, 0)]: { sceneId: "zz", cx: 0, cy: 0, rev: 0, cells: { "1,1": "dirt" } },
    // A chunk whose only entry is a stamp of an image that did not come through: nothing is left of it.
    [chunkKey("s3", 0, 0)]: { sceneId: "s3", cx: 0, cy: 0, rev: 0, stamps: { Tq: stamp("Tq", "s3", { assetId: "a-lost" }) } },
  };
  state.memoryBy = {
    [holderChunkKey("s1", "p1", 1, 0)]: holder("p1", 1),
    [holderChunkKey("s1", "p2", 0, 0)]: holder("p2", 0),
    [holderChunkKey("s1", "gone", 0, 0)]: holder("gone", 0),
  };
  state.playedScenes = { s1: { sceneId: "s1", rev: 2 }, s2: { sceneId: "s2", rev: 0 }, zz: { sceneId: "zz", rev: 0 } };
  state.memoryShared = { s1: { sceneId: "s1", rev: 0 }, s2: { sceneId: "s2", rev: 0 }, zz: { sceneId: "zz", rev: 0 } };
  return state;
}

const ASSETS = new Map<string, ImportedAsset>([
  ["a-token", { id: "n-token", kind: "token" }],
  ["a-map", { id: "n-map", kind: "map" }],
]);

function imported(state: RoomState): { out: RoomState; member: (old: string) => string; scene: (name: string) => string } {
  const memberIds = new Map([
    ["dm1", "m-dm"],
    ["p1", "m-z"],
    ["p2", "m-y"],
    ["p3", "m-a"],
  ]);
  let n = 0;
  const out = remapState(state, { assets: ASSETS, memberIds, newId: () => `n${n++}` });
  return { out, member: (old) => memberIds.get(old)!, scene: (name) => Object.values(out.scenes).find((s) => s.order === state.scenes[name]!.order)!.id };
}

describe("an import of players' memory", () => {
  test("keeps the party's memory of a scene that keeps memory, re-keyed under its new scene, and drops the rest", () => {
    const { out, scene } = imported(remembering());
    const s1 = scene("s1");
    const s3 = scene("s3");
    assert.deepEqual(Object.keys(out.memory!).sort(), [chunkKey(s1, 0, 0), chunkKey(s3, 1, 0)].sort());
    for (const [key, c] of Object.entries(out.memory!)) {
      assert.equal(key, chunkKey(c.sceneId, c.cx, c.cy));
      assert.equal(c.memberId, undefined);
    }
    const chunk = out.memory![chunkKey(s1, 0, 0)]!;
    assert.equal(chunk.rev, 3);
    assert.deepEqual(chunk.cells, { "1,1": "stone" });
    assert.deepEqual(chunk.edges, { "2,1,w": "auto" });
    // A free wall's id is chunk scoped, so it stays.
    assert.deepEqual(chunk.walls, { [WALL]: [{ wall: null, cells: ["1,1"] }] });
    assert.deepEqual(out.memory![chunkKey(s3, 1, 0)]!.cells, { "17,1": "grass" });
  });

  test("gives a live label or stamp's entry the live one's new id, and an id only memory names one fresh id in every layer", () => {
    const { out, scene, member } = imported(remembering());
    const s1 = scene("s1");
    const liveLabel = Object.values(out.labels)[0]!;
    const liveStamp = Object.values(out.stamps).find((s) => "assetId" in s.art)!;
    const chunk = out.memory![chunkKey(s1, 0, 0)]!;
    const labels = chunk.labels!;
    assert.deepEqual(labels[liveLabel.id], label(liveLabel.id, s1));
    const labelOnly = Object.keys(labels).filter((id) => id !== liveLabel.id);
    assert.equal(labelOnly.length, 2);
    for (const id of [...labelOnly, ...Object.keys(chunk.stamps!)]) assert.ok(!["L1", "Lm", "Ln", "T1", "Tm", "Tk", "Tn"].includes(id), `${id} is a new id`);
    const stamps = chunk.stamps!;
    assert.deepEqual(stamps[liveStamp.id], stamp(liveStamp.id, s1, { assetId: "n-token" }));
    const own = out.memoryBy![holderChunkKey(s1, member("p1"), 1, 0)]!;
    const [lm] = Object.keys(own.labels!);
    const [tm] = Object.keys(own.stamps!);
    assert.ok(lm !== undefined && labels[lm] !== undefined && labels[lm] !== null, "the holder's remembered label has the party's fresh id");
    assert.deepEqual(own.labels![lm], label(lm, s1, 18));
    assert.ok(tm !== undefined && stamps[tm] !== undefined, "the holder's remembered stamp has the party's fresh id");
    assert.deepEqual(stamps[tm], stamp(tm, s1, { assetId: "n-token" }));
    assert.deepEqual(own.stamps![tm], stamp(tm, s1, { assetId: "n-token" }, { x: 18.5 }));
    // The absent-then entries come along under fresh ids of their own.
    assert.equal(Object.values(labels).filter((v) => v === null).length, 1);
    assert.equal(Object.values(stamps).filter((v) => v === null).length, 1);
    const memoryOnly = [...labelOnly, ...Object.keys(stamps).filter((id) => id !== liveStamp.id)];
    assert.equal(new Set(memoryOnly).size, memoryOnly.length);
    for (const id of memoryOnly) assert.ok(out.labels[id] === undefined && out.stamps[id] === undefined, `${id} names nothing live`);
  });

  test("maps a remembered stamp's uploaded art, keeps a shipped key, and drops one whose art did not come through, is not token art or is the DM's alone", () => {
    const { out, scene } = imported(remembering());
    const stamps = out.memory![chunkKey(scene("s1"), 0, 0)]!.stamps!;
    const arts = Object.values(stamps).flatMap((s) => (s === null ? [] : [s.art]));
    assert.deepEqual(arts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ assetId: "n-token" }, { assetId: "n-token" }, { key: "oak-tree" }]);
    const dmOnly = Object.values(out.stamps).find((s) => s.visibility === "dm")!;
    assert.equal(stamps[dmOnly.id], undefined, "the DM's own stamp is never remembered");
    assert.equal(Object.keys(stamps).length, 4);
    // A chunk left with nothing is no chunk.
    assert.equal(out.memory![chunkKey(scene("s3"), 0, 0)], undefined);
  });

  test("a remembered stamp whose art did not come through, of a live stamp they never saw as it is, is remembered as absent, so the live art never shows (MD3-ASTRA-3)", () => {
    const state = remembering();
    state.stamps.T4 = stamp("T4", "s1", { key: "oak-tree" }, { x: 7.5 });
    state.stamps.T5 = stamp("T5", "s1", { key: "barrel" }, { x: 8.5 });
    const party = state.memory![chunkKey("s1", 0, 0)]!;
    state.memory![chunkKey("s1", 0, 0)] = { ...party, stamps: { ...party.stamps, T4: stamp("T4", "s1", { assetId: "a-lost" }, { x: 7.5 }), T5: stamp("T5", "s1", { assetId: "a-map" }, { x: 8.5 }) } };
    const { out, scene } = imported(state);
    const stamps = out.memory![chunkKey(scene("s1"), 0, 0)]!.stamps!;
    for (const old of ["T4", "T5"]) {
      const live = Object.values(out.stamps).find((s) => s.x === state.stamps[old]!.x)!;
      assert.ok(live, `${old} came through live`);
      assert.ok(Object.hasOwn(stamps, live.id) && stamps[live.id] === null, `${old}: remembered as absent, not dropped`);
    }
    assert.ok(parseRoomState(out).ok, "the store takes it");
  });

  test("keeps a holder's memory only where their entry is on, under their new id, and drops it with their layer otherwise", () => {
    const { out, scene, member } = imported(remembering());
    const s1 = scene("s1");
    assert.deepEqual(Object.keys(out.memoryBy!), [holderChunkKey(s1, member("p1"), 1, 0)]);
    const own = out.memoryBy![holderChunkKey(s1, member("p1"), 1, 0)]!;
    assert.equal(own.memberId, member("p1"));
    assert.equal(own.sceneId, s1);
    assert.deepEqual(own.cells, { "17,1": "wood" });
  });

  test("drops a holder's memory once the scene stops being per player in the file, as their layer goes", () => {
    const state = remembering();
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark" } };
    const { out } = imported(state);
    assert.deepEqual(out.memoryBy, {});
    assert.equal(Object.keys(out.memory!).length, 2);
  });

  test("maps both marks to their scenes' new ids, drops those of scenes that did not come through, and a share mark where no memory is kept", () => {
    const { out, scene } = imported(remembering());
    const [s1, s2, s3] = [scene("s1"), scene("s2"), scene("s3")];
    assert.deepEqual(out.playedScenes, { [s1]: { sceneId: s1, rev: 2 }, [s2]: { sceneId: s2, rev: 0 }, [s3]: { sceneId: s3, rev: 0 } }, "the players' scene is marked too");
    assert.deepEqual(out.memoryShared, { [s1]: { sceneId: s1, rev: 0 } });
  });

  test("the result is a state the store takes", () => {
    const { out } = imported(remembering());
    const parsed = parseRoomState(out);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("a state with no memory or marks comes out with all four, empty but for the players' scene's mark", () => {
    const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...bare } = room();
    let n = 0;
    const out = remapState(bare, { assets: new Map(), newId: () => `n${n++}` });
    const players = out.meta.playerSceneId!;
    assert.deepEqual([out.memory, out.memoryBy, out.memoryShared], [{}, {}, {}]);
    assert.deepEqual(out.playedScenes, { [players]: { sceneId: players, rev: 0 } });
  });
});
