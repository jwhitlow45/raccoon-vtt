import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { MAX_MOVES } from "#shared/protocol.ts";
import type { DiagonalRule, EdgeFeature, RoomState, TerrainId, Token } from "#shared/model.ts";
import { snapStep } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { alongStraightLeg, plainLegCost, routeFeet, routePoints, routeStop, routeWalk, routeWalkers, walkTrace, type RoutePiece } from "#shared/rules/route.ts";
import { legStop } from "#shared/rules/movement.ts";
import { findRoute, WalkWorld } from "#shared/rules/walk.ts";
import { publicWorld } from "#shared/rules/walkWorld.ts";
import { DM, P1, token } from "#shared/testutil.ts";
import { cutForWalkers, dropMode, dropView, goesStraight, heldText, holdLabel, keyStep, landedElevation, moveOpsOf, planGroup, planLands, planOne, planPress, planWalk, routeTarget, stopText, walkerOf, walkersStop, type Found } from "./drop.ts";
import { dragReading, remoteReading } from "../measure/movement.ts";
import { footprintSize } from "#shared/rules/footprint.ts";
import { snapPosition } from "../../lib/scene.ts";
import { actor } from "#shared/testutil.ts";
import { copyFor } from "../attach/testing.ts";
import { groupDragOf } from "./dragTesting.ts";
import { frameFields, groupLanding, groupReading, walkPreview } from "./preview.ts";
import { CLOSED, line, onTurn, raised, recordedCost, seenRoom, thorn, world } from "./testing.ts";
import { ownWalk } from "#shared/rules/movement.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    const plan = planOne(seenRoom(state), thorn({ x: 2, y: 5 }), { x: 9.2, y: 4.9 }, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.deepEqual(plan.stop, { tokenId: "thorn", sceneId: "s1", blocker: "wall", door: null, ghost: { x: 9, y: 5 }, aim: { x: 9.2, y: 4.9 }, at: { x: 5, y: 5 } });
    assert.equal(stopText(plan.stop!), "Stopped at a wall. Drop at the corner first, then go on.");
  });

  test("a closed door names itself, so the note says to tap it", () => {
    const plan = planOne(seenRoom(divided(true)), thorn({ x: 2, y: 5 }), { x: 9, y: 5 }, "walk");
    assert.deepEqual(plan.stop?.door, { edge: "6,5,w" });
    assert.equal(stopText(plan.stop!), "A door is in the way. Tap it to open.");
  });

  test("a walk stopped at its first step moves nothing and still says why", () => {
    const plan = planOne(seenRoom(divided()), thorn({ x: 5, y: 5 }), { x: 8, y: 5 }, "walk");
    assert.deepEqual(plan.moves, []);
    assert.deepEqual(plan.stop?.at, { x: 5, y: 5 });
    assert.deepEqual(plan.stop?.ghost, { x: 8, y: 5 });
  });

  test("the DM's drop and a scene that stops nothing pass the wall", () => {
    const plan = planOne(seenRoom(divided()), thorn({ x: 2, y: 5 }), { x: 9, y: 5 }, "free");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] });
  });

  test("a clear walk lands where it was dropped, snapped", () => {
    const plan = planOne(seenRoom(divided()), thorn({ x: 2, y: 5 }), { x: 4.4, y: 1.6 }, "walk");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 4, y: 2 }], stop: null, held: [] });
  });

  test("a drop where it stood moves nothing", () => {
    assert.deepEqual(planOne(seenRoom(divided()), thorn({ x: 2, y: 5 }), { x: 2.3, y: 4.8 }, "walk"), { moves: [], stop: null, held: [] });
  });

  test("a Large creature dropped into a 5 ft corridor lands squeezed half a cell off the grid", () => {
    const state = corridor();
    const ogre = thorn({ size: "large", x: 9, y: 6 });
    // Under the finger, the squeezed spot puts its 5 ft footprint on the corridor's cells.
    const plan = planOne(seenRoom(state), ogre, { x: 9.2, y: 13.3 }, "walk");
    assert.deepEqual(plan, { moves: [{ tokenId: "thorn", x: 9.5, y: 13.5, squeeze: true }], stop: null, held: [] });
    // The DM's drop lines it up the same way.
    assert.deepEqual(planOne(seenRoom(state), ogre, { x: 9.2, y: 13.3 }, "free").moves, [{ tokenId: "thorn", x: 9.5, y: 13.5, squeeze: true }]);
  });

  test("a drop beside a corridor is lined up with it by the rule's half-cell shifts", () => {
    // The finger is over the corridor's west wall, where no squeezed spot fits, so the snapped drop shifts (section 4.1).
    const plan = planOne(seenRoom(corridor()), thorn({ size: "large", x: 9, y: 6 }), { x: 8.6, y: 13.2 }, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 9.5, y: 12.5, squeeze: true }]);
  });

  test("a drop against a corridor's outside wall stands full size on the grid, never squeezed", () => {
    // Open ground west of the corridor: one wall beside the creature is no narrow space (section 4.1, check 3).
    const ogre = thorn({ size: "large", x: 4, y: 14 });
    for (const mode of ["walk", "free"] as const) {
      assert.deepEqual(planOne(seenRoom(corridor()), ogre, { x: 8.2, y: 14.3 }, mode).moves, [{ tokenId: "thorn", x: 8, y: 14 }], mode);
    }
  });

  test("a squeezed creature moves along its corridor by the cell it is dropped on, and a nudge leaves it be", () => {
    const squeezed = thorn({ size: "large", x: 9.5, y: 12.5, squeeze: true });
    assert.deepEqual(planOne(seenRoom(corridor()), squeezed, { x: 9.6, y: 12.4 }, "walk").moves, []);
    assert.deepEqual(planOne(seenRoom(corridor()), squeezed, { x: 9.1, y: 15.9 }, "walk").moves, [{ tokenId: "thorn", x: 9.5, y: 15.5, squeeze: true }]);
  });

  test("a squeezed creature walked out into the open stands full size on the grid", () => {
    const squeezed = thorn({ size: "large", x: 9.5, y: 18.5, squeeze: true });
    assert.deepEqual(planOne(seenRoom(corridor()), squeezed, { x: 9.2, y: 22.1 }, "walk").moves, [{ tokenId: "thorn", x: 9, y: 22 }]);
  });

  test("a walker is stopped at a ledge, and a flier above it passes", () => {
    const state = world({ heights: raised(6, 0, 30, 30, 10) });
    const walk = planOne(seenRoom(state), thorn({ x: 2, y: 5 }), { x: 8, y: 5 }, "walk");
    assert.equal(walk.stop?.blocker, "ledge");
    assert.deepEqual(walk.stop?.at, { x: 5, y: 5 });
    assert.equal(stopText(walk.stop!), "Ledge in the way. Take the stairs.");
    const fly = planOne(seenRoom(state), thorn({ x: 2, y: 5, elevation: 30 }), { x: 8, y: 5 }, "walk");
    assert.deepEqual(fly, { moves: [{ tokenId: "thorn", x: 8, y: 5 }], stop: null, held: [] });
  });

  test("a landing on raised ground writes the ground into the move", () => {
    const state = world({ heights: raised(6, 0, 30, 30, 10), blockMovement: false });
    assert.deepEqual(planOne(seenRoom(state), thorn({ x: 2, y: 5 }), { x: 8, y: 5 }, "free").moves, [{ tokenId: "thorn", x: 8, y: 5, elevation: 10 }]);
    assert.deepEqual(planOne(seenRoom(state), thorn({ x: 8, y: 5, elevation: 10 }), { x: 2, y: 5 }, "free").moves, [{ tokenId: "thorn", x: 2, y: 5, elevation: 0 }]);
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
    const plan = planGroup(seenRoom(state), [a, b], 5, 0, "walk");
    assert.deepEqual(plan.moves, [{ tokenId: "gob", x: 7, y: 8 }]);
    assert.deepEqual(plan.held.map((h) => [h.token.id, h.blocker]), [["thorn", "wall"]]);
    assert.equal(planGroup(seenRoom(state), [a, b], 5, 0, "free").held.length, 0);
  });

  test("the dragged token's label reads what its move records: the height it lands at, and no squeeze (review ASTRA-18)", () => {
    const rand = mulberry32(18);
    let climbed = 0;
    for (let n = 0; n < 150; n++) {
      const heights: Record<string, number> = {};
      for (let k = 0; k < 30; k++) heights[`${Math.floor(rand() * 16)},${Math.floor(rand() * 16)}`] = [1, 3, 5, 10][Math.floor(rand() * 4)]!;
      const base = world({ blockMovement: rand() < 0.5, heights });
      const size = (["tiny", "medium", "large"] as const)[Math.floor(rand() * 3)]!;
      const placed = token("lead", { size, x: 3 + Math.floor(rand() * 8), y: 3 + Math.floor(rand() * 8), kind: "pc", ownerIds: ["p1"], disposition: "ally", actor: { inline: actor({ speeds: { walk: 30 } }) } });
      base.tokens.lead = { ...placed, elevation: footprintGround(base.buildChunks, placed) };
      base.tokens.mate = token("mate", { x: 1, y: 1, kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      const diagonal = (["five", "fiveTen", "euclid"] as const)[Math.floor(rand() * 3)]!;
      base.meta = { ...base.meta, settings: { ...base.meta.settings, diagonal } };
      const view = onTurn(base, "lead");
      const lead = view.tokens.lead!;
      const dx = Math.floor(rand() * 9) - 4;
      const dy = Math.floor(rand() * 9) - 4;
      const plan = planGroup(seenRoom(view), [lead, view.tokens.mate!], dx, dy, dropMode("player", view.scenes.s1));
      const move = plan.moves.find((m) => m.tokenId === "lead");
      if (!move) continue;
      if (move.elevation !== undefined && move.elevation !== lead.elevation) climbed++;
      const cost = recordedCost(view, moveOpsOf(plan.moves)[0]!, "lead");
      const to = { x: lead.x + dx, y: lead.y + dy };
      const read = dragReading({ token: walkerOf(seenRoom(view), lead), to: { x: move.x, y: move.y }, encounter: view.encounter, activeTokenId: "lead", speeds: undefined, rules: { feetPerCell: 5, diagonal }, role: "player", landing: groupLanding(view, lead, to) });
      assert.equal(read.dragFt, cost, `case ${n}: ${size} by ${dx},${dy} under ${diagonal}`);
      // The DM's device reads the frames the drag sends of it, which carry the leg's cost, so it reads the height the move lands at, its band too (review MV-O-29).
      const sent = groupDragOf(copyFor(view, P1), "player", ["lead", "mate"], to);
      const remote = remoteReading({ token: lead, to: snapPosition(to.x, to.y, footprintSize(lead)), encounter: view.encounter, activeTokenId: "lead", speeds: { walk: 30 }, rules: { feetPerCell: 5, diagonal }, role: "dm" }, { corners: [], ...(sent.frame.ft !== undefined ? { costFt: sent.frame.ft } : {}) });
      assert.deepEqual([remote.dragFt, remote.left], [cost, sent.label.left], `case ${n}: another device's read of ${size} by ${dx},${dy} under ${diagonal}`);
    }
    assert.ok(climbed > 10, `${climbed} landed at another height`);
  });

  test("a group's dragged token that sits on a holder straddling a step reads the landing the drop sends, judged by the holder (docs/design-v1-attach.md 4.3)", () => {
    // The horse stands on the high half of a step, at its height, and the kite perches over the low half.
    for (const feet of [10, 30]) {
      const base = world({
        blockMovement: false,
        heights: raised(5, 4, 6, 6, feet),
        tokens: [
          token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: feet }),
          token("kite", { name: "Kite", kind: "pc", size: "tiny", ownerIds: ["p1"], disposition: "ally", x: 4, y: 4, elevation: feet, attached: { to: "horse", kind: "perch" } }),
          token("mate", { name: "Mate", x: 1, y: 8, kind: "pc", ownerIds: ["p1"], disposition: "ally" }),
        ],
      });
      const view = dropView(onTurn(base, "kite"), "player");
      const kite = view.tokens.kite!;
      const to = { x: 3, y: 4 };
      const plan = planGroup(view, [kite, view.tokens.mate!], to.x - kite.x, 0, "free");
      const move = plan.moves.find((m) => m.tokenId === "kite")!;
      assert.equal(move.elevation, 0, "off a holder on the ground it lands on the ground");
      const read = groupReading(view, kite, to, "player");
      assert.equal(read.dragFt, recordedCost(view, moveOpsOf(plan.moves)[0]!, "kite"), `${feet} ft`);
      // Its walk starts on the ground under its own footprint, so the seat's height above it is no distance (review LP12-AT-4).
      assert.equal(read.dragFt, 5, `${feet} ft: one square, the drop from the seat not counted`);
    }
  });

  test("a group never squeezes, so a creature that would have to stays put on a walk", () => {
    const ogre = thorn({ size: "large", x: 9, y: 6 });
    const plan = planGroup(seenRoom(corridor()), [ogre], 0, 7, "walk");
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
    const answer = findRoute(publicWorld(state, ownWalk(t), { role: "player" }).input, to);
    return answer === null ? { kind: "open" } : answer === "none" ? { kind: "none", capped: false } : { kind: "route", route: answer };
  };

  test("a route lands at the drop's spot and goes with the move, which the server takes", () => {
    const state = around();
    const t = thorn({ x: 2, y: 5 });
    state.tokens.thorn = t;
    const found = searched(state, t, { x: 9, y: 5 });
    assert.equal(found.kind, "route");
    const plan = planWalk(seenRoom(state), t, { x: 9.2, y: 5.1 }, "walk", found, 5);
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
    const plan = planWalk(seenRoom(state), t, { x: 9, y: 5 }, "walk", none, 5);
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.equal(stopText(plan.stop!), "Stopped at a wall. There is no way around it that you have seen.");
    assert.equal(stopText(planWalk(seenRoom(state), t, { x: 9, y: 5 }, "walk", { kind: "none", capped: true }, 5).stop!), "Too far to work out a way around. Stopped at a wall. There is no way around it that you have seen.");
    assert.equal(stopText({ blocker: "ledge", door: null, searched: true }), "Ledge in the way. No stairs you have seen lead there.");
    assert.equal(stopText({ blocker: "wall", door: { edge: "6,5,w" }, searched: true }), "A door is in the way. Tap it to open.");
    assert.deepEqual(planWalk(seenRoom(state), t, { x: 9, y: 5 }, "free", none, 5).moves, [{ tokenId: "thorn", x: 9, y: 5 }]);
  });

  test("past 64 pieces the walk lands partway and says so, and past 300 squares it goes without its route", () => {
    const state = world({});
    const t = thorn({ x: 0, y: 0 });
    const zigzag = Array.from({ length: 70 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 1 : 0, i + 1, 0, 0]);
    const cut = planWalk(seenRoom(state), t, { x: 1, y: 70 }, "free", { kind: "route", route: { pieces: zigzag } }, 5);
    assert.equal(cut.cut, true);
    assert.equal(cut.moves[0]!.route!.length, 64);
    assert.deepEqual([cut.moves[0]!.x, cut.moves[0]!.y], [zigzag[63]![0], zigzag[63]![1]]);
    const far = Array.from({ length: 12 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 29 : 0, 2 * i + 1, 0, 0]);
    const long = planWalk(seenRoom(state), t, { x: 29, y: 23 }, "free", { kind: "route", route: { pieces: [...far, [29, 23, 0, 0]] } }, 5);
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
      const found = keyStep(new WalkWorld(publicWorld(view, ownWalk(hero), { role: "player" }).input), to);
      return { found, plan: planWalk(seenRoom(view), hero, to, "walk", found, 5) };
    };
    assert.deepEqual(press({ x: 2, y: 2 }, { x: 3, y: 2 }).found, { kind: "open" });
    // Into the wall along x = 6: held where it stands, with today's note, never searched.
    const wall = press({ x: 5, y: 2 }, { x: 6, y: 2 });
    assert.deepEqual([wall.found, wall.plan.moves, wall.plan.stop?.searched], [{ kind: "open" }, [], undefined]);
    const rubble = press({ x: 2, y: 2 }, { x: 3, y: 2 }, { "3,2": "rubble" });
    assert.deepEqual(rubble.found, { kind: "route", route: { pieces: [[3, 2, 1, 0]] } });
    assert.deepEqual(rubble.plan.moves[0]!.route, [[3, 2, 1, 0]], "the press into rubble goes with its route, so it costs 10 ft");
  });

  test("an arrow key's step pays each lattice step's own terrain: a Tiny creature's half squares into rubble", () => {
    const state = world({});
    const chunk = state.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
    state.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, "1,0": "rubble" } };
    const sprite = token("sprite", { size: "tiny", x: 0, y: 0 });
    const found = keyStep(new WalkWorld(publicWorld(state, ownWalk(sprite), { role: "dm" }).input), { x: 1, y: 0 });
    assert.deepEqual(found, { kind: "route", route: { pieces: [[0.5, 0, 0, 0], [1, 0, 1, 0]] } }, "the first half square is plain, the second in rubble");
    const pieces = found.kind === "route" ? found.route.pieces : [];
    const feet = routeFeet(routePoints(state.buildChunks, ownWalk(sprite), pieces, 0), pieces.map(([, , extra, swim]) => ({ extra, swim })), { feetPerCell: 5, diagonal: "five" }, { h: 0, v: 0 }, { swimSpeed: false, step: 0.5 });
    assert.equal(feet.cost, 7.5, "2.5 ft, then 5 ft for the half square of rubble");
  });

  test("an arrow key's press costs what the route along it does, lattice step by lattice step, by creatures, pits, walls and unseen ground (reviews ASTRA-13 and ASTRA-15)", () => {
    const rand = mulberry32(13);
    const terrains: (TerrainId | null)[] = [null, null, null, null, "rubble", "water", "difficult", "pit"];
    const rises = [0, 0, 0, 1, 3, 5, 10];
    const dirs = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y }))).filter((d) => d.x !== 0 || d.y !== 0);
    type Rules = { feetPerCell: number; diagonal: DiagonalRule };
    type Case = { view: RoomState; mover: Token; to: { x: number; y: number }; rules: Rules; seen: number };
    /** The world a press walks in: the public one, seen only left of `seen`. */
    const worldOf = (c: Case) => {
      const input = publicWorld({ ...c.view, meta: { ...c.view.meta, settings: { ...c.view.meta.settings, ...c.rules } } }, ownWalk(c.mover), { role: "dm" }).input;
      return new WalkWorld({ ...input, seen: c.seen < 30 ? (x: number) => x < c.seen : null });
    };
    /** What a move costs as the reducer counts it: its route's feet, or the plain straight leg's, squeezed where it lands squeezed. */
    const moveFeet = (c: Case, at: { x: number; y: number; squeeze?: true }, pieces: readonly RoutePiece[] | undefined) => {
      const landing = landedElevation(c.view.buildChunks, c.mover, at);
      if (!pieces) return plainLegCost(c.mover, { ...c.mover, ...at, elevation: landing }, c.rules, { h: 0, v: 0 }).cost;
      return routeFeet(routePoints(c.view.buildChunks, ownWalk(c.mover), pieces, landing), pieces.map(([, , extra, swim]) => ({ extra, swim })), c.rules, { h: 0, v: 0 }, { swimSpeed: false, step: snapStep(c.mover) }).cost;
    };
    const cases: Case[] = [];
    // Review ASTRA-13: a Tiny creature a square on, half a square up onto ground 10 ft higher and half a square across it, which the straight leg counted as 10 ft.
    cases.push({ view: world({ blockMovement: false, heights: { "1,0": 10 } }), mover: token("sprite", { size: "tiny", x: 0.5, y: 0, elevation: 0 }), to: { x: 1.5, y: 0 }, rules: { feetPerCell: 5, diagonal: "five" }, seen: 30 });
    // Review ASTRA-15: a Large ally a square on into the space of a Medium enemy, which it may end in: both half steps pay its space, 10 ft, not 5.
    const ally = token("ogre", { size: "large", x: 0, y: 0, disposition: "ally" });
    cases.push({ view: world({ tokens: [ally, token("goblin", { x: 2, y: 0, disposition: "hostile" })] }), mover: ally, to: { x: 1, y: 0 }, rules: { feetPerCell: 5, diagonal: "five" }, seen: 30 });
    for (let n = 0; n < 1200; n++) {
      const heights: Record<string, number> = {};
      const cells: Record<string, TerrainId> = {};
      const edges: Record<string, EdgeFeature> = {};
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          const rise = rises[Math.floor(rand() * rises.length)]!;
          if (rise > 0) heights[`${x},${y}`] = rise;
          const t = terrains[Math.floor(rand() * terrains.length)];
          if (t) cells[`${x},${y}`] = t;
          if (rand() < 0.05) edges[`${x},${y},${rand() < 0.5 ? "w" : "n"}`] = { kind: "wall" };
        }
      }
      const size = (["tiny", "medium", "large"] as const)[Math.floor(rand() * 3)]!;
      const step = size === "medium" ? 1 : 0.5;
      const at = { x: 3 + Math.floor(rand() * 6) * step, y: 3 + Math.floor(rand() * 6) * step };
      const others = Array.from({ length: Math.floor(rand() * 3) }, (_, k) => token(`other${k}`, { size: (["tiny", "medium", "large"] as const)[Math.floor(rand() * 3)]!, x: 2 + Math.floor(rand() * 7), y: 2 + Math.floor(rand() * 7), disposition: rand() < 0.5 ? "hostile" : "ally" }));
      const view = world({ blockMovement: rand() < 0.5, heights, edges, tokens: others });
      const chunk = view.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
      view.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, ...cells } };
      const placed = token("mover", { size, ...at, kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      const mover = { ...placed, elevation: footprintGround(view.buildChunks, placed) };
      view.tokens.mover = mover;
      const d = dirs[Math.floor(rand() * dirs.length)]!;
      const len = (size === "tiny" ? 0.5 : 1) * (1 + Math.floor(rand() * 2));
      const diagonal = (["five", "fiveTen", "euclid"] as const)[Math.floor(rand() * 3)]!;
      // Half the scenes seen only part of the way across, where unseen ground reads as plain.
      const seen = rand() < 0.5 ? 30 : 3 + Math.floor(rand() * 7);
      cases.push({ view, mover, to: { x: at.x + d.x * len, y: at.y + d.y * len }, rules: { feetPerCell: 5, diagonal }, seen });
    }
    let walked = 0;
    let plain = 0;
    for (const [n, c] of cases.entries()) {
      const w = worldOf(c);
      const plan = planPress(seenRoom(c.view), w, c.mover, c.to, "walk", 5);
      const move = plan.moves[0];
      // Every move the press sends, squeezed or not, is one the server takes (review MV-O-24).
      const label0 = `case ${n}: ${c.mover.size} from ${c.mover.x},${c.mover.y} to ${c.to.x},${c.to.y}`;
      const owned = { ...c.view, tokens: { ...c.view.tokens, [c.mover.id]: { ...c.mover, kind: "pc" as const, ownerIds: ["p1"] } } };
      for (const op of moveOpsOf(plan.moves)) {
        const answer = canApply(op, P1, owned, { canUseAsset: () => true });
        assert.ok(answer.ok, `${label0}: the server refuses ${JSON.stringify(op)}: ${answer.ok ? "" : answer.message}`);
      }
      // What the press counts is what its move records on the creature's turn, squeezed or not (review ASTRA-18).
      if (move) {
        const turn = onTurn({ ...owned, meta: { ...owned.meta, settings: { ...owned.meta.settings, ...c.rules } } }, c.mover.id);
        assert.equal(recordedCost(turn, moveOpsOf(plan.moves)[0]!, c.mover.id), moveFeet(c, move, move.route), `${label0}${move.squeeze ? ", squeezed" : ""}: the move records what the press counts`);
      }
      if (!move || move.squeeze) continue;
      // Off the eight directions a piece runs straight between the snapped spots it passes, so no sum of its steps measures it.
      const dx = Math.abs(move.x - c.mover.x);
      const dy = Math.abs(move.y - c.mover.y);
      if (dx > 1e-9 && dy > 1e-9 && Math.abs(dx - dy) > 1e-9) continue;
      walked++;
      // The route along the leg the move walks, one piece a step as the reducer steps it (route.ts routeWalk), each with what that step pays.
      const spots = routeWalk(walkTrace(c.view.buildChunks, ownWalk(c.mover), [{ x: c.mover.x, y: c.mover.y, elevation: c.mover.elevation }, { x: move.x, y: move.y, elevation: landedElevation(c.view.buildChunks, c.mover, move) }]), c.view);
      const each: RoutePiece[] = spots.slice(1).map((q, i) => {
        const p = spots[i]!;
        const node = w.nodeAt(q);
        const { extra, swim } = w.extraOf(p.x, p.y, q.x, q.y, node >= 0 ? w.elevationAt(node) : q.elevation, node);
        return [q.x, q.y, extra, swim];
      });
      const label = `case ${n}: ${c.mover.size} from ${c.mover.x},${c.mover.y} to ${move.x},${move.y} of ${c.to.x},${c.to.y} under ${c.rules.diagonal}, seen x < ${c.seen}${plan.stop ? ", held" : ""}`;
      // Where the server's check refuses the walk piece by piece, a ledge met from the low half of a step, the move goes as the plain straight leg, and the drag's picture reads it so (review MV-O-24).
      if (!move.route && c.view.scenes.s1!.blockMovement && routeStop(c.view, ownWalk(c.mover), each, landedElevation(c.view.buildChunks, c.mover, move)) !== null) {
        plain++;
        continue;
      }
      assert.equal(moveFeet(c, move, move.route), moveFeet(c, move, each), label);
      if (n === 0) assert.equal(moveFeet(c, move, move.route), 12.5, label);
      if (n === 1) assert.deepEqual([move.route?.length, moveFeet(c, move, move.route)], [1, 10], label);
    }
    assert.ok(walked > 300, `${walked} presses walked`);
    assert.ok(plain < walked / 10, `${plain} of ${walked} went plain`);
  });

  test("a Large walk held at a wall past a short stub inside its body sends a move the server takes (review MV-O-24)", () => {
    const edges = { ...line("w", 14, 0, 30), "8,8,n": { kind: "wall" } as EdgeFeature };
    const view = world({ blockMovement: true, edges });
    const chunk = view.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
    view.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, "8,7": "rubble" } };
    const ogre = token("ogre", { size: "large", x: 2, y: 7, kind: "pc", ownerIds: ["p1"], disposition: "ally" });
    view.tokens.ogre = ogre;
    const w = new WalkWorld(publicWorld(view, ownWalk(ogre), { role: "player" }).input);
    const plan = planWalk(seenRoom(view), ogre, { x: 20, y: 7 }, "walk", { kind: "none", capped: false }, 5, (to) => keyStep(w, to));
    assert.deepEqual([plan.moves[0]!.x, plan.moves[0]!.y, plan.stop?.searched], [12, 7, true]);
    const [op] = moveOpsOf(plan.moves);
    const answer = canApply(op!, P1, view, { canUseAsset: () => true });
    assert.ok(answer.ok, answer.ok ? "" : answer.message);
  });

  test("a drag whose route the drop would not take draws the straight drop, ending where it lands (review MV-O-24)", () => {
    const view = world({ blockMovement: true, edges: line("w", 6, 0, 10) });
    const hero = token("hero", { x: 2, y: 2, kind: "pc", ownerIds: ["p1"], disposition: "ally" });
    view.tokens.hero = hero;
    const seen = publicWorld(view, ownWalk(hero), { role: "player" });
    const w = new WalkWorld(seen.input);
    const raw = { x: 9.2, y: 2.1 };
    const target = routeTarget(seenRoom(view), hero, raw);
    // A route through the wall: the server refuses it, and it has no lattice steps that pass.
    const pieces: RoutePiece[] = [[4, 2, 0, 0], [9, 2, 0, 0]];
    const answer = { kind: "route" as const, route: { pieces, points: routePoints(view.buildChunks, ownWalk(hero), pieces, 0), endsBlocked: false } };
    assert.equal(goesStraight(seenRoom(view), hero, target, answer, 5), true);
    const plan = planWalk(seenRoom(view), hero, raw, "walk", answer, 5, (to) => keyStep(w, to));
    const held = planLands(planOne(seenRoom(view), hero, raw, "walk"), hero);
    assert.deepEqual([held, plan.moves[0]?.x, plan.moves[0]?.y, plan.stop?.blocker], [{ x: 5, y: 2 }, 5, 2, "wall"]);
    for (const op of moveOpsOf(plan.moves)) {
      const ok = canApply(op, P1, view, { canUseAsset: () => true });
      assert.ok(ok.ok, ok.ok ? "" : ok.message);
    }
    const own = keyStep(w, held);
    const preview = walkPreview({ view: seenRoom(view), token: hero, target, answer, held, world: seen, role: "player", straight: own.kind === "route" ? { to: held, pieces: own.route.pieces } : null });
    assert.deepEqual(preview.to, { x: 5, y: 2 });
  });

  test("every drop the client sends is one the server takes, and the drag's picture reads what lands (review MV-O-24)", () => {
    const rand = mulberry32(24);
    const terrains: (TerrainId | null)[] = [null, null, null, null, "rubble", "water", "difficult", "pit"];
    const rises = [0, 0, 0, 1, 3, 5, 10];
    let routed = 0;
    let squeezed = 0;
    let wholeLeg = 0;
    for (let n = 0; n < 300; n++) {
      const heights: Record<string, number> = {};
      const cells: Record<string, TerrainId> = {};
      const edges: Record<string, EdgeFeature> = {};
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (rand() < 0.5) {
            const rise = rises[Math.floor(rand() * rises.length)]!;
            if (rise > 0) heights[`${x},${y}`] = rise;
          }
          const t = terrains[Math.floor(rand() * terrains.length)];
          if (t) cells[`${x},${y}`] = t;
          // Wall stubs, and now and then a corridor a square wide that a Large creature squeezes through.
          if (rand() < 0.05) edges[`${x},${y},${rand() < 0.5 ? "w" : "n"}`] = { kind: "wall" };
        }
      }
      if (rand() < 0.4) Object.assign(edges, line("w", 8, 4, 12), line("w", 9, 4, 12));
      const size = (["tiny", "medium", "large", "large"] as const)[Math.floor(rand() * 4)]!;
      const at = { x: 2 + Math.floor(rand() * 10), y: 2 + Math.floor(rand() * 10) };
      const base = world({ blockMovement: true, heights, edges });
      const chunk = base.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
      base.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, ...cells } };
      const placed = token("mover", { size, ...at, kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      base.tokens.mover = { ...placed, elevation: footprintGround(base.buildChunks, placed) };
      base.meta = { ...base.meta, settings: { ...base.meta.settings, diagonal: (["five", "fiveTen", "euclid"] as const)[Math.floor(rand() * 3)]! } };
      // On the mover's turn, so the move records what it took.
      const view = onTurn(base, "mover");
      const mover = view.tokens.mover!;
      // Half the scenes seen only part of the way across, where a route may cross a wall the party has not seen.
      const edge = rand() < 0.5 ? null : 3 + Math.floor(rand() * 10);
      const known = publicWorld(view, ownWalk(mover), { role: "player" });
      const seen = { ...known, input: { ...known.input, seen: edge === null ? null : (x: number) => x < edge } };
      const w = new WalkWorld(seen.input);
      const raw = { x: 1 + rand() * 14, y: 1 + rand() * 14 };
      const target = routeTarget(seenRoom(view), mover, raw);
      const r = findRoute(seen.input, target);
      const found: Found = r === null ? { kind: "open" } : r === "none" ? { kind: "none", capped: false } : { kind: "route", route: r };
      const plan = planWalk(seenRoom(view), mover, raw, "walk", found, 5, (to) => keyStep(w, to));
      const label = `case ${n}: ${size} from ${at.x},${at.y} to ${target.x},${target.y}, ${found.kind}, seen x < ${edge ?? "all"}`;
      for (const op of moveOpsOf(plan.moves)) {
        const answer = canApply(op, P1, view, { canUseAsset: () => true });
        assert.ok(answer.ok, `${label}: the server refuses ${JSON.stringify(op)}: ${answer.ok ? "" : answer.message}`);
      }
      const move = plan.moves[0];
      if (move?.route) routed++;
      if (move?.squeeze) squeezed++;
      // A straight drop keeps what its straight leg walks over: its own route goes with it, judged by the test of its whole
      // leg where a piece alone would meet ground the leg passes beside (review MV-PLAIN-1). Only a squeeze at its end,
      // judged at the end of the walk, sends it plain.
      if (move && !move.route && goesStraight(seenRoom(view), mover, target, found, 5)) {
        const own = keyStep(w, { x: move.x, y: move.y, ...(move.squeeze ? { squeeze: true } : {}) });
        assert.ok(own.kind !== "route" || move.squeeze === true, `${label}: the straight drop went plain, dropping ${JSON.stringify(own)}`);
      }
      if (move?.route && alongStraightLeg(mover, move.route)) {
        const trace = routeWalkers(view.buildChunks, walkerOf(seenRoom(view), mover), move.route, move.elevation ?? mover.elevation);
        if (trace.some((at, i) => i > 0 && legStop(view, trace[i - 1]!, at) !== null)) wholeLeg++;
      }
      // The picture, as the board draws it: held at the wall where the drop goes straight, reading the straight walk's own route.
      const answer = r === null ? { kind: "open" as const } : r === "none" ? { kind: "none" as const, capped: false } : { kind: "route" as const, route: r };
      const held = goesStraight(seenRoom(view), mover, target, answer, 5) ? planLands(planOne(seenRoom(view), mover, raw, "walk"), mover) : null;
      const own = held ? keyStep(w, held) : null;
      const preview = walkPreview({ view: seenRoom(view), token: mover, target, answer, held, world: seen, role: "player", straight: held && own?.kind === "route" ? { to: held, pieces: own.route.pieces } : null });
      const lands = move ? { x: move.x, y: move.y } : { x: mover.x, y: mover.y };
      assert.deepEqual(preview.to, lands, `${label}: the picture ends where the drop lands`);
      if (move?.route) assert.deepEqual(preview.corners, move.route.slice(0, -1).map(([x, y]) => ({ x, y })), `${label}: the picture's corners are the route's`);
      // The label and the frame others see read what the move records on the turn (review ASTRA-18).
      if (move) {
        const cost = recordedCost(view, moveOpsOf(plan.moves)[0]!, "mover");
        assert.deepEqual([preview.read.dragFt, frameFields(preview).ft], [cost, cost], `${label}${move.squeeze ? ", squeezed" : ""}${move.route ? "" : ", plain"}: the label and the frame read what the move records`);
      }
    }
    assert.ok(routed > 50 && squeezed > 0 && wholeLeg > 5, `${routed} routed, ${squeezed} squeezed, ${wholeLeg} judged by the whole leg`);
  });

  test("random straight walks of Large and Huge creatures over scattered raised squares and rough ground keep what they walk over: the server takes the straight walk's own route by its whole leg, and the label reads what it stores (review MV-PLAIN-1)", () => {
    const rand = mulberry32(29);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    let routed = 0;
    let wholeLeg = 0;
    let rough = 0;
    let presses = 0;
    for (let n = 0; n < 1200; n++) {
      const heights: Record<string, number> = {};
      const cells: Record<string, TerrainId> = {};
      for (let k = int(10, 30); k > 0; k--) heights[`${int(2, 22)},${int(2, 22)}`] = [3, 5, 10][int(0, 2)]!;
      for (let k = int(6, 20); k > 0; k--) cells[`${int(2, 20)},${int(2, 20)}`] = (["rubble", "water", "difficult"] as const)[int(0, 2)]!;
      const base = world({ blockMovement: true, heights });
      const chunk = base.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
      base.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, ...cells } };
      const placed = token("mover", { size: (["large", "large", "huge"] as const)[int(0, 2)], x: int(5, 13), y: int(5, 13), kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      base.tokens.mover = { ...placed, elevation: footprintGround(base.buildChunks, placed) };
      base.meta = { ...base.meta, settings: { ...base.meta.settings, diagonal: (["five", "fiveTen", "euclid"] as const)[int(0, 2)]! } };
      const view = onTurn(base, "mover");
      const mover = view.tokens.mover!;
      const known = publicWorld(view, ownWalk(mover), { role: "player" });
      const w = new WalkWorld(known.input);
      // An arrow key's press of a square, or a drop with no way searched, both straight.
      const press = rand() < 0.4;
      const raw = press ? { x: mover.x + int(-1, 1), y: mover.y + int(-1, 1) } : { x: mover.x + int(-7, 7), y: mover.y + int(-7, 7) };
      const none = { kind: "none" as const, capped: false };
      const plan = press ? planPress(seenRoom(view), w, mover, raw, "walk", 5) : planWalk(seenRoom(view), mover, raw, "walk", none, 5, (to) => keyStep(w, to));
      const move = plan.moves[0];
      if (!move) continue;
      const label = `case ${n}: ${mover.size} from ${mover.x},${mover.y} to ${move.x},${move.y}${press ? ", pressed" : ""}`;
      const [op] = moveOpsOf(plan.moves);
      const answer = canApply(op!, P1, view, { canUseAsset: () => true });
      assert.ok(answer.ok, `${label}: the server refuses ${JSON.stringify(op)}: ${answer.ok ? "" : answer.message}`);
      const own = keyStep(w, { x: move.x, y: move.y, ...(move.squeeze ? { squeeze: true } : {}) });
      if (own.kind === "route" && !move.squeeze) assert.deepEqual(move.route, own.route.pieces, `${label}: the drop carries its straight walk's own route`);
      if (!move.route) continue;
      routed++;
      if (press) presses++;
      if (move.route.some(([, , extra, swim]) => extra !== 0 || swim !== 0)) rough++;
      const trace = routeWalkers(view.buildChunks, walkerOf(seenRoom(view), mover), move.route, move.elevation ?? mover.elevation);
      if (trace.some((at, i) => i > 0 && legStop(view, trace[i - 1]!, at) !== null)) wholeLeg++;
      if (press) continue;
      const held = planLands(plan, mover);
      const target = routeTarget(seenRoom(view), mover, raw);
      const preview = walkPreview({ view: seenRoom(view), token: mover, target, answer: none, held, world: known, role: "player", straight: { to: held, pieces: own.kind === "route" ? own.route.pieces : [] } });
      assert.equal(preview.read.dragFt, recordedCost(view, op!, "mover"), `${label}: the label reads what the move stores`);
    }
    assert.ok(routed > 300 && wholeLeg > 35 && rough > 200 && presses > 70, JSON.stringify({ routed, wholeLeg, rough, presses }));
  });

  test("a walk cut inside a 5 ft corridor lands squeezed, at a piece end where the squeeze is a real one", () => {
    const state = world({ edges: { ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
    const ogre = token("ogre", { size: "large", x: 4, y: 0 });
    // 62 pieces above the corridor, the last to its mouth, then down it a half square at a time.
    const above = Array.from({ length: 62 }, (_, i): [number, number, number, 0 | 1] => (i === 61 ? [9.5, 8, 0, 0] : [i % 2 === 0 ? 5 : 4, 0.5 + i * 0.1, 0, 0]));
    const down = (ys: number[]) => ys.map((y): [number, number, number, 0 | 1] => [9.5, y, 0, 0]);
    // The 64th piece ends at y 12.5, where the squeezed footprint lies on the grid.
    const long = [...above, ...down([12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5])];
    const onGrid = planWalk(seenRoom(state), ogre, { x: 9.5, y: 15.5 }, "free", { kind: "route", route: { pieces: long } }, 5);
    assert.equal(onGrid.cut, true);
    assert.deepEqual([onGrid.moves[0]!.x, onGrid.moves[0]!.y, onGrid.moves[0]!.squeeze, onGrid.moves[0]!.route!.length], [9.5, 12.5, true, 64]);
    // The drag's label for the cut walk reads what its move records (review ASTRA-18).
    const turn = onTurn({ ...state, tokens: { ogre } }, "ogre");
    const target = routeTarget(seenRoom(turn), ogre, { x: 9.5, y: 15.5 });
    const answer = { kind: "route" as const, route: { pieces: long, points: routePoints(turn.buildChunks, ownWalk(ogre), long, 0), endsBlocked: false } };
    const preview = walkPreview({ view: seenRoom(turn, "dm"), token: turn.tokens.ogre!, target, answer, held: null, world: publicWorld(turn, ownWalk(ogre), { role: "dm" }), role: "dm" });
    assert.deepEqual([preview.cut, preview.read.dragFt], [true, recordedCost(turn, moveOpsOf(onGrid.moves)[0]!, "ogre", DM)]);
    // The 64th ends at y 13, half a square off it: the cut steps back to the 63rd.
    const offGrid = planWalk(seenRoom(state), ogre, { x: 9.5, y: 15.5 }, "free", { kind: "route", route: { pieces: [...above, ...down([12.5, 13, 13.5, 14, 14.5, 15, 15.5])] } }, 5);
    assert.deepEqual([offGrid.moves[0]!.x, offGrid.moves[0]!.y, offGrid.moves[0]!.squeeze, offGrid.moves[0]!.route!.length], [9.5, 12.5, true, 63]);
    // On open ground, where nothing pinches it, a cut lands only on the creature's own grid from where it stands: half a square off it, the cut steps back.
    const open = world({});
    const half = Array.from({ length: 70 }, (_, i): [number, number, number, 0 | 1] => [4, 0.5 * (i + 1), 0, 0]);
    const cut = planWalk(seenRoom(open), ogre, { x: 4, y: 35 }, "free", { kind: "route", route: { pieces: half } }, 5);
    assert.deepEqual([cut.moves[0]!.x, cut.moves[0]!.y, cut.moves[0]!.squeeze, cut.moves[0]!.route!.length], [4, 32, undefined, 64]);
    // The 64th piece ends at y 32.5.
    const odd = planWalk(seenRoom(open), ogre, { x: 4, y: 35 }, "free", { kind: "route", route: { pieces: half.map(([x, y, e, w]): [number, number, number, 0 | 1] => [x, y + 0.5, e, w]) } }, 5);
    assert.deepEqual([odd.moves[0]!.y, odd.moves[0]!.route!.length], [32, 63]);
  });

  test("the route's spot is the drop's own, squeezed where the creature squeezes, on the lattice from where it stands", () => {
    const state = world({ edges: { ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
    const ogre = token("ogre", { size: "large", x: 4, y: 4 });
    assert.deepEqual(routeTarget(seenRoom(state), ogre, { x: 7.2, y: 8.1 }), { x: 7, y: 8, squeeze: false });
    assert.deepEqual(routeTarget(seenRoom(state), ogre, { x: 9.6, y: 14.2 }), { x: 9.5, y: 14.5, squeeze: true });
    const off = thorn({ x: 1.3, y: 2 });
    assert.deepEqual(routeTarget(seenRoom(state), off, { x: 5.1, y: 2.2 }), { x: 5.3, y: 2, squeeze: false });
  });
});

describe("a holder that drags a creature beside it (docs/design-v1-attach.md 4.2)", () => {
  /** A wall along x = 6 from the top down to y = 5, so Thorn walks past its end at y = 5 and the goblin he drags at y = 4 does not. */
  const walled = () => world({ edges: line("w", 6, 0, 5) });
  const holder = () => thorn({ x: 2, y: 5 });
  const goblin = token("goblin", { x: 2, y: 4, attached: { to: "thorn", kind: "drag" } });

  test("the walk stops at the last spot where the holder and each creature it drags may stand", () => {
    const state = walled();
    const points = [
      { x: 2, y: 5, elevation: 0 },
      { x: 9, y: 5, elevation: 0 },
    ];
    assert.deepEqual(walkersStop(state, ownWalk(holder()), points, [goblin]), { at: { x: 5, y: 5, elevation: 0 }, pieces: 0, blocker: "wall" });
    assert.equal(walkersStop(state, ownWalk(holder()), points, []), null);
    assert.equal(walkersStop(state, ownWalk(holder()), [points[0]!, { x: 5, y: 5, elevation: 0 }], [goblin]), null);
  });

  test("a cut on a piece along no axis or diagonal stands on the holder's lattice, as a route's spots do", () => {
    // Thorn walks from (2,5) to (7,8), and the goblin he drags at y = 4 meets the wall along x = 6 down to y = 7, which he passes below.
    const state = world({ edges: line("w", 6, 0, 7) });
    const points = [
      { x: 2, y: 5, elevation: 0 },
      { x: 7, y: 8, elevation: 0 },
    ];
    assert.deepEqual(walkersStop(state, ownWalk(holder()), points, [goblin]), { at: { x: 5, y: 7, elevation: 0 }, pieces: 0, blocker: "wall" });
  });

  test("a player's drop is cut there with the note a wall gives, and the DM's goes on", () => {
    const state = walled();
    const plan = { moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] };
    const cut = cutForWalkers(seenRoom(state), holder(), plan, [goblin], "walk");
    assert.deepEqual(cut.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.deepEqual(cut.stop?.at, { x: 5, y: 5 });
    assert.equal(cut.stop?.blocker, "wall");
    assert.equal(cutForWalkers(seenRoom(state), holder(), plan, [goblin], "free"), plan);
    // A route keeps its pieces up to the cut, the last one ending there with the extra it had.
    const routed = { moves: [{ tokenId: "thorn", x: 9, y: 5, route: [[9, 5, 1, 0] as [number, number, number, 0 | 1]] }], stop: null, held: [] };
    assert.deepEqual(cutForWalkers(seenRoom(state), holder(), routed, [goblin], "walk").moves[0]?.route, [[5, 5, 1, 0]]);
    // Stopped right where a piece starts, the route ends with the piece before it.
    const turning = { moves: [{ tokenId: "thorn", x: 9, y: 4, route: [[5, 5, 1, 0], [5, 4, 1, 0], [9, 4, 1, 0]] as [number, number, number, 0 | 1][] }], stop: null, held: [] };
    const bent = cutForWalkers(seenRoom(state), holder(), turning, [goblin], "walk").moves[0];
    assert.deepEqual(bent?.route, [[5, 5, 1, 0], [5, 4, 1, 0]]);
    assert.deepEqual([bent?.x, bent?.y], [5, 4]);
  });

  test("in a group drag, a holder whose creature could not follow stays where it was", () => {
    const state = walled();
    const plan = planGroup(seenRoom(state), [holder(), token("other", { x: 2, y: 8 })], 7, 0, "walk", (t) => (t.id === "thorn" ? [goblin] : []));
    assert.deepEqual(plan.moves.map((m) => m.tokenId), ["other"]);
    assert.deepEqual(plan.held.map((h) => h.token.id), ["thorn"]);
  });
});
