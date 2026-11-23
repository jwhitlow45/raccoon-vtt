import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { chunkKey } from "#shared/keys.ts";
import { PLAYER_LIMITS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { SEALED_IDS_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { actor, character, member, scene, token } from "#shared/testutil.ts";
import { layerCharge } from "./memorySize.ts";
import { mapStepOps } from "./remember.ts";
import { restartStored, storedActor, StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * A room from before player limits has every memory layer measured against
 * its cap once (actor.ts). Its first load on this build stores it at
 * today's version as it gives its ids anew (reid.ts), and a later load
 * takes a room at today's version as measured, so that measure runs in the
 * first load, on what it stores: a restart before the room's first batch
 * finds its layers within their caps.
 */

/** A dark room whose party remembers four chunks of ground on its scene, twice what the scene's fixed share holds. */
function overShare(): { state: RoomState; sceneId: string; share: number } {
  const dm = member(uuidv7(), "dm");
  const player = member(uuidv7());
  const state = createInitialState({ roomName: "Dark", dm });
  state.members[player.id] = player;
  const sceneId = state.meta.playerSceneId!;
  state.scenes[sceneId] = { ...state.scenes[sceneId]!, fogEnabled: true, vision: { on: true, light: "dark" }, bounds: { w: 100, h: 60 }, blockMovement: true };
  const crypt = uuidv7();
  state.scenes[crypt] = scene(crypt, { name: "Crypt", order: 1 });
  const characterId = uuidv7();
  state.characters[characterId] = character(characterId, { ownerIds: [player.id], actor: actor({ senses: "Darkvision 30 ft." }) });
  const pcId = uuidv7();
  // A goblin only the DM sees, which its first load on this build gives a new id.
  const goblin = uuidv7();
  state.tokens[goblin] = token(goblin, { sceneId, name: "Goblin", visibility: "dm", x: 5, y: 5 });
  state.tokens[pcId] = token(pcId, { sceneId, kind: "pc", name: "Ayla", disposition: "ally", x: 90, y: 50, actor: { ref: characterId } });
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 6; tx++) state.exploredTiles[`${sceneId}:${tx},${ty}`] = { sceneId, tx, ty, rev: 0, bits: encodeTile(fullTileBits()) };
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 6; cx++) {
      const cells: Record<string, "stone"> = {};
      for (let y = cy * 16; y < Math.min(44, cy * 16 + 16); y++) for (let x = cx * 16; x < cx * 16 + 16; x++) cells[`${x},${y}`] = "stone";
      state.buildChunks[chunkKey(sceneId, cx, cy)] = { sceneId, cx, cy, rev: 0, cells, edges: {} };
    }
  }
  state.playedScenes = { [sceneId]: { sceneId, rev: 0 } };
  state.memory = {};
  for (let cx = 0; cx < 4; cx++) {
    const cells: Record<string, "wood"> = {};
    for (let k = 0; k < 120; k++) cells[`${cx * 16 + (k % 16)},${Math.floor(k / 16)}`] = "wood";
    state.memory[chunkKey(sceneId, cx, 0)] = { sceneId, cx, cy: 0, rev: 0, cells };
  }
  const share = Math.floor(layerCharge(state, state.scenes[sceneId]!, null) / 2);
  state.memoryShared = { [sceneId]: { sceneId, rev: 0, share } };
  return { state, sceneId, share };
}

const charge = (state: RoomState, sceneId: string) => layerCharge(state, state.scenes[sceneId]!, null);

test("a room from before player limits has its layers within their caps once its first load stores it, so a restart before its first batch keeps them so", async (t) => {
  const { state, sceneId, share } = overShare();
  assert.ok(charge(state, sceneId) > share, "the party's layer is over its share as stored");
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false });
  assert.ok(charge(first.actor.committed.state, sceneId) <= share, "measured as the load stored it");
  assert.equal(db.snapshotWrites, 1);
  assert.ok(charge(db.snapshot.state as RoomState, sceneId) <= share, "and stored so");

  // Stopped before any batch, as a crash would, and loaded again from what the first load stored.
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false });
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "still within its share");
  const dm = await again.connect(Object.values(again.actor.committed.state.members).find((m) => m.kind === "dm")!);
  const other = Object.keys(again.actor.committed.state.scenes).find((id) => id !== sceneId)!;
  assert.equal((await dm.apply({ t: "scene.update", sceneId: other, patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "and after the first batch");
});

/** The map step, made to throw the first time it measures every layer, as a bug would. */
function failingOnce(): typeof mapStepOps {
  let failed = false;
  return (input) => {
    if (input.everyLayer && !failed) {
      failed = true;
      throw new Error("a measure that fails");
    }
    return mapStepOps(input);
  };
}

const dmOf = (state: RoomState) => Object.values(state.members).find((m) => m.kind === "dm")!;

test("a load whose measure fails gives no ids anew and stores nothing at today's version, so a restart before its first batch measures and gives them then", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failingOnce() });
  assert.equal(db.snapshotWrites, 0, "nothing stored");
  assert.deepEqual(Object.keys(first.actor.committed.state.tokens).sort(), Object.keys(state.tokens).sort(), "no id given anew");

  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false });
  assert.deepEqual([db.snapshotWrites, db.snapshot.version], [1, SNAPSHOT_VERSION], "the restart's load gives the ids and stores the room");
  assert.notDeepEqual(Object.keys(again.actor.committed.state.tokens).sort(), Object.keys(state.tokens).sort(), "ids given anew");
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "measured");
  const dm = await again.connect(dmOf(again.actor.committed.state));
  const other = Object.keys(again.actor.committed.state.scenes).find((id) => id !== sceneId)!;
  assert.equal((await dm.apply({ t: "scene.update", sceneId: other, patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "and so after an edit elsewhere");
});

test("a room whose load's measure failed stores its snapshots below the version of new ids, so its next load gives them", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failingOnce() });
  const dm = await first.connect(dmOf(state));
  const other = Object.keys(state.scenes).find((id) => id !== sceneId)!;
  assert.equal((await dm.apply({ t: "scene.update", sceneId: other, patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.ok(charge(first.actor.committed.state, sceneId) <= share, "the first batch measured every layer");
  assert.equal(db.snapshot.version, SEALED_IDS_SNAPSHOT_VERSION - 1, "its first commit stored the room below the version");

  // A deploy's stop writes the snapshot, at that version too, and the next load gives the ids anew.
  const again = await restartStored(t, first, { snapshot: true }, { idGate: false });
  assert.equal(db.snapshot.version, SNAPSHOT_VERSION);
  assert.notDeepEqual(Object.keys(again.actor.committed.state.tokens).sort(), Object.keys(state.tokens).sort(), "ids given anew");
  assert.ok(charge(again.actor.committed.state, sceneId) <= share);
});

test("an id players held only in a memory layer the load's measure forgets keeps its id", async (t) => {
  const { state, sceneId } = overShare();
  const base = structuredClone(state);
  // Which chunk the measure forgets, from a load of the room as it is.
  const probe = await storedActor(t, new StoredRoomDb(structuredClone(base), { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 }), { idGate: false });
  const forgotten = Object.keys(base.memory ?? {}).find((key) => probe.actor.committed.state.memory?.[key] === undefined);
  assert.ok(forgotten, "the measure forgets a chunk");
  // A barrel players saw there, which they remember, and see nowhere now.
  const barrel = uuidv7();
  const chunk = base.memory![forgotten]!;
  const stamp = { id: barrel, rev: 0, sceneId, art: { key: "barrel" }, x: chunk.cx * 16 + 2, y: chunk.cy * 16 + 2, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const };
  base.stamps = { [barrel]: stamp as never };
  base.memory![forgotten] = { ...chunk, stamps: { [barrel]: stamp } } as never;
  const h = await storedActor(t, new StoredRoomDb(base, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 }), { idGate: false });
  assert.equal(h.actor.committed.state.memory?.[forgotten], undefined, "the measure forgot it here too");
  assert.ok(h.actor.committed.state.stamps[barrel], "the barrel keeps its id");
});
