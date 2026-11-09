import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { EntityKey } from "#shared/keys.ts";
import type { Op, OpOf } from "#shared/protocol.ts";
import type { RoomState } from "#shared/model.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { UNCOUNTED_LINE } from "#shared/reducer/tx.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { DM, env } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { forgetSceneOp, mapStepOps } from "./remember.ts";

/**
 * The server's own explore, remember and music ops (counted.ts) reduce at
 * the room count as it stands, a number an answered op may already hold, so
 * nothing they do may read it. Over random rooms, each such op the actor
 * would make, reduced at a number P and again at P + 7, gives the same room
 * and the same touched keys, writes no line, and is never refused by the
 * guard against lines (tx.ts UNCOUNTED_LINE).
 */

const SERVER = { memberId: "server", role: "dm" } as const;

type Room = { door: boolean; perPlayer: boolean; a: [number, number]; b: [number, number]; paint: [number, number, number, number]; tick: boolean; p: number };

const square = (xs: [number, number], ys: [number, number]) => fc.tuple(fc.integer({ min: xs[0], max: xs[1] }), fc.integer({ min: ys[0], max: ys[1] }));
const rooms: fc.Arbitrary<Room> = fc.record({
  door: fc.boolean(),
  perPlayer: fc.boolean(),
  // Room R, the corridor and room Q of the twins (secretDoorTestutil.ts), so a token may stand anywhere it could.
  a: fc.oneof(square([2, 9], [2, 9]), square([10, 15], [5, 5])),
  b: fc.oneof(square([2, 9], [2, 9]), square([19, 25], [3, 9])),
  paint: fc.tuple(fc.integer({ min: 0, max: 28 }), fc.integer({ min: 0, max: 11 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 })),
  tick: fc.boolean(),
  p: fc.integer({ min: 1, max: 1_000_000 }),
});

/** The room the property starts from: a twin, its two tokens placed, the second player a sight holder too on a per-player scene. */
function start(r: Room): RoomState {
  const pair = twins({ cover: "auto", explore: true, perPlayer: r.perPlayer });
  const state = r.door ? pair.door : pair.rock;
  state.tokens.a = { ...state.tokens.a!, x: r.a[0], y: r.a[1] };
  state.tokens.b = { ...state.tokens.b!, x: r.b[0], y: r.b[1] };
  if (r.perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  return state;
}

/** Reduces an uncounted op at two numbers and checks they agree, then goes on from the first. */
function same(state: RoomState, op: Op, p: number, touched: EntityKey[] = []): RoomState {
  const at = applyOp(state, op, SERVER, { ...env(p), uncounted: true });
  const later = applyOp(state, op, SERVER, { ...env(p + 7), at: env(p).at, uncounted: true });
  for (const r of [at, later]) assert.notEqual(r.ok ? null : r.message, UNCOUNTED_LINE, `${op.t}: the guard against lines never fires`);
  assert.ok(at.ok, `${op.t} at ${p}: ${at.ok ? "" : at.message}`);
  assert.ok(later.ok, `${op.t} at ${p + 7}: ${later.ok ? "" : later.message}`);
  assert.deepEqual(at.log, [], `${op.t} writes no line`);
  assert.deepEqual(later.state, at.state, `${op.t}: the room it leaves reads no number`);
  assert.deepEqual(later.touched, at.touched, `${op.t}: the keys it touches read no number`);
  touched.push(...at.touched);
  return at.state;
}

describe("uncounted ops read no number", () => {
  test("explore, the map step, its forgetting and the music's tick give the same room at any number", () => {
    const seen = { explore: 0, remember: 0, forget: 0, sound: 0 };
    holds(
      fc.property(rooms, (r) => {
        let state = start(r);
        const first = exploreOp(state, "s1");
        if (first) {
          state = same(state, first, r.p);
          seen.explore++;
        }
        // The DM paints over what the party explored, which the map step then writes into what they remember.
        const before = state;
        const [x, y, w, h] = r.paint;
        const cells = [];
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push(`${x + dx},${y + dy}`);
        const painted = applyOp(state, { t: "build.paint", sceneId: "s1", terrain: "stone", cells, forget: true } as OpOf<"build.paint">, DM, env(r.p + 1));
        assert.ok(painted.ok, painted.ok ? "" : painted.message);
        state = painted.state;
        const touched: EntityKey[] = [...painted.touched];
        const again = exploreOp(state, "s1");
        if (again) {
          state = same(state, again, r.p + 1, touched);
          seen.explore++;
        }
        for (const op of mapStepOps({ before, after: state, touched, cap: () => MEMORY_CAP })) {
          state = same(state, op, r.p + 1);
          seen.remember++;
        }
        const forget = forgetSceneOp(state, "s1");
        if (forget) {
          state = same(state, forget, r.p + 1);
          seen.forget++;
        }
        if (r.tick) {
          state = same(state, { t: "sys.sound", from: state.playing?.rev ?? 0, music: null, loops: {}, effects: [] }, r.p + 1);
          seen.sound++;
        }
      }),
      60,
    );
    assert.ok(seen.explore > 20 && seen.remember > 5 && seen.forget > 20 && seen.sound > 10, `each kind ran: ${JSON.stringify(seen)}`);
  });
});
