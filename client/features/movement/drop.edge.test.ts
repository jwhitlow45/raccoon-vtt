import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import type { EdgeFeature, RoomState, Token } from "#shared/model.ts";
import { opSchema } from "#shared/protocol.ts";
import { standsInScene } from "#shared/rules/sceneEdge.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { DM, P1, int, pick, rng, room, scene, token } from "#shared/testutil.ts";
import { groupOffsetOnScene, heldShortOfCreature, keptOnScene, measuredLanding, moveOpsOf, pressedAim, planGroup, planOne, type DropPlan } from "./drop.ts";
import { groupDragOf } from "./dragTesting.ts";
import { teleportMove } from "./teleport.ts";
import { line, seenRoom, thorn, world } from "./testing.ts";

/**
 * A player's drop ends inside the scene, whatever the scene's walls stop
 * (DROP-OFF-MAP, D-261122-160): a plain drop far past the edge lands on its
 * nearest spot there, a group keeps its shape against the edge by one cut
 * back offset (D-261122-179), and what the device sends is what the server
 * takes. The DM's drops are left where they are aimed (D-261122-178).
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
  describe(`a player's drop, ${mode === "walk" ? "walls stopping moves" : "free"}`, () => {
    const state = square(mode === "walk", [pc("a"), pc("big", { size: "large", x: 10, y: 10 })]);
    const view = seenRoom(state, "player");
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

describe("the DM's drop", () => {
  test("is left where it is aimed, past the edge or not, so a DM can still park a token off the map (D-261122-178)", () => {
    for (const blocking of [false, true]) {
      const state = square(blocking, [pc("a"), pc("b", { x: 7, y: 5 })]);
      const view = seenRoom(state, "dm");
      assert.deepEqual(planOne(view, state.tokens.a!, { x: -10, y: -10 }, "free").moves, [{ tokenId: "a", x: -10, y: -10 }]);
      assert.deepEqual(planGroup(view, [state.tokens.a!, state.tokens.b!], -20, 0, "free").moves, [{ tokenId: "a", x: -15, y: 5 }, { tokenId: "b", x: -13, y: 5 }]);
      const board = groupDragOf(state, "dm", ["a", "b"], { x: -5, y: 5 });
      assert.deepEqual(board.plan.moves.find((m) => m.tokenId === "a"), { tokenId: "a", x: -5, y: 5 });
    }
  });
});

describe("where the ruler measures a drag to (R2-OPUS-2)", () => {
  test("a group lead that stood past the edge reads the spot planGroup pulls it to, and a lone drag its snapped spot pulled the same way", () => {
    const s = square(false, [pc("a", { x: -4, y: 5 }), pc("b", { x: 10, y: 5 })]);
    const view = seenRoom(s, "player");
    const board = { x: -2, y: 5 };
    assert.deepEqual(measuredLanding(view, s.tokens.a!, { x: 99, y: 99 }, board), { x: 0, y: 5 });
    assert.deepEqual(planGroup(view, [s.tokens.a!, s.tokens.b!], 2, 0, "free").moves.find((m) => m.tokenId === "a"), { tokenId: "a", x: 0, y: 5 });
    assert.deepEqual(measuredLanding(view, s.tokens.b!, { x: 5, y: -9 }, undefined), { x: 5, y: 0 });
    assert.deepEqual(measuredLanding(seenRoom(s, "dm"), s.tokens.b!, { x: 5, y: -9 }, undefined), { x: 5, y: -9 });
    assert.deepEqual(measuredLanding(undefined, s.tokens.b!, { x: 5, y: -9 }, undefined), { x: 5, y: -9 });
  });
});

describe("a parked token walked back in", () => {
  test("held outside by a wall on the edge line is no move, and the stop's note stays (DROPMAP-OPUS-1)", () => {
    const parked = pc("a", { x: -3, y: 5 });
    const state = world({ edges: line("w", 0, 0, 30), tokens: [parked] });
    const plan = planOne(seenRoom(state, "player"), parked, { x: 5, y: 5 }, "walk");
    assert.deepEqual(plan.moves, []);
    assert.ok(plan.stop, "the note says what stopped it");
    // The DM may be held there and moved, as before.
    assert.ok(planOne(seenRoom(state, "dm"), parked, { x: 5, y: 5 }, "free").moves.length === 1);
  });
});

describe("a parked token held short of a creature", () => {
  test("is held outside no more than walked there: no move is planned (DROPMAP-OPUS-1)", () => {
    const parked = pc("a", { x: -3, y: 5 });
    const state = world({ tokens: [parked], blockMovement: true });
    const view = seenRoom(state, "player");
    const plan: DropPlan = { moves: [{ tokenId: "a", x: 5, y: 5 }], stop: { tokenId: "a", sceneId: "s1", blocker: "wall", door: null, ghost: { x: 5, y: 5 }, aim: { x: 5, y: 5 }, at: { x: 5, y: 5 } }, held: [] };
    // A creature's space begins at x = -1, so the walk is held on -2, still past the edge.
    const held = heldShortOfCreature(view, parked, plan, { x: 5, y: 5 }, (at) => at.x >= -1);
    assert.deepEqual(held.moves, []);
    assert.ok(held.stop);
  });
});

describe("a drop on hexes", () => {
  test("row -10 on hex columns lands on the nearest hex of the scene", () => {
    const c = hexCenter(COLUMNS, { col: 6, row: -10 });
    const state = hexes([pc("a", { x: 3, y: 3 })]);
    const plan = planOne(seenRoom(state, "player"), state.tokens.a!, { x: c.x - 0.5, y: c.y - 0.5 }, "free");
    assert.equal(plan.moves.length, 1);
    allInside(state, plan, "hex columns");
    assert.ok(plan.moves[0]!.y < 2, "at the top of the scene, not far from where it was aimed");
  });

  test("a group dragged past an edge keeps its shape", () => {
    const on = (col: number, row: number) => ({ x: hexCenter(COLUMNS, { col, row }).x - 0.5, y: hexCenter(COLUMNS, { col, row }).y - 0.5 });
    const state = hexes([pc("a", on(3, 4)), pc("b", on(4, 4))]);
    const view = seenRoom(state, "player");
    const group = [state.tokens.a!, state.tokens.b!];
    const plan = planGroup(view, group, 0, -30, "free");
    allInside(state, plan, "hex group");
    assert.equal(plan.moves.length, 2);
    // Both slid up by the same cells, the way a shape does, and neither stands on the other.
    assert.equal(plan.moves[0]!.y - group[0]!.y, plan.moves[1]!.y - group[1]!.y);
    assert.equal(plan.moves[1]!.x - plan.moves[0]!.x, group[1]!.x - group[0]!.x);
  });
});

describe("a group's drop", () => {
  const state = square(false, [pc("a", { x: 10, y: 5 }), pc("b", { x: 11, y: 5 }), pc("c", { x: 10, y: 7 })]);
  const group = (s: RoomState) => ["a", "b", "c"].map((id) => s.tokens[id]!);
  const ends = (plan: DropPlan) => plan.moves.map((m) => [m.tokenId, m.x, m.y]);

  test("keeps its shape against the edge it is dragged into, and slides along it (D-261122-179)", () => {
    const view = seenRoom(state, "player");
    assert.deepEqual(ends(planGroup(view, group(state), 0, -9, "free")), [["a", 10, 0], ["b", 11, 0], ["c", 10, 2]]);
    assert.deepEqual(ends(planGroup(view, group(state), -40, -40, "free")), [["a", 0, 0], ["b", 1, 0], ["c", 0, 2]]);
    assert.deepEqual(ends(planGroup(view, group(state), 8, -40, "free")), [["a", 18, 0], ["b", 19, 0], ["c", 18, 2]]);
    assert.deepEqual(ends(planGroup(view, group(state), 40, 40, "free")), [["a", 28, 17], ["b", 29, 17], ["c", 28, 19]]);
  });

  test("a move that stays inside is the move asked for", () => {
    const plan = planGroup(seenRoom(state, "player"), group(state), 4, 3, "free");
    assert.deepEqual(ends(plan), [["a", 14, 8], ["b", 15, 8], ["c", 14, 10]]);
  });

  test("a squeezed member is held to the footprint a group move stores, full size", () => {
    const ogre = pc("o", { size: "large", x: -0.5, y: 7, squeeze: true });
    const s = square(false, [ogre, pc("p", { x: 6, y: 7 })]);
    const plan = planGroup(seenRoom(s, "player"), [s.tokens.o!, s.tokens.p!], 3, 0, "free");
    allInside(s, plan, "squeezed member");
  });

  test("a member squeezed against the east or south edge is pulled out of its squeeze alone, and the group still moves (R2-OPUS-1)", () => {
    for (const [name, at] of [["east", { x: 28.5, y: 7 }], ["south", { x: 12, y: 18.5 }]] as const) {
      const s = square(false, [pc("o", { size: "large", ...at, squeeze: true }), pc("p", { x: 15, y: 7 })]);
      const view = seenRoom(s, "player");
      const members = [s.tokens.o!, s.tokens.p!];
      for (const [dx, dy] of [[0, 3], [0, -3], [-5, 0], [4, 4]] as const) {
        const offset = groupOffsetOnScene(view, members, dx, dy);
        assert.notDeepEqual(offset, { dx: 0, dy: 0 }, `${name} ${dx},${dy}: the group is not frozen`);
        allInside(s, planGroup(view, members, dx, dy, "free"), `${name} ${dx},${dy}`);
      }
    }
  });

  test("a member that stood past the edge is pulled in on its own, and the rest keep their place", () => {
    const parked = square(false, [pc("a", { x: 10, y: 5 }), pc("far", { x: -4, y: 5 })]);
    const plan = planGroup(seenRoom(parked, "player"), [parked.tokens.a!, parked.tokens.far!], 3, 0, "free");
    assert.deepEqual(ends(plan), [["a", 13, 5], ["far", 0, 5]]);
  });

  test("the lead's frame and label read the spot the drop lands on", () => {
    const board = groupDragOf(state, "player", ["a", "b", "c"], { x: 10, y: -30 });
    assert.deepEqual(board.plan.moves.find((m) => m.tokenId === "a"), { tokenId: "a", x: 10, y: 0 });
    // From 10, 5 to 10, 0 is 25 ft, not the 175 ft of the spot under the finger.
    assert.equal(board.label.dragFt, 25);
    assert.equal(board.frame.ft, 25);
    // The member that sets the cut, and one that does not: each reads its own leg inside the group's offset.
    const slide = groupDragOf(state, "player", ["c", "a", "b"], { x: 10, y: -30 });
    assert.deepEqual(slide.plan.moves.find((m) => m.tokenId === "c"), { tokenId: "c", x: 10, y: 2 });
    assert.equal(slide.label.dragFt, 25);
  });
});

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

describe("a squeeze along the map's edge, from change format 66 (D-261126-226, 238)", () => {
  // A corridor one square wide along each of two sides, walled on its inner side alone: the scene's edge is its other wall.
  const corridors = [
    { side: "north", edges: line("n", 1, 10, 30), parked: { x: 7, y: -0.5 }, aim: { x: 13.3, y: -0.4 }, squeezed: { x: 13.5, y: -0.5 } },
    { side: "west", edges: line("w", 1, 10, 30), parked: { x: -0.5, y: 7 }, aim: { x: -0.4, y: 13.3 }, squeezed: { x: -0.5, y: 13.5 } },
  ] as const;

  for (const c of corridors) {
    test(`a Large creature dragged into the corridor along the ${c.side} side lands squeezed, and the server takes it`, () => {
      const ogre = thorn({ size: "large", ...c.parked });
      const state = world({ edges: c.edges, tokens: [ogre] });
      for (const mode of ["walk", "free"] as const) {
        const plan = planOne(seenRoom(state), ogre, c.aim, mode);
        assert.deepEqual(plan.moves, [{ tokenId: "thorn", ...c.squeezed, squeeze: true }], mode);
        for (const op of moveOpsOf(plan.moves)) assert.equal(canApply(opSchema.parse(op), P1, state, deps).ok, true, `${mode}: ${JSON.stringify(op)}`);
      }
    });

    test(`Teleport here from a walk the corridor's wall stopped, along the ${c.side} side, lands squeezed in it, and the server takes it`, () => {
      const ogre = thorn({ size: "large", x: 5, y: 5 });
      const state = world({ edges: c.edges, tokens: [ogre], blockMovement: true });
      const view = seenRoom(state);
      const plan = planOne(view, ogre, c.aim, "walk");
      assert.ok(plan.stop, "the walk is stopped short of the corridor");
      const op = { t: "token.move" as const, ...teleportMove(view, ogre, plan.stop) };
      assert.deepEqual({ x: op.x, y: op.y, squeeze: op.squeeze }, { ...c.squeezed, squeeze: true });
      assert.equal(canApply(opSchema.parse(op), P1, state, deps).ok, true);
    });
  }

  // A corridor one square wide that ends at the scene's edge (30 by 30), walled on both sides, the ogre parked in it.
  const ending = [
    { side: "east", edges: { ...line("n", 5, 10, 30), ...line("n", 6, 10, 30) }, parked: { x: 20, y: 4.5 }, last: { x: 28.5, y: 4.5 }, aims: [{ x: 28.6, y: 4.6 }, { x: 29.4, y: 4.6 }, { x: 31.3, y: 4.6 }, { x: 60, y: 4.6 }] },
    { side: "south", edges: { ...line("w", 5, 10, 30), ...line("w", 6, 10, 30) }, parked: { x: 4.5, y: 10 }, last: { x: 4.5, y: 28.5 }, aims: [{ x: 4.6, y: 28.6 }, { x: 4.6, y: 29.4 }, { x: 4.6, y: 31.3 }, { x: 4.6, y: 60 }] },
  ] as const;

  for (const c of ending) {
    test(`a Large creature dropped past the edge where a corridor ends on the ${c.side} lands where a drop on its last square does, and the server takes it`, () => {
      const ogre = thorn({ size: "large", ...c.parked });
      const state = world({ edges: c.edges, tokens: [ogre] });
      for (const mode of ["walk", "free"] as const) {
        for (const aim of c.aims) {
          const plan = planOne(seenRoom(state), ogre, aim, mode);
          assert.deepEqual(plan.moves, [{ tokenId: "thorn", ...c.last, squeeze: true }], `${mode} ${JSON.stringify(aim)}`);
          for (const op of moveOpsOf(plan.moves)) assert.equal(canApply(opSchema.parse(op), P1, state, deps).ok, true, `${mode}: ${JSON.stringify(op)}`);
        }
      }
    });
  }

  test("beside the side in the open a drop never squeezes, so the box is kept on the scene full size", () => {
    const ogre = thorn({ size: "large", x: 7, y: 3 });
    const state = world({ tokens: [ogre] });
    const plan = planOne(seenRoom(state), ogre, { x: 13.3, y: -0.4 }, "free");
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 13, y: 0 }]);
  });
});

describe("what the device sends the server takes", () => {
  /** Random edge walls: runs inside the scene and on its edge lines, which is where a held spot can fall outside (DROPMAP-OPUS-1). */
  function randomEdges(r: () => number, w: number, h: number): Record<string, EdgeFeature> {
    const edges: Record<string, EdgeFeature> = {};
    const lines = int(r, 0, 5);
    for (let k = 0; k < lines; k++) {
      const vertical = r() < 0.5;
      const at = pick(r, vertical ? [0, 1, 6, w - 1, w] : [0, 1, 5, h - 1, h]);
      const from = int(r, 0, 8);
      const to = from + int(r, 3, 12);
      for (let v = from; v < to; v++) edges[vertical ? `${at},${v},w` : `${v},${at},n`] = { kind: "wall" };
    }
    return edges;
  }

  test("over random scenes with walls, sizes, parked tokens, riders, aims and group drags, every move a drop plans ends inside and is one canApply takes", () => {
    const r = rng(0xd0a9);
    let moves = 0;
    for (let i = 0; i < 600; i++) {
      const hex = r() < 0.4;
      const sizes = ["tiny", "small", "medium", "large", "huge"] as const;
      const tokens = Array.from({ length: int(r, 1, 4) }, (_, k) => pc(`t${k}`, { size: pick(r, sizes), x: r() < 0.25 ? int(r, -4, 0) : int(r, 2, 14), y: r() < 0.25 ? int(r, -4, 0) : int(r, 0, 10) }));
      // A Large mount of the player's with a rider sitting on it.
      const mount = pc("mount", { size: "large", x: int(r, 0, 8), y: int(r, 0, 6) });
      const rider = pc("rider", { x: mount.x + 1, y: mount.y, attached: { to: "mount", kind: "ride" } });
      const all = hex ? tokens : [...tokens, mount, rider];
      const mode = r() < 0.5 ? "walk" : "free";
      const base = hex ? hexes(all) : world({ edges: randomEdges(r, 30, 30), tokens: all, blockMovement: mode === "walk" });
      const state: RoomState = hex ? { ...base, scenes: { s1: { ...base.scenes.s1!, blockMovement: mode === "walk" } } } : base;
      // Tokens of a hex room stand on a hex's anchor, so they are placed by the rule that places them.
      if (hex) for (const t of tokens) Object.assign(state.tokens[t.id]!, { ...keptOnScene(seenRoom(state, "player"), t, { x: t.x, y: t.y }) });
      const view = seenRoom(state, "player");
      const bounds = state.scenes.s1!.bounds;
      const aim = { x: r() * (bounds.w + 40) - 20, y: r() * (bounds.h + 40) - 20 };
      const lead = state.tokens.t0!;
      const plans = [planOne(view, lead, aim, mode)];
      if (tokens.length > 1) plans.push(planGroup(view, tokens.map((t) => state.tokens[t.id]!), aim.x - lead.x, aim.y - lead.y, mode));
      if (!hex) plans.push(planOne(view, state.tokens.mount!, pressedAim(view, state.tokens.mount!, state.tokens.rider!, aim), mode));
      for (const plan of plans) {
        for (const m of plan.moves) {
          const t = state.tokens[m.tokenId]!;
          const sc = state.scenes.s1!;
          const stays = m.x === t.x && m.y === t.y;
          assert.ok(stays || standsInScene(sceneGrid(sc), sc.bounds, { ...t, x: m.x, y: m.y, ...(m.squeeze ? { squeeze: true as const } : {}) }), `run ${i}: ${m.tokenId} on ${m.x},${m.y}`);
        }
        for (const op of moveOpsOf(plan.moves)) {
          moves++;
          const d = canApply(opSchema.parse(op), P1, state, deps);
          // A wall or a squeeze may stop a move, but never the edge rule.
          assert.ok(d.ok || !d.message.includes("inside the map"), `run ${i}: ${JSON.stringify(op)} ${d.ok ? "" : d.message}`);
        }
      }
    }
    assert.ok(moves > 300, `${moves} moves planned`);
  });
});
