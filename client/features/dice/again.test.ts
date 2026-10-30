import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp } from "#shared/dice/resolve.ts";
import type { DiceRoll, LogEvent, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { DiceRollInput, Op, OpOf } from "#shared/protocol.ts";
import { DM, P1, actor, apply, effect, room, token } from "#shared/testutil.ts";
import { againInput } from "./logic.ts";

/**
 * Again on a creature's initiative (B7B-ASTRA-01): the roll it sends is an
 * initiative roll again, so the server keeps it from players by the order
 * setting as it stands then (docs/design-v1-combat-flow.md 11.3), the way
 * Recent rolls and the sticky line send it, through the resolve, the
 * reducer and a player's projection.
 */

let seq = 0;
const run = (state: RoomState, op: Op) => apply(state, op, DM, ++seq);

/** A dice.roll as the DM's panel sends it, resolved as the server resolves it, and applied. */
function rolled(state: RoomState, rolls: DiceRollInput[], to: "all" | "dm"): RoomState {
  const asked: OpOf<"dice.roll"> = { t: "dice.roll", tag: `0192f0a8-6c1e-7a4b-9c3d-${String(++seq).padStart(12, "0")}`, to, rolls };
  const resolved = resolveDiceOp(asked, state, { draw: () => 12, batch: "AbCdEfGhIjKlMnOp" });
  assert.ok(resolved.ok);
  return run(state, resolved.op);
}

function lastDice(state: RoomState): Extract<LogEvent, { type: "dice" }> {
  const data = state.log.at(-1)!.data;
  assert.equal(data?.type, "dice");
  return data as Extract<LogEvent, { type: "dice" }>;
}

/** The last line as the player gets it, or null when it does not reach them. */
function forPlayer(state: RoomState): Extract<LogEvent, { type: "dice" }> | null {
  const id = state.log.at(-1)!.id;
  const line = projectState(state, P1, { sceneId: "s1" }).log.find((l) => l.id === id);
  return line?.data?.type === "dice" ? line.data : null;
}

function fight(): RoomState {
  const state = room({ tokens: { pc1: token("pc1", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 1, y: 1 }), gob: token("gob", { x: 2, y: 2 }) } });
  state.meta.settings.playersSeeOrder = "party";
  return run(state, { t: "encounter.start", entries: [{ id: "r-pc", tokenId: "pc1", value: 20 }, { id: "r-gob", tokenId: "gob", value: 15 }] });
}

const INITIATIVE: DiceRollInput = { formula: "1d20+2", label: "Initiative", creature: { tokenId: "gob" }, initiative: true };

describe("Again on an initiative roll (B7B-ASTRA-01, docs/design-v1-combat-flow.md 11.3)", () => {
  test("the line keeps the mark, and Again sends an initiative roll again", () => {
    const state = rolled(fight(), [INITIATIVE], "all");
    const roll = lastDice(state).rolls[0]!;
    assert.equal(roll.initiative, true);
    assert.equal(roll.hidden, true);
    assert.deepEqual(againInput(roll), INITIATIVE);
    // A line from before the mark was kept, hidden all the same.
    const { initiative: _mark, ...older } = roll;
    assert.equal(againInput(older as DiceRoll)?.initiative, true);
    // A free roll stays one.
    assert.equal(againInput({ formula: "1d20+2", faces: [12], total: 14, label: "Initiative", tokenId: "gob" })?.initiative, undefined);
    assert.equal(againInput({ formula: "1d20", faces: [12], total: 12, initiative: true })?.initiative, undefined, "no creature, no initiative");
  });

  test("before the goblin's turn, Again in the open or in secret reaches no player, as the first roll did not", () => {
    for (const to of ["all", "dm"] as const) {
      let state = rolled(fight(), [INITIATIVE], to);
      assert.equal(forPlayer(state), null);
      state = rolled(state, [againInput(lastDice(state).rolls[0]!)!], to);
      assert.equal(lastDice(state).rolls[0]!.hidden, true, to);
      assert.equal(forPlayer(state), null, `${to}: no total, no bare line`);
    }
  });

  test("once the goblin's turn has come, Again meets the rule as it stands then and reaches players", () => {
    let state = rolled(fight(), [INITIATIVE], "all");
    const first = lastDice(state);
    state = run(run(state, { t: "encounter.next" }), { t: "encounter.next" });
    state = rolled(state, [againInput(first.rolls[0]!)!], "all");
    assert.equal(lastDice(state).rolls[0]!.hidden, undefined);
    assert.equal(lastDice(state).rolls[0]!.initiative, true);
    assert.equal(forPlayer(state)!.rolls[0]!.total, 14);
    state = rolled(state, [againInput(first.rolls[0]!)!], "dm");
    assert.deepEqual(forPlayer(state), { type: "dice", by: "dm1", to: "dm", rolls: [] });
  });
});

describe("Again on a creature's save", () => {
  const SAVE: DiceRollInput = { formula: "1d20+2", label: "Dexterity save", creature: { tokenId: "gob" }, save: "dex" };

  test("the line keeps the save, and Again on a Stunned creature's save records the fail again", () => {
    const stunned = room({ tokens: { gob: token("gob", { actor: { inline: actor({ effects: [effect("e1", { key: "stunned" })] }) } }) } });
    let state = rolled(stunned, [SAVE], "all");
    const first = lastDice(state).rolls[0]!;
    assert.equal(first.save, "dex");
    assert.equal(first.fails, "stunned");
    assert.deepEqual(againInput(first), SAVE);
    state = rolled(state, [againInput(first)!], "all");
    assert.equal(lastDice(state).rolls[0]!.fails, "stunned", "the repeated save fails as the first did");
  });

  test("a save with no creature, and a check, go as they came", () => {
    const state = room({ tokens: { gob: token("gob") } });
    const loose = rolled(state, [{ formula: "1d20+2", label: "Dexterity save", save: "dex" }], "all");
    assert.equal(lastDice(loose).rolls[0]!.save, undefined, "no creature, no save");
    const check: DiceRollInput = { formula: "1d20+2", label: "Stealth check", creature: { tokenId: "gob" } };
    const checked = rolled(state, [check], "all");
    assert.deepEqual(againInput(lastDice(checked).rolls[0]!), check);
  });
});

test("menu repeats replace aggregate modes without reconstructing current effects or carrying private labels", async () => {
  const { modeRepeat } = await import("./logic.ts");
  const saved: DiceRoll = { formula: "2d20kh1+2+1d4", faces: [15, 3, 2], total: 19, mode: "adv", cancelled: true, label: "Private trap DC 19", tokenId: "gob", save: "wis" };
  assert.deepEqual(modeRepeat([saved], "dis", "all"), [{ formula: "1d20+2+1d4", creature: { tokenId: "gob" }, save: "wis", label: "Repeated roll", mode: "dis" }]);
  assert.deepEqual(modeRepeat([saved], "normal", "dm"), [{ formula: "1d20+2+1d4", creature: { tokenId: "gob" }, save: "wis", label: "Private trap DC 19" }]);
  assert.equal(modeRepeat([saved], "secret", "all"), null);
  assert.deepEqual(againInput({ formula: "2d6", faces: [3, 4], total: 7, type: "fire" }), { formula: "2d6", type: "fire" });
  assert.equal(modeRepeat([saved, { formula: "1d6", faces: [2], total: 2 }], "adv", "all"), null);
});
