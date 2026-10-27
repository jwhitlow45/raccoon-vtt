import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, holderChunkKey } from "#shared/keys.ts";
import { MAP_DISCOVERY_SNAPSHOT_VERSION, migrateSnapshot } from "#shared/migrate.ts";
import type { Label, RoomState, Stamp } from "#shared/model.ts";
import { DM, room, scene } from "#shared/testutil.ts";
import { exportableState, roomExport, type RoomExport } from "./exportRoom.ts";
import { HttpError } from "../auth/http.ts";
import { assertWithinLimits, MEMORY_TOO_LARGE, withDiscoveryUpgrade } from "./importRoom.ts";
import { layerCharge, MEMORY_CAP } from "./memorySize.ts";
import { MEMORY_FULL, measuredStateBytes, memoryReserves } from "./sizeGuard.ts";
import { exploredReserve, LIMITS } from "#shared/limits.ts";
import { remapState, type ImportedAsset } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A room's memory and marks through its export and back in
 * (docs/design-v1-map-discovery.md 5.4 and 5.5), along the import's state
 * path: the file's migration, the stored-state schema, the remap and the
 * upgrade step, which only a file from before map discovery takes. A newer
 * file's own marks stand, so a scene that lost its share mark stays
 * without one.
 */

const label = (id: string, sceneId: string): Label => ({ id, rev: 0, sceneId, x: 1, y: 1, text: "Hall", size: 1 });
const stamp = (id: string, sceneId: string, assetId: string): Stamp => ({ id, rev: 0, sceneId, art: { assetId }, x: 1.5, y: 1.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });

function played(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  state.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dim" } });
  // Fog and party vision on, but its share mark went when vision went off for a while (5.5).
  state.scenes.s3 = scene("s3", { order: 2, fogEnabled: true, vision: { on: true, light: "dim" } });
  state.meta.playerSceneId = "s2";
  state.holders = { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } };
  state.labels = { L1: label("L1", "s2") };
  state.stamps = { T1: stamp("T1", "s2", "a-token") };
  state.memory = {
    [chunkKey("s2", 0, 0)]: { sceneId: "s2", cx: 0, cy: 0, rev: 2, cells: { "1,1": "stone" }, labels: { L1: label("L1", "s2"), Lm: label("Lm", "s2") }, stamps: { T1: stamp("T1", "s2", "a-token"), Tm: stamp("Tm", "s2", "a-token") } },
  };
  state.memoryBy = {
    [holderChunkKey("s1", "p1", 0, 0)]: { sceneId: "s1", memberId: "p1", cx: 0, cy: 0, rev: 1, cells: { "2,2": "wood" }, stamps: { Tm: stamp("Tm", "s1", "a-token") } },
  };
  state.playedScenes = { s1: { sceneId: "s1", rev: 0 }, s2: { sceneId: "s2", rev: 1 } };
  state.memoryShared = { s1: { sceneId: "s1", rev: 0 }, s2: { sceneId: "s2", rev: 0 } };
  return state;
}

const ASSETS = new Map<string, ImportedAsset>([["a-token", { id: "n-token", kind: "token" }]]);
const MEMBERS = new Map([
  ["dm1", "m-dm"],
  ["p1", "m-p1"],
  ["p2", "m-p2"],
]);

/** The file as an export writes it and an import reads it: JSON text, then the migration and the stored-state schema. */
function throughFile(state: RoomState, version = MAP_DISCOVERY_SNAPSHOT_VERSION): { file: RoomExport; parsed: RoomState } {
  const file = JSON.parse(JSON.stringify({ ...roomExport("ABCDEFGH", 9, exportableState(state, DM), ["dm1"]), schemaVersion: version })) as RoomExport;
  const parsed = parseRoomState(migrateSnapshot(file.state, file.schemaVersion));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  return { file, parsed: parsed.state };
}

function imported(state: RoomState, version?: number): { out: RoomState; scene: (old: string) => string } {
  const { file, parsed } = throughFile(state, version);
  let n = 0;
  const out = withDiscoveryUpgrade(remapState(parsed, { assets: ASSETS, memberIds: MEMBERS, newId: () => `n${n++}` }), file.schemaVersion);
  const stored = parseRoomState(out);
  assert.ok(stored.ok, stored.ok ? "" : stored.message);
  return { out, scene: (old) => Object.values(out.scenes).find((s) => s.order === state.scenes[old]!.order)!.id };
}

describe("players' memory through a room export and import", () => {
  test("memory, holders' memory and both marks come back under the new ids", () => {
    const { out, scene } = imported(played());
    const [s1, s2] = [scene("s1"), scene("s2")];
    const liveLabel = Object.keys(out.labels)[0]!;
    const liveStamp = Object.keys(out.stamps)[0]!;
    const party = out.memory![chunkKey(s2, 0, 0)]!;
    assert.deepEqual(Object.keys(out.memory!), [chunkKey(s2, 0, 0)]);
    assert.equal(party.sceneId, s2);
    assert.deepEqual(party.cells, { "1,1": "stone" });
    assert.deepEqual(party.labels![liveLabel], label(liveLabel, s2));
    assert.deepEqual(party.stamps![liveStamp], stamp(liveStamp, s2, "n-token"));
    const tm = Object.keys(party.stamps!).find((id) => id !== liveStamp)!;
    assert.ok(!["T1", "Tm"].includes(tm));
    assert.deepEqual(Object.keys(out.memoryBy!), [holderChunkKey(s1, "m-p1", 0, 0)]);
    const own = out.memoryBy![holderChunkKey(s1, "m-p1", 0, 0)]!;
    assert.equal(own.memberId, "m-p1");
    assert.deepEqual(own.stamps, { [tm]: stamp(tm, s1, "n-token") }, "the stamp only memory names has one new id in every layer");
    assert.deepEqual(out.playedScenes, { [s1]: { sceneId: s1, rev: 0 }, [s2]: { sceneId: s2, rev: 1 } });
    assert.deepEqual(out.memoryShared, { [s1]: { sceneId: s1, rev: 0 }, [s2]: { sceneId: s2, rev: 0 } });
  });

  test("a file from today takes no upgrade step: the scene that lost its share mark stays without one, and no other scene is marked", () => {
    const { out, scene } = imported(played());
    assert.equal(out.memoryShared![scene("s3")], undefined);
    assert.equal(out.playedScenes![scene("s3")], undefined);
    assert.equal(out.playedScenes![scene("s1")]?.rev, 0);
  });

  test("a file from before map discovery takes the step: every scene played, every one with fog and party vision on sharing", () => {
    const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...before } = played();
    const { out } = imported(before, MAP_DISCOVERY_SNAPSHOT_VERSION - 1);
    const ids = Object.keys(out.scenes).sort();
    assert.deepEqual(Object.keys(out.playedScenes!).sort(), ids);
    const sharing = Object.values(out.scenes).filter((s) => s.fogEnabled && s.vision?.on === true).map((s) => s.id).sort();
    assert.equal(sharing.length, 3);
    assert.deepEqual(Object.keys(out.memoryShared!).sort(), sharing);
    assert.deepEqual([out.memory, out.memoryBy], [{}, {}]);
  });

  test("a file from today whose played scenes' whole caps do not fit the room is refused in words the DM can act on, and shares always fit", () => {
    const state = room();
    for (let i = 3; i <= 6; i++) state.members[`p${i}`] = { ...state.members.p1!, id: `p${i}`, name: `p${i}` };
    const marks: NonNullable<RoomState["playedScenes"]> = {};
    state.playedScenes = marks;
    state.memoryShared = {};
    // Per-player scenes the players have been on, each reserving the party's cap and one for each of the six players.
    for (let i = 0; measuredStateBytes(state) + exploredReserve(state) + memoryReserves(state).whole <= LIMITS.stateBytes; i++) {
      const id = `pp${i}`;
      state.scenes[id] = scene(id, { order: 10 + i, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
      marks[id] = { sceneId: id, rev: 0 };
    }
    assert.ok(measuredStateBytes(state) + exploredReserve(state) <= LIMITS.stateBytes, "the state itself fits");
    assert.throws(
      () => assertWithinLimits(state),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === MEMORY_FULL,
    );
    // Sharing the room's space, as after the upgrade, the same scenes fit at a smaller share.
    const sharing = { ...state, memoryShared: Object.fromEntries(Object.keys(marks).map((id) => [id, { sceneId: id, rev: 0 }])) };
    assert.doesNotThrow(() => assertWithinLimits(sharing));
  });

  test("a file whose memory of a layer is over that layer's cap, or holds memory where none is kept, is refused (MD3-D-4)", () => {
    const { out } = imported(played());
    assert.doesNotThrow(() => assertWithinLimits(out));
    const party = Object.values(out.memory ?? {})[0]!;
    const sceneId = party.sceneId;
    const refused = (state: RoomState) =>
      assert.throws(() => assertWithinLimits(state), (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === MEMORY_TOO_LARGE);
    // The party's memory of the scene filled past its 64 KiB cap with remembered stone, chunk by chunk.
    const big: RoomState = { ...out, memory: { ...out.memory } };
    for (let cy = 0; cy < 3 && layerCharge(big, big.scenes[sceneId]!, null) <= MEMORY_CAP; cy++) {
      for (let cx = 0; cx < 10 && layerCharge(big, big.scenes[sceneId]!, null) <= MEMORY_CAP; cx++) {
        const cells: Record<string, "stone"> = {};
        for (let k = 0; k < 256; k++) cells[`${cx * 16 + (k % 16)},${cy * 16 + (k >> 4)}`] = "stone";
        big.memory![chunkKey(sceneId, cx, cy)] = { sceneId, cx, cy, rev: 0, cells };
      }
    }
    assert.ok(layerCharge(big, big.scenes[sceneId]!, null) > MEMORY_CAP);
    refused(big);
    // A holder's own memory past its cap, the party's under it.
    const mine: RoomState = { ...out, memoryBy: { ...out.memoryBy } };
    for (const chunk of Object.values(big.memory!)) if (chunk.sceneId === sceneId) mine.memoryBy![holderChunkKey(sceneId, "m1", chunk.cx, chunk.cy)] = { ...chunk, memberId: "m1" };
    assert.ok(layerCharge(mine, mine.scenes[sceneId]!, "m1") > MEMORY_CAP);
    refused(mine);
    // Memory of a scene nobody played, where the room reserves none.
    const unplayed = Object.values(out.scenes).find((s) => out.playedScenes?.[s.id] === undefined && s.fogEnabled && s.vision?.on === true);
    assert.ok(unplayed, "the file has a scene with fog and party vision on that nobody played");
    refused({ ...out, memory: { ...out.memory, [chunkKey(unplayed.id, 0, 0)]: { sceneId: unplayed.id, cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" } } } });
  });
});
