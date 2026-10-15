import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_MOVES } from "#shared/protocol.ts";
import { token } from "#shared/testutil.ts";
import { dropMode, heldText, holdLabel, landedElevation, moveOpsOf, planGroup, planOne, stopText } from "./drop.ts";
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
