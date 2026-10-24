import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1 } from "../testutil.ts";

/**
 * Ops stored before op version 21 replay with the rule they were applied
 * under (shared/migrate.ts takesBackTurnOnly): Previous put back the saved
 * step's whole encounter and each ticked creature's whole effects list, and
 * a companion's rows left every saved step, an active one passing its turn
 * on there.
 *
 * The fixture is a fight the build before op version 21 (fc4e9149) played:
 * a dragon, Thorn with Bless and his own-turn wolf, a troll with a save-ends
 * effect, a hidden goblin and a kobold out of the fight. On Thorn's turn the
 * DM adds the kobold, frightens Thorn, sets the troll's value, puts the
 * dragon in its lair and spends the wolf's Reaction, then Previous. Then the
 * troll's row is removed on the turn after its own, the acting goblin is
 * removed, and the wolf comes to act on Thorn's turn, each followed by
 * Previous. Each step stores a hash of the state and log that build made, so
 * a change that breaks this must keep version 20 ops on the rule they were
 * applied under rather than record the file again.
 */
type Step = { who: "dm" | "player"; op: Op; after: string };
type Fixture = { build: string; state: RoomState; steps: Step[] };

const fixture = JSON.parse(readFileSync(new URL("./opVersion20.fixture.json", import.meta.url), "utf8")) as Fixture;
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

describe("version 20 Previous: the whole saved encounter and effects (design 9.4)", () => {
  test("replay at version 20 to the bytes the build before version 21 made, every step", () => {
    assert.equal(fixture.build, "fc4e9149");
    assert.equal(fixture.steps.length, 23);
    const { hashes, refusals } = replay(20);
    assert.deepEqual(refusals, fixture.steps.map(() => null));
    assert.deepEqual(hashes, fixture.steps.map((s) => s.after));
  });

  test("the same ops live take back only the turn, so the version is what keeps the old bytes", () => {
    const { hashes, states } = replay();
    const firstPrev = fixture.steps.findIndex((s) => s.op.t === "encounter.prev");
    assert.notEqual(hashes[firstPrev], fixture.steps[firstPrev]!.after);
    const back = states[firstPrev]!.encounter!;
    assert.ok(back.entries.some((e) => e.id === "ek"), "a live Previous keeps the kobold the DM added");
    assert.equal(back.entries.find((e) => e.id === "ed")!.inLair, true, "and In lair");
  });
});
