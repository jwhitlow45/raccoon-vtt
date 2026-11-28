import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { RoomState, Token } from "../model.ts";
import { MAX_PATH_STOPS, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, env, room, token } from "../testutil.ts";
import { pathThisTurn } from "./path.ts";
import { reconcileLegs, type LegRecord } from "./opportunity.ts";

/**
 * Occurrence ids through the real reducer (docs/design/design-v1-opportunity-attacks.md
 * 4 and 9, build note DOA-OPUS-R4-01): random moves, routes with corners,
 * undos, resizes, squeezes, climbs, "Doesn't count" and moves the path did
 * not see, past 50 stops and 100 corners, each path update reconciled
 * against the last. Invariants:
 *
 * - KEEP: a leg not undone keeps its id through every rewrite.
 * - NEW-ONLY-MOVES: only an appended leg gets a new id, at the path's end.
 * - UNDO-REMOVES: an Undo gives back exactly the records before the step it
 *   undoes, a join it reverses split into its parts.
 * - PARTS: a join holds exactly the two records it joined, end to end.
 */

type Step =
  | { kind: "move"; x: number; y: number }
  | { kind: "route"; x: number; y: number; bends: number }
  | { kind: "resize"; size: Token["size"] }
  | { kind: "squeeze"; x: number; y: number }
  | { kind: "climb"; elevation: number }
  | { kind: "count"; counts: boolean }
  | { kind: "unseen"; x: number; y: number }
  | { kind: "undo" };

const spot = fc.integer({ min: 2, max: 30 });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 12, arbitrary: fc.record({ kind: fc.constant("move" as const), x: spot, y: spot }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("route" as const), x: spot, y: spot, bends: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("resize" as const), size: fc.constantFrom<Token["size"]>("medium", "large", "huge") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("squeeze" as const), x: spot, y: spot }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("climb" as const), elevation: fc.constantFrom(0, 5, 10) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("count" as const), counts: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unseen" as const), x: spot, y: spot }) },
  { weight: 3, arbitrary: fc.constant({ kind: "undo" as const }) },
);

/** The route of a walk with bends: a corner every few squares on the way to (x, y). */
function routeTo(from: { x: number; y: number }, x: number, y: number, bends: number): [number, number, number, 0 | 1][] {
  const out: [number, number, number, 0 | 1][] = [];
  for (let i = 1; i <= bends; i++) {
    const t = i / (bends + 1);
    out.push([Math.round(from.x + (x - from.x) * t), Math.round(from.y + (y - from.y) * t) + (i % 2 === 0 ? 1 : -1), 0, 0]);
  }
  out.push([x, y, 0, 0]);
  return out;
}

function leafIds(records: readonly LegRecord[]): number[] {
  return records.flatMap((r) => (r.parts ? leafIds(r.parts) : [r.id]));
}

function checkParts(records: readonly LegRecord[]): void {
  for (const r of records) {
    if (!r.parts) continue;
    assert.equal(r.parts.length, 2, "PARTS: two records");
    const [a, b] = r.parts as [LegRecord, LegRecord];
    assert.deepEqual([r.from, a.to, r.to], [a.from, b.from, b.to], "PARTS: end to end");
    checkParts(r.parts);
  }
}

type Run = { state: RoomState; records: LegRecord[]; undo: { before: Token; leaves: number[] }[]; joins: number; corners: number; stops: number; doubleJoins: number };

function legsNow(state: RoomState) {
  const path = pathThisTurn(state.encounter, state.tokens.wolf!);
  const stops = path?.stops ?? [];
  return stops.slice(1).map((to, i) => ({ from: stops[i]!, to }));
}

function play(steps: readonly Step[]): Run {
  let seq = 0;
  let state = room({ tokens: { wolf: token("wolf", { name: "Wolf", x: 5, y: 5 }), gob: token("gob", { x: 40, y: 40 }) } });
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 60, h: 60 } };
  const apply = (op: Op): boolean => {
    seq++;
    const result = applyOp(state, op, DM, env(seq));
    if (!result.ok) return false;
    state = result.state;
    return true;
  };
  assert.ok(apply({ t: "encounter.start", entries: [{ id: "n1", tokenId: "wolf", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] }));
  assert.ok(apply({ t: "encounter.next" }));
  let ids = 0;
  const newId = () => ++ids;
  const run: Run = { state, records: [], undo: [], joins: 0, corners: 0, stops: 0, doubleJoins: 0 };
  for (const s of steps) {
    const before = state.tokens.wolf!;
    const leavesBefore = leafIds(run.records);
    let op: Op | null = null;
    if (s.kind === "undo") {
      const last = run.undo.pop();
      if (!last) continue;
      op = { t: "sys.restore", entries: [{ key: "token:wolf", value: last.before }], from: "undo", deps: true } as Op;
      if (!apply(op)) continue;
      const r = reconcileLegs(run.records, legsNow(state), newId);
      assert.deepEqual(leafIds(r.legs), last.leaves, "UNDO-REMOVES: the records before the undone step, joins split");
      assert.deepEqual(r.added, [], "NEW-ONLY-MOVES: an undo adds no occurrence");
      checkParts(r.legs);
      run.records = r.legs;
      continue;
    }
    if (s.kind === "unseen") {
      // A move the path did not see, so the next move appends a gap stop before its own.
      state = { ...state, tokens: { ...state.tokens, wolf: { ...before, x: s.x, y: s.y } } };
      continue;
    }
    if (s.kind === "move") op = { t: "token.move", tokenId: "wolf", x: s.x, y: s.y };
    if (s.kind === "route") op = { t: "token.move", tokenId: "wolf", x: s.x, y: s.y, route: routeTo(before, s.x, s.y, s.bends) };
    if (s.kind === "squeeze") op = { t: "token.move", tokenId: "wolf", x: s.x, y: s.y, squeeze: true };
    if (s.kind === "resize") op = { t: "token.update", tokenId: "wolf", patch: { size: s.size } };
    if (s.kind === "climb") op = { t: "token.update", tokenId: "wolf", patch: { elevation: s.elevation } };
    if (s.kind === "count") op = { t: "token.countLeg", tokenId: "wolf", counts: s.counts };
    if (!op || !apply(op)) continue;
    const legs = legsNow(state);
    const r = reconcileLegs(run.records, legs, newId);
    const after = leafIds(r.legs);
    for (const id of leavesBefore) assert.ok(after.includes(id), `KEEP: leg ${id} kept through ${s.kind}`);
    assert.deepEqual(r.removed, [], `KEEP: nothing removed by ${s.kind}`);
    const tail = r.legs.slice(r.legs.length - r.added.length);
    assert.deepEqual(tail, r.added, "NEW-ONLY-MOVES: new occurrences only at the end");
    if (s.kind === "count") assert.deepEqual(r.added, [], "NEW-ONLY-MOVES: a mark changed is no new leg");
    checkParts(r.legs);
    const joinsNow = r.legs.filter((l) => l.parts).length;
    if (r.legs.some((l, i) => l.parts && !run.records.includes(l) && l.parts.some((p) => p.parts && !run.records.includes(p)))) run.doubleJoins++;
    run.joins = Math.max(run.joins, joinsNow);
    run.stops = Math.max(run.stops, legs.length + 1);
    run.corners = Math.max(run.corners, legs.reduce((n, l) => n + (l.to.via?.length ?? 0) / 2, 0));
    run.undo.push({ before, leaves: leavesBefore });
    run.records = r.legs;
  }
  run.state = state;
  return run;
}

describe("occurrence ids through the reducer's rewrites", () => {
  test("KEEP, NEW-ONLY-MOVES, UNDO-REMOVES and PARTS over random turns", () => {
    let full = 0;
    let cornered = 0;
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 40, maxLength: 160 }), (steps) => {
        const run = play(steps);
        if (run.stops >= MAX_PATH_STOPS) full++;
        if (run.corners >= 90) cornered++;
      }),
      { numRuns: 80 },
    );
    assert.ok(full > 0, "some turns filled the path, so withStop joined legs");
    assert.ok(cornered > 0, "and some held close to 100 corners");
  });

  test("a gap stop and a move in one update, two joins in one update, and a join across a resize", () => {
    const moves: Step[] = [];
    for (let i = 0; i < MAX_PATH_STOPS + 2; i++) moves.push({ kind: "move", x: 5 + (i % 2), y: 5 + (i % 20) });
    // Full: an unseen move then a move appends two stops, which joins twice.
    const twice = play([...moves, { kind: "unseen", x: 20, y: 20 }, { kind: "move", x: 22, y: 22 }, { kind: "undo" }]);
    assert.ok(twice.doubleJoins > 0 || twice.joins >= 2, "two joins in one update");
    // Resizes all along leave no pair at one size, so the oldest pair joins anyway.
    const sized: Step[] = [];
    for (let i = 0; i < MAX_PATH_STOPS + 4; i++) sized.push(i % 2 === 0 ? { kind: "move", x: 5 + (i % 3), y: 5 + (i % 17) } : { kind: "resize", size: i % 4 === 1 ? "large" : "medium" });
    const resized = play([...sized, { kind: "undo" }, { kind: "undo" }]);
    assert.ok(resized.joins > 0, "a join across a resize");
    // A gap stop and a move short of full: two new legs at once.
    const gap = play([{ kind: "move", x: 8, y: 8 }, { kind: "unseen", x: 12, y: 8 }, { kind: "move", x: 14, y: 10 }, { kind: "undo" }]);
    assert.equal(leafIds(gap.records).length, 1);
  });
});
