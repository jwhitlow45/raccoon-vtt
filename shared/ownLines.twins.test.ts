import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM_LINE_BASE, partyIndex, rosterRanks } from "./logRings.ts";
import type { DiceRoll, LogEntry, RoomState } from "./model.ts";
import { canApply } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { P1, castTable, damageRoll, diceLine, entry, env } from "./testutil.ts";

/*
 * Whether a player's initiative value or a cast's damage is their own roll
 * reads only lines they hold (shared/logRings.ts ownLines): the shared lines
 * and their own party copies, never the DM's line a copy stands for
 * (shared/migrate.ts rollsFromOwnLines). Twins apart only in whether the
 * DM's ring still holds a party roll's original give the player the same
 * answers.
 *
 * Thorn's table (shared/testutil.ts castTable): Thorn is p1's character.
 */

/** A party roll of p1's at seq 40: the DM's line, and p1's copy of it, as Tx.settleLog writes them. */
function partyRoll(tag: string, rolls: DiceRoll[], state: RoomState): { original: LogEntry; copy: LogEntry } {
  const original = diceLine(`40:${DM_LINE_BASE}`, tag, rolls);
  const copy: LogEntry = { ...diceLine(`40:${partyIndex(rosterRanks(state.members).get("p1")!, 0)}`, tag, rolls), to: ["p1"], copyOf: original.id };
  return { original, copy };
}

type Held = "both" | "copy only" | "original only" | "neither";
const HELD: Held[] = ["both", "copy only", "original only", "neither"];

function withRoll(state: RoomState, tag: string, rolls: DiceRoll[], held: Held): RoomState {
  const { original, copy } = partyRoll(tag, rolls, state);
  const log = [...state.log];
  if (held === "both" || held === "original only") log.push(original);
  if (held === "both" || held === "copy only") log.push(copy);
  return { ...state, log };
}

/** What p1's copy holds: their copy, never the DM's original. */
const p1Holds = (held: Held) => held === "both" || held === "copy only";

describe("a player's initiative from their own lines (9)", () => {
  function fight(): RoomState {
    const state = castTable();
    state.meta.settings.playersTypeTotals = false;
    state.encounter = { rev: 0, round: 1, activeEntryId: null, startSeq: 30, entries: [entry("n1", { tokenId: "thorn", value: null })] };
    return state;
  }
  const initiative = (total: number): DiceRoll => ({ formula: "1d20+2", faces: [total - 2], total, label: "Initiative", tokenId: "thorn", initiative: true });
  const set: Op = { t: "encounter.setValue", entryId: "n1", value: 14, roll: "t-init" };

  test("the answer follows p1's copy alone, whether the DM's original is held or dropped", () => {
    for (const held of HELD) {
      const decision = canApply(set, P1, withRoll(fight(), "t-init", [initiative(14)], held), { canUseAsset: () => true });
      assert.equal(decision.ok, p1Holds(held), held);
    }
  });

  test("twins with p1's copy gone from its ring, one with the DM's original and one without, answer alike", () => {
    const [a, b] = [withRoll(fight(), "t-init", [initiative(14)], "original only"), withRoll(fight(), "t-init", [initiative(14)], "neither")];
    const answer = (s: RoomState) => canApply(set, P1, s, { canUseAsset: () => true });
    assert.deepEqual(answer(a), answer(b));
  });
});

describe("a cast's damage from the asker's own lines (9)", () => {
  const ask: Op = { t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 3, area: "a1", damage: { tag: "dmg", parts: 1 } } };
  function rolled(state: RoomState, opVersion?: number) {
    const r = applyOp(state, ask, P1, { ...env(50), ...(opVersion !== undefined ? { opVersion } : {}) });
    assert.ok(r.ok, r.ok ? "" : r.message);
    return r;
  }

  test("from 65 the ask copies the roll exactly while p1's copy is held, whatever the DM's ring holds", () => {
    for (const held of HELD) {
      const ask = rolled(withRoll(castTable(), "dmg", [damageRoll()], held)).state.casts.k1!;
      assert.deepEqual(ask.rolled, p1Holds(held) ? [{ formula: "8d6", total: 28, type: "fire" }] : undefined, held);
    }
  });

  test("twins with p1's copy gone, one with the DM's original and one without, write the same ask and lines", () => {
    const [a, b] = [rolled(withRoll(castTable(), "dmg", [damageRoll()], "original only")), rolled(withRoll(castTable(), "dmg", [damageRoll()], "neither"))];
    assert.deepEqual(a.state.casts, b.state.casts);
    assert.deepEqual(a.log, b.log);
  });

  test("an op stored at 64 replays as it ran: the DM's original stands in for a dropped copy", () => {
    const state = withRoll(castTable(), "dmg", [damageRoll()], "original only");
    assert.deepEqual(rolled(state, 64).state.casts.k1!.rolled, [{ formula: "8d6", total: 28, type: "fire" }]);
    assert.equal(rolled(state, 65).state.casts.k1!.rolled, undefined);
  });

  test("a shared roll reads alike before and from 65", () => {
    const state = castTable({ log: [diceLine("40:0", "dmg", [damageRoll()])] });
    assert.deepEqual(rolled(state, 64).state.casts.k1!.rolled, rolled(state).state.casts.k1!.rolled);
  });
});
