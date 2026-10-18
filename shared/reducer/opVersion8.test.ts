import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, entry, env, room, token } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Ops stored before op version 8 replay as they ran (shared/migrate.ts,
 * step 7 to 8): a turn that started marked nothing on its row. Replay hands
 * the reducer the stored version, so a version 7 Next makes the very
 * encounter it made then, and a later stored restore's guard still matches
 * (docs/design-v1-combat-flow.md 11.4).
 */
const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

function fight(): RoomState {
  const state = room({ tokens: { pc1: token("pc1", { kind: "pc", ownerIds: ["p1"] }), g1: token("g1", { name: "Goblin" }), g2: token("g2", { name: "Goblin" }) } });
  state.meta.settings.playersSeeOrder = "party";
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n1", { tokenId: "pc1", value: 20 }), entry("n2", { tokenId: "g1", value: 15, tieOrder: 1 }), entry("n3", { tokenId: "g2", value: 10, tieOrder: 2 })] };
  return state;
}

function applied(state: RoomState, op: Op, seq: number, opVersion?: number) {
  const r = applyOp(state, op, DM, at(seq, opVersion));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r;
}

const marked = (state: RoomState) => state.encounter!.entries.filter((e) => e.hadTurn).map((e) => e.id);

describe("version 7 ops and the rows whose turn has come", () => {
  test("a Next at version 7 marks no row, and at version 8 or live marks the row whose turn starts", () => {
    assert.deepEqual(marked(applied(fight(), { t: "encounter.next" }, 2, 7).state), []);
    assert.deepEqual(marked(applied(fight(), { t: "encounter.next" }, 2, 8).state), ["n1"]);
    let state = applied(fight(), { t: "encounter.next" }, 2).state;
    state = applied(state, { t: "encounter.next" }, 3).state;
    assert.deepEqual(marked(state), ["n1", "n2"]);
  });

  test("a removal that passes the turn on marks the next row only from version 8", () => {
    const acting = applied(fight(), { t: "encounter.next" }, 2, 7).state;
    assert.deepEqual(marked(applied(acting, { t: "encounter.remove", entryIds: ["n1"] }, 3, 7).state), []);
    assert.deepEqual(marked(applied(acting, { t: "encounter.remove", entryIds: ["n1"] }, 3, 8).state), ["n2"]);
  });

  test("an undo of a version 7 Next still matches its guard when replayed at version 7, and would not under today's rule", () => {
    const start = fight();
    const first = applied(start, { t: "encounter.next" }, 2, 7);
    assert.ok(first.inverse);
    const undo: Op = { t: "sys.restore", entries: first.inverse, from: "undo", deps: true };
    const replayed = applyOp(first.state, undo, DM, at(3, 7));
    assert.ok(replayed.ok, "the guard matches the encounter the version 7 Next made");
    assert.equal(replayed.state.encounter!.activeEntryId, null);
    const today = applied(start, { t: "encounter.next" }, 2);
    assert.equal(applyOp(today.state, undo, DM, at(3)).ok, false, "today's Next made another encounter, so the stored guard would refuse");
  });
});
