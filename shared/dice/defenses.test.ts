import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Effect } from "../model.ts";
import { incapacitated } from "../rules/rollReminders.ts";
import { loadMonsters, type SrdMonster } from "../srd/monsters.ts";
import { RULES_TEXT } from "../srd/rules-text.ts";
import { emptyStatBlock, monsterView } from "../statBlock.ts";
import { EFFECT_DEFENSES, blockDefenses, effectDefenses, type Defense } from "./defenses.ts";
import { hasTrait } from "./named.ts";

/** Defenses with their qualifiers, from blocks and from effects (docs/design-v1-roll-options.md 3.3). */

let monsters: readonly SrdMonster[] = [];
before(async () => {
  monsters = await loadMonsters();
});

const byName = (name: string): SrdMonster => {
  const m = monsters.find((x) => x.name === name);
  assert.ok(m, `no monster named ${name}`);
  return m;
};

const keys = (...list: string[]): Pick<Effect, "key">[] => list.map((key) => ({ key: key as Effect["key"] }));
const block = (lines: { immunities?: string; resistances?: string; vulnerabilities?: string }) => monsterView({ ...emptyStatBlock(), name: "Test", ...lines });
const stat = (kind: Defense["kind"], of: Defense["of"], qualifier?: string): Defense => (qualifier ? { kind, of, qualifier, source: "Stat block" } : { kind, of, source: "Stat block" });

describe("a block's defenses", () => {
  test("2024's damage types, a semicolon, then conditions", () => {
    assert.deepEqual(blockDefenses(byName("Gelatinous Cube")), [
      stat("immune", "acid"),
      stat("immune", "blinded"),
      stat("immune", "charmed"),
      stat("immune", "deafened"),
      stat("immune", "exhaustion"),
      stat("immune", "frightened"),
      stat("immune", "prone"),
    ]);
  });

  test("qualifiers are kept as printed, in brackets or not", () => {
    assert.deepEqual(blockDefenses(byName("Vampire Familiar")).filter((d) => d.qualifier), [stat("immune", "charmed", "except from its vampire master")]);
    const pointed = monsters.flatMap((m) => blockDefenses(m).filter((d) => d.kind === "vulnerable" && d.qualifier));
    assert.deepEqual(pointed, [stat("vulnerable", "piercing", "from weapons wielded by creatures under the effect of a Bless spell")]);
  });

  test("2014's clause gives its qualifier to every type in it: three qualified resistances", () => {
    assert.deepEqual(blockDefenses(block({ resistances: "Cold, Fire; Bludgeoning, Piercing, and Slashing from Nonmagical Attacks" })), [
      stat("resist", "cold"),
      stat("resist", "fire"),
      stat("resist", "bludgeoning", "from Nonmagical Attacks"),
      stat("resist", "piercing", "from Nonmagical Attacks"),
      stat("resist", "slashing", "from Nonmagical Attacks"),
    ]);
    assert.deepEqual(blockDefenses(block({ immunities: "poison; poisoned, exhaustion" })), [stat("immune", "poison"), stat("immune", "poisoned"), stat("immune", "exhaustion")]);
  });

  test("a clause that starts with no type names none, and conditions are immunities only", () => {
    assert.deepEqual(blockDefenses(block({ resistances: "Damage type chosen for the Draconic Origin trait below" })), []);
    assert.deepEqual(blockDefenses(block({ resistances: "Charmed; Fire" })), [stat("resist", "fire")]);
  });

  test("every SRD defense names a damage type or a condition, and only the four printed qualifiers are qualified", () => {
    let qualified = 0;
    for (const m of monsters) {
      for (const d of blockDefenses(m)) {
        assert.ok(d.of !== "all");
        if (d.qualifier) qualified++;
      }
    }
    // "Charmed (except from its vampire master)", "Charmed (with Mind Blank)" and the Bless vulnerability.
    assert.equal(qualified, 3);
  });
});

describe("defenses from effects, and the one incapacitation rule", () => {
  test("every effect defense rests on words its SRD rule says", () => {
    for (const rule of EFFECT_DEFENSES) {
      const entry = rule.source === "conditions" ? RULES_TEXT.conditions[rule.key as "petrified"] : RULES_TEXT.statuses[rule.key as "raging"];
      assert.ok(entry?.text.includes(rule.quote), `${rule.key}: "${rule.quote}"`);
    }
  });

  test("Petrified resists all damage and is immune to Poisoned", () => {
    assert.deepEqual(effectDefenses(keys("petrified")), [
      { kind: "resist", of: "all", source: "Petrified" },
      { kind: "immune", of: "poisoned", source: "Petrified" },
    ]);
  });

  test("Raging resists Bludgeoning, Piercing and Slashing, but not while incapacitated: Raging and Stunned take full bludgeoning", () => {
    assert.deepEqual(
      effectDefenses(keys("raging")).map((d) => d.of),
      ["bludgeoning", "piercing", "slashing"],
    );
    for (const key of ["incapacitated", "stunned", "paralyzed", "unconscious"]) assert.deepEqual(effectDefenses(keys("raging", key)), [], key);
    // Petrified includes Incapacitated, so it ends Rage's resistance and keeps its own.
    assert.deepEqual(
      effectDefenses(keys("raging", "petrified")).map((d) => d.source),
      ["Petrified", "Petrified"],
    );
  });

  test("incapacitated is Incapacitated or a condition that includes it", () => {
    for (const key of ["incapacitated", "stunned", "paralyzed", "unconscious", "petrified"]) assert.equal(incapacitated(keys(key)), true, key);
    for (const key of ["restrained", "grappled", "prone", "poisoned", "raging", "dodging"]) assert.equal(incapacitated(keys(key)), false, key);
    assert.equal(incapacitated([]), false);
  });

  test("Evasion is a trait the Assassin has, and a Stunned assassin is incapacitated, so it takes a whole Fireball", () => {
    const assassin = byName("Assassin");
    assert.equal(hasTrait(assassin, "Evasion"), true);
    assert.match(assassin.statBlock, /Incapacitated/, "its Evasion names the exception");
    assert.equal(incapacitated(keys("stunned")), true);
  });
});
