import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DdbSync, PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { AT, actor, character, room } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/** A character's stat block in an exported room (docs/design-v1-pc-stats.md 3.5): it travels, by the op's own bounds, and sets its actor's numbers. */

const BLOCK: PcStats = {
  ...structuredClone(EMPTY_PC_STATS as PcStats),
  abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 14, cha: 10 },
  skills: { perception: "prof" },
  rolls: [{ id: "r1", name: "Longbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "piercing", mod: true }] }],
};

describe("a stat block in room.json", () => {
  test("a block passes the stored-state schema, one past its bounds does not, and an older file without one still does", () => {
    const state = room({ characters: { bree: character("bree", { stats: BLOCK }), cy: character("cy") } });
    assert.ok(parseRoomState(structuredClone(state)).ok);
    const bad = structuredClone(state);
    bad.characters.bree!.stats!.abilities.str = 31;
    assert.equal(parseRoomState(bad).ok, false);
    const doubled = structuredClone(state);
    doubled.characters.bree!.stats!.rolls.push({ ...BLOCK.rolls[0]! });
    assert.equal(parseRoomState(doubled).ok, false, "two rolls with one id");
  });

  test("a shape's kept numbers and whose its pool is pass, on the actor and on an HP line that can be taken back (W7-SOL-07)", () => {
    const shaped = actor({ srdId: "brown-bear", ac: 11, hp: { cur: 20, max: 20, temp: 30 }, unshaped: { ac: 14, speeds: { walk: 30 }, shapeTemp: true } });
    const state = room({ characters: { bree: character("bree", { actor: shaped }) } });
    const vitals = (temp: number) => ({ hp: { cur: 20, max: 20, temp }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    state.log.push({ id: "9:0", at: AT, kind: "event", data: { type: "hp", characterId: "bree", change: "temp", amount: 30, revert: { before: vitals(22), after: vitals(30), shapeTemp: { before: "brown-bear" } } } });
    assert.ok(parseRoomState(structuredClone(state)).ok);
    const bad = structuredClone(state);
    (bad.log[0]!.data as { revert: { shapeTemp: object } }).revert.shapeTemp = { before: "brown-bear", amount: 22 };
    assert.equal(parseRoomState(bad).ok, false);
  });

  test("the block travels through the remap, which names nothing in it, and a hand-made file's actor numbers follow it", () => {
    // A hand-made file: the actor's numbers say something else than the block.
    const state = room({ characters: { bree: character("bree", { level: 5, stats: BLOCK, actor: actor({ initBonus: 9, passivePerception: 30 }) }) } });
    const out = remapState(state, { assets: new Map() });
    const [bree] = Object.values(out.characters);
    assert.deepEqual(bree?.stats, BLOCK);
    assert.equal(bree?.actor.initBonus, 3);
    assert.equal(bree?.actor.passivePerception, 10 + 2 + 3);
  });
});

/** A sync record in an exported room (docs/design-v1-resync.md 4): it travels by the op's own bounds, its at required, and the remap leaves it alone. */
describe("a sync record in room.json", () => {
  const RECORD: DdbSync = {
    at: AT,
    from: "123456789",
    base: { abilities: BLOCK.abilities, skills: BLOCK.skills, spellAbility: null, level: 5, ac: 15, hpMax: 38, speeds: { walk: 30 }, senses: "Darkvision 60 ft." },
    rolls: { "0123456789ab": { k: "w:00000000000a", h: "abcdef012345" } },
    gone: ["s:00000000000b"],
  };
  const synced = () => room({ characters: { bree: character("bree", { level: 5, stats: BLOCK, ddbSync: RECORD }), cy: character("cy") } });

  test("a record passes the stored-state schema, one without its at or past its bounds does not", () => {
    assert.ok(parseRoomState(structuredClone(synced())).ok);
    const broken: ((r: DdbSync) => void)[] = [
      (r) => delete (r as Partial<DdbSync>).at,
      (r) => (r.at = "yesterday"),
      (r) => (r.from = "12345678901234"),
      (r) => (r.rolls = { "0123456789AB": { k: "w:00000000000a", h: "abcdef012345" } }),
      (r) => (r.rolls = { "0123456789ab": { k: "x:00000000000a", h: "abcdef012345" } }),
      (r) => (r.gone = Array.from({ length: 41 }, () => "w:00000000000a")),
      (r) => ((r.base as { name?: string }).name = "Bree"),
      (r) => (r.base.level = 21),
    ];
    for (const [i, breakIt] of broken.entries()) {
      const bad = structuredClone(synced());
      breakIt(bad.characters.bree!.ddbSync!);
      assert.equal(parseRoomState(bad).ok, false, `broken record ${i}`);
    }
  });

  test("the record travels through the remap as it was, since its keys hash roll ids the remap leaves alone", () => {
    const out = remapState(synced(), { assets: new Map() });
    const bree = Object.values(out.characters).find((c) => c.stats !== undefined);
    assert.deepEqual(bree?.ddbSync, RECORD);
    assert.deepEqual(bree?.stats?.rolls.map((r) => r.id), ["r1"]);
    assert.equal(Object.values(out.characters).filter((c) => c.ddbSync !== undefined).length, 1, "the other character gains none");
  });
});
