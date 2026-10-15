import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SavedEncounter } from "#shared/model.ts";
import { savedEncounterInputSchema } from "#shared/protocol.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { customMonster } from "#shared/testutil.ts";
import {
  addGroup,
  addMonster,
  creatureCount,
  draftOf,
  emptyDraft,
  encounterInput,
  encounterPatch,
  lineXp,
  monsterXps,
  removeLine,
  resolveLine,
  setCount,
  setGroup,
  setLair,
  srdIndex,
  type Draft,
} from "./draft.ts";

const saved: SavedEncounter = { id: "e1", rev: 3, name: "Ambush", monsters: [{ srdId: "goblin-warrior", count: 4 }], party: [{ count: 4, level: 3 }] };

describe("encounter draft", () => {
  test("adding a monster again counts it on its line, and a new monster gets a line", () => {
    let d = addMonster(emptyDraft(), { srdId: "goblin-warrior" });
    d = addMonster(d, { srdId: "goblin-warrior" });
    d = addMonster(d, { monsterId: "m1" });
    assert.deepEqual(d.monsters, [{ srdId: "goblin-warrior", count: 2 }, { monsterId: "m1", count: 1 }]);
    // A lair line is a line of its own, so adding one more outside the lair starts another.
    d = addMonster(setLair(d, 1, true), { monsterId: "m1" });
    assert.deepEqual(d.monsters, [{ srdId: "goblin-warrior", count: 2 }, { monsterId: "m1", count: 1, inLair: true }, { monsterId: "m1", count: 1 }]);
    assert.deepEqual(setLair(d, 1, false).monsters[1], { monsterId: "m1", count: 1 });
  });

  test("an encounter stops at 50 creatures and 20 kinds, as the protocol does", () => {
    let d: Draft = { ...emptyDraft(), name: "Horde" };
    for (let i = 0; i < 20; i++) d = addMonster(d, { srdId: `monster-${i}` });
    assert.equal(addMonster(d, { srdId: "one-more" }), d);
    d = setCount(d, 0, 100);
    assert.equal(d.monsters[0]!.count, 31);
    assert.equal(creatureCount(d.monsters), 50);
    assert.equal(addMonster(d, { srdId: "monster-1" }), d);
    assert.ok(savedEncounterInputSchema.safeParse(encounterInput("e2", d)).success);
    assert.equal(setCount(d, 0, 0).monsters[0]!.count, 1);
    assert.deepEqual(removeLine(d, 0).monsters.length, 19);
  });

  test("a save creates the whole draft, and an edit sends only what changed", () => {
    const d = { ...draftOf(saved), name: "  Ambush at dusk " };
    assert.deepEqual(encounterInput("e9", d), { id: "e9", name: "Ambush at dusk", monsters: saved.monsters, party: saved.party });
    assert.deepEqual(encounterInput("e9", { ...d, party: null }), { id: "e9", name: "Ambush at dusk", monsters: saved.monsters });
    assert.equal(encounterPatch(saved, draftOf(saved)), null);
    assert.deepEqual(encounterPatch(saved, d), { name: "Ambush at dusk" });
    assert.deepEqual(encounterPatch(saved, { ...draftOf(saved), party: null }), { party: null });
    const more = addMonster(draftOf(saved), { srdId: "goblin-warrior" });
    assert.deepEqual(encounterPatch(saved, more), { monsters: [{ srdId: "goblin-warrior", count: 5 }] });
  });

  test("party groups stay within the counts and levels the table has", () => {
    const party = addGroup([{ count: 4, level: 3 }]);
    assert.deepEqual(party, [{ count: 4, level: 3 }, { count: 1, level: 3 }]);
    assert.deepEqual(setGroup(party, 1, { count: 0, level: 25 }, 50), [{ count: 4, level: 3 }, { count: 1, level: 20 }]);
    assert.equal(addGroup(Array.from({ length: 10 }, () => ({ count: 1, level: 1 }))).length, 10);
  });

  test("each line reads its XP from its own stat block, in its lair when it has one", async () => {
    const srd = srdIndex(await loadMonsters());
    const monsters = { m1: customMonster("m1", { cr: "2", xp: 450, xpInLair: 700 }) };
    const dragon = resolveLine({ srdId: "adult-red-dragon", count: 1, inLair: true }, srd, monsters);
    assert.equal(dragon?.source, "srd");
    assert.equal(lineXp({ srdId: "adult-red-dragon", count: 1, inLair: true }, dragon!.view), 20_000);
    assert.equal(lineXp({ srdId: "adult-red-dragon", count: 1 }, dragon!.view), 18_000);
    const own = resolveLine({ monsterId: "m1", count: 2, inLair: true }, srd, monsters);
    assert.equal(own?.source, "room");
    assert.equal(lineXp({ monsterId: "m1", count: 2, inLair: true }, own!.view), 700);
    // A monster deleted since, or the SRD list not loaded yet, is unknown rather than worth nothing.
    assert.equal(resolveLine({ monsterId: "gone", count: 1 }, srd, monsters), null);
    assert.equal(resolveLine({ srdId: "goblin-warrior", count: 1 }, null, monsters), null);
    const lines = [{ srdId: "goblin-warrior", count: 3 }, { monsterId: "gone", count: 1 }];
    assert.deepEqual(monsterXps(lines, (m) => resolveLine(m, srd, monsters)), [{ count: 3, xp: 50 }, { count: 1, xp: null }]);
  });
});
