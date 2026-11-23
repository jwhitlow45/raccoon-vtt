import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { idKeyOf, sealedId, uuidv7 } from "#shared/ids.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { NEW_ID_PATHS, newIdsOf, nestedIdsIn, type Op, type OpType } from "#shared/protocol.ts";
import type { Playing } from "#shared/sound.ts";
import { actor, character, room, token } from "#shared/testutil.ts";
import { newV7Ids } from "./newIdPaths.ts";

const DM = { memberId: "dm1", role: "dm" as const };
const P1 = { memberId: "p1", role: "player" as const };
const key = idKeyOf(createHash("sha256").update("dm1").digest());
const T = 1_700_000_000_000;

const old = uuidv7(T - 60_000);
const fresh = uuidv7(T);
const sealed = sealedId(key, T);

function playing(over: Partial<Playing> = {}): Playing {
  return { rev: 0, music: null, loops: {}, effects: [], volume: { music: 80, effects: 80 }, ...over };
}

const roll = (id: string) => ({ id, name: "Longsword", kind: "weapon" as const, ability: "str" as const, dice: [{ formula: "1d8" }] });

function table(): RoomState {
  const s = room();
  s.stamps = { [old]: { id: old, sceneId: "s1", art: { key: "barrel" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", rev: 0 } } as never;
  s.lights = { [old]: { id: old, sceneId: "s1", x: 1, y: 1, bright: 10, dim: 10, on: true, walls: true, rev: 0 } } as never;
  s.labels = { [old]: { id: old, sceneId: "s1", x: 1, y: 1, text: "Old", size: 1, rev: 0 } } as never;
  s.pins = { [old]: { id: old, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all", rev: 0 } } as never;
  s.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor(), stats: { rolls: [roll(old)] } as never, resources: [{ id: old, name: "Rage", max: 2, used: 0 }] as never });
  s.playing = playing({ music: { run: old, repeat: "all", fade: 0 } as never, loops: { [old]: { soundId: "x", at: 0, volume: 50 } as never }, effects: [{ id: old, builtin: "click", at: 0 } as never] });
  s.scenes.s1 = { ...s.scenes.s1!, phases: [phase(old)] };
  // Thorn is P1's and the goblin the DM's, each with an ask to change its answer, and Thorn with a change allowed before.
  s.tokens.thorn = token("thorn", { ownerIds: ["p1"] });
  s.tokens.gob = token("gob");
  s.rolls = {
    r1: { id: "r1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: "2026-11-13T12:00:00.000Z", targets: [{ tokenId: "thorn", tag: "t1", total: 9, change: ask(old), changed: ask(allowed) }, { tokenId: "gob", tag: "t2", total: 4, change: ask(dms) }] },
  } as never;
  return s;
}

const allowed = uuidv7(T - 120_000);
const dms = uuidv7(T - 90_000);

function phase(id: string) {
  return { id, name: "On fire", assetId: "a1", widthPx: 1000, heightPx: 800 };
}

function ask(id: string, on = "t1") {
  return { id, on, reason: "fix-total" as const };
}

const v7 = (op: Op, viewer: Viewer = DM, held: ReadonlyMap<string, unknown> | null = null, state = table()) => newV7Ids(op, state, viewer, held);

describe("the new-id fields an op carries (NEW_ID_PATHS)", () => {
  test("a build's stamps and lights: only a version 7 key the room lacks is new, whatever else the put holds", () => {
    const stamp = (id: string) => ({ id, art: { key: "barrel" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });
    assert.deepEqual(v7({ t: "build.stamps", sceneId: "s1", put: [stamp(old), stamp(fresh), stamp(sealed)] } as Op), [fresh]);
    assert.deepEqual(v7({ t: "build.stamps", sceneId: "s1", remove: [old] } as Op), [], "a removal names no new thing");
    const light = (id: string) => ({ id, x: 1, y: 1, bright: 10, dim: 10, on: true, walls: true });
    assert.deepEqual(v7({ t: "build.lights", sceneId: "s1", put: [light(fresh), light(old)] } as Op), [fresh]);
  });

  test("a label, a pin and a journal page: new only where the room lacks the key", () => {
    const label = (labelId: string, text: string | null) => ({ t: "build.label", sceneId: "s1", labelId, label: text === null ? null : { x: 1, y: 1, text, size: 1 } }) as Op;
    assert.deepEqual(v7(label(fresh, "Here")), [fresh]);
    assert.deepEqual(v7(label(old, "Moved")), []);
    assert.deepEqual(v7(label(fresh, null)), [], "a label put back to nothing is a removal");
    const pin = (id: string) => ({ t: "pin.put", pin: { id, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all" } }) as Op;
    assert.deepEqual(v7(pin(fresh)), [fresh]);
    assert.deepEqual(v7(pin(old)), []);
    assert.deepEqual(v7({ t: "journal.update", pageId: fresh, patch: { title: "x" } } as Op), [fresh]);
  });

  test("a character's rolls and class resources: new where the character lacks them, a new character's all new", () => {
    const update: Op = { t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(old), roll(fresh)] }, resources: [{ id: old, name: "Rage", max: 2, reset: "long" }, { id: sealed, name: "Ki", max: 2, reset: "long" }] } } as unknown as Op;
    assert.deepEqual(v7(update), [fresh]);
    const other = uuidv7(T + 1);
    assert.deepEqual(v7({ t: "character.update", characterId: "c1", patch: { resources: [{ id: other, name: "Ki", max: 2, reset: "long" }] } } as unknown as Op), [other]);
    assert.deepEqual(v7({ t: "character.create", character: { id: sealed, name: "Cade", size: "medium", ownerIds: ["p1"], actor: actor(), stats: { rolls: [roll(old)] } } } as unknown as Op), [old], "the character is new, so every roll in it is");
  });

  test("a player's character update reads the character as their own copy holds it, which owners hold whole", () => {
    const update: Op = { t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(old), roll(fresh)] } } } as unknown as Op;
    assert.deepEqual(v7(update, P1), [fresh]);
  });

  test("what plays now: a run, a loop and a fired effect are new where it lacks them", () => {
    const run = (r: string) => [
      { t: "music.play", run: r, soundId: "m1", order: ["m1"], repeat: "all", fade: 0 },
      { t: "music.resume", run: r },
      { t: "music.skip", run: r },
      { t: "music.jump", run: r, from: old, soundId: "m1" },
      { t: "sound.scene", sceneId: "s1", run: r, order: [] },
    ] as Op[];
    for (const op of run(fresh)) assert.deepEqual(v7(op), [fresh], op.t);
    for (const op of run(old)) assert.deepEqual(v7(op), [], `${op.t} of the run playing now`);
    assert.deepEqual(v7({ t: "loop.start", id: fresh, soundId: "x", volume: 50 } as Op), [fresh]);
    assert.deepEqual(v7({ t: "loop.start", id: old, soundId: "x", volume: 50 } as Op), []);
    assert.deepEqual(v7({ t: "effect.fire", id: fresh, builtin: "click" } as Op), [fresh]);
    assert.deepEqual(v7({ t: "effect.fire", id: old, builtin: "click" } as Op), []);
    const behind = table();
    behind.playing = playing({ dmEffects: [{ id: fresh, builtin: "click", at: 0 } as never] });
    assert.deepEqual(v7({ t: "effect.fire", id: fresh, builtin: "click" } as Op, DM, null, behind), [], "an effect fired behind a blackout is held too");
  });

  test("a scene's map phases: new where the scene lacks them", () => {
    const update = (...ids: string[]) => ({ t: "scene.update", sceneId: "s1", patch: { phases: ids.map(phase) } }) as unknown as Op;
    assert.deepEqual(v7(update(old, fresh, sealed)), [fresh]);
    assert.deepEqual(v7(update(old)), [], "a phase the scene holds");
    assert.deepEqual(v7({ t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } } as Op), [], "an update with no phases names none");
  });

  test("an ask to change an answer: new where the request holds no ask or change of its id, read for a player from their own copy", () => {
    const change = (id: string, tokenId = "thorn") => ({ t: "roll.change", rollId: "r1", target: { tokenId }, ask: ask(id) }) as unknown as Op;
    assert.deepEqual(v7(change(fresh)), [fresh]);
    assert.deepEqual(v7(change(old)), [], "the pending ask");
    assert.deepEqual(v7(change(allowed)), [], "a change allowed before");
    assert.deepEqual(v7(change(sealed)), []);
    assert.deepEqual(v7({ t: "roll.change", rollId: "r1", target: { tokenId: "thorn" }, clear: fresh } as Op), [], "a clear names a stored ask");
    assert.deepEqual(v7(change(fresh), P1), [fresh]);
    assert.deepEqual(v7(change(old), P1), []);
    assert.deepEqual(v7(change(dms), P1), [dms], "the goblin's ask is not in P1's copy");
    assert.deepEqual(v7(change(dms)), [], "the room holds it");
  });

  test("a player's keys are read from what their socket holds, never from the room", () => {
    const pin: Op = { t: "pin.put", pin: { id: old, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all" } } as Op;
    assert.deepEqual(v7(pin, P1, new Map()), [old], "the room holds it, the player's copy does not");
    assert.deepEqual(v7(pin, P1, new Map([[`pin:${old}`, "hash"]])), []);
  });

  test("ops that bring things back, the server's own and every other kind list no keys or nested fields", () => {
    const withPaths = (Object.keys(NEW_ID_PATHS) as OpType[]).filter((t) => NEW_ID_PATHS[t] !== "none").sort();
    assert.deepEqual(withPaths, ["build.label", "build.lights", "build.stamps", "character.create", "character.update", "effect.fire", "journal.update", "loop.start", "music.jump", "music.play", "music.resume", "music.skip", "pin.put", "roll.change", "scene.update", "sound.scene"]);
    for (const t of ["undo", "redo", "sys.restore"] as const) assert.equal(NEW_ID_PATHS[t], "none");
    for (const t of Object.keys(NEW_ID_PATHS) as OpType[]) if (t.startsWith("sys.")) assert.equal(NEW_ID_PATHS[t], "none", t);
  });

  test("an op's new-id fields: minted, recorded, keys and nested, each id once per part", () => {
    const op = { t: "build.stamps", sceneId: "s1", put: [{ id: fresh }, { id: fresh }] } as unknown as Op;
    assert.deepEqual(newIdsOf(op), { minted: [], recorded: [], keys: [{ key: `stamp:${fresh}`, id: fresh }], nested: [] });
    assert.deepEqual([...nestedIdsIn("character:c1", table().characters.c1)].sort(), [old]);
    assert.deepEqual([...nestedIdsIn("token:x", { id: "y" })], []);
  });
});
