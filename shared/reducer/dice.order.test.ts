import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult, LogEvent, OrderReveal, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { opSchema, type ActorTarget, type Op, type OpOf } from "../protocol.ts";
import { DM, P1, P2, apply, room, token } from "../testutil.ts";

/**
 * An initiative roll for a creature whose place in the order players may not
 * know yet stays the DM's, open or secret (docs/design-v1-combat-flow.md
 * 11.3): the line marks the roll `hidden` when it is written, and a player's
 * projection drops it, so no total, bare line or toast reaches them.
 */

const BATCH = "AbCdEfGhIjKlMnOp";

let seq = 0;
const run = (state: RoomState, op: Op) => apply(state, op, DM, ++seq);

/** The DM's initiative for these creatures, as auto initiative and a row's Roll send it, with a total of 14 + i. */
function initiative(creatures: ActorTarget[], to: "all" | "dm", mark = true): Op {
  const asked: OpOf<"dice.roll"> = {
    t: "dice.roll",
    tag: `0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c${String(++seq).padStart(2, "0")}`,
    to,
    rolls: creatures.map((creature) => ({ formula: "1d20+2", label: "Initiative", creature, ...(mark ? { initiative: true as const } : {}) })),
  };
  const results: DiceResult[] = creatures.map((_, i) => ({ formula: "1d20+2", faces: [12 + i], total: 14 + i }));
  return { t: "sys.dice", asked, batch: BATCH, results };
}

function fight(reveal: OrderReveal): RoomState {
  const state = room({
    tokens: {
      pc1: token("pc1", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 1, y: 1 }),
      gob: token("gob", { x: 2, y: 2 }),
      late: token("late", { name: "Ogre", x: 4, y: 2 }),
      ally: token("ally", { kind: "npc", name: "Guard", disposition: "ally", x: 3, y: 2 }),
    },
  });
  state.meta.settings.playersSeeOrder = reveal;
  return run(state, { t: "encounter.start", entries: [{ id: "r-pc", tokenId: "pc1", value: 20 }, { id: "r-gob", tokenId: "gob", value: 15 }, { id: "r-ally", tokenId: "ally", value: 10 }] });
}

const lastLine = (state: RoomState) => state.log.at(-1)!;
/**
 * The last op's dice line as a viewer gets it, or null when it does not reach them: a line only some players read is
 * the DM's, with a copy for each reader (shared/logRings.ts).
 */
function diceFor(state: RoomState, viewer: typeof DM): Extract<LogEvent, { type: "dice" }> | null {
  const id = lastLine(state).id;
  const seq = id.slice(0, id.indexOf(":") + 1);
  const line = projectState(state, viewer, { sceneId: "s1" }).log.filter((l) => l.id.startsWith(seq)).at(-1);
  return line?.data?.type === "dice" ? line.data : null;
}

describe("initiative rolls under the order setting (docs/design-v1-combat-flow.md 11.3)", () => {
  test("a monster's roll before its turn reaches no player, open or secret, and reaches the DM whole with its mark", () => {
    for (const to of ["all", "dm"] as const) {
      const state = run(fight("party"), initiative([{ tokenId: "gob" }], to));
      assert.equal(diceFor(state, P1), null, `${to}: no line, so no bare line and no toast`);
      assert.equal(diceFor(state, P2), null);
      const dm = diceFor(state, DM)!;
      assert.equal(dm.rolls[0]!.total, 14);
      assert.equal(dm.rolls[0]!.hidden, true);
      assert.ok(!projectState(state, P1, { sceneId: "s1" }).log.some((l) => l.data?.type === "dice"), "nor any other line of it");
    }
  });

  test("once its turn has come, under Everyone, and for a creature players play, the roll reaches players as before", () => {
    let state = run(run(fight("party"), { t: "encounter.next" }), { t: "encounter.next" });
    assert.equal(state.encounter!.activeEntryId, "r-gob");
    state = run(state, initiative([{ tokenId: "gob" }], "all"));
    assert.equal(diceFor(state, P1)!.rolls[0]!.total, 14);
    assert.equal(diceFor(state, P1)!.rolls[0]!.hidden, undefined);
    state = run(fight("all"), initiative([{ tokenId: "gob" }], "all"));
    assert.equal(diceFor(state, P1)!.rolls[0]!.total, 14);
    state = run(fight("party"), initiative([{ tokenId: "pc1" }], "all"));
    assert.equal(diceFor(state, P2)!.rolls[0]!.total, 14);
    // A secret roll that would reach a player made public still comes as the bare line.
    state = run(state, { t: "encounter.next" });
    state = run(state, { t: "encounter.next" });
    state = run(state, initiative([{ tokenId: "gob" }], "dm"));
    assert.deepEqual(diceFor(state, P1), { type: "dice", by: "dm1", to: "dm", rolls: [] });
  });

  test("an ally's roll follows the choice, a creature not in the fight yet counts as unseen, and an unmarked free roll is no initiative", () => {
    assert.ok(diceFor(run(fight("allies"), initiative([{ tokenId: "ally" }], "all")), P1));
    assert.equal(diceFor(run(fight("party"), initiative([{ tokenId: "ally" }], "all")), P1), null);
    assert.equal(diceFor(run(fight("party"), initiative([{ tokenId: "late" }], "all")), P1), null, "rolled before it joins, it tells players nothing");
    assert.equal(diceFor(run(fight("party"), initiative([{ tokenId: "gob" }], "all", false)), P1)!.rolls[0]!.total, 14);
  });

  test("a line of several keeps only the rolls players may have, and a hidden roll stays out after the reveal", () => {
    let state = run(fight("party"), initiative([{ tokenId: "pc1" }, { tokenId: "gob" }], "all"));
    const p1 = diceFor(state, P1)!;
    assert.deepEqual(p1.rolls.map((r) => [r.tokenId, r.total]), [["pc1", 14]]);
    const id = lastLine(state).id;
    state = run(run(state, { t: "encounter.next" }), { t: "encounter.next" });
    assert.ok(projectState(state, P1, { sceneId: "s1" }).encounter!.entries.some((e) => e.id === "r-gob"), "the goblin's row shows now");
    const later = projectState(state, P1, { sceneId: "s1" }).log.find((l) => l.id === id)!.data as Extract<LogEvent, { type: "dice" }>;
    assert.deepEqual(later.rolls.map((r) => r.tokenId), ["pc1"], "the mark is never rewritten");
  });

  test("every marked roll keeps its mark on the line, and a repeat of it before the reveal stays the DM's, open or secret (B7B-ASTRA-01)", () => {
    for (const to of ["all", "dm"] as const) {
      let state = run(fight("party"), initiative([{ tokenId: "gob" }], to));
      state = run(state, initiative([{ tokenId: "gob" }], to));
      const roll = diceFor(state, DM)!.rolls[0]!;
      assert.equal(roll.initiative, true);
      assert.equal(roll.hidden, true);
      assert.equal(diceFor(state, P1), null, `${to}: the repeat reaches no player`);
    }
    const shown = diceFor(run(fight("party"), initiative([{ tokenId: "pc1" }], "all")), DM)!.rolls[0]!;
    assert.equal(shown.initiative, true, "a roll players may have keeps the mark too, so its Again is checked again");
    assert.equal(shown.hidden, undefined);
    assert.equal(diceFor(run(fight("party"), initiative([{ tokenId: "gob" }], "all", false)), DM)!.rolls[0]!.initiative, undefined);
  });

  test("a monster lent to a player has its roll reach that player alone before its turn, as its row does (the project owner, 2026-10-17)", () => {
    for (const to of ["all", "dm"] as const) {
      let state = fight("party");
      state = run(state, { t: "token.update", tokenId: "gob", patch: { ownerIds: ["p2"] } });
      state = run(state, initiative([{ tokenId: "gob" }], to));
      assert.equal(diceFor(state, DM)!.rolls[0]!.hidden, true);
      // Its own player keeps it, as any roll the DM makes for their creature: in full, or as a secret one's bare line.
      if (to === "all") assert.deepEqual([diceFor(state, P2)!.rolls[0]!.total, diceFor(state, P2)!.rolls[0]!.hidden], [14, undefined], "the mark is the DM's");
      else assert.deepEqual(diceFor(state, P2), { type: "dice", by: "dm1", to: "dm", rolls: [] });
      assert.equal(diceFor(state, P1), null, `${to}: another player gets no total and no bare line`);
    }
  });

  test("a stored marked roll parses as replay parses it, and replays to the same line", () => {
    const op = initiative([{ tokenId: "gob" }], "all");
    const stored = opSchema.parse(JSON.parse(JSON.stringify(op))) as Op;
    const once = apply(fight("party"), op, DM, 200);
    const again = apply(fight("party"), stored, DM, 200);
    assert.deepEqual(lastLine(again), lastLine(once));
  });
});
