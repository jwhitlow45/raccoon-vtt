import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1 } from "../testutil.ts";

/**
 * Ops stored before op version 20 replay with the rules they were applied
 * under (shared/migrate.ts combatUses): a turn start wrote no record, Next
 * refilled the landing row's pips alone, a marked row's included, a removal
 * that passed the turn on wrote no actor, a fight's end cleared nothing of a
 * creature's uses, and a group save's Legendary Resistance wrote no line.
 *
 * The fixture is a fight the build before op version 20 (f160b35b) played:
 * a dragon, a goblin, Thorn dying with his shared wolf, and Bree on a
 * warhorse whose row marks time, through Nexts, a group save with
 * Resistance, damage and a condition, the stored restore of an undo of a
 * Next, a removal of the acting row, Previous and the fight's end. Each step
 * stores a hash of the state and log that build made, so a change that
 * breaks this must keep version 19 ops on the rule they were applied under
 * rather than record the file again.
 */
type Step = { who: "dm" | "player"; op: Op; after: string };
type Fixture = { build: string; state: RoomState; steps: Step[] };

const fixture = JSON.parse(readFileSync(new URL("./opVersion19.fixture.json", import.meta.url), "utf8")) as Fixture;
const envelope = (i: number, opVersion?: number) => ({ seq: 1000 + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...(opVersion === undefined ? {} : { opVersion }) });

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

describe("version 19 turns, a group save's Resistance and a fight's end (docs/design-v1-combat-controls.md 3.3)", () => {
  test("replay at version 19 to the bytes the build before version 20 made, complete state and history, the stored restore included", () => {
    assert.equal(fixture.steps.length, 16);
    assert.equal(fixture.steps[11]!.op.t, "sys.restore");
    const { hashes, refusals } = replay(19);
    assert.deepEqual(refusals, fixture.steps.map(() => null));
    assert.deepEqual(hashes, fixture.steps.map((s) => s.after));
  });

  test("the same ops live write what combat uses add, so the version is what keeps the old bytes", () => {
    const { hashes, states, refusals } = replay();
    const firstNext = fixture.steps.findIndex((s) => s.op.t === "encounter.next");
    assert.notEqual(hashes[firstNext], fixture.steps[firstNext]!.after, "a live Next stamps records");
    assert.ok(Object.values(states[firstNext]!.tokens).some((t) => "inline" in t.actor && t.actor.inline.turnRecord !== undefined));
    // A live replay goes its own way: the stored restore's guards were taken over the old bytes.
    assert.ok(refusals.length <= fixture.steps.length);
  });
});
