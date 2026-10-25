import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lineAudience } from "./logRings.ts";
import type { RoomState, Viewer } from "./model.ts";
import { opSchema } from "./protocol.ts";
import { hash128, projectState, stableStringify } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, env, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Whole-party scenes are byte for byte as before per-player vision
 * (docs/design-v1-per-player-vision.md section 9, rule 12): random rooms,
 * none of whose scenes is per player, go through random ops, and every
 * state the reducer leaves, every answer it gives and every viewer's
 * projection hash as they did on the build before per-player vision. The
 * fixture holds those hashes, one per seed, beside a hash of the inputs.
 *
 * The inputs come from testutil.ts's generators. When those change, the
 * inputs' hash no longer matches and the test says so: write the fixture
 * again on the parent of the change that moved the generators, with
 * PV_GOLDEN=write, so it records what the code did before.
 */

const FIXTURE = new URL("./pervision.golden.fixture.json", import.meta.url);
const SEEDS = 150;
const OPS = 40;
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWS: readonly [Viewer, string][] = [
  [DM, "s1"],
  [DM, "s2"],
  [P1, "s1"],
  [P2, "s1"],
  [DISPLAY, "s1"],
];

/* The collections per-player vision adds hold nothing on these rooms, and so say nothing the build before held. */
function stored(state: RoomState): string {
  const room = { ...state } as Record<string, unknown>;
  for (const field of ["holders", "exploredBy"]) {
    const value = room[field];
    if (value !== undefined && Object.keys(value as object).length === 0) delete room[field];
  }
  return stableStringify(room);
}

function run(seed: number): { input: string; output: string } {
  const r = rng(seed);
  let state = randomState(r);
  const inputs: string[] = [stored(state)];
  const outputs: string[] = [];
  for (let i = 0; i < OPS; i++) {
    const who = i % 5 === 4 ? (i % 2 === 0 ? P1 : P2) : DM;
    const op = opSchema.parse(randomOp(r, state, who));
    inputs.push(stableStringify(op));
    const result = applyOp(state, op, who, env(100 + i));
    if (!result.ok) {
      outputs.push(`refused ${result.code}: ${result.message}`);
      continue;
    }
    state = result.state;
    outputs.push(hash128(stored(state)), String(result.global), result.touched.join(","));
    for (const line of result.log) outputs.push(`${line.id} ${lineAudience(line)}`);
    for (const [viewer, sceneId] of VIEWS) outputs.push(hash128(stableStringify(projectState(state, viewer, { sceneId }))));
  }
  return { input: hash128(inputs.join("\n")), output: hash128(outputs.join("\n")) };
}

describe("whole-party scenes as before per-player vision", () => {
  test("random rooms and ops leave the same states, answers and projections", () => {
    const got = Array.from({ length: SEEDS }, (_, i) => run(i + 1));
    if (process.env.PV_GOLDEN === "write") {
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as { input: string; output: string }[];
    assert.equal(want.length, SEEDS);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i]!.input, w.input, `seed ${i + 1}: the generators changed, so the fixture compares other rooms (see the note above)`);
      assert.equal(got[i]!.output, w.output, `seed ${i + 1}: a whole-party room changed`);
    }
  });
});
