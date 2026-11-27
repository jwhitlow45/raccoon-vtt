import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatFeatures, MAX_CHOICES_PER_ROLE, migratedChoices, NO_CHOICES, parseFeatures, withChoice, withPreset, withShow, type FeatureChoices } from "./store.ts";

/*
 * This device's parts choices as stored (docs/design/design-v1-features.md 9):
 * only changed choices, per role, unknown ids kept, a malformed value read
 * as none, and the one-time migration from Roll animation. The device's
 * own store, with its first read and its migration, runs in a fresh
 * import below, over a stand-in storage.
 */

describe("parts choices as stored", () => {
  test("a missing or malformed value reads as no choices", () => {
    for (const raw of [null, "", "{", "[]", "null", '"x"', '{"v":2,"dm":{"sound":false}}', '{"dm":{"sound":false}}']) assert.deepEqual(parseFeatures(raw), NO_CHOICES, String(raw));
  });

  test("ids must look like ids and values like booleans, unknown ids are kept, and a role holds at most 64", () => {
    const raw = JSON.stringify({ v: 1, dm: { sound: false, futurePart: false, "Bad id": false, x1: "no", "1x": false }, player: { weather: true } });
    assert.deepEqual(parseFeatures(raw), { dm: { sound: false, futurePart: false }, player: { weather: true } });
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`part${i}`, false]));
    assert.equal(Object.keys(parseFeatures(JSON.stringify({ v: 1, dm: many, player: {} })).dm).length, MAX_CHOICES_PER_ROLE);
  });

  test("the stored form reads back as written", () => {
    const choices: FeatureChoices = { dm: { spellSlots: false, futurePart: true }, player: { sound: false } };
    assert.equal(formatFeatures(choices), '{"v":1,"dm":{"spellSlots":false,"futurePart":true},"player":{"sound":false}}');
    assert.deepEqual(parseFeatures(formatFeatures(choices)), choices);
  });

  test("a switch stores only a change from the default, and keeps the other role and unknown ids", () => {
    const off = withChoice({ dm: { futurePart: false }, player: { sound: false } }, "dm", "spellSlots", false);
    assert.deepEqual(off, { dm: { futurePart: false, spellSlots: false }, player: { sound: false } });
    assert.deepEqual(withChoice(off, "dm", "spellSlots", true), { dm: { futurePart: false }, player: { sound: false } });
  });

  test("a Show turns on the part and what it needs, and turning a need off keeps the dependent's own choice", () => {
    const both = withChoice(withChoice(NO_CHOICES, "dm", "builder", false), "dm", "dungeon", false);
    assert.deepEqual(withShow(both, "dm", "dungeon"), NO_CHOICES);
    const needOff = withChoice(NO_CHOICES, "dm", "builder", false);
    assert.deepEqual(needOff.dm, { builder: false }, "the generator's own choice stays on");
  });

  test("Simple hides every part its role's Simple leaves out, Everything clears the role, and the other role stays", () => {
    const simple = withPreset({ dm: {}, player: { sound: false } }, "dm", "simple");
    assert.deepEqual(Object.keys(simple.dm).sort(), ["builder", "classResources", "companions", "ddb", "dungeon", "encounters", "floors", "hitDice", "isometric", "journal", "outliner", "pins", "sound", "spellSlots", "tableDisplay", "time", "traps", "weather"]);
    assert.ok(Object.values(simple.dm).every((v) => v === false));
    assert.deepEqual(simple.player, { sound: false });
    assert.deepEqual(withPreset({ dm: { futurePart: false, sound: false }, player: {} }, "dm", "everything"), NO_CHOICES);
    assert.deepEqual(Object.keys(withPreset(NO_CHOICES, "player", "simple").player).sort(), ["classResources", "companions", "ddb", "hitDice", "isometric", "spellSlots", "draw", "areas"].sort());
  });

  test("Roll animation off with nothing stored hides Dice animation for both roles, once", () => {
    assert.deepEqual(migratedChoices(null, "off"), { dm: { diceAnimation: false }, player: { diceAnimation: false } });
    assert.equal(migratedChoices(null, "on"), null);
    assert.equal(migratedChoices(null, null), null);
    assert.equal(migratedChoices(formatFeatures(NO_CHOICES), "off"), null, "a device that has choices already keeps them");
  });
});

/** A stand-in storage for one fresh import of the store. */
function storage(items: Record<string, string>) {
  const map = new Map(Object.entries(items));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

async function freshStore(items: Record<string, string>) {
  const s = storage(items);
  (globalThis as { localStorage?: unknown }).localStorage = s;
  const store = (await import(`./store.ts?fresh=${Math.random()}`)) as typeof import("./store.ts");
  return { store, items: s.map };
}

describe("the device's parts store", () => {
  test("the migration writes once and keeps the old key, which is never written again", async () => {
    const { store, items } = await freshStore({ "rvtt.rollAnimation": "off" });
    assert.deepEqual(store.featureChoices(), { dm: { diceAnimation: false }, player: { diceAnimation: false } });
    assert.equal(items.get("rvtt.features"), '{"v":1,"dm":{"diceAnimation":false},"player":{"diceAnimation":false}}');
    assert.equal(items.get("rvtt.rollAnimation"), "off");
    store.setModuleShown("diceAnimation", "dm", true);
    assert.equal(items.get("rvtt.rollAnimation"), "off");
    assert.equal(items.get("rvtt.features"), '{"v":1,"dm":{},"player":{"diceAnimation":false}}');
  });

  test("no key means every default, and Reset all clears both roles", async () => {
    const { store, items } = await freshStore({});
    assert.deepEqual(store.featureChoices(), NO_CHOICES);
    assert.equal(items.has("rvtt.features"), false, "nothing is written until a choice changes");
    store.setModuleShown("sound", "dm", false);
    store.showModule("weather", "player");
    store.applyPreset("player", "simple");
    assert.equal(store.featureChoices().dm.sound, false);
    assert.ok(Object.keys(store.featureChoices().player).length > 0);
    store.resetAllFeatures();
    assert.deepEqual(store.featureChoices(), NO_CHOICES);
    assert.equal(items.get("rvtt.features"), '{"v":1,"dm":{},"player":{}}');
  });

  test("a device whose storage throws keeps a change for the page", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = (await import(`./store.ts?fresh=${Math.random()}`)) as typeof import("./store.ts");
    store.setModuleShown("ruler", "player", false);
    assert.deepEqual(store.featureChoices().player, { ruler: false });
  });
});
