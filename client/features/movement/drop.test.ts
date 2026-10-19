import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { MAX_MOVES } from "#shared/protocol.ts";
import { findRoute, WalkWorld } from "#shared/rules/walk.ts";
import { publicWorld } from "#shared/rules/walkWorld.ts";
import { P1, token } from "#shared/testutil.ts";
import { dropMode, heldText, holdLabel, keyStep, landedElevation, moveOpsOf, planGroup, planOne, planWalk, routeTarget, stopText, type Found } from "./drop.ts";
import { CLOSED, line, raised, thorn, world } from "./testing.ts";

/** A room cut in two by a wall along x = 6, with a closed door at (6, 5) when asked. */
function divided(door = false, blockMovement = true) {
  const edges = line("w", 6, 0, 30);
  if (door) edges["6,5,w"] = CLOSED;
  return world({ edges, blockMovement });
}

/**
 * A room above y = 10 whose south wall leaves one cell open at x = 10, and
 * a 5 ft corridor running south from it between x = 10 and x = 11.
 */
function corridor() {
  return world({ edges: { ...line("n", 10, 0, 10), ...line("n", 10, 11, 30), ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
}

describe("how a drop is judged", () => {
  test("only a player's drop on a scene whose walls stop moves is walked", () => {
    assert.equal(dropMode("player", { blockMovement: true }), "walk");
    assert.equal(dropMode("player", { blockMovement: false }), "free");
    assert.equal(dropMode("player", {}), "free");
    assert.equal(dropMode("dm", { blockMovement: true }), "free");
    assert.equal(dropMode("player", undefined), "free");
  });
});

describe("a lone token's drop", () => {
  test("a walk into a wall stops on the last clear spot, the ghost where it was dropped", () => {
    const state = divided();
    const plan = planOne(state, thorn({ x: 2, y: 5 }), { x: 9.2, y: 4.9 }, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.deepEqual(plan.stop, { tokenId: "thorn", sceneId: "s1", blocker: "wall", door: null, ghost: { x: 9, y: 5 }, aim: { x: 9.2, y: 4.9 }, at: { x: 5, y: 5 } });
    assert.equal(stopText(plan.stop!), "Stopped at a wall. Drop at the corner first, then go on.");
  });

  test("a closed door names itself, so the note says to tap it", () => {
    const plan = planOne(divided(true), thorn({ x: 2, y: 5 }), { x: 9, y: 5 }, "walk");
    assert.deepEqual(plan.stop?.door, { edge: "6,5,w" });
    assert.equal(stopText(plan.stop!), "A door is in the way. Tap it to open.");
  });

  test("a walk stopped at its first step moves nothing and still says why", () => {
    const plan = planOne(divided(), thorn({ x: 5, y: 5 }), { x: 8, y: 5 }, "walk");
    assert.deepEqual(plan.moves, []);
    assert.deepEqual(plan.stop?.at, { x: 5, y: 5 });
    assert.deepEqual(plan.stop?.ghost, { x: 8, y: 5 });
  });

  test("the DM's drop and a scene that stops nothing pass the wall", () => {
    const plan = planOne(divided(), thorn({ x: 2, y: 5 }), { x: 9, y: 5 }, "free");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] });
  });

  test("a clear walk lands where it was dropped, snapped", () => {
    const plan = planOne(divided(), thorn({ x: 2, y: 5 }), { x: 4.4, y: 1.6 }, "walk");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 4, y: 2 }], stop: null, held: [] });
  });

  test("a drop where it stood moves nothing", () => {
    assert.deepEqual(planOne(divided(), thorn({ x: 2, y: 5 }), { x: 2.3, y: 4.8 }, "walk"), { moves: [], stop: null, held: [] });
  });

  test("a Large creature dropped into a 5 ft corridor lands squeezed half a cell off the grid", () => {
    const state = corridor();
    const ogre = thorn({ size: "large", x: 9, y: 6 });
    // Under the finger, the squeezed spot puts its 5 ft footprint on the corridor's cells.
    const plan = planOne(state, ogre, { x: 9.2, y: 13.3 }, "walk");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 9.5, y: 13.5, squeeze: true }], stop: null, held: [] });
    // The DM's drop lines it up the same way.
    assert.deepEqual(planOne(state, ogre, { x: 9.2, y: 13.3 }, "free").moves, [{ tokenId: "thorn", x: 9.5, y: 13.5, squeeze: true }]);
  });

  test("a drop beside a corridor is lined up with it by the rule's half-cell shifts", () => {
    // The finger is over the corridor's west wall, where no squeezed spot fits, so the snapped drop shifts (section 4.1).
    const plan = planOne(corridor(), thorn({ size: "large", x: 9, y: 6 }), { x: 8.6, y: 13.2 }, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 9.5, y: 12.5, squeeze: true }]);
  });

  test("a drop against a corridor's outside wall stands full size on the grid, never squeezed", () => {
    // Open ground west of the corridor: one wall beside the creature is no narrow space (section 4.1, check 3).
    const ogre = thorn({ size: "large", x: 4, y: 14 });
    for (const mode of ["walk", "free"] as const) {
      assert.deepEqual(planOne(corridor(), ogre, { x: 8.2, y: 14.3 }, mode).moves, [{ tokenId: "thorn", x: 8, y: 14 }], mode);
    }
  });

  test("a squeezed creature moves along its corridor by the cell it is dropped on, and a nudge leaves it be", () => {
    const squeezed = thorn({ size: "large", x: 9.5, y: 12.5, squeeze: true });
    assert.deepEqual(planOne(corridor(), squeezed, { x: 9.6, y: 12.4 }, "walk").moves, []);
    assert.deepEqual(planOne(corridor(), squeezed, { x: 9.1, y: 15.9 }, "walk").moves, [{ tokenId: "thorn", x: 9.5, y: 15.5, squeeze: true }]);
  });

  test("a squeezed creature walked out into the open stands full size on the grid", () => {
    const squeezed = thorn({ size: "large", x: 9.5, y: 18.5, squeeze: true });
    assert.deepEqual(planOne(corridor(), squeezed, { x: 9.2, y: 22.1 }, "walk").moves, [{ tokenId: "thorn", x: 9, y: 22 }]);
  });

  test("a walker is stopped at a ledge, and a flier above it passes", () => {
    const state = world({ heights: raised(6, 0, 30, 30, 10) });
    const walk = planOne(state, thorn({ x: 2, y: 5 }), { x: 8, y: 5 }, "walk");
    assert.equal(walk.stop?.blocker, "ledge");
    assert.deepEqual(walk.stop?.at, { x: 5, y: 5 });
    assert.equal(stopText(walk.stop!), "Ledge in the way. Take the stairs.");
    const fly = planOne(state, thorn({ x: 2, y: 5, elevation: 30 }), { x: 8, y: 5 }, "walk");
    assert.deepEqual(fly, { moves: [{ tokenId: "thorn", x: 8, y: 5 }], stop: null, held: [] });
  });

  test("a landing on raised ground writes the ground into the move", () => {
    const state = world({ heights: raised(6, 0, 30, 30, 10), blockMovement: false });
    assert.deepEqual(planOne(state, thorn({ x: 2, y: 5 }), { x: 8, y: 5 }, "free").moves, [{ tokenId: "thorn", x: 8, y: 5, elevation: 10 }]);
    assert.deepEqual(planOne(state, thorn({ x: 8, y: 5, elevation: 10 }), { x: 2, y: 5 }, "free").moves, [{ tokenId: "thorn", x: 2, y: 5, elevation: 0 }]);
  });
});

describe("landings write the ground (section 4.2)", () => {
  const state = world({ heights: raised(6, 0, 30, 30, 10) });
  const chunks = state.buildChunks;
  test("a token on the ground takes the ground where it lands", () => {
    assert.equal(landedElevation(chunks, thorn({ x: 2, y: 5 }), { x: 8, y: 5 }), 10);
    assert.equal(landedElevation(chunks, thorn({ x: 8, y: 5, elevation: 10 }), { x: 2, y: 5 }), 0);
  });
  test("a flier keeps its height, or rises to the ground there", () => {
    assert.equal(landedElevation(chunks, thorn({ x: 2, y: 5, elevation: 30 }), { x: 8, y: 5 }), 30);
    assert.equal(landedElevation(chunks, thorn({ x: 2, y: 5, elevation: 5 }), { x: 8, y: 5 }), 10);
  });
  test("a token inside the ground keeps its elevation", () => {
    assert.equal(landedElevation(chunks, thorn({ x: 2, y: 5, elevation: -10 }), { x: 8, y: 5 }), -10);
  });
  test("a Large footprint stands on the highest ground under it", () => {
    assert.equal(landedElevation(chunks, thorn({ size: "large", x: 1, y: 5 }), { x: 5, y: 5 }), 10);
  });
});

describe("a group drag", () => {
  test("each token's own leg is tested, and only the allowed ones move", () => {
    const state = world({ edges: line("w", 6, 0, 7) });
    const a = thorn({ x: 2, y: 5 });
    const b = token("gob", { name: "Goblin", number: 2, x: 2, y: 8 });
    const plan = planGroup(state, [a, b], 5, 0, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "gob", x: 7, y: 8 }]);
    assert.deepEqual(plan.held.map((h) => [h.token.id, h.blocker]), [["thorn", "wall"]]);
    assert.equal(planGroup(state, [a, b], 5, 0, "free").held.length, 0);
  });

  test("a group never squeezes, so a creature that would have to stays put on a walk", () => {
    const ogre = thorn({ size: "large", x: 9, y: 6 });
    const plan = planGroup(corridor(), [ogre], 0, 7, "walk");
    assert.deepEqual(plan.moves, []);
    assert.equal(plan.held.length, 1);
  });
});

describe("ops and words", () => {
  test("a lone move may squeeze, a group move never carries the flag", () => {
    assert.deepEqual(moveOpsOf([{ tokenId: "a", x: 1, y: 2, squeeze: true }]), [{ t: "token.move", tokenId: "a", x: 1, y: 2, squeeze: true }]);
    assert.deepEqual(moveOpsOf([
      { tokenId: "a", x: 1, y: 2, squeeze: true },
      { tokenId: "b", x: 3, y: 4, elevation: 10 },
    ]), [{ t: "token.moveMany", moves: [{ tokenId: "a", x: 1, y: 2 }, { tokenId: "b", x: 3, y: 4, elevation: 10 }] }]);
    const many = Array.from({ length: MAX_MOVES + 1 }, (_, i) => ({ tokenId: `t${i}`, x: i, y: 0 }));
    assert.equal(moveOpsOf(many).length, 2);
    assert.deepEqual(moveOpsOf([]), []);
  });

  test("the labels and notes", () => {
    assert.equal(holdLabel("wall"), "Wall in the way");
    assert.equal(holdLabel("ledge"), "Ledge in the way");
    assert.equal(heldText([]), null);
    assert.equal(heldText([{ name: "Goblin 2", blocker: "wall" }]), "Goblin 2 stayed where it was: a wall is in the way.");
    assert.equal(heldText([{ name: "A", blocker: "ledge" }, { name: "B", blocker: "ledge" }]), "2 tokens stayed where they were: ledges are in the way.");
    assert.equal(heldText([{ name: "A", blocker: "wall" }, { name: "B", blocker: "ledge" }]), "2 tokens stayed where they were: walls or ledges are in the way.");
  });
});

describe("a lone drop walks its route (docs/design-v1-movement.md 3.1)", () => {
  /** The wall along x = 6 stops at y = 10, so the way from 2, 5 to 9, 5 goes round its end. */
  const around = () => world({ edges: line("w", 6, 0, 10) });
  const searched = (state: ReturnType<typeof world>, t: ReturnType<typeof thorn>, to: { x: number; y: number }): Found => {
    const answer = findRoute(publicWorld(state, t, { role: "player" }).input, to);
    return answer === null ? { kind: "open" } : answer === "none" ? { kind: "none", capped: false } : { kind: "route", route: answer };
  };

  test("a route lands at the drop's spot and goes with the move, which the server takes", () => {
    const state = around();
    const t = thorn({ x: 2, y: 5 });
    state.tokens.thorn = t;
    const found = searched(state, t, { x: 9, y: 5 });
    assert.equal(found.kind, "route");
    const plan = planWalk(state, t, { x: 9.2, y: 5.1 }, "walk", found, 5);
    assert.equal(plan.moves.length, 1);
    const move = plan.moves[0]!;
    assert.deepEqual([move.x, move.y], [9, 5]);
    assert.ok(move.route && move.route.length > 1, "it bends round the wall's end");
    assert.deepEqual(move.route.at(-1)!.slice(0, 2), [9, 5]);
    assert.equal(plan.stop, null);
    assert.ok(canApply(moveOpsOf(plan.moves)[0]!, P1, state, { canUseAsset: () => true }).ok);
  });

  test("no route holds a player at the wall with the new words, and the DM's drop goes straight", () => {
    const state = divided();
    const t = thorn({ x: 2, y: 5 });
    state.tokens.thorn = t;
    const none: Found = { kind: "none", capped: false };
    const plan = planWalk(state, t, { x: 9, y: 5 }, "walk", none, 5);
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.equal(stopText(plan.stop!), "Stopped at a wall. There is no way around it that you have seen.");
    assert.equal(stopText(planWalk(state, t, { x: 9, y: 5 }, "walk", { kind: "none", capped: true }, 5).stop!), "Too far to work out a way around. Stopped at a wall. There is no way around it that you have seen.");
    assert.equal(stopText({ blocker: "ledge", door: null, searched: true }), "Ledge in the way. No stairs you have seen lead there.");
    assert.equal(stopText({ blocker: "wall", door: { edge: "6,5,w" }, searched: true }), "A door is in the way. Tap it to open.");
    assert.deepEqual(planWalk(state, t, { x: 9, y: 5 }, "free", none, 5).moves, [{ tokenId: "thorn", x: 9, y: 5 }]);
  });

  test("past 64 pieces the walk lands partway and says so, and past 300 squares it goes without its route", () => {
    const state = world({});
    const t = thorn({ x: 0, y: 0 });
    const zigzag = Array.from({ length: 70 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 1 : 0, i + 1, 0, 0]);
    const cut = planWalk(state, t, { x: 1, y: 70 }, "free", { kind: "route", route: { pieces: zigzag } }, 5);
    assert.equal(cut.cut, true);
    assert.equal(cut.moves[0]!.route!.length, 64);
    assert.deepEqual([cut.moves[0]!.x, cut.moves[0]!.y], [zigzag[63]![0], zigzag[63]![1]]);
    const far = Array.from({ length: 12 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 29 : 0, 2 * i + 1, 0, 0]);
    const long = planWalk(state, t, { x: 29, y: 23 }, "free", { kind: "route", route: { pieces: [...far, [29, 23, 0, 0]] } }, 5);
    assert.equal(long.moves[0]!.route, undefined, "over 300 squares of reach: the drop goes without a route");
  });

  test("an arrow key steps one square, stops at a wall as before, never goes round it, and counts the square's terrain", () => {
    const state = divided();
    const press = (from: { x: number; y: number }, to: { x: number; y: number }, cells: Record<string, "rubble"> = {}) => {
      const view = { ...state, buildChunks: { ...state.buildChunks } };
      for (const [key, terrain] of Object.entries(cells)) {
        const chunk = view.buildChunks["s1:0,0"]!;
        view.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, [key]: terrain } };
      }
      const hero = thorn(from);
      const found = keyStep(new WalkWorld(publicWorld(view, hero, { role: "player" }).input), to);
      return { found, plan: planWalk(view, hero, to, "walk", found, 5) };
    };
    assert.deepEqual(press({ x: 2, y: 2 }, { x: 3, y: 2 }).found, { kind: "open" });
    // Into the wall along x = 6: held where it stands, with today's note, never searched.
    const wall = press({ x: 5, y: 2 }, { x: 6, y: 2 });
    assert.deepEqual([wall.found, wall.plan.moves, wall.plan.stop?.searched], [{ kind: "open" }, [], undefined]);
    const rubble = press({ x: 2, y: 2 }, { x: 3, y: 2 }, { "3,2": "rubble" });
    assert.deepEqual(rubble.found, { kind: "route", route: { pieces: [[3, 2, 1, 0]] } });
    assert.deepEqual(rubble.plan.moves[0]!.route, [[3, 2, 1, 0]], "the press into rubble goes with its route, so it costs 10 ft");
  });

  test("a walk cut inside a 5 ft corridor lands squeezed, at a piece end where the squeeze is a real one", () => {
    const state = world({ edges: { ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
    const ogre = token("ogre", { size: "large", x: 4, y: 0 });
    // 62 pieces above the corridor, then down it a half square at a time.
    const above = Array.from({ length: 62 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 5 : 4, 0.5 + i * 0.1, 0, 0]);
    const down = (ys: number[]) => ys.map((y): [number, number, number, 0 | 1] => [9.5, y, 0, 0]);
    // The 64th piece ends at y 12.5, where the squeezed footprint lies on the grid.
    const onGrid = planWalk(state, ogre, { x: 9.5, y: 15.5 }, "free", { kind: "route", route: { pieces: [...above, ...down([12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5])] } }, 5);
    assert.equal(onGrid.cut, true);
    assert.deepEqual([onGrid.moves[0]!.x, onGrid.moves[0]!.y, onGrid.moves[0]!.squeeze, onGrid.moves[0]!.route!.length], [9.5, 12.5, true, 64]);
    // The 64th ends at y 13, half a square off it: the cut steps back to the 63rd.
    const offGrid = planWalk(state, ogre, { x: 9.5, y: 15.5 }, "free", { kind: "route", route: { pieces: [...above, ...down([12.5, 13, 13.5, 14, 14.5, 15, 15.5])] } }, 5);
    assert.deepEqual([offGrid.moves[0]!.x, offGrid.moves[0]!.y, offGrid.moves[0]!.squeeze, offGrid.moves[0]!.route!.length], [9.5, 12.5, true, 63]);
  });

  test("the route's spot is the drop's own, squeezed where the creature squeezes, on the lattice from where it stands", () => {
    const state = world({ edges: { ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
    const ogre = token("ogre", { size: "large", x: 4, y: 4 });
    assert.deepEqual(routeTarget(state, ogre, { x: 7.2, y: 8.1 }), { x: 7, y: 8, squeeze: false });
    assert.deepEqual(routeTarget(state, ogre, { x: 9.6, y: 14.2 }), { x: 9.5, y: 14.5, squeeze: true });
    const off = thorn({ x: 1.3, y: 2 });
    assert.deepEqual(routeTarget(state, off, { x: 5.1, y: 2.2 }), { x: 5.3, y: 2, squeeze: false });
  });
});
