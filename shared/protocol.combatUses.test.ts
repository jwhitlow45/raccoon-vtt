import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actorSchemaForImport, clientOpSchema, combatUseSchemas, opSchema } from "./protocol.ts";
import { actor } from "./testutil.ts";

type Schema = { safeParse: (v: unknown) => { success: boolean } };
const ok = (schema: Schema, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: Schema, value: unknown, why?: string) => assert.ok(!schema.safeParse(value).success, why ?? JSON.stringify(value));

const use = (u: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ t: "actor.use", target: { tokenId: "dragon" }, use: u, ...more });
const breath = { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 };

describe("combat uses: ops (docs/design-v1-combat-controls.md 3.1)", () => {
  test("every kind of use, spent and given back", () => {
    ok(clientOpSchema, use({ kind: "legendary", cost: 1 }));
    ok(clientOpSchema, use({ kind: "legendary", cost: 2, key: "legendaryActions:wing-attack", name: "Wing Attack" }));
    ok(clientOpSchema, use({ kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true }, { back: true }));
    ok(clientOpSchema, use({ kind: "resist" }, { quiet: true }));
    ok(clientOpSchema, use(breath));
    ok(clientOpSchema, use({ ...breath, ifReady: true }, { quiet: true }));
    ok(clientOpSchema, use({ kind: "ability", key: "actions:dominate-mind", name: "Dominate Mind", limit: "day", max: 2 }, { back: true }));
    ok(clientOpSchema, use({ kind: "ability", key: "actions:shapechange", name: "Shapechange", limit: "day", max: 9, short: true }));
    ok(clientOpSchema, use({ kind: "ability", key: "actions:phantasms", name: "Phantasms", limit: "rest", max: 1 }));
    ok(clientOpSchema, use({ kind: "regenerate", key: "traits:regeneration", amount: 15, record: 41 }));
    ok(clientOpSchema, use({ kind: "resource", id: "lay-on-hands", amount: 5 }, { target: { characterId: "bree" } }));
    ok(clientOpSchema, use({ kind: "resource", id: "rage" }, { back: true }));
  });

  test("each kind keeps to the facts its limit has", () => {
    bad(clientOpSchema, use({ kind: "legendary", cost: 0 }));
    bad(clientOpSchema, use({ kind: "legendary", cost: 4 }));
    bad(clientOpSchema, use({ kind: "legendary", cost: 1, key: "legendaryActions:pounce" }), "a key without its name");
    bad(clientOpSchema, use({ kind: "legendary", cost: 1, once: true }), "once with no key to mark");
    bad(clientOpSchema, use({ ...breath, max: 2 }), "a recharge counts one use");
    bad(clientOpSchema, use({ ...breath, min: undefined }), "a recharge names its range");
    bad(clientOpSchema, use({ ...breath, min: 1 }));
    bad(clientOpSchema, use({ ...breath, min: 7 }));
    bad(clientOpSchema, use({ kind: "ability", key: "actions:x", name: "X", limit: "day", max: 2, min: 5 }), "only a recharge has a range");
    bad(clientOpSchema, use({ kind: "ability", key: "actions:x", name: "X", limit: "day", max: 10 }));
    bad(clientOpSchema, use({ kind: "ability", key: "actions:x", name: "X", limit: "rest", max: 1, short: true }));
    bad(clientOpSchema, use({ kind: "regenerate", key: "traits:regeneration", amount: 0, record: 1 }));
    bad(clientOpSchema, use({ kind: "regenerate", key: "traits:regeneration", amount: 1_000, record: 1 }));
    bad(clientOpSchema, use({ kind: "regenerate", key: "traits:regeneration", amount: 15 }), "Regeneration names its turn");
    bad(clientOpSchema, use({ kind: "regenerate", key: "traits:regeneration", amount: 15, record: 1 }, { back: true }));
    bad(clientOpSchema, use({ ...breath, ifReady: true }, { back: true }));
    bad(clientOpSchema, use({ kind: "resource", id: "rage", amount: 201 }));
    bad(clientOpSchema, use({ kind: "resource", id: "has space" }));
    bad(clientOpSchema, use({ kind: "rest" }));
  });

  test("a name of 120 characters goes whole through a use and a recharge roll, and one more is refused", () => {
    const long = "Breath of the Ancient Wyrm That Sleeps Beneath the Mountain and Wakes Only When the Stars Align Over the Old Kingdom!!!!";
    assert.equal(long.length, 120);
    const spent = clientOpSchema.parse(use({ ...breath, name: long }));
    assert.ok(spent.t === "actor.use" && spent.use.kind === "ability" && spent.use.name === long);
    const roll = clientOpSchema.parse({ t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: long, min: 5 });
    assert.ok(roll.t === "actor.rechargeRoll" && roll.name === long);
    bad(clientOpSchema, use({ ...breath, name: `${long}!` }));
    bad(clientOpSchema, { t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: `${long}!`, min: 5 });
    bad(clientOpSchema, use({ ...breath, name: "" }));
    bad(clientOpSchema, use({ ...breath, name: "Fire\nBreath" }));
  });

  test("an ability's key is a section and a slug of at most 64 characters", () => {
    const key = `actions:${"a".repeat(56)}`;
    assert.equal(key.length, 64);
    ok(clientOpSchema, use({ ...breath, key }));
    ok(clientOpSchema, use({ ...breath, key: "bonusActions:misty-step-2-0a1b2c" }));
    for (const wrong of [`${key}a`, "__proto__", "constructor", "actions:", ":fire", "actions:Fire-Breath", "actions:fire--breath", "actions:fire-breath:hit", "actions:fire breath"]) {
      bad(clientOpSchema, use({ ...breath, key: wrong }));
    }
  });

  test("a recharge roll and a death save's roll may name their turn record, and a stored roll keeps it", () => {
    ok(clientOpSchema, { t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: "Fire Breath", min: 6, record: 12 });
    bad(clientOpSchema, { t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: "Fire Breath", min: 6, record: -1 });
    ok(clientOpSchema, { t: "actor.deathRoll", tag: "d1", target: { characterId: "thorn" }, record: 12 });
    const result = { formula: "1d6", total: 5, faces: [5] };
    ok(opSchema, { t: "sys.dice", asked: { t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: "Fire Breath", min: 5, record: 3 }, batch: "AAAAAAAAAAAAAAAA", results: [result] });
    bad(clientOpSchema, { t: "sys.dice", asked: { t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: "Fire Breath", min: 5 }, batch: "AAAAAAAAAAAAAAAA", results: [result] });
  });

  test("a prompt is skipped or reopened by its name in its record", () => {
    for (const what of ["regeneration", "deathSave", "recharge:actions:fire-breath"]) {
      for (const state of ["skipped", "open"]) ok(clientOpSchema, { t: "actor.prompt", target: { tokenId: "troll" }, record: 7, what, state });
    }
    for (const what of ["recharge:", "recharge:__proto__", "regen", "deathSaves", "constructor"]) bad(clientOpSchema, { t: "actor.prompt", target: { tokenId: "troll" }, record: 7, what, state: "skipped" });
    bad(clientOpSchema, { t: "actor.prompt", target: { tokenId: "troll" }, record: 7, what: "regeneration", state: "done" });
    bad(clientOpSchema, { t: "actor.prompt", target: { tokenId: "troll" }, what: "regeneration", state: "skipped" });
  });

  test("In lair's counts go only with the switch", () => {
    ok(clientOpSchema, { t: "encounter.update", entryId: "e1", patch: { inLair: true }, counts: { actionsMax: 4, resistMax: 4, xp: 15_000 } });
    ok(clientOpSchema, { t: "encounter.update", entryId: "e1", patch: { inLair: false }, counts: { actionsMax: 3, resistMax: 3 } });
    bad(clientOpSchema, { t: "encounter.update", entryId: "e1", patch: { hidden: true }, counts: { actionsMax: 3, resistMax: 3 } });
    bad(clientOpSchema, { t: "encounter.update", entryId: "e1", patch: { inLair: true }, counts: { actionsMax: 11, resistMax: 3 } });
    bad(clientOpSchema, { t: "encounter.update", entryId: "e1", patch: { inLair: true }, counts: { actionsMax: 3 } });
  });

  test("a hit carries its damage types, each once", () => {
    ok(clientOpSchema, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 12, types: ["fire", "slashing"] } });
    bad(clientOpSchema, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 12, types: ["fire", "fire"] } });
    bad(clientOpSchema, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 12, types: [] } });
    bad(clientOpSchema, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 12, types: ["sonic"] } });
    bad(clientOpSchema, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "heal", amount: 12, types: ["fire"] } });
    ok(clientOpSchema, { t: "actor.damageMany", hits: [{ target: { tokenId: "troll" }, amount: 3, types: ["acid"] }] });
    ok(clientOpSchema, { t: "actor.outcome", plan: "pl1", quiet: true, targets: [{ target: { tokenId: "troll" }, amount: 3, types: ["acid"], resist: true }] });
    ok(clientOpSchema, { t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "2d6", label: "Fire Breath, Fire", type: "fire" }] });
    bad(clientOpSchema, { t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "2d6", type: "healing" }] });
  });

  test("class resources go whole, with no count used, each id once", () => {
    const rage = { id: "rage", name: "Rage", max: 3, reset: "shortOne", preset: "rage", level: 3, atLevel: 3 };
    const update = (resources: unknown) => ({ t: "character.update", characterId: "thorn", patch: { resources } });
    ok(clientOpSchema, update([rage, { id: "loh", name: "Lay on Hands", max: 200, reset: "long", pool: true }]));
    ok(clientOpSchema, update([]));
    bad(clientOpSchema, update([{ ...rage, used: 1 }]));
    bad(clientOpSchema, update([rage, rage]));
    bad(clientOpSchema, update([{ ...rage, max: 100 }]), "a count is at most 99");
    bad(clientOpSchema, update([{ ...rage, max: 201, pool: true }]));
    bad(clientOpSchema, update([{ ...rage, max: 0 }]));
    bad(clientOpSchema, update([{ ...rage, name: "A".repeat(41) }]));
    bad(clientOpSchema, update([{ ...rage, name: "Ra‮ge" }]));
    bad(clientOpSchema, update([{ ...rage, name: "Ra\uD800ge" }]));
    bad(clientOpSchema, update([{ ...rage, reset: "dawn" }]));
    bad(clientOpSchema, update(Array.from({ length: 13 }, (_, i) => ({ ...rage, id: `r${i}` }))));
  });

  test("only an imported actor holds what the reducer writes, never an op's", () => {
    const held = actor({
      uses: { "actions:fire-breath": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 }, "actions:dominate-mind": { kind: "day", name: "Dominate Mind", used: 2, max: 3 } },
      hurt: ["fire"],
      turnRecord: { id: 3, entryId: "e1", round: 2, hp: 0, life: "dying", took: ["acid"], due: ["actions:fire-breath"], settled: { deathSave: { state: "done", total: 14, outcome: "success" }, "recharge:actions:fire-breath": { state: "skipped" } } },
    });
    ok(actorSchemaForImport, held);
    bad(clientOpSchema, { t: "character.create", character: { id: "c1", name: "Thorn", size: "medium", ownerIds: [], actor: held } });
    bad(actorSchemaForImport, actor({ uses: { "actions:x": { kind: "day", name: "X", used: 4, max: 3 } } }));
    bad(actorSchemaForImport, actor({ uses: { "actions:x": { kind: "turn", name: "X", used: 1, max: 2 } } }));
    bad(actorSchemaForImport, actor({ uses: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`actions:a${i}`, { kind: "rest", name: "A", used: 1, max: 1 }])) }));
    bad(actorSchemaForImport, { ...actor(), turnRecord: { id: 3, entryId: "e1", round: 2, hp: 0, life: "dying", settled: { nonsense: { state: "done" } } } });
    bad(combatUseSchemas.resourceStored, { id: "rage", name: "Rage", max: 3, used: 4, reset: "long" });
    ok(combatUseSchemas.resourceStored, { id: "rage", name: "Rage", max: 3, used: 3, reset: "long" });
  });
});
