import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { clientOpSchema, opSchema, type ActorPatch, type Op, type OpOf } from "./protocol.ts";
import { character, room, token } from "./testutil.ts";
import type { UndoScope } from "./undoContract.ts";

type Classifier = { undoScope(op: Op, before: RoomState): UndoScope; UNDO_SCOPE_BY_OP: Record<Op["t"], unknown> };
const path = new URL("./undoScope.ts", import.meta.url);
// Lane A owns this module. Missing scaffolding is a skip, never fail-first evidence.
const classifier: Classifier | null = existsSync(path) ? await import(path.href) as Classifier : null;

const inventory = {
  play: [
    "token.move", "token.moveMany", "token.countLeg", "token.attach", "token.detach", "token.create", "token.delete", "token.deleteMany",
    "actor.hp", "actor.damageMany", "actor.deathSave", "actor.life", "actor.rest", "actor.effect.add", "actor.effect.update", "actor.effect.remove", "actor.effects", "actor.saveDue", "actor.use", "actor.prompt", "actor.outcome",
    "encounter.start", "encounter.end", "encounter.add", "encounter.remove", "encounter.setValue", "encounter.setValues", "encounter.reorder", "encounter.next", "encounter.prev", "encounter.update",
    "roll.ask", "roll.answer", "roll.reopen", "roll.close", "template.create", "template.update", "template.delete", "drawing.create", "drawing.delete", "drawing.clear",
    "fog.draft", "fog.publish", "fog.discard", "fog.live", "fog.reset", "build.paint", "build.erase", "build.rect", "build.poly", "build.edge", "build.label", "build.clear", "build.walls", "build.stamps", "build.lights", "build.height", "build.stairs", "build.rough",
    "door.set", "trap.spring", "trap.act", "trap.settle", "scene.setPhase", "room.setPlayerScene", "view.follow", "view.blackout", "journal.reveal", "handout.show", "handout.close",
  ],
  setup: [
    "trap.create", "trap.delete", "character.create", "character.delete", "monster.create", "monster.update", "monster.delete", "monster.setSrdImage", "companionBlock.create", "companionBlock.update", "companionBlock.delete",
    "savedEncounter.create", "savedEncounter.update", "savedEncounter.delete", "scene.create", "scene.delete", "scene.duplicate", "scene.reorder", "scene.setMap", "scene.setGrid", "vision.holders", "room.update",
    "journal.create", "journal.update", "journal.delete", "pin.put", "pin.remove", "handoutDoc.create", "handoutDoc.delete",
  ],
  none: ["roll.change", "cast.ask", "cast.close", "dice.roll", "roll.dice", "actor.deathRoll", "actor.rechargeRoll", "build.ask", "member.update", "log.chat", "log.whisper", "undo", "redo"],
} satisfies Record<UndoScope, string[]>;
const fieldSensitive = ["token.update", "token.updateMany", "character.update", "scene.update", "trap.update"];

function before(): RoomState {
  return room({ characters: { bree: character("bree") }, tokens: { goblin: token("goblin"), pc: token("pc", { kind: "pc", actor: { ref: "bree" } }) } });
}

function scope(op: unknown, state = before()): UndoScope {
  assert.ok(classifier, "lane A's classifier scaffold is available");
  return classifier.undoScope(op as Op, state);
}

describe("undo classifier inventory", { skip: classifier === null ? "waiting for lane A shared/undoScope.ts" : false }, () => {
  test("every client protocol discriminant and server op has an explicit inventory entry", () => {
    const expected = [...Object.values(inventory).flat(), ...fieldSensitive];
    assert.equal(new Set(expected).size, expected.length);
    const actual = clientOpSchema.options.map((schema) => schema.shape.t.value);
    assert.deepEqual([...expected].sort(), [...actual].sort());
    assert.deepEqual(Object.keys(classifier!.UNDO_SCOPE_BY_OP).sort(), opSchema.options.map((schema) => schema.shape.t.value).sort());
  });

  for (const [expected, types] of Object.entries(inventory)) {
    for (const t of types) test(`${t} is ${expected}`, () => assert.equal(scope({ t }), expected));
  }

  const tokenFields = {
    sceneId: ["s2", "play"], x: [4, "play"], y: [4, "play"], elevation: [5, "play"], rotation: [90, "play"], size: ["large", "play"], w: [2, "play"], h: [2, "play"], visibility: ["dm", "play"], light: [{ bright: 10, dim: 20 }, "play"], companionReaction: [true, "play"], actor: [{ hp: { cur: 3 } }, "play"],
    kind: ["npc", "setup"], name: ["Captain", "setup"], publicName: ["Unknown figure", "setup"], nameHidden: [true, "setup"], image: [null, "setup"], height: [10, "setup"], disposition: ["ally", "setup"], fogExempt: [true, "setup"], locked: [true, "setup"], layer: ["object", "setup"], ownerIds: [["p1"], "setup"], hpVisibility: ["exact", "setup"], number: [2, "setup"], notes: ["Private definition", "setup"], altImages: [null, "setup"], rangeRings: [[10], "setup"], partyVision: [false, "setup"], companion: [null, "setup"],
  } satisfies Record<keyof OpOf<"token.update">["patch"], readonly [unknown, UndoScope]>;

  test("the token field matrix covers every schema patch key", () => {
    const schema = clientOpSchema.options.find((s) => s.shape.t.value === "token.update");
    assert.ok(schema && "patch" in schema.shape);
    assert.deepEqual(Object.keys(tokenFields).sort(), Object.keys((schema.shape.patch as { shape: object }).shape).sort());
  });

  for (const [field, [value, expected]] of Object.entries(tokenFields)) {
    test(`token patch ${field} is ${expected}`, () => assert.equal(scope({ t: "token.update", tokenId: "goblin", patch: { [field]: value } }), expected));
  }

  test("bulk token fields use the same allowlist", () => {
    const schema = clientOpSchema.options.find((s) => s.shape.t.value === "token.updateMany");
    assert.ok(schema && "patch" in schema.shape);
    const fields = Object.keys((schema.shape.patch as { shape: object }).shape);
    for (const field of fields) {
      const sample = tokenFields[field as keyof typeof tokenFields];
      assert.ok(sample, `missing token.updateMany field ${field}`);
      assert.equal(scope({ t: "token.updateMany", tokenIds: ["goblin"], patch: { [field]: sample[0] } }), sample[1], field);
    }
  });

  test("unknown and mixed token fields default to Setup", () => {
    for (const patch of [{ x: 5, name: "Captain" }, { x: 5, futureField: true }, { actor: { hp: { cur: 3 }, futureField: true } }]) {
      assert.equal(scope({ t: "token.update", tokenId: "goblin", patch }), "setup");
    }
  });

  const actorFields = {
    hp: [{ cur: 8, temp: 2 }, "play"], ac: [19, "setup"], speeds: [{ walk: 40 }, "setup"], initBonus: [4, "setup"], initScore: [14, "setup"], passivePerception: [15, "setup"], senses: ["Darkvision 60 ft.", "setup"], creatureType: ["Beast", "setup"], cr: ["1", "setup"], xp: [200, "setup"], srdId: ["wolf", "setup"], monsterId: ["custom", "setup"], blockId: ["block", "setup"], wildShape: [true, "setup"], sheetUrl: [null, "setup"], legendary: [null, "setup"], notes: ["Notes", "setup"], dmNotes: ["Private notes", "setup"],
  } satisfies Record<keyof ActorPatch, readonly [unknown, UndoScope]>;

  for (const [field, [value, expected]] of Object.entries(actorFields)) {
    test(`actor patch ${field} is ${expected}`, () => {
      for (const op of [{ t: "character.update", characterId: "bree" }, { t: "token.update", tokenId: "goblin" }]) assert.equal(scope({ ...op, patch: { actor: { [field]: value } } }), expected);
    });
  }

  test("HP-section maximum is Play, sheet maximum and mixed HP/AC saves are Setup", () => {
    assert.equal(scope({ t: "actor.hp", target: { characterId: "bree" }, change: { kind: "set", max: 30 } }), "play");
    for (const actor of [{ hp: { max: 30 } }, { hp: { cur: 10, max: 10 } }, { hp: { cur: 10 }, ac: 19 }]) {
      assert.equal(scope({ t: "character.update", characterId: "bree", patch: { actor } }), "setup");
      assert.equal(scope({ t: "token.update", tokenId: "goblin", patch: { actor } }), "setup");
    }
  });

  test("legacy spent legendary counts are Play only while all maxima match before", () => {
    const state = before();
    state.characters.bree!.actor.legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 2, resistUsed: 0 };
    const legendary = { actionsMax: 3, actionsUsed: 2, resistMax: 2, resistUsed: 1 };
    const op = (patch: object) => ({ t: "character.update", characterId: "bree", patch: { actor: patch } });
    assert.equal(scope(op({ legendary }), state), "play");
    assert.equal(scope(op({ legendary: { ...legendary, actionsMax: 4 } }), state), "setup");
    assert.equal(scope(op({ legendary: { ...legendary, resistMax: 3 } }), state), "setup");
    assert.equal(scope(op({ legendary, ac: 19 }), state), "setup");
    assert.equal(scope(op({ legendary }), before()), "setup");
  });

  test("only the exact character shape structures qualify as Play", () => {
    const take = { srdId: "wolf", ac: 12, speeds: { walk: 40 } };
    for (const actor of [take, { ...take, wildShape: true }, { ...take, hp: { temp: 8 } }, { srdId: null }]) {
      assert.equal(scope({ t: "character.update", characterId: "bree", patch: { actor } }), "play");
      assert.equal(scope({ t: "token.update", tokenId: "pc", patch: { actor } }), "play");
      assert.equal(scope({ t: "token.update", tokenId: "goblin", patch: { actor } }), "setup");
    }
    for (const actor of [{ ...take, hp: { max: 30 } }, { ...take, hp: { cur: 8 } }, { srdId: "wolf", ac: 12 }, { ...take, notes: "extra" }, { ...take, futureField: true }]) {
      assert.equal(scope({ t: "character.update", characterId: "bree", patch: { actor } }), "setup");
    }
    assert.equal(scope({ t: "character.update", characterId: "bree", patch: { actor: take, level: 6 } }), "setup");
    assert.equal(scope({ t: "character.update", characterId: "bree", patch: { size: "large" } }), "setup");
  });

  const characterFields = {
    name: "Bree", size: "large", ownerIds: ["p2"], defaultImage: null, actor: { ac: 19 }, level: 6,
    stats: { evasion: true }, knownForms: ["wolf"], ddbSync: null, resources: [],
  } satisfies Record<keyof OpOf<"character.update">["patch"], unknown>;
  for (const [field, value] of Object.entries(characterFields)) {
    test(`character field ${field} is Setup unless covered by the exact actor exceptions`, () => {
      assert.equal(scope({ t: "character.update", characterId: "bree", patch: { [field]: value } }), "setup");
    });
  }

  const sceneFields = {
    name: ["Dungeon", "setup"], bounds: [{ w: 20, h: 20 }, "setup"], grid: [{ show: false, color: "#ffffff", opacity: 0.2, lineWidth: 1 }, "setup"], background: ["#000000", "setup"], fogEnabled: [true, "setup"], defaultView: [null, "setup"], autoWalls: ["off", "setup"], folder: [null, "setup"], thumb: [null, "none"], phases: [[], "setup"], blockMovement: [true, "setup"], vision: [{ on: true, light: "dark" }, "setup"], gridShape: ["hexRows", "setup"], suggestedView: ["isometric", "play"],
  } satisfies Record<keyof OpOf<"scene.update">["patch"], readonly [unknown, UndoScope]>;
  for (const [field, [value, expected]] of Object.entries(sceneFields)) {
    test(`scene field ${field} is ${expected}`, () => assert.equal(scope({ t: "scene.update", sceneId: "s1", patch: { [field]: value } }), expected));
  }

  test("scene vision compares effective on and perPlayer, while thumbnail-only is None", () => {
    const state = before();
    const op = (patch: object) => ({ t: "scene.update", sceneId: "s1", patch });
    assert.equal(scope(op({ thumb: null }), state), "none");
    assert.equal(scope(op({ suggestedView: "isometric" }), state), "play");
    assert.equal(scope(op({ vision: { on: false, light: "dim" } }), state), "play");
    assert.equal(scope(op({ vision: { on: true, light: "dim" } }), state), "setup");
    state.scenes.s1!.vision = { on: true, perPlayer: true, light: "bright" };
    assert.equal(scope(op({ vision: { on: true, perPlayer: true, light: "dim" } }), state), "play");
    assert.equal(scope(op({ vision: { on: true, perPlayer: false, light: "dim" } }), state), "setup");
    for (const patch of [{ vision: { on: true, light: "dim" }, name: "Dungeon" }, { suggestedView: "isometric", bounds: { w: 30, h: 30 } }, { futureField: true }]) assert.equal(scope(op(patch), state), "setup");
  });

  test("trap runtime state is Play, definitions and mixed edits are Setup", () => {
    for (const patch of [{ state: "disarmed" }, { found: true }, { state: "armed", found: false }]) assert.equal(scope({ t: "trap.update", trapId: "trap", patch }), "play");
    for (const patch of [{ name: "Pit" }, { rig: {} }, { zone: {} }, { state: "disarmed", name: "Pit" }, { futureField: true }]) assert.equal(scope({ t: "trap.update", trapId: "trap", patch }), "setup");
  });
});
