import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, actor, chance, effect, env, int, pick, rng, token } from "#shared/testutil.ts";
import { dragOf } from "../movement/dragTesting.ts";
import { world } from "../movement/testing.ts";
import { copyFor } from "./testing.ts";

/**
 * The planner's walks of attached tokens against the server (review
 * AT-ASTRA-13, the attach side of movement's drop tests): riders on a
 * holder that straddles a step, holders that drag a creature beside them
 * and riders that drag one, among walls and raised ground, under both
 * diagonal rules. Each drag is planned on the mover's own copy as the board
 * plans it, its route from findRoute (dragTesting.ts), and its op must pass
 * the server's check and apply, land where the picture showed it, and store
 * the cost the picture read.
 */

type Case = { state: RoomState; mover: string; who: Viewer };

function grappled(id: string, over: Partial<Token>): Token {
  return token(id, { name: id, size: "small", actor: { inline: actor({ effects: [effect(`g${id}`, { key: "grappled" })] }) }, ...over });
}

function randomCase(r: () => number): Case {
  const hx = int(r, 4, 12);
  const hy = int(r, 4, 12);
  const edges: Record<string, EdgeFeature> = {};
  const heights: Record<string, number> = {};
  // The step under the horse, its high half on one side, the ground beyond it raised as far as the scene goes.
  const high = chance(r, 0.5) ? hx + 1 : hx;
  const right = high === hx + 1;
  for (let y = 0; y < 30; y++) for (let x = right ? high : 0; x < (right ? 30 : high + 1); x++) heights[`${x},${y}`] = 10;
  // Raised cells and walls around it.
  for (let i = int(r, 0, 4); i > 0; i--) heights[`${int(r, hx - 4, hx + 5)},${int(r, hy - 4, hy + 5)}`] = pick(r, [5, 15]);
  for (let i = int(r, 0, 3); i > 0; i--) {
    const at = int(r, hx - 4, hx + 5);
    const from = int(r, hy - 4, hy + 2);
    for (let v = from; v < from + int(r, 1, 5); v++) edges[chance(r, 0.5) ? `${at},${v},w` : `${v},${at},n`] = { kind: "wall" };
  }
  const flies = chance(r, 0.15);
  const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: chance(r, 0.7) ? ["p1"] : [], x: hx, y: hy, elevation: flies ? 20 : 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
  // An independent ride: a drag of a controlled mount's rider moves the mount instead (Stage.tsx), so the board never walks her alone.
  const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: hx + int(r, 0, 1), y: hy + int(r, 0, 1), elevation: horse.elevation, actor: { inline: actor({ speeds: { walk: 30 } }) }, attached: { to: "horse", kind: "ride" } });
  const shape = r();
  const tokens: Token[] = [horse];
  let mover = "bree";
  if (shape < 0.5) tokens.push(bree);
  else if (shape < 0.75) {
    // The horse drags a goblin beside it, and is the one moved.
    tokens.push(grappled("goblin", { x: hx - 1, y: hy + int(r, 0, 1), attached: { to: "horse", kind: "drag" } }));
    horse.ownerIds = ["p1"];
    mover = "horse";
  } else {
    // Bree, on the horse, drags a kobold standing beside it.
    tokens.push(bree, grappled("kobold", { x: right ? hx - 1 : hx + 2, y: bree.y, attached: { to: "bree", kind: "drag" } }));
  }
  tokens.push(token("gob", { name: "Goblin", x: 25, y: 25 }));
  let state = world({ blockMovement: chance(r, 0.75), edges, heights, tokens });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen"] as const) };
  for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: mover, value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
    const out = applyOp(state, op, DM, env(i + 1));
    assert.ok(out.ok);
    state = out.state;
  }
  return { state, mover, who: chance(r, 0.8) ? P1 : DM };
}

describe("a drag of an attached token plans the walk the server takes and stores what the picture read (review AT-ASTRA-13)", () => {
  test("random riders, holders and draggers on straddling holders, steps and walls", () => {
    let moved = 0;
    let routed = 0;
    let off = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const c = randomCase(r);
      const mover = c.state.tokens[c.mover]!;
      const raw = { x: Math.max(0, Math.min(28, mover.x + int(r, -5, 5))), y: Math.max(0, Math.min(28, mover.y + int(r, -5, 5))) };
      const copy = c.who.role === "dm" ? c.state : copyFor(c.state, c.who);
      const drag = dragOf(copy, c.who.role, c.mover, raw);
      const where = `seed ${seed} (${c.who.memberId} drags ${c.mover} to ${raw.x},${raw.y}, ${drag.answer.kind})`;
      if (!drag.op) continue;
      const op = drag.op as Op;
      const allowed = canApply(op, c.who, c.state, { canUseAsset: () => true });
      assert.ok(allowed.ok, `${where}: ${allowed.ok ? "" : allowed.message} for ${JSON.stringify(op)}`);
      const applied = applyOp(c.state, op, c.who, env(10));
      assert.ok(applied.ok, `${where}: ${applied.ok ? "" : applied.message}`);
      const after = applied.state.tokens[c.mover]!;
      assert.deepEqual(drag.preview.to, { x: after.x, y: after.y }, `${where}: the picture showed another spot`);
      const before = mover.path?.stops.length ?? 1;
      const stored = (after.path?.stops ?? []).slice(before).reduce((sum, s) => sum + (s.cost ?? 0), 0);
      assert.equal(drag.preview.read.dragFt, stored, `${where}: the band read another cost than the one stored, ${JSON.stringify(op)}`);
      moved++;
      if (op.t === "token.move" && op.route) routed++;
      if (mover.attached && !after.attached) off++;
    }
    // A run that never walks off a mount or along a route tests nothing.
    assert.ok(moved > 200 && routed > 30 && off > 60, JSON.stringify({ moved, routed, off }));
  });
});
