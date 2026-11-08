import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { holds, mutatedJson } from "./propertyTestutil.ts";
import { clientMessageSchema, clientOpSchema, opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, env, P1, P2, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Property tests of the wire schemas (docs/design/design.md 7) against what a
 * hostile or broken client can send. The server parses every frame with
 * clientMessageSchema and every op with clientOpSchema, stores what passes
 * as JSON, and replays it through opSchema. So a frame must be refused or
 * parsed without a throw, an op that passes must replay as the same op,
 * and an op the permissions allow must apply or be refused, never throw.
 *
 * The inputs start valid (testutil.ts's random rooms and ops) and take a
 * few edits anywhere (mutatedJson), so most of them reach the checks past
 * an op's tag, where random JSON never gets.
 */

const who = fc.constantFrom<Viewer>(DM, P1, P2);

/**
 * A valid op in a random room, and the seed of that room rather than the
 * room itself, so a counterexample prints in a few lines. randomState gives
 * the same room for the same seed.
 */
const roomAndOp = fc.tuple(fc.nat(), fc.nat(), who).map(([room, opSeed, viewer]) => ({ room, op: randomOp(rng(opSeed), randomState(rng(room)), viewer) as unknown, viewer }));

const id = fc.constantFrom("s1", "s2", "0192f0aa-0000-7000-8000-000000000001");
const validMessage = fc.oneof(
  fc.record({ t: fc.constant("hello"), clientId: fc.constantFrom("c1", "client-2"), resumeFrom: fc.integer({ min: 1, max: 1_000 }), sceneId: id }),
  fc.record({ t: fc.constant("ping"), k: fc.nat() }),
  fc.record({ t: fc.constant("scene"), sceneId: id }),
  fc.record({ t: fc.constant("eph"), sceneId: id, e: fc.record({ k: fc.constant("ping"), x: fc.integer({ min: 0, max: 50 }), y: fc.integer({ min: 0, max: 50 }) }) }),
  fc.record({ t: fc.constant("eph"), sceneId: id, e: fc.record({ k: fc.constant("dragMove"), tokenId: fc.constant("t1"), x: fc.integer({ min: 0, max: 50 }), y: fc.integer({ min: 0, max: 50 }) }) }),
  fc.tuple(fc.integer({ min: 1, max: 1_000 }), roomAndOp, fc.option(id, { nil: undefined })).map(([n, { op }, g]) => ({ t: "op", n, op, ...(g ? { g } : {}) })),
);

/** Numbers past every bound an op's numbers have, of the sizes a hostile client sends to make the server count. */
const EXTREME = [1e300, -1e300, 2 ** 53, 2 ** 31, 1e9, -1, 0.5, -0.5, -0] as const;

/** Where the numbers sit in a JSON value. */
function numberSlots(value: unknown, out: { parent: Record<string, unknown>; key: string }[] = []): { parent: Record<string, unknown>; key: string }[] {
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number") out.push({ parent: value as Record<string, unknown>, key });
    else numberSlots(child, out);
  }
  return out;
}

/**
 * A valid op with one of its numbers past its bounds. A bound zod reports
 * does not stop the refinements after it, so one that walks a range must
 * not take such a number on trust. mutatedJson reaches a number only now
 * and then, among every other slot.
 */
const extremeOp = fc.tuple(roomAndOp, fc.nat(), fc.constantFrom(...EXTREME)).map(([base, at, value]) => {
  const op = stored(base.op);
  const slots = numberSlots(op);
  const slot = slots[at % Math.max(1, slots.length)];
  if (slot) slot.parent[slot.key] = value;
  return { ...base, op };
});

/** As the server stores an op and reads it back: JSON text, which drops what JSON cannot spell. */
function stored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** -0 as 0, which JSON writes it as: no rule reads the sign of a zero. */
function zeroed(value: unknown): unknown {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(zeroed);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, zeroed(v)]));
  return value;
}

describe("the wire schemas, over hostile input (property)", () => {
  test("any frame is parsed or refused without a throw, and one that parses reads the same from its JSON", () => {
    holds(
      fc.property(fc.oneof(fc.jsonValue({ maxDepth: 4 }), mutatedJson(validMessage)), (raw) => {
        const parsed = clientMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        // A frame's op is any JSON here, read by clientOpSchema later (the next property), so the envelope alone must keep.
        const envelope = parsed.data.t === "op" ? { ...parsed.data, op: null } : parsed.data;
        const again = clientMessageSchema.safeParse(stored(envelope));
        assert.ok(again.success, "a parsed frame parses again from its JSON");
        assert.deepEqual(zeroed(again.data), zeroed(envelope));
      }),
      5_000,
    );
  });

  test("an op the server accepts replays as the same op, and applies or is refused without a throw", () => {
    holds(
      fc.property(fc.oneof(roomAndOp.chain((base) => mutatedJson(fc.constant(base.op)).map((op) => ({ ...base, op }))), extremeOp), ({ room, op: raw, viewer }) => {
        const parsed = clientOpSchema.safeParse(raw);
        if (!parsed.success) return;
        const op = parsed.data as Op;
        const replayed = opSchema.safeParse(stored(op));
        assert.ok(replayed.success, `${op.t} replays: ${replayed.success ? "" : replayed.error.issues[0]?.message}`);
        assert.deepEqual(zeroed(replayed.data), zeroed(op), `${op.t} replays as the op that was applied`);
        const state = randomState(rng(room));
        const decision = canApply(op, viewer, state, { canUseAsset: () => true });
        if (!decision.ok) return;
        const result = applyOp(state, op, viewer, env(2));
        if (result.ok) assert.ok(result.state !== state, "an applied op makes a new state");
        // The room is stored as JSON, which writes -0 as 0 (NEG-ZERO-REPLAY): the op as sent and the op as replayed must leave the same stored room.
        const replay = applyOp(state, replayed.data as Op, viewer, env(2));
        assert.equal(replay.ok, result.ok, "an op applies or is refused alike when replayed");
        if (result.ok && replay.ok) assert.equal(JSON.stringify(replay.state), JSON.stringify(result.state), `${op.t} leaves the same stored room when replayed`);
      }),
      4_000,
    );
  });
});
