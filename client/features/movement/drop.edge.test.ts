import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { opSchema } from "#shared/protocol.ts";
import { standsInScene } from "#shared/rules/sceneEdge.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { DM, P1, int, pick, rng, room, scene, token } from "#shared/testutil.ts";
import { keptOnScene, moveOpsOf, planGroup, planOne, type DropPlan } from "./drop.ts";
import { groupDragOf } from "./dragTesting.ts";
import { line, seenRoom, thorn, world } from "./testing.ts";

/**
 * A drop ends inside the scene, whoever drops it and whatever the scene's
 * walls stop (DROP-OFF-MAP, D-261122-160): a plain drop far past the edge
 * lands on its nearest spot there, a group keeps its shape against the
 * edge, and what the device sends is what the server takes.
 */

const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const deps = { canUseAsset: () => true };

function square(blockMovement: boolean, tokens: Token[] = []): RoomState {
  return room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement }) }, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
}

function hexes(tokens: Token[] = []): RoomState {
  return room({ scenes: { s1: scene("s1", { gridShape: "hexColumns", bounds: { w: 20, h: 14 } }) }, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
}

const pc = (id: string, over: Partial<Token> = {}): Token => token(id, { kind: "pc", name: id, ownerIds: ["p1"], x: 5, y: 5, ...over });

/** The spot every move of the plan ends on stands on the scene. */
function allInside(state: RoomState, plan: DropPlan, where: string): void {
  const scene = state.scenes.s1!;
  for (const m of plan.moves) {
    const t = state.tokens[m.tokenId]!;
    assert.equal(standsInScene(sceneGrid(scene), scene.bounds, { ...t, x: m.x, y: m.y, ...(m.squeeze ? { squeeze: true as const } : {}) }), true, `${where}: ${m.tokenId} on ${m.x},${m.y}`);
  }
}

for (const mode of ["free", "walk"] as const) {
  for (const role of ["player", "dm"] as const) {
    describe(`a ${role}'s drop, ${mode === "walk" ? "walls stopping moves" : "free"}`, () => {
      const state = square(mode === "walk", [pc("a"), pc("big", { size: "large", x: 10, y: 10 })]);
      const view = seenRoom(state, role);
      const aim = (x: number, y: number) => ({ x, y });

      test("a drop past any edge lands on the nearest spot inside, each axis on its own", () => {
        const a = state.tokens.a!;
        assert.deepEqual(planOne(view, a, aim(-10, 5), mode).moves, [{ tokenId: "a", x: 0, y: 5 }]);
        assert.deepEqual(planOne(view, a, aim(9, -10), mode).moves, [{ tokenId: "a", x: 9, y: 0 }]);
        assert.deepEqual(planOne(view, a, aim(80, 5), mode).moves, [{ tokenId: "a", x: 29, y: 5 }]);
        assert.deepEqual(planOne(view, a, aim(9, 80), mode).moves, [{ tokenId: "a", x: 9, y: 19 }]);
        assert.deepEqual(planOne(view, a, aim(-5, -5), mode).moves, [{ tokenId: "a", x: 0, y: 0 }]);
      });

      test("a Large creature's whole box is held inside", () => {
        assert.deepEqual(planOne(view, state.tokens.big!, aim(80, 80), mode).moves, [{ tokenId: "big", x: 28, y: 18 }]);
      });

      test("a drop on the edge, and one that pulls back to where the token stands, are as they were", () => {
        const a = state.tokens.a!;
        assert.deepEqual(planOne(view, a, aim(29, 19), mode).moves, [{ tokenId: "a", x: 29, y: 19 }]);
        assert.deepEqual(planOne(view, { ...a, x: 0 }, aim(-4, 5), mode).moves, []);
      });
    });
  }
}

describe("a squeeze at the edge", () => {
  test("a Large creature squeezes into a corridor one column wide along the scene's west edge, standing half a cell past it with its squeezed box inside", () => {
    const ogre = thorn({ size: "large", x: -0.5, y: 7 });
    const state = world({ edges: { ...line("n", 10, 1, 30), ...line("w", 0, 10, 20), ...line("w", 1, 10, 20) }, tokens: [ogre] });
    for (const mode of ["walk", "free"] as const) {
      const plan = planOne(seenRoom(state), ogre, { x: -0.4, y: 13.3 }, mode);
      assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: -0.5, y: 13.5, squeeze: true }], mode);
    }
    const op = opSchema.parse({ t: "token.move", tokenId: "thorn", x: -0.5, y: 13.5, squeeze: true });
    assert.equal(canApply(op, P1, state, deps).ok, true);
  });
});

describe("a drop on hexes", () => {
  test("row -10 on hex columns lands on the nearest hex of the scene", () => {
    const c = hexCenter(COLUMNS, { col: 6, row: -10 });
    const state = hexes([pc("a", { x: 3, y: 3 })]);
    const plan = planOne(seenRoom(state), state.tokens.a!, { x: c.x - 0.5, y: c.y - 0.5 }, "free");
    assert.equal(plan.moves.length, 1);
    allInside(state, plan, "hex columns");
    assert.ok(plan.moves[0]!.y < 2, "at the top of the scene, not far from where it was aimed");
  });
});

describe("a group's drop", () => {
  const state = square(false, [pc("a", { x: 10, y: 5 }), pc("b", { x: 11, y: 5 }), pc("c", { x: 10, y: 7 })]);
  const group = (s: RoomState) => ["a", "b", "c"].map((id) => s.tokens[id]!);

  test("each token that would end past an edge stands along it, the rest where the move puts them", () => {
    const north = planGroup(seenRoom(state), group(state), 0, -9, "free");
    assert.deepEqual(north.moves.map((m) => [m.tokenId, m.x, m.y]), [["a", 10, 0], ["b", 11, 0], ["c", 10, 0]]);
    const corner = planGroup(seenRoom(state), group(state), -40, -40, "free");
    assert.deepEqual(corner.moves.map((m) => [m.tokenId, m.x, m.y]), [["a", 0, 0], ["b", 0, 0], ["c", 0, 0]]);
    const some = planGroup(seenRoom(state), group(state), 0, -6, "free");
    assert.deepEqual(some.moves.map((m) => [m.tokenId, m.x, m.y]), [["a", 10, 0], ["b", 11, 0], ["c", 10, 1]]);
  });

  test("a move that stays inside is the move asked for", () => {
    const plan = planGroup(seenRoom(state), group(state), 4, 3, "free");
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y]), [["a", 14, 8], ["b", 15, 8], ["c", 14, 10]]);
  });

  test("the lead's frame and label read the spot the drop lands on", () => {
    const board = groupDragOf(state, "player", ["a", "b", "c"], { x: 10, y: -30 });
    assert.deepEqual(board.plan.moves.find((m) => m.tokenId === "a"), { tokenId: "a", x: 10, y: 0 });
    // From 10, 5 to 10, 0 is 25 ft, not the 175 ft of the spot under the finger.
    assert.equal(board.label.dragFt, 25);
    assert.equal(board.frame.ft, 25);
  });
});

describe("what the device sends the server takes", () => {
  test("over random scenes, sizes, aims and group drags, every move a drop plans is one canApply takes, for a player and the DM", () => {
    const r = rng(0xd0a9);
    for (let i = 0; i < 400; i++) {
      const hex = r() < 0.4;
      const sizes = ["tiny", "small", "medium", "large", "huge"] as const;
      const tokens = Array.from({ length: int(r, 1, 4) }, (_, k) => pc(`t${k}`, { size: pick(r, sizes), x: int(r, 2, 14), y: int(r, 2, 10) }));
      const mode = r() < 0.5 ? "walk" : "free";
      const base = hex ? hexes(tokens) : square(mode === "walk", tokens);
      const state: RoomState = hex ? { ...base, scenes: { s1: { ...base.scenes.s1!, blockMovement: mode === "walk" } } } : base;
      // Tokens of a hex room stand on a hex's anchor, so they are placed by the rule that places them.
      if (hex) for (const t of tokens) Object.assign(state.tokens[t.id]!, { ...keptOnScene(state, t, { x: t.x, y: t.y }) });
      const view = seenRoom(state, "player");
      const aim = { x: r() * 70 - 25, y: r() * 60 - 25 };
      const lead = state.tokens.t0!;
      const plans = [planOne(view, lead, aim, mode)];
      if (tokens.length > 1) plans.push(planGroup(view, tokens.map((t) => state.tokens[t.id]!), aim.x - lead.x, aim.y - lead.y, mode));
      for (const plan of plans) {
        allInside(state, plan, `run ${i}`);
        for (const op of moveOpsOf(plan.moves)) {
          const d = canApply(opSchema.parse(op), P1, state, deps);
          // A wall or a squeeze may stop a move, but never the edge rule.
          assert.ok(d.ok || !d.message.includes("inside the map"), `run ${i}: ${JSON.stringify(op)} ${d.ok ? "" : d.message}`);
          assert.equal(canApply(opSchema.parse(op), DM, state, deps).ok, true);
        }
      }
    }
  });
});
