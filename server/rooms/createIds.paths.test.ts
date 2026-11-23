import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { ID_TIME_REFUSED, isUuidv7, sealedTime, uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, character, room, scene } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * The id gate on each field that holds a new thing's id (createIds.ts,
 * newIdPaths.ts) through the room actor: a keyed socket's version 7 id in
 * a minted, keys or nested field is refused in the words its page retries
 * on, a keys or nested refusal names exactly the ids it found new, and the
 * op sent again with those ids sealed lands. Fields keyed by another
 * thing's id, and edits of things the room holds under version 7 ids,
 * land as they are.
 */

const HOUR = 3_600_000;
/** Ids of the room's things as an older build made them, two hours ago. */
const made = (label: string) => uuidv7(Date.now() - 2 * HOUR + label.length);
const OLD = { stamp: made("s"), light: made("li"), label: made("lab"), pin: made("pins"), page: made("pages"), roll: made("rolls_"), res: made("resour_"), scene: made("scenes__") };

const roll = (id: string) => ({ id, name: "Longsword", kind: "weapon", ability: "str", dice: [{ formula: "1d8" }] });
const stampPut = (id: string, x = 1) => ({ id, art: { key: "barrel" }, x, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });
const lightPut = (id: string) => ({ id, x: 1, y: 1, bright: 10, dim: 10, on: true, walls: true });
const pinPut = (id: string, label?: string) => ({ id, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all", ...(label ? { label } : {}) });

function table(): RoomState {
  const s = room();
  s.scenes[OLD.scene] = scene(OLD.scene, { name: "Old cave", order: 2 });
  s.stamps = { [OLD.stamp]: { ...stampPut(OLD.stamp), sceneId: "s1", rev: 0 } } as never;
  s.lights = { [OLD.light]: { ...lightPut(OLD.light), sceneId: "s1", rev: 0 } } as never;
  s.labels = { [OLD.label]: { id: OLD.label, sceneId: "s1", x: 1, y: 1, text: "Old", size: 1, rev: 0 } } as never;
  s.pins = { [OLD.pin]: { ...pinPut(OLD.pin), rev: 0 } } as never;
  s.journal = { [OLD.page]: { id: OLD.page, rev: 0, title: "Old page", blocks: [], access: { players: "none" } } } as never;
  s.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor(), stats: { ...EMPTY_PC_STATS, rolls: [roll(OLD.roll)] } as never, resources: [{ id: OLD.res, name: "Rage", max: 2, reset: "long", used: 0 }] as never });
  return s;
}

async function open(t: TestContext, options: Parameters<typeof scopeActor>[2] = {}) {
  const state = table();
  const { actor: room, connect } = await scopeActor(t, state, options);
  const dm = await connect(state.members.dm1!, "dm", undefined, undefined, true);
  const p1 = await connect(state.members.p1!, "player", undefined, undefined, true);
  const olderDm = await connect(state.members.dm1!, "dm");
  return { room, dm, p1, olderDm, state: () => room.committed.state };
}

type Refusal = { code: string; message: string; ids?: string[] };

async function answer(client: ScopeClient, op: Op): Promise<"taken" | Refusal> {
  const event = await client.send(op);
  const refusal = event.rejects?.find((r) => r.n === client.n);
  return refusal ? { code: refusal.code, message: refusal.message, ...("ids" in refusal && refusal.ids ? { ids: refusal.ids as string[] } : {}) } : "taken";
}

/** `op` with each of `ids` swapped for a fresh id sealed under the client's key, as a page's one retry makes them. */
function resealed(client: ScopeClient, op: Op, ids: readonly string[]): { op: Op; renames: Map<string, string> } {
  const renames = new Map(ids.map((id) => [id, client.newId()]));
  let text = JSON.stringify(op);
  for (const [from, to] of renames) text = text.split(from).join(to);
  return { op: JSON.parse(text) as Op, renames };
}

const REFUSED = { code: "invalid", message: ID_TIME_REFUSED };

describe("a keyed page's version 7 id in a field of a new thing", () => {
  test("a minted id is refused in the words the page retries on, naming none, and the op with a sealed id lands", async (t) => {
    const r = await open(t);
    const id = uuidv7();
    const create: Op = { t: "drawing.create", drawing: { id, sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "dm1", visibility: "all" } } as Op;
    assert.deepEqual(await answer(r.dm, create), REFUSED);
    const again = resealed(r.dm, create, [id]);
    assert.equal(await answer(r.dm, again.op), "taken");
    const keys = new RoomIdKeys(DEVELOPMENT_ROOM_SECRET_KEY, "UNDOSCOPE");
    const sealed = again.renames.get(id)!;
    assert.ok(r.state().drawings[sealed]);
    assert.ok(sealedTime(keys.member("dm1").key, sealed) !== null);
  });

  for (const [name, op, fresh] of (() => {
    const id = () => uuidv7();
    const s = id(), l = id(), lab = id(), p = id(), rl = id(), rs = id();
    return [
      ["a stamp", { t: "build.stamps", sceneId: "s1", put: [stampPut(s, 3)], forget: true }, s],
      ["a light", { t: "build.lights", sceneId: "s1", put: [lightPut(l)] }, l],
      ["a label", { t: "build.label", sceneId: "s1", labelId: lab, label: { x: 2, y: 2, text: "New", size: 1 }, forget: true }, lab],
      ["a pin", { t: "pin.put", pin: pinPut(p) }, p],
      ["a character's roll", { t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(OLD.roll), roll(rl)] } } }, rl],
      ["a character's class resource", { t: "character.update", characterId: "c1", patch: { resources: [{ id: OLD.res, name: "Rage", max: 2, reset: "long" }, { id: rs, name: "Ki", max: 3, reset: "short" }] } }, rs],
    ] as const;
  })()) {
    test(`${name}: refused naming exactly that id, and sent again with it sealed it lands`, async (t) => {
      const r = await open(t);
      const sent = op as unknown as Op;
      assert.deepEqual(await answer(r.dm, sent), { ...REFUSED, ids: [fresh] });
      const again = resealed(r.dm, sent, [fresh]);
      assert.equal(await answer(r.dm, again.op), "taken");
      assert.ok(JSON.stringify(r.state()).includes(again.renames.get(fresh)!));
      assert.ok(!JSON.stringify(r.state()).includes(fresh), "the version 7 id never landed");
    });
  }

  test("a player's own character: a new version 7 roll is refused naming it, read against the player's own copy", async (t) => {
    const r = await open(t);
    const fresh = uuidv7();
    const op: Op = { t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(OLD.roll), roll(fresh)] } } } as Op;
    assert.deepEqual(await answer(r.p1, op), { ...REFUSED, ids: [fresh] });
    assert.equal(await answer(r.p1, resealed(r.p1, op, [fresh]).op), "taken");
  });

  test("a fired effect: refused naming its id, and taken sealed", async (t) => {
    // Sound switched on: off, the room refuses the op itself before its ids.
    const r = await open(t, { roomSound: true });
    const fresh = uuidv7();
    const op = { t: "effect.fire", id: fresh, builtin: "click" } as Op;
    assert.deepEqual(await answer(r.dm, op), { ...REFUSED, ids: [fresh] });
    assert.equal(await answer(r.dm, resealed(r.dm, op, [fresh]).op), "taken");
  });

  test("one build of stamps that adds a new one and replaces an old one is refused naming the new one alone, and its retry leaves two", async (t) => {
    const r = await open(t);
    const fresh = uuidv7();
    const op: Op = { t: "build.stamps", sceneId: "s1", put: [stampPut(OLD.stamp, 4), stampPut(fresh, 6)], forget: true } as Op;
    assert.deepEqual(await answer(r.dm, op), { ...REFUSED, ids: [fresh] });
    // The DM's view moves to another scene before the retry: the server's list, never what the page holds, says which is new.
    await r.dm.apply({ t: "room.setPlayerScene", sceneId: "s2" });
    const again = resealed(r.dm, op, [fresh]);
    assert.equal(await answer(r.dm, again.op), "taken");
    const stamps = Object.values(r.state().stamps ?? {}).filter((s) => s.sceneId === "s1");
    assert.equal(stamps.length, 2);
    assert.equal(r.state().stamps[OLD.stamp]?.x, 4, "the old stamp replaced in place under its own id");
    assert.ok(r.state().stamps[again.renames.get(fresh)!]);
  });
});

describe("what a keyed page sends as it is", () => {
  test("edits and removals of a pin, stamp, light, label and journal page the room holds under version 7 ids land under those ids", async (t) => {
    const r = await open(t);
    const edits: Op[] = [
      { t: "pin.put", pin: pinPut(OLD.pin, "Moved") },
      { t: "build.stamps", sceneId: "s1", put: [stampPut(OLD.stamp, 5)], forget: true },
      { t: "build.lights", sceneId: "s1", put: [{ ...lightPut(OLD.light), bright: 20 }] },
      { t: "build.label", sceneId: "s1", labelId: OLD.label, label: { x: 3, y: 3, text: "Moved", size: 1 }, forget: true },
      { t: "journal.update", pageId: OLD.page, patch: { title: "Renamed" } },
    ] as Op[];
    for (const op of edits) assert.equal(await answer(r.dm, op), "taken", op.t);
    const s = r.state();
    assert.deepEqual([Object.keys(s.pins), Object.keys(s.stamps), Object.keys(s.lights), Object.keys(s.labels), Object.keys(s.journal)], [[OLD.pin], [OLD.stamp], [OLD.light], [OLD.label], [OLD.page]], "no second thing");
    const removals: Op[] = [
      { t: "pin.remove", pinId: OLD.pin },
      { t: "build.stamps", sceneId: "s1", remove: [OLD.stamp], forget: true },
      { t: "build.lights", sceneId: "s1", remove: [OLD.light] },
      { t: "build.label", sceneId: "s1", labelId: OLD.label, label: null, forget: true },
      { t: "journal.delete", pageId: OLD.page },
    ] as Op[];
    for (const op of removals) assert.equal(await answer(r.dm, op), "taken", op.t);
    const after = r.state();
    assert.deepEqual([after.pins, after.stamps, after.lights, after.labels, after.journal].map((m) => Object.keys(m ?? {}).length), [0, 0, 0, 0, 0]);
  });

  test("fields keyed by another thing's id take a version 7 scene's id: a first fog draft, and the party moved to a scene they never played", async (t) => {
    const r = await open(t);
    assert.ok(isUuidv7(OLD.scene));
    assert.equal(await answer(r.dm, { t: "fog.draft", sceneId: OLD.scene, add: [{ id: r.dm.newId(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } }] } as Op), "taken");
    assert.equal(await answer(r.dm, { t: "room.setPlayerScene", sceneId: OLD.scene } as Op), "taken");
    assert.equal(r.state().meta.playerSceneId, OLD.scene);
  });

  test("a page that holds no key brings version 7 ids in every field before the cutover", async (t) => {
    const r = await open(t);
    const fresh = uuidv7();
    assert.equal(await answer(r.olderDm, { t: "pin.put", pin: pinPut(fresh) } as Op), "taken");
    assert.equal(await answer(r.olderDm, { t: "drawing.create", drawing: { id: uuidv7(), sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "dm1", visibility: "all" } } as Op), "taken");
  });
});
