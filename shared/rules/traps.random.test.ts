import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState, Token, Trap, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, chance, env, int, pick, rng, room, token } from "../testutil.ts";
import { carriedGroup } from "./attach.ts";
import { footprintRect } from "./footprint.ts";
import { describeMove, planMove } from "./moveLeg.ts";
import { planTrapMove, type TrapRoom } from "./traps.ts";

/**
 * planMove equals describeMove on random group moves with traps on the way
 * (docs/design-v1-traps.md 11 and 13.1): riders, carried and perched tokens
 * and dragged creatures, seen or hidden, walking straight legs, two-piece
 * routes, teleports, landings and Get off across squares and wires that
 * stop creatures or not. For every op the reducer applies, the plan of the
 * op it moved (the stop step's rewrite, or the op itself) equals what the
 * reducer did, and the stop step rewrites only an op that a stopping trap
 * caught a walker in. A walker a stopping trap caught stepping onto it on a
 * leg along a row or a column stands on the trap where its group stops, at the first spot at or after
 * the trap went off where it may stand, its half steps too (review
 * LP13-TR-2). A pit that opens takes a lone walker that fits in it to the
 * bottom from its first square wholly over it, and leaves one that never
 * covers it whole at the rim (review FU20A-OP-2).
 */

const SEEDS = 400;
const STEPS = 12;

function world(r: () => number): RoomState {
  const state = room();
  const t = (id: string, over: Partial<Token>) => (state.tokens[id] = token(id, over));
  t("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 2, y: 6 });
  t("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: ["p1"], x: 2, y: 3 });
  t("gob", { name: "Goblin", size: "small", x: 4, y: 9, visibility: chance(r, 0.4) ? "dm" : "all" });
  t("imp", { name: "Imp", size: "tiny", x: 3, y: 9, visibility: chance(r, 0.5) ? "dm" : "all" });
  t("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p1"], x: 2.5, y: 6.5 });
  t("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 2.5, y: 7 });
  if (chance(r, 0.5)) state.tokens.thorn = { ...state.tokens.thorn!, x: 2, y: 3, attached: { to: "horse", kind: "ride", ...(chance(r, 0.5) ? { steer: true as const } : {}) } };
  if (chance(r, 0.4)) state.tokens.owl = { ...state.tokens.owl!, ...pos(state.tokens.thorn!), attached: { to: "thorn", kind: "perch" } };
  if (chance(r, 0.4)) state.tokens.torch = { ...state.tokens.torch!, ...pos(state.tokens.thorn!), attached: { to: "thorn", kind: "carry" } };
  if (chance(r, 0.4)) state.tokens.imp = { ...state.tokens.imp!, x: 3, y: 9, attached: { to: "gob", kind: "drag" } };
  if (chance(r, 0.3)) state.tokens.gob = { ...state.tokens.gob!, elevation: 10 };
  const traps: Record<string, Trap> = {};
  for (let i = 0; i < int(r, 1, 4); i++) {
    const id = `trap${i}`;
    const zone: Trap["zone"] = chance(r, 0.75)
      ? { cells: [{ x: int(r, 3, 10), y: int(r, 2, 10), w: int(r, 1, 3), h: int(r, 1, 3) }] }
      : { wire: { a: [int(r, 3, 10), int(r, 2, 10)], b: [int(r, 3, 10) + 0.5, int(r, 2, 10) + 1] } };
    const squares = "cells" in zone;
    traps[id] = {
      id,
      rev: 0,
      sceneId: "s1",
      name: id,
      zone,
      state: "armed",
      found: false,
      rig: { on: squares ? [pick(r, ["enter", "leave"] as const)] : [], who: "any", floor: chance(r, 0.6), resets: "never", stops: chance(r, 0.7), foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false },
    };
  }
  state.traps = traps;
  return state;
}

function pos(t: Token): { x: number; y: number } {
  return { x: t.x, y: t.y };
}

const near = (r: () => number, v: number, by = 6) => Math.max(0, Math.min(20, v + int(r, -by, by)));

function nextOp(r: () => number, state: RoomState): { op: Op; who: Viewer } {
  const ids = Object.keys(state.tokens);
  const id = pick(r, ids);
  const t = state.tokens[id]!;
  const who = t.ownerIds?.includes("p1") && chance(r, 0.6) ? P1 : DM;
  const x = near(r, t.x);
  const y = near(r, t.y);
  const n = r();
  // Now and then along its row or its column, where a walker a trap stops stands on it (review LP13-TR-2).
  if (n < 0.45) return { who, op: { t: "token.move", tokenId: id, ...(chance(r, 0.6) ? (chance(r, 0.5) ? { x, y: t.y } : { x: t.x, y }) : { x, y }) } };
  if (n < 0.6 && who.role === "dm") {
    // Two straight pieces through a corner, on whole cells.
    const cx = near(r, t.x, 3);
    const cy = near(r, t.y, 3);
    return { who, op: { t: "token.move", tokenId: id, x, y, route: [[cx, cy, 0, 0], [x, y, 0, 0]] } };
  }
  if (n < 0.7) return { who: DM, op: { t: "token.move", tokenId: id, x, y, teleport: "wall" } };
  if (n < 0.85) {
    const other = pick(r, ids.filter((o) => o !== id));
    const o = state.tokens[other]!;
    return { who: DM, op: { t: "token.moveMany", moves: [{ tokenId: id, x, y }, { tokenId: other, x: near(r, o.x), y: near(r, o.y) }] } };
  }
  if (n < 0.93) return { who: DM, op: { t: "token.update", tokenId: id, patch: { elevation: pick(r, [0, 0, 5, 10]) } } };
  return { who, op: { t: "token.detach", tokenId: id, x: t.x + 2, y: t.y } };
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a creature of the stopped move stands on the trap that stopped it,
 * where the move now lands it, by its offset from the named token. Asked
 * only of a leg along a row or a column, as a leg that crosses a trap's
 * corner on the slant may leave it between two spots it may stand at.
 */
function standsOnTrap(state: RoomState, op: Op, planned: Op, trap: Trap, by: readonly string[]): boolean | null {
  if (op.t !== "token.move" || planned.t !== "token.move" || op.route || !("cells" in trap.zone)) return null;
  const named = state.tokens[op.tokenId]!;
  if (op.x !== named.x && op.y !== named.y) return null;
  return by.some((id) => {
    const t = state.tokens[id]!;
    const r = footprintRect({ ...t, x: planned.x + t.x - named.x, y: planned.y + t.y - named.y, squeeze: undefined });
    return (trap.zone as { cells: { x: number; y: number; w: number; h: number }[] }).cells.some((c) => r.x < c.x + c.w && c.x < r.x + r.w && r.y < c.y + c.h && c.y < r.y + r.h);
  });
}

/**
 * Where a lone walker a pit stopped on a straight leg along a row or a
 * column should land (review FU20A-OP-2): at its first whole square of the
 * leg wholly over the opening when it has one ("fell"), else anywhere
 * partly off it ("rim"). Null for any other move.
 */
function pitLanding(state: RoomState, op: Op, trap: Trap): { fell: { x: number; y: number } | null } | null {
  const rig = trap.rig;
  if (op.t !== "token.move" || op.route || !rig?.pit || !("cells" in trap.zone) || trap.zone.cells.length !== 1) return null;
  const named = state.tokens[op.tokenId]!;
  if ((op.x !== named.x && op.y !== named.y) || named.x % 1 !== 0 || named.y % 1 !== 0 || named.elevation !== 0) return null;
  const c = trap.zone.cells[0]!;
  const dx = Math.sign(op.x - named.x);
  const dy = Math.sign(op.y - named.y);
  const steps = Math.abs(op.x - named.x) + Math.abs(op.y - named.y);
  for (let k = 1; k <= steps; k++) {
    const r = footprintRect({ ...named, x: named.x + k * dx, y: named.y + k * dy, squeeze: undefined });
    if (r.x >= c.x && r.y >= c.y && r.x + r.w <= c.x + c.w && r.y + r.h <= c.y + c.h) return { fell: { x: named.x + k * dx, y: named.y + k * dy } };
  }
  return { fell: null };
}

test("planMove equals describeMove on random group moves across traps, for the op the reducer moved", () => {
  let applied = 0;
  let rewritten = 0;
  let onTrap = 0;
  let halfSteps = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let state = world(r);
    for (let n = 0; n < STEPS; n++) {
      const { op, who } = nextOp(r, state);
      const res = applyOp(state, op, who, env(10 + n));
      if (!res.ok) continue;
      applied++;
      const planned = planTrapMove(op, state as TrapRoom, who, {});
      if (planned.op !== op) {
        rewritten++;
        assert.ok(planned.springings.some((s) => s.pass === "public" && s.trap.rig?.stops === true), `seed ${seed} step ${n}: ${op.t} rewritten with no stopping trap`);
        // The springing that stopped it: the first a walker of its group set off, the named token or a creature it drags.
        const walkers = op.t === "token.move" ? [op.tokenId, ...carriedGroup(state.tokens, op.tokenId).filter((id) => state.tokens[id]!.attached?.kind === "drag")] : [];
        const stopper = planned.springings.find((s) => s.pass === "public" && s.trap.rig?.stops === true && s.by.some((id) => walkers.includes(id)));
        const on = stopper?.how === "enter" ? standsOnTrap(state, op, planned.op, stopper.trap, stopper.by.filter((id) => walkers.includes(id))) : null;
        if (on !== null) {
          assert.ok(on, `seed ${seed} step ${n}: ${JSON.stringify(op)} stopped at ${JSON.stringify(planned.op)}, off ${stopper!.trap.id} ${JSON.stringify(stopper!.trap.zone)}`);
          onTrap++;
          if (planned.op.t === "token.move" && (planned.op.x % 1 !== 0 || stopper!.by.some((id) => state.tokens[id]!.size === "large") || carriedGroup(state.tokens, op.t === "token.move" ? op.tokenId : "").some((id) => state.tokens[id]!.size === "tiny"))) halfSteps++;
        }
      }
      const plan = planMove(planned.op, state, who, {});
      const described = describeMove(planned.op, state, res.state, who, {});
      assert.ok(isDeepEqual(described, plan.filter((m) => res.state.tokens[m.tokenId])), `seed ${seed} step ${n}: ${JSON.stringify(planned.op)}\nplan ${JSON.stringify(plan)}\ndescribed ${JSON.stringify(described)}`);
      state = res.state;
      // Traps arm again now and then, so later steps meet them.
      if (chance(r, 0.3)) state = { ...state, traps: Object.fromEntries(Object.entries(state.traps).map(([id, t]) => [id, { ...t, state: "armed" as const }])) };
    }
  }
  assert.ok(applied > SEEDS * 4, `${applied} ops applied`);
  assert.ok(rewritten > 50 && onTrap > 10 && halfSteps > 8, JSON.stringify({ rewritten, onTrap, halfSteps }));
});

test("a pit that opens takes a walker that fits in it down from its first square wholly over it, and leaves one that never covers it whole at the rim (review FU20A-OP-2)", () => {
  let fell = 0;
  let rim = 0;
  let riders = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const state = room();
    const size = pick(r, ["tiny", "medium", "large", "huge"] as const);
    const w = int(r, 1, 3);
    const h = int(r, 1, 3);
    const c = { x: int(r, 6, 9), y: int(r, 6, 9), w, h };
    state.traps.pit = { id: "pit", rev: 0, sceneId: "s1", name: "Pit", zone: { cells: [c] }, state: "armed", found: false, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, pit: { floor: -10 } } };
    // Along a row or a column across the pit, from a whole square before it to one past it.
    const across = chance(r, 0.5);
    const at = across ? { x: 1, y: c.y + int(r, -1, h - 1) } : { x: c.x + int(r, -1, w - 1), y: 1 };
    state.tokens.mover = token("mover", { name: "Mover", size, x: at.x, y: at.y });
    const rides = (size === "large" || size === "huge") && chance(r, 0.7);
    if (rides) state.tokens.bree = token("bree", { name: "Bree", kind: "pc", x: at.x + 1, y: at.y, attached: { to: "mover", kind: "ride" } });
    const op: Op = { t: "token.move", tokenId: "mover", ...(across ? { x: 15, y: at.y } : { x: at.x, y: 15 }) };
    const expected = pitLanding(state, op, state.traps.pit);
    const res = applyOp(state, op, DM, env(10));
    assert.ok(res.ok && expected);
    const after = res.state.tokens.mover!;
    const where = `seed ${seed}: a ${size} from ${at.x},${at.y} across ${JSON.stringify(c)}, at ${after.x},${after.y} ${after.elevation} ft`;
    // Only a walker that met the opening is stopped by it.
    if (after.x === 15 || after.y === 15) continue;
    if (expected.fell) {
      assert.deepEqual([after.x, after.y, after.elevation], [expected.fell.x, expected.fell.y, -10], where);
      fell++;
      if (rides) {
        assert.equal(res.state.tokens.bree!.elevation, -10, `${where}: the rider falls with it`);
        riders++;
      }
    } else {
      assert.equal(after.elevation, 0, `${where}: at the rim`);
      rim++;
    }
  }
  assert.ok(fell > 140 && rim > 180 && riders > 14, JSON.stringify({ fell, rim, riders }));
});
