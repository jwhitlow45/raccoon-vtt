import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcRoll, PcStats } from "../model.ts";
import { fillSummary, mergeFill, type PcFill } from "./pcFill.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";

/** What a fill does to a block (docs/design-v1-pc-stats.md 6.1). */

const roll = (id: string, ddb?: true): PcRoll => ({ id, name: id, kind: "other", dice: [{ formula: "1d6" }], ...(ddb ? { ddb } : {}) });
const BASE: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), jack: true, spellAbility: "wis", rolls: [roll("own1"), roll("old1", true), roll("own2"), roll("old2", true)] };

function fill(source: PcFill["source"], stats: Partial<PcFill["stats"]>): PcFill {
  return { source, stats: { rolls: [], ...stats }, actor: {}, warnings: [] };
}

describe("mergeFill", () => {
  test("pasted text replaces the parts it found and adds its rolls beside the ones there", () => {
    const m = mergeFill(BASE, fill("paste", { saves: ["dex"], rolls: [roll("new1"), roll("new2", true)] }));
    assert.deepEqual(m.stats.saves, ["dex"]);
    assert.equal(m.stats.jack, true, "a part it did not read stays");
    assert.equal(m.stats.spellAbility, "wis");
    assert.deepEqual(m.stats.rolls.map((r) => r.id), ["own1", "old1", "own2", "old2", "new1", "new2"]);
    assert.equal(m.stats.rolls[5]!.ddb, undefined, "a pasted roll is the player's own");
    assert.deepEqual({ added: m.added, replaced: m.replaced, kept: m.kept, dropped: m.dropped }, { added: 2, replaced: 0, kept: 4, dropped: 0 });
    assert.equal(fillSummary(fill("paste", { saves: ["dex"] }), m), "Replaces the saving throws. Adds 2 rolls.");
  });

  test("a D&D Beyond import replaces the last import's rolls, keeps the player's own, and reads its flags as on or off", () => {
    const m = mergeFill(BASE, fill("ddb", { abilities: BASE.abilities, jack: false, spellAbility: null, critOn: 19, rolls: [roll("a"), roll("b"), roll("c")] }));
    assert.deepEqual(m.stats.rolls.map((r) => r.id), ["own1", "own2", "a", "b", "c"]);
    assert.ok(m.stats.rolls.slice(2).every((r) => r.ddb === true));
    assert.equal("jack" in m.stats, false);
    assert.equal("spellAbility" in m.stats, false);
    assert.equal(m.stats.critOn, 19);
    assert.equal(fillSummary(fill("ddb", { abilities: BASE.abilities }), m), "Replaces the scores and the 2 rolls from the last import. Adds 3 rolls. Keeps your 2 own rolls.");
  });

  test("past 40 rolls the player's own come first and the rest are counted as left out", () => {
    const many = Array.from({ length: 39 }, (_, i) => roll(`r${i}`));
    const m = mergeFill({ ...BASE, rolls: many }, fill("paste", { rolls: [roll("x"), roll("y"), roll("z")] }));
    assert.equal(m.stats.rolls.length, 40);
    assert.equal(m.dropped, 2);
    assert.match(fillSummary(fill("paste", {}), m), /Adds 1 roll\. 2 more rolls were left out\. At most 40 rolls fit\.$/);
  });

  test("a fill that reads nothing changes nothing", () => {
    const m = mergeFill(BASE, fill("paste", {}));
    assert.deepEqual(m.stats, BASE);
    assert.equal(fillSummary(fill("paste", {}), m), "Changes nothing in the stat block.");
  });
});
