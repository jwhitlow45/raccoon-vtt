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
 * fails marks the snapshot row (caps_pending), at today's format still, so
 * each load's first batch measures every layer until one commits.
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

/** Every snapshot row this build wrote is at today's format, which a build from before it (format 49) refuses. */
const allToday = (db: StoredRoomDb) => db.versions.length > 0 && db.versions.every((v) => v >= SNAPSHOT_VERSION);

test("a load whose measure fails gives the ids anew all the same and stores the room at today's format, marked as owing the measure, which a restart's first batch takes and clears", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  assert.deepEqual([db.snapshotWrites, db.snapshot.version, db.snapshot.capsPending], [1, SNAPSHOT_VERSION, true]);
  assert.notDeepEqual(v7Tokens(first.actor.committed.state), v7Tokens(state), "the goblin's id given anew");
  assert.ok(charge(db.snapshot.state as RoomState, sceneId) > share, "stored unmeasured");

  // Restarted before any batch: the load gives no ids again, and its first batch measures every layer.
  const step = failing(0);
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false, mapStep: step });
  const dm = await again.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(again.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.equal(step.measures, 1);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "measured");
  assert.deepEqual(v7Tokens(again.actor.committed.state), v7Tokens(first.actor.committed.state));

  // The stop's snapshot no longer owes it, so the next load's first batch measures only what moved.
  const later = failing(0);
  const third = await restartStored(t, again, { snapshot: true }, { idGate: false, mapStep: later });
  assert.equal(db.snapshot.capsPending, false, "the mark cleared");
  const dm3 = await third.connect(dmOf(state));
  assert.equal((await dm3.apply({ t: "scene.update", sceneId: otherScene(third.actor.committed.state, sceneId), patch: { name: "Elsewhere again" } })).rejects, undefined);
  assert.equal(later.measures, 0);
  assert.ok(allToday(db), `every row at today's format: ${db.versions.join(", ")}`);
});

test("a room whose measure failed at its load and at its first batch stays marked through a restart, whose first batch measures it, and the charge falls to its share", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const twice = failing(2);
  const first = await storedActor(t, db, { idGate: false, mapStep: twice });
  const dm = await first.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(first.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.equal(twice.measures, 2, "the load's measure and the first batch's both failed");
  assert.ok(charge(first.actor.committed.state, sceneId) > share, "still over its share");

  // A deploy's stop writes the snapshot, still marked, and the next load's first batch measures.
  const step = failing(0);
  const again = await restartStored(t, first, { snapshot: true }, { idGate: false, mapStep: step });
  assert.deepEqual([db.snapshot.version, db.snapshot.capsPending], [SNAPSHOT_VERSION, true]);
  const dm2 = await again.connect(dmOf(state));
  assert.equal((await dm2.apply({ t: "scene.update", sceneId: otherScene(again.actor.committed.state, sceneId), patch: { name: "Elsewhere again" } })).rejects, undefined);
  assert.equal(step.measures, 1);
  assert.ok(charge(again.actor.committed.state, sceneId) <= share, "the charge falls to its share");
  assert.ok(allToday(db), `every row at today's format: ${db.versions.join(", ")}`);
});

test("a room the build before stored over its share, whose load's measure fails, has its first batch measure every layer", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: SEALED_IDS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  assert.ok(charge(first.actor.committed.state, sceneId) > share);
  const dm = await first.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(first.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.ok(charge(first.actor.committed.state, sceneId) <= share, "the first batch measured every layer");
  assert.ok(allToday(db));
});

test("a room whose measure fails at every load still has its ids given anew, at today's format, and stays marked", async (t) => {
  const { state } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing() });
  const kept = v7Tokens(first.actor.committed.state);
  assert.ok(kept.length < v7Tokens(state).length, "the goblin's id given anew");
  const again = await restartStored(t, first, { snapshot: true }, { idGate: false, mapStep: failing() });
  assert.deepEqual([db.snapshot.version, db.snapshot.capsPending], [SNAPSHOT_VERSION, true]);
  assert.deepEqual(Object.keys(again.actor.committed.state.tokens).sort(), Object.keys(first.actor.committed.state.tokens).sort(), "the restart gives no id again");
  assert.ok(allToday(db));
});

test("the mark is the snapshot row's alone: no frame a DM or a player is sent carries it", async (t) => {
  const { state } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const h = await storedActor(t, db, { idGate: false, mapStep: failing() });
  assert.equal(db.snapshot.capsPending, true);
  assert.equal(Object.hasOwn(h.actor.committed.state, "capsPending"), false, "the room's state holds no such field");
  const player = Object.values(state.members).find((m) => m.kind === "player")!;
  for (const who of [dmOf(state), player]) {
    const client = await h.connect(who);
    const text = JSON.stringify(client.sent);
    assert.ok(client.sent.some((m) => m.t === "snapshot"));
    assert.doesNotMatch(text, /caps_?pending/i, who.kind);
  }
});

test("a room this build measured and stored below today's version is unchanged by its load's measure", async (t) => {
  const { state, sceneId } = overShare();
  // Measured as a first load leaves it, then stored at each version below version 8 ids that a live room can hold: a room
  // stored at or past them gives no ids anew, so its load runs no measure (reidDue).
  const once = await storedActor(t, new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 }), { idGate: false });
  const measured = once.actor.committed.state;
  for (let version = PLAYER_LIMITS_SNAPSHOT_VERSION; version < SEALED_IDS_SNAPSHOT_VERSION; version++) {
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

/** The map step with every op it returns while it measures every layer made one the schema refuses: nothing kept, nothing forgotten. */
function refusing(): typeof mapStepOps & { measures: number } {
  const step = ((input) => {
    const ops = mapStepOps(input);
    if (!input.everyLayer) return ops;
    step.measures++;
    return ops.map((op) => ({ t: "sys.remember" as const, sceneId: op.sceneId, layers: [] }));
  }) as typeof mapStepOps & { measures: number };
  step.measures = 0;
  return step;
}

test("a batch whose every-layer measure is refused with its forgetting leaves the room owing the measure, which its next batch takes again", async (t) => {
  const { state, sceneId, share } = overShare();
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  assert.equal(db.snapshot.capsPending, true);
  const step = refusing();
  const noForgetting = (_state: RoomState, scene: string) => ({ t: "sys.remember" as const, sceneId: scene, layers: [] });
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false, mapStep: step, forgetScene: noForgetting });
  const dm = await again.connect(dmOf(state));
  const other = otherScene(again.actor.committed.state, sceneId);
  assert.equal((await dm.apply({ t: "scene.update", sceneId: other, patch: { name: "Elsewhere" } })).rejects, undefined);
  assert.equal(step.measures, 1);
  assert.ok(charge(again.actor.committed.state, sceneId) > share, "the refused measure forgot nothing");
  assert.equal((await dm.apply({ t: "scene.update", sceneId: other, patch: { name: "Elsewhere again" } })).rejects, undefined);
  assert.equal(step.measures, 2, "the next batch measures every layer again");
  await restartStored(t, again, { snapshot: true }, { idGate: false, mapStep: failing(0) });
  assert.equal(db.snapshot.capsPending, true, "the stop's snapshot still owes the measure");
});

test("a batch of refusals alone whose measure clears the owed mark stores the mark cleared at the stop, though no op was stored", async (t) => {
  const { state, sceneId } = overShare();
  // A share the party's layer fits, so the measure forgets nothing.
  state.memoryShared = { [sceneId]: { sceneId, rev: 0, share: 10 * charge(state, sceneId) } };
  const db = new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1, seq: 9 });
  const first = await storedActor(t, db, { idGate: false, mapStep: failing(1) });
  // A batch that remembers what the party sees, whose measure fails, then a stop that stores the room still marked.
  const again = await restartStored(t, first, { snapshot: false, flush: false }, { idGate: false, mapStep: failing(1) });
  const dm = await again.connect(dmOf(state));
  assert.equal((await dm.apply({ t: "scene.update", sceneId: otherScene(again.actor.committed.state, sceneId), patch: { name: "Elsewhere" } })).rejects, undefined);
  const step = failing(0);
  const third = await restartStored(t, again, { snapshot: true }, { idGate: false, mapStep: step });
  assert.deepEqual([db.snapshot.seq, db.snapshot.capsPending], [third.actor.committed.seq, true]);
  const seq = third.actor.committed.seq;
  const dm3 = await third.connect(dmOf(state));
  const refused = await dm3.send({ t: "scene.update", sceneId: "no-such-scene", patch: { name: "Nowhere" } });
  assert.equal(refused.rejects?.length, 1);
  assert.equal(step.measures, 1, "the refusal's batch measured every layer");
  assert.equal(third.actor.committed.seq, seq, "and stored no op");
  const writes = db.snapshotWrites;
  const fourth = await restartStored(t, third, { snapshot: true }, { idGate: false, mapStep: failing(0) });
  assert.deepEqual([db.snapshotWrites, db.snapshot.seq, db.snapshot.capsPending], [writes + 1, seq, false], "the stop stored the mark cleared");
  const later = failing(0);
  const fifth = await restartStored(t, fourth, { snapshot: true }, { idGate: false, mapStep: later });
  const dm5 = await fifth.connect(dmOf(state));
  assert.equal((await dm5.apply({ t: "scene.update", sceneId: otherScene(fifth.actor.committed.state, sceneId), patch: { name: "Elsewhere still" } })).rejects, undefined);
  assert.equal(later.measures, 0, "a load after it measures only what moved");
});
