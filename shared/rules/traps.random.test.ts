import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState, Token, Trap, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, chance, env, int, pick, rng, room, token } from "../testutil.ts";
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
 * caught a walker in.
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
  if (n < 0.45) return { who, op: { t: "token.move", tokenId: id, x, y } };
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

test("planMove equals describeMove on random group moves across traps, for the op the reducer moved", () => {
  let applied = 0;
  let rewritten = 0;
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
        assert.ok(planned.springings.some((s) => s.stopped), `seed ${seed} step ${n}: ${op.t} rewritten with no stop`);
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
  assert.ok(rewritten > 50, `${rewritten} stopped`);
});
