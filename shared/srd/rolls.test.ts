import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { before, describe, test } from "node:test";
import { bonusFor, type SrdRolls } from "../dice/bonus.ts";
import { loadMonsters, type SrdMonster } from "./monsters.ts";
import { loadSrdRolls, srdRollsOf } from "./rolls.ts";

/** rolls.json, the SRD creatures' numbers by id (docs/design/design-v1-dice.md 6.1, docs/design/design-v1-roll-options.md Appendix A). */

let monsters: readonly SrdMonster[] = [];
let rolls: SrdRolls = {};
before(async () => {
  monsters = await loadMonsters();
  rolls = await loadSrdRolls();
});

describe("rolls.json", () => {
  test("matches every block it was read from, so it never drifts from monsters.json (node scripts/srd-import.ts --rolls writes it again)", () => {
    assert.equal(Object.keys(rolls).length, 330);
    assert.deepEqual(rolls, srdRollsOf(monsters));
    assert.deepEqual(Object.keys(rolls), monsters.map((m) => m.srdId));
  });

  test("stays small enough to load beside a roll card: under 100 KB", () => {
    const bytes = statSync(new URL("./rolls.json", import.meta.url)).size;
    assert.ok(bytes < 100_000, `rolls.json is ${bytes} bytes`);
  });

  test("reads saves, skills and the spell numbers as printed", () => {
    const goblin = rolls["goblin-warrior"]!;
    assert.equal(bonusFor(goblin, { kind: "save", ability: "dex" }), 2);
    assert.equal(bonusFor(goblin, { kind: "check", ability: "dex", skill: "stealth" }), 6);
    assert.equal(bonusFor(goblin, { kind: "save", ability: "str" }), -1);
    const bronze = rolls["adult-bronze-dragon"]!;
    assert.deepEqual([bronze.abilities.dex.save, bronze.skills.perception, bronze.spellDc, bronze.spellAttack], [5, 12, 17, 10]);
    assert.equal(rolls["goblin-warrior"]!.spellDc, undefined);
  });

  test("holds each creature's distinct melee reaches when one passes 5 ft (docs/design/design-v1-opportunity-attacks.md 4)", () => {
    assert.deepEqual(rolls["barbed-devil"]!.reaches, [5, 10], "a 5 ft Claw and a 10 ft Tail");
    assert.equal(rolls["goblin-warrior"]!.reaches, undefined, "5 ft is the default");
    const longest = new Map<number, number>();
    for (const numbers of Object.values(rolls)) if (numbers.reaches) longest.set(Math.max(...numbers.reaches), (longest.get(Math.max(...numbers.reaches)) ?? 0) + 1);
    assert.deepEqual([...longest].sort((a, b) => a[0] - b[0]), [[10, 73], [15, 14], [30, 3], [60, 1]], "91 of the 330 reach past 5 ft");
    assert.equal(Object.values(rolls).filter((n) => (n.reaches?.length ?? 0) > 1).length, 13, "13 with two distinct reaches");
  });

  test("loads once a page", async () => {
    assert.equal(await loadSrdRolls(), rolls);
  });
});
