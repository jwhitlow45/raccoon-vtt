import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, character, room } from "#shared/testutil.ts";
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
