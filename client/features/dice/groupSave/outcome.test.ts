import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Defense } from "#shared/dice/defenses.ts";
import { OUTCOME_TOO_BIG } from "#shared/protocol.ts";
import { conditionSkip, damageWords, parseParts, partAmounts, planTargets, rowDamage, worstCase, type PartAmount } from "./outcome.ts";

/** A group save's outcome (docs/design-v1-roll-options.md 5.4 and 5.5). */

const stat = (kind: Defense["kind"], of: Defense["of"], qualifier?: string): Defense => (qualifier ? { kind, of, qualifier, source: "Stat block" } : { kind, of, source: "Stat block" });
const row = (defenses: Defense[] = [], extra: { evasion?: boolean; effects?: { key: never }[]; on?: string[] } = {}) => ({ defenses, qualifiedOn: new Set(extra.on ?? []), evasion: extra.evasion ?? false, effects: extra.effects ?? [] });
const FLAME: PartAmount[] = [
  { amount: 18, type: "fire" },
  { amount: 16, type: "radiant" },
];

describe("the damage field", () => {
  test("typed parts, dice or numbers, each with its type, and a bare number takes the fill's", () => {
    assert.deepEqual(parseParts("8d6 fire"), { ok: true, parts: [{ formula: "8d6", type: "fire" }] });
    assert.deepEqual(parseParts("5d6 fire + 5d6 radiant"), { ok: true, parts: [{ formula: "5d6", type: "fire" }, { formula: "5d6", type: "radiant" }] });
    assert.deepEqual(parseParts("28 fire + 14 radiant"), { ok: true, parts: [{ amount: 28, type: "fire" }, { amount: 14, type: "radiant" }] });
    assert.deepEqual(parseParts("28", "fire"), { ok: true, parts: [{ amount: 28, type: "fire" }] });
    assert.deepEqual(parseParts("8d6 + 3 fire"), { ok: true, parts: [{ formula: "8d6+3", type: "fire" }] });
    assert.equal(parseParts("8d6 lava").ok, false);
    assert.equal(parseParts("").ok, false);
    assert.deepEqual(partAmounts([{ formula: "5d6", type: "fire" }, { amount: 14, type: "radiant" }], [18]), [{ amount: 18, type: "fire" }, { amount: 14, type: "radiant" }]);
    assert.equal(partAmounts([{ formula: "5d6", type: "fire" }], []), null, "a roll still waiting");
  });
});

describe("what one row takes", () => {
  test("Flame Strike on a fire elemental: the fire part 0, the radiant part dealt, named", () => {
    const fail = rowDamage(FLAME, "fail", { onPass: "half", dexSave: true, row: row([stat("immune", "fire")]) });
    assert.equal(fail.amount, 16);
    assert.equal(damageWords(FLAME, fail), "Immune to fire: 16 radiant");
    const pass = rowDamage(FLAME, "pass", { onPass: "half", dexSave: true, row: row([stat("immune", "fire")]) });
    assert.equal(pass.amount, 8);
  });

  test("half on a pass or none, each part rounded down on its own, resistance then vulnerability", () => {
    assert.equal(rowDamage([{ amount: 9, type: "fire" }, { amount: 9, type: "cold" }], "pass", { onPass: "half", dexSave: false, row: row() }).amount, 8, "4 + 4");
    assert.equal(rowDamage(FLAME, "pass", { onPass: "none", dexSave: false, row: row() }).amount, 0);
    assert.equal(rowDamage([{ amount: 15, type: "cold" }], "fail", { onPass: "half", dexSave: false, row: row([stat("resist", "cold")]) }).amount, 7, "Ice Storm on a cold-resistant creature");
    assert.equal(rowDamage([{ amount: 15, type: "cold" }], "fail", { onPass: "half", dexSave: false, row: row([stat("vulnerable", "cold")]) }).amount, 30);
  });

  test("a qualified defense waits for the DM's switch, Petrified resists all", () => {
    const qualified = [stat("resist", "slashing", "from Nonmagical Attacks")];
    assert.equal(rowDamage([{ amount: 10, type: "slashing" }], "fail", { onPass: "half", dexSave: false, row: row(qualified) }).amount, 10, "off by default");
    assert.equal(rowDamage([{ amount: 10, type: "slashing" }], "fail", { onPass: "half", dexSave: false, row: row(qualified, { on: ["resist:slashing:from Nonmagical Attacks:Stat block"] }) }).amount, 5);
    const petrified: Defense[] = [{ kind: "resist", of: "all", source: "Petrified" }];
    assert.equal(rowDamage([{ amount: 28, type: "fire" }], "fail", { onPass: "half", dexSave: true, row: row(petrified) }).amount, 14, "Petrified in a Fireball: fails, half of the full");
  });

  test("Evasion on a Dexterity save that halves: none on a pass, half on a fail, never while incapacitated", () => {
    const evader = row([], { evasion: true });
    assert.equal(rowDamage([{ amount: 28, type: "fire" }], "pass", { onPass: "half", dexSave: true, row: evader }).amount, 0);
    assert.equal(rowDamage([{ amount: 28, type: "fire" }], "fail", { onPass: "half", dexSave: true, row: evader }).amount, 14);
    assert.equal(rowDamage([{ amount: 28, type: "fire" }], "fail", { onPass: "half", dexSave: false, row: evader }).amount, 28, "not on another save");
    const stunned = row([], { evasion: true, effects: [{ key: "stunned" as never }] });
    assert.equal(rowDamage([{ amount: 28, type: "fire" }], "fail", { onPass: "half", dexSave: true, row: stunned }).amount, 28, "a Stunned assassin takes it all");
  });
});

describe("conditions and the plan", () => {
  test("a failed row gains no condition it is immune to, already has, or when the damage drops it to 0, temporary HP first", () => {
    const base = { defenses: [] as Defense[], qualifiedOn: new Set<string>(), effects: [] as { key: never }[], hp: { cur: 10, temp: 5 } };
    assert.equal(conditionSkip("frightened", base, 14), null);
    assert.equal(conditionSkip("frightened", base, 15), "Drops to 0 HP");
    assert.equal(conditionSkip("frightened", { ...base, defenses: [stat("immune", "frightened")] }, 1), "Immune to Frightened");
    assert.equal(conditionSkip("frightened", { ...base, effects: [{ key: "frightened" as never }] }, 1), "Already Frightened");
  });

  test("the plan names each creature with something to change, and its bounds hold 100 with two conditions, never three", () => {
    let n = 0;
    const ids = () => `id${n++}`;
    const targets = planTargets(
      [
        { target: { tokenId: "a" }, amount: 9, conditions: [{ key: "frightened" }], resist: false },
        { target: { tokenId: "b" }, amount: 0, conditions: [], resist: false },
        { target: { tokenId: "c" }, amount: 0, conditions: [], resist: true },
      ],
      ids,
    );
    assert.deepEqual(targets, [
      { target: { tokenId: "a" }, amount: 9, effects: [{ id: "id0", key: "frightened" }] },
      { target: { tokenId: "c" }, resist: true },
    ]);
    const hundred = Array.from({ length: 100 }, (_, i) => ({ tokenId: `0192f0a8-6c1e-7a4b-9c3d-${String(i).padStart(12, "0")}` }));
    const two = [
      { key: "charmed" as const, duration: { mode: "turnEnd" as const, of: { tokenId: "0192f0a8-6c1e-7a4b-9c3d-000000000001" } }, save: { ability: "wis" as const, dc: 15 } },
      { key: "incapacitated" as const, duration: { mode: "turnEnd" as const, of: { tokenId: "0192f0a8-6c1e-7a4b-9c3d-000000000001" } }, save: { ability: "wis" as const, dc: 15 } },
    ];
    assert.equal(worstCase(hundred, two, "Hypnotic Pattern"), null);
    assert.equal(worstCase(hundred, [...two, { ...two[0]!, key: "prone" }], "Hypnotic Pattern"), OUTCOME_TOO_BIG);
    assert.match(worstCase([...hundred, { tokenId: "x" }], []) ?? "", /At most 100/);
  });
});
