import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1 } from "../testutil.ts";

/**
 * Ops stored before op version 6 replay with the rule they were applied
 * under (shared/migrate.ts, step 5 to 6): a size change on the acting
 * creature's turn was a move, so a token update with a size and a place
 * recorded a counted stop, and one with a size alone recorded nothing.
 * Replay hands the reducer the stored version, so a version 5 op makes the
 * very state it made then, and a later stored restore's guard still
 * matches.
 *
 * The fixture is a fight the build before op version 6 (161166e1) played:
 * Thorn moves, grows with a place and in place, moves, and shrinks with a
 * place, then the DM undoes the shrink. Each step stores a hash of the
 * state and log that build made. A change that breaks this must keep
 * version 5 ops on the rule they were applied under, as resizeStop does,
 * rather than record the file again.
 */
type Step = { who: "dm" | "player"; op: Op; after: string };
type Fixture = { build: string; state: RoomState; steps: Step[] };

const fixture = JSON.parse(readFileSync(new URL("./opVersion5.fixture.json", import.meta.url), "utf8")) as Fixture;
const envelope = (i: number, opVersion?: number) => ({ seq: 1000 + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...(opVersion === undefined ? {} : { opVersion }) });

/** The fixture's ops applied at one version, each step's state and log hashed, and the states. */
function replay(opVersion?: number): { hashes: string[]; states: RoomState[]; refusals: (string | null)[] } {
  let state = fixture.state;
  const hashes: string[] = [];
  const states: RoomState[] = [];
  const refusals: (string | null)[] = [];
  for (const [i, step] of fixture.steps.entries()) {
    const r = applyOp(state, step.op, step.who === "dm" ? DM : P1, envelope(i, opVersion));
    if (!r.ok) {
      refusals.push(r.message);
      break;
    }
    refusals.push(null);
    hashes.push(hash128(stableStringify({ state: r.state, log: r.log })));
    states.push(r.state);
    state = r.state;
  }
  return { hashes, states, refusals };
}

describe("version 5 size and place updates on the acting creature", () => {
  test("replay at version 5 to the bytes the build before version 6 made", () => {
    assert.equal(fixture.steps.length, 8);
    const { hashes, refusals } = replay(5);
    assert.deepEqual(refusals, fixture.steps.map(() => null));
    assert.deepEqual(hashes, fixture.steps.map((s) => s.after));
  });

  test("a size and a place record a counted stop at version 5, and a resize's stop at version 6", () => {
    const stops = (opVersion: number, step: number) => replay(opVersion).states[step]!.tokens.thorn!.path!.stops;
    const then = stops(5, 3);
    assert.deepEqual(then.at(-1), { x: 3, y: 0, elevation: 0, seen: true }, "counted, no size on any stop");
    assert.ok(then.every((s) => s.footprint === undefined));
    const now = stops(6, 3);
    assert.deepEqual(now.at(-1), { x: 3, y: 0, elevation: 0, seen: true, uncounted: true });
    assert.deepEqual(now.slice(0, -1).map((s) => s.footprint), [{ w: 1, h: 1 }, { w: 1, h: 1 }], "the stops before it keep their size");
    assert.equal(stops(5, 4).length, then.length, "a size alone recorded nothing at version 5");
    assert.equal(stops(6, 4).length, now.length + 1, "and records a resize's stop at version 6");
  });

  test("the DM's undo of a version 5 shrink matches its guard only when replayed at version 5", () => {
    assert.equal(replay(5).refusals.at(-1), null);
    const today = replay(6);
    assert.notEqual(today.refusals.at(-1), null, "today's ops made another path, so the stored guard refuses");
  });
});
