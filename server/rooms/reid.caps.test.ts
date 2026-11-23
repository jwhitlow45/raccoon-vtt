import assert from "node:assert/strict";
import { test } from "node:test";
import { isUuidv7, uuidv7 } from "#shared/ids.ts";
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
 * takes a room at today's version as measured, so that measure runs in
 * every load that gives ids anew, on what it stores: a restart before the
 * room's first batch finds its layers within their caps. A measure that
 * fails stores the room below today's version, so the next load measures.
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

/** The map step, made to throw the first `times` times it measures every layer (every time with no count), as a bug would, counting the measures that ran. */
function failing(times = Infinity): typeof mapStepOps & { measures: number } {
  let failed = 0;
  const step = ((input) => {
    if (input.everyLayer) {
      step.measures++;
      if (failed < times) {
        failed++;
        throw new Error("a measure that fails");
      }
    }
    return mapStepOps(input);
  }) as typeof mapStepOps & { measures: number };
  step.measures = 0;
  return step;
}

const dmOf = (state: RoomState) => Object.values(state.members).find((m) => m.kind === "dm")!;
const otherScene = (state: RoomState, sceneId: string) => Object.keys(state.scenes).find((id) => id !== sceneId)!;
const v7Tokens = (state: RoomState) => Object.keys(state.tokens).filter(isUuidv7).sort();

test("a load whose measure fails gives the ids anew all the same and stores the room below today's version, so a restart before its first batch measures it", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  assert.deepEqual([db.snapshotWrites, db.snapshot.version], [1, SEALED_IDS_SNAPSHOT_VERSION - 1]);
  assert.notDeepEqual(v7Tokens(first.actor.committed.state), v7Tokens(state), "the goblin's id given anew");
  assert.ok(charge(db.snapshot.state as RoomState, sceneId) > share, "stored unmeasured");

  const step = failing(0);
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false, mapStep: step });
  assert.equal(step.measures, 1, "the restart's load measures");
  assert.deepEqual([db.snapshotWrites, db.snapshot.version], [2, SNAPSHOT_VERSION]);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "measured");
  assert.deepEqual(v7Tokens(again.actor.committed.state), v7Tokens(first.actor.committed.state), "giving the ids again renames none the first load kept");
});

test("a room whose measure failed at its load and at its first batch stores itself below today's version, so its next load measures it and the charge falls", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const twice = failing(2);
  const first = await storedActor(t, db, { idGate: false, mapStep: twice });
  const dm = await first.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(first.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.equal(twice.measures, 2, "the load's measure and the first batch's both failed");
  assert.ok(charge(first.actor.committed.state, sceneId) > share, "still over its share");

  // A deploy's stop writes the snapshot below today's version, and the next load measures.
  const step = failing(0);
  const again = await restartStored(t, first, { snapshot: true }, { idGate: false, mapStep: step });
  assert.equal(step.measures, 1);
  assert.equal(db.snapshot.version, SNAPSHOT_VERSION);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "the charge falls to its share");
  assert.ok(charge(db.snapshot.state as RoomState, sceneId) <= share, "and is stored so");
});

test("a room stored below today's version over its share, whose load's measure fails, has its first batch measure every layer", async (t) => {
  const { state, sceneId, share } = overShare();
  // As a room stored at 49 by a session whose measures all failed holds it.
  const db = new StoredRoomDb(state, { version: SEALED_IDS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  assert.ok(charge(first.actor.committed.state, sceneId) > share);
  const dm = await first.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(first.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.ok(charge(first.actor.committed.state, sceneId) <= share, "the first batch measured every layer");
});

test("a room whose measure fails at every load still has its ids given anew, and stays below today's version", async (t) => {
  const { state } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing() });
  const kept = v7Tokens(first.actor.committed.state);
  assert.ok(kept.length < v7Tokens(state).length, "the goblin's id given anew");
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false, mapStep: failing() });
  assert.equal(db.snapshot.version, SEALED_IDS_SNAPSHOT_VERSION - 1);
  assert.deepEqual(v7Tokens(again.actor.committed.state), kept);
  assert.deepEqual(Object.keys(again.actor.committed.state.tokens).sort(), Object.keys(first.actor.committed.state.tokens).sort(), "the second load renames nothing");
});

test("a room this build measured and stored below today's version is unchanged by its load's measure", async (t) => {
  const { state, sceneId } = overShare();
  // Measured as a first load leaves it, then stored at each version below today's that a live room can hold.
  const once = await storedActor(t, new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 }), { idGate: false });
  const measured = once.actor.committed.state;
  for (let version = PLAYER_LIMITS_SNAPSHOT_VERSION; version < SNAPSHOT_VERSION; version++) {
    const db = new StoredRoomDb(structuredClone(measured), { version, seq: 9 });
    const ops: number[] = [];
    const step: typeof mapStepOps = (input) => {
      const out = mapStepOps(input);
      if (input.everyLayer) ops.push(out.length);
      return out;
    };
    const h = await storedActor(t, db, { idGate: false, mapStep: step });
    assert.deepEqual(ops, [0], `${version}: the measure forgets nothing`);
    assert.deepEqual(h.actor.committed.state, measured, `${version}: the room as it was`);
    assert.deepEqual([db.snapshot.version, charge(db.snapshot.state as RoomState, sceneId)], [SNAPSHOT_VERSION, charge(measured, sceneId)]);
  }
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
