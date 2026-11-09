import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fogRoom, paint } from "#shared/discoveryTestutil.ts";
import { COUNT_OP_VERSION } from "#shared/migrate.ts";
import type { LogEvent, RoomState, Trap, TrapRig } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { Env } from "#shared/reducer/tx.ts";
import { DM, env, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { forgetSceneOp } from "./remember.ts";

/**
 * No op the server makes to keep its books starts a turn
 * (shared/reducer/trapStep.ts turnStarted). Each takes the room count as it
 * stands (counted.ts), which right after a Next is the Next's own number,
 * the one the turn's start holds. Here Next starts Thorn's turn on a statue
 * that goes off at a turn's start and arms again each turn, then the music's
 * tick, an explore, a second explore once Thorn stands in the other room,
 * and the map step's forgetting each run at that very number, as the actor
 * runs them after a Next with no member's op between. The statue goes off once: one use spent, one line. Stored
 * rows before op version 57 replay the same way at whatever number they
 * carry.
 */

const SERVER = { memberId: "server", role: "dm" } as const;
const NEXT = 41;

const rig: TrapRig = { on: ["turnStart"], who: "any", floor: true, resets: "nextTurn", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "The statue's eyes glow.", usesLeft: 3 };
const statue: Trap = { id: "statue", rev: 0, sceneId: "s1", name: "Statue", zone: { cells: [{ x: 4, y: 4, w: 1, h: 1 }] }, state: "sprung", found: true, rig };

function fight(): RoomState {
  const state = fogRoom({ vision: true, bounds: { w: 48, h: 16 } });
  // Two rooms with rock between, so sight in one never reaches the other.
  paint(state, { x: 1, y: 1, w: 12, h: 10 });
  paint(state, { x: 30, y: 1, w: 12, h: 10 });
  state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 9, y: 8 });
  state.traps = { statue };
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "n2",
    entries: [
      { id: "n1", tokenId: "thorn", value: 20, order: 0 } as never,
      { id: "n2", tokenId: "gob", value: 10, order: 1 } as never,
    ],
  };
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
}

const sprungLines = (state: RoomState) => state.trapLog.filter((l) => (l.data as LogEvent & { trapId?: string }).trapId === "statue").length;

/** The server's ops after the Next, each built from the room as the one before left it, as the actor builds them. */
function bookkeeping(state: RoomState, at: (state: RoomState) => Env): { kinds: string[]; state: RoomState } {
  const kinds: string[] = [];
  let s = state;
  const run = (op: Op | null) => {
    if (op === null) return;
    const r = applyOp(s, op, SERVER, at(s));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    assert.deepEqual(r.log, [], `${op.t} writes no line`);
    kinds.push(op.t);
    s = r.state;
  };
  run({ t: "sys.sound", from: s.playing?.rev ?? 0, music: null, loops: {}, effects: [] });
  run(exploreOp(s, "s1"));
  // Thorn stands in the other room for the next explore, so it has ground to add, and back on the statue after.
  const home = s.tokens.thorn!;
  s = { ...s, tokens: { ...s.tokens, thorn: { ...home, x: 35, y: 5 } } };
  run(exploreOp(s, "s1"));
  run(forgetSceneOp(s, "s1"));
  s = { ...s, tokens: { ...s.tokens, thorn: { ...s.tokens.thorn!, x: home.x, y: home.y } } };
  return { kinds, state: s };
}

describe("bookkeeping ops start no turn", () => {
  for (const [what, opVersion] of [["live and at today's version", undefined], ["a row stored before the room count", COUNT_OP_VERSION - 1]] as const) {
    test(`a turn-start trap goes off once for one Next, ${what}`, () => {
      const next = applyOp(fight(), { t: "encounter.next" }, DM, { ...env(NEXT), ...(opVersion === undefined ? {} : { opVersion }) });
      assert.ok(next.ok);
      assert.equal(next.state.encounter!.turnStart!.seq, NEXT, "the turn's start holds the Next's number");
      assert.equal(next.state.traps.statue!.rig!.usesLeft, 2);
      assert.equal(sprungLines(next.state), 1);
      // Every one of them carries the Next's number: uncounted at today's version, and pinned to it for the older row.
      const after = bookkeeping(next.state, () => ({ ...env(NEXT), ...(opVersion === undefined ? { uncounted: true as const } : { opVersion }) }));
      assert.deepEqual(after.kinds, ["sys.sound", "sys.explore", "sys.explore", "sys.remember"], "each kind ran");
      assert.equal(after.state.traps.statue!.rig!.usesLeft, 2, "no use spent again");
      assert.equal(sprungLines(after.state), 1, "no second line");
      assert.equal(after.state.encounter!.turnStart!.seq, NEXT);
    });
  }

  test("the next Next starts the next turn as before", () => {
    const next = applyOp(fight(), { t: "encounter.next" }, DM, env(NEXT));
    assert.ok(next.ok);
    const after = bookkeeping(next.state, () => ({ ...env(NEXT), uncounted: true }));
    const again = applyOp(after.state, { t: "encounter.next" }, DM, env(NEXT + 1));
    assert.ok(again.ok);
    const back = applyOp(again.state, { t: "encounter.next" }, DM, env(NEXT + 2));
    assert.ok(back.ok);
    assert.equal(back.state.encounter!.activeEntryId, "n1");
    assert.equal(back.state.traps.statue!.rig!.usesLeft, 1, "Thorn's next turn spends one more");
  });
});
