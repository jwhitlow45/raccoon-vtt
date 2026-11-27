import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { apply, character, DM, room, token } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/** Imports of spell slots and Hit Point Dice (docs/design/design-v1-slots.md 5, 6). */
describe("an import with classes, spent counts and the use stamp", () => {
  function rested() {
    let s = room({
      characters: { bree: character("bree", { name: "Bree", classes: [{ id: "wizard", level: 5 }, { id: "warlock", level: 3 }], actor: { ...character("x").actor, hp: { cur: 5, max: 30, temp: 0 } } }) },
      tokens: { t1: token("t1", { kind: "pc", actor: { ref: "bree" } }) },
    });
    const ops: Op[] = [
      { t: "actor.use", target: { characterId: "bree" }, use: { kind: "slot", level: 2 } },
      { t: "actor.use", target: { characterId: "bree" }, use: { kind: "pact" } },
      { t: "actor.use", target: { characterId: "bree" }, use: { kind: "hitDie", die: 6, heal: 4 } },
      { t: "actor.rest", target: { characterId: "bree" }, kind: "short" },
    ];
    ops.forEach((op, i) => (s = apply(s, op, DM, i + 1)));
    return JSON.parse(JSON.stringify(s));
  }

  test("a room rested at change format 68 imports whole, the three fields kept", () => {
    const state = rested();
    assert.deepEqual(state.characters.bree.spent, { slots: [0, 1, 0, 0, 0, 0, 0, 0, 0], dice: { d6: 1 } });
    assert.equal(state.characters.bree.useRev, 4);
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const bree = parsed.ok ? parsed.state.characters.bree! : undefined;
    assert.deepEqual([bree?.classes, bree?.spent, bree?.useRev], [state.characters.bree.classes, state.characters.bree.spent, 4]);
  });

  test("spent out of its normal form or past the counts is refused", () => {
    for (const spent of [{ slots: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, { slots: [5, 0, 0, 0, 0, 0, 0, 0, 0] }, { pact: 0 }, { pact: 3 }, { dice: { d10: 1 } }, { dice: { d6: 0 } }, {}]) {
      const state = rested();
      state.characters.bree.spent = spent;
      assert.equal(parseRoomState(state).ok, false, JSON.stringify(spent));
    }
    const noClasses = rested();
    delete noClasses.characters.bree.classes;
    assert.equal(parseRoomState(noClasses).ok, false, "spent with no classes");
  });

  test("bad classes and stamps are refused, and a room from before has none", () => {
    for (const change of [
      (s: { characters: Record<string, Record<string, unknown>> }) => (s.characters.bree!.classes = []),
      (s: { characters: Record<string, Record<string, unknown>> }) => (s.characters.bree!.classes = [{ id: "wizard", level: 21 }]),
      (s: { characters: Record<string, Record<string, unknown>> }) => (s.characters.bree!.classes = [{ id: "wizard", level: 3, third: true }]),
      (s: { characters: Record<string, Record<string, unknown>> }) => (s.characters.bree!.useRev = -1),
      (s: { characters: Record<string, Record<string, unknown>> }) => (s.characters.bree!.useRev = 1.5),
    ]) {
      const state = rested();
      delete state.characters.bree.spent;
      change(state);
      assert.equal(parseRoomState(state).ok, false);
    }
    const before = JSON.parse(JSON.stringify(room({ characters: { bree: character("bree") } })));
    assert.ok(parseRoomState(before).ok);
  });
});
