import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lineAudience } from "./logRings.ts";
import type { RoomState, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { opSchema, type Op } from "./protocol.ts";
import { hash128, projectState, stableStringify } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, env, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Square scenes are byte for byte as before hex grids
 * (docs/design-v1-hex-grids.md section 10): random rooms, every scene of
 * them on squares, go through random ops, and every permission decision,
 * every state the reducer leaves, every answer it gives, every viewer's
 * projection and the undo of each step hash as they did on the build
 * before hex grids. The fixture holds those hashes, one per seed, beside
 * a hash of the inputs.
 *
 * The inputs come from testutil.ts's generators. When those change, the
 * inputs' hash no longer matches and the test says so: write the fixture
 * again on the parent of the change that moved the generators, with
 * HEX_GOLDEN=write, so it records what the code did before.
 */

const FIXTURE = new URL("./hex.golden.fixture.json", import.meta.url);
const SEEDS = 120;
const OPS = 40;
const deps = { canUseAsset: () => true };
const VIEWS: readonly [Viewer, string][] = [
  [DM, "s1"],
  [P1, "s1"],
  [P2, "s2"],
];

/*
 * Map discovery's collections hold nothing on these rooms, and so say
 * nothing the build before held. The played marks a move of the players
 * writes are bookkeeping no build before wrote, so they are left out with
 * their keys (docs/design-v1-map-discovery.md 5.5).
 */
const DISCOVERY = ["memory", "memoryBy", "memoryShared"] as const;

function stored(state: RoomState): string {
  const room = { ...state } as Record<string, unknown>;
  delete room.playedScenes;
  for (const field of DISCOVERY) if (Object.keys((room[field] as object | undefined) ?? {}).length === 0) delete room[field];
  return stableStringify(room);
}

function touchedBefore(touched: readonly string[]): string {
  return touched.filter((key) => !key.startsWith("played:")).join(",");
}

function answer(result: ReturnType<typeof applyOp>): string[] {
  if (!result.ok) return [`refused ${result.code}: ${result.message}`];
  const out = [hash128(stored(result.state)), String(result.global), touchedBefore(result.touched)];
  for (const line of result.log) out.push(`${line.id} ${lineAudience(line)}`);
  return out;
}

function run(seed: number): { input: string; output: string } {
  const r = rng(seed);
  let state: RoomState = randomState(r);
  const inputs: string[] = [stored(state)];
  const outputs: string[] = [];
  for (let i = 0; i < OPS; i++) {
    // Every fourth op is a player's, the two taking turns.
    const who = i % 4 === 3 ? (Math.floor(i / 4) % 2 === 0 ? P1 : P2) : DM;
    const op = opSchema.parse(randomOp(r, state, who));
    inputs.push(stableStringify(op));
    const decision = canApply(op, who, state, deps);
    outputs.push(decision.ok ? "allowed" : `${decision.code}: ${decision.message}`);
    const result = applyOp(state, op, who, env(100 + i));
    outputs.push(...answer(result));
    if (!result.ok) continue;
    const inverse = result.inverse;
    outputs.push(inverse === null ? "no undo" : hash128(stableStringify(inverse)));
    if (inverse !== null && i % 3 === 0) {
      // The step's undo, as the server builds it: through the same restore every undo and redo takes.
      const undo: Op = { t: "sys.restore", entries: inverse, from: "undo", deps: true };
      outputs.push(...answer(applyOp(result.state, undo, DM, env(1_000 + i))));
    }
    state = result.state;
    for (const [viewer, sceneId] of VIEWS) outputs.push(hash128(stableStringify(projectState(state, viewer, { sceneId }))));
  }
  return { input: hash128(inputs.join("\n")), output: hash128(outputs.join("\n")) };
}

describe("square scenes as before hex grids", () => {
  test("random rooms and ops get the same decisions, states, answers, projections and undos", () => {
    const got = Array.from({ length: SEEDS }, (_, i) => run(i + 1));
    if (process.env.HEX_GOLDEN === "write") {
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as { input: string; output: string }[];
    assert.equal(want.length, SEEDS);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i]!.input, w.input, `seed ${i + 1}: the generators changed, so the fixture compares other rooms (see the note above)`);
      assert.equal(got[i]!.output, w.output, `seed ${i + 1}: a square room changed`);
    }
  });
});
