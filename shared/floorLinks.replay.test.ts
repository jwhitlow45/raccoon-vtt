import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RoomState, Viewer } from "./model.ts";
import { stableStringify } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";

/*
 * Replay across the stairs' version (docs/design/design-v1-floors.md phase 2,
 * 12). The fixture was recorded by the build before stairs, the room count's
 * contract: a fight in which the DM moves the acting creature to another
 * floor mid-turn and back, and another creature on its own turn. Stored at op
 * version 57, each replays as it was applied, every path dropped at a change
 * of floor. The same ops live keep the turn's feet in `prior`.
 */

type Fixture = { initial: RoomState; ops: { op: Op; who: Viewer; seq: number; at: string; opVersion: number }[]; final: RoomState };
const fixture = JSON.parse(readFileSync(new URL("./floorLinks.replay.fixture.json", import.meta.url), "utf8")) as Fixture;

function replay(live: boolean): RoomState[] {
  const states: RoomState[] = [];
  let state = fixture.initial;
  for (const { op, who, seq, at, opVersion } of fixture.ops) {
    const r = applyOp(state, opSchema.parse(op), who, live ? { seq, at } : { seq, at, opVersion });
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
    states.push(state);
  }
  return states;
}

test("ops stored before the stairs replay as they were applied, the path dropped at each change of floor", () => {
  const states = replay(false);
  assert.equal(stableStringify(states.at(-1)), stableStringify(fixture.final));
  assert.equal(states[3]!.tokens.thorn!.path, undefined);
});

test("the same ops live keep the turn's feet across Move to floor", () => {
  const states = replay(true);
  const upstairs = states[3]!.tokens.thorn!.path!;
  assert.deepEqual(upstairs.prior, { moved: 25, cost: 25, seenDiag: [0, 0] });
  assert.equal(upstairs.stops.length, 1);
  const back = states[5]!.tokens.thorn!.path!;
  assert.deepEqual(back.prior, { moved: 35, cost: 35, seenDiag: [0, 0] });
});
