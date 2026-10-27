import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, lift, wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { legStop, ownWalk, previewChunks, squeezeFits, stepTester, walkEnd } from "#shared/rules/movement.ts";
import { findRoute, WorkBudget } from "#shared/rules/walk.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { P1, token } from "#shared/testutil.ts";
import { walkersCut } from "../attach/walk.ts";
import { getOffPlace } from "../attach/detach.ts";
import { doorsInReach } from "../doors/doors.ts";
import { tokenStop } from "../measure/ruler.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { companionSpot } from "../tokens/companions.ts";
import { dragOf } from "./dragTesting.ts";
import { dropView, planGroup, planOne, previewView, type DropView } from "./drop.ts";
import { pressPlan, worldFor } from "./press.ts";
import { sendPlan } from "./send.ts";
import { CLOSED, thorn } from "./testing.ts";

/*
 * The device's two tests of a held build's pieces where the client calls
 * them (docs/design-v1-map-discovery.md 5.2, ASTRA-34, section 10's md-9):
 * every gate on an action sent to the server takes the permissive test, so
 * a walk the exact wall allows is sent, and every preview that nothing
 * checks after takes the conservative one.
 *
 * Astra's case: the wall from (4.265625, 6.484375) to (10.515625, 1.5)
 * passes about 0.00004 cell north of (5.5, 5.5), so a Medium creature's
 * walk from (5, 6) to (5, 5), its center from (5.5, 6.5) to (5.5, 5.5),
 * ends south of it and the exact wall allows it. The player holds the wall
 * as a piece the server cut at x = 8 and rounded, which ends that walk
 * inside the piece's band.
 */

const WALL_A: [number, number] = [4.265625, 6.484375];
const WALL_B: [number, number] = [10.515625, 1.5];

/** Astra's room: the wall, the ground about it revealed, and the player's copy of it. */
function astra(tokens: Token[], build: (state: RoomState) => void = () => {}): { state: RoomState; copy: RoomState } {
  const state = fogRoom({ scene: { blockMovement: true } });
  wall(state, "aaaaaaaaaaaa", WALL_A, WALL_B);
  build(state);
  lift(state, "dm", { x: 0, y: 0, w: 16, h: 12 });
  state.tokens = Object.fromEntries(tokens.map((t) => [t.id, t]));
  return { state, copy: projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState };
}

/** Thorn, the player's Medium creature, on scene s1. */
function hero(x: number, y: number, over: Partial<Token> = {}): Token {
  return thorn({ x, y, sceneId: "s1", ...over });
}

/** The same copy with its build read as a preview reads it, as every mutant that turns a gate conservative would read it. */
function conservative(copy: RoomState): RoomState {
  return { ...copy, buildChunks: previewChunks(copy.buildChunks) };
}

describe("astra's wall reaches the player as a piece the walk ends inside the band of", () => {
  test("the copy holds it cut and rounded, not as the wall the DM drew", () => {
    const { copy } = astra([hero(5, 6)]);
    const walls = Object.values(copy.buildChunks).flatMap((c) => c?.walls ?? []);
    assert.ok(walls.length > 0 && walls.every((w) => w.id !== "aaaaaaaaaaaa"), JSON.stringify(walls));
    assert.ok(walls.some((w) => w.a[0] === WALL_A[0] && w.b[0] !== WALL_B[0]), "a piece from the real end, cut short of the far one");
  });
});

describe("every gate takes the permissive test (5.2)", () => {
  test("a drag's drop sends the walk the search finds open, and its picture follows it to the finger", () => {
    const { copy } = astra([hero(5, 6)]);
    const drag = dragOf(copy, "player", "thorn", { x: 5.3, y: 5.2 });
    assert.deepEqual(drag.op, { t: "token.move", tokenId: "thorn", x: 5, y: 5 });
    assert.equal(drag.plan.stop, null);
    assert.equal(drag.hold, null);
  });

  test("a drag with no way through lands at the last spot the exact wall allows, while its picture holds where the band begins", () => {
    // A wall across the whole scene at y = 4 leaves no way north, so the drop goes as the straight leg, held at a wall.
    const across = (state: RoomState) => {
      for (let x = 0; x < 48; x++) edge(state, `${x},4,n`, { kind: "wall" });
    };
    const { copy } = astra([hero(5, 6)], across);
    const drag = dragOf(copy, "player", "thorn", { x: 5.3, y: 3.2 });
    assert.equal(drag.answer.kind, "none");
    assert.deepEqual(drag.op, { t: "token.move", tokenId: "thorn", x: 5, y: 5 });
    assert.deepEqual(drag.plan.stop?.at, { x: 5, y: 5 });
    // The picture is a preview, which nothing checks after: the band of the piece holds it a step short.
    assert.deepEqual(drag.hold, { tokenId: "thorn", at: { x: 5, y: 6 }, blocker: "wall" });
  });

  test("the drop's own landing", () => {
    const { copy } = astra([hero(5, 6)]);
    const view = dropView(copy, "player");
    assert.deepEqual(planOne(view, copy.tokens.thorn!, { x: 5.3, y: 5.2 }, "walk").moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    const held = planOne(dropView(conservative(copy), "player"), copy.tokens.thorn!, { x: 5.3, y: 5.2 }, "walk");
    assert.deepEqual([held.moves, held.stop?.at], [[], { x: 5, y: 6 }], "the conservative test holds the walk where it starts");
  });

  test("an arrow key's step", () => {
    const { copy } = astra([hero(5, 6)]);
    const plan = pressPlan(copy, copy.tokens.thorn!, { x: 5, y: 5 }, [copy.tokens.thorn!], "player", WorkBudget.all());
    assert.deepEqual(plan.moves, [{ tokenId: "thorn", x: 5, y: 5 }]);
    assert.equal(pressPlan(conservative(copy), copy.tokens.thorn!, { x: 5, y: 5 }, [copy.tokens.thorn!], "player", WorkBudget.all()).moves.length, 0);
  });

  test("a group's legs", () => {
    const friend = token("bree", { kind: "pc", name: "Bree", ownerIds: ["p1"], x: 12, y: 8, sceneId: "s1" });
    const { copy } = astra([hero(5, 6), friend]);
    const group = [copy.tokens.thorn!, copy.tokens.bree!];
    const plan = planGroup(dropView(copy, "player"), group, 0, -1, "walk");
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y]), [["thorn", 5, 5], ["bree", 12, 7]]);
    assert.deepEqual(plan.held, []);
    assert.deepEqual(planGroup(dropView(conservative(copy), "player"), group, 0, -1, "walk").held.map((h) => h.token.id), ["thorn"]);
  });

  test("a route's search finds the straight leg open", () => {
    const { copy } = astra([hero(5, 6)]);
    const input = worldFor(dropView(copy, "player"), copy.tokens.thorn!, "player").input;
    assert.equal(findRoute(input, { x: 5, y: 5 }), null, "the straight leg is the route");
    const held = worldFor(dropView(conservative(copy), "player"), copy.tokens.thorn!, "player").input;
    assert.notEqual(findRoute(held, { x: 5, y: 5 }), null);
  });

  test("a holder's walk with a creature it drags beside it", () => {
    // Thorn at (6, 6) walks north clear of the wall, and drags a goblin at (5, 6) along astra's walk.
    const goblin = token("goblin", { name: "Goblin", x: 5, y: 6, sceneId: "s1", attached: { to: "thorn", kind: "drag" } });
    const { copy } = astra([hero(6, 6), goblin]);
    assert.equal(walkersCut(dropView(copy, "player"), copy.tokens.thorn!, { x: 6, y: 5 }, null, "player"), null);
    assert.notEqual(walkersCut(dropView(conservative(copy), "player"), copy.tokens.thorn!, { x: 6, y: 5 }, null, "player"), null);
  });

  test("getting off a mount", () => {
    // Bree rides a Large horse at (5, 6). Creatures stand on every other spot beside it, so the one left is astra's walk's end.
    const horse = token("horse", { kind: "npc", name: "Horse", size: "large", x: 5, y: 6, sceneId: "s1", ownerIds: ["p1"] });
    const bree = hero(5, 6, { attached: { to: "horse", kind: "ride" }, elevation: 0 });
    const others: Token[] = [];
    let k = 0;
    for (let y = 4; y <= 9; y++) {
      for (let x = 3; x <= 8; x++) {
        const inside = x >= 5 && x <= 6 && y >= 6 && y <= 7;
        if (inside || (x === 5 && y === 5)) continue;
        others.push(token(`rock${k++}`, { kind: "monster", name: "Rock", x, y, sceneId: "s1" }));
      }
    }
    const { copy } = astra([horse, bree, ...others]);
    assert.deepEqual(getOffPlace(copy, P1, copy.tokens.thorn!), { x: 5, y: 5, elevation: 0 });
    assert.notDeepEqual(getOffPlace(conservative(copy), P1, copy.tokens.thorn!), { x: 5, y: 5, elevation: 0 });
  });

  test("placing a companion beside its character", () => {
    // Every other spot beside Thorn is taken, so the one left is astra's walk's end.
    const others = [
      [6, 6],
      [6, 7],
      [5, 7],
      [4, 7],
      [4, 6],
      [4, 5],
      [6, 5],
    ].map(([x, y], k) => token(`rock${k}`, { kind: "monster", name: "Rock", x: x!, y: y!, sceneId: "s1" }));
    const { copy } = astra([hero(5, 6), ...others]);
    const spot = companionSpot(copy as never, copy.tokens.thorn!, { size: "medium" });
    assert.deepEqual(spot, { x: 5, y: 5 });
    assert.notDeepEqual(companionSpot(conservative(copy) as never, copy.tokens.thorn!, { size: "medium" }), { x: 5, y: 5 });
  });

  test("a door's reach, for the pill's list and its press", () => {
    // From (5, 5) the line to the door on cell (5, 5)'s east side starts inside the band, south of the wall.
    const { copy } = astra([hero(5, 5)], (state) => edge(state, "6,5,w", CLOSED));
    const reached = doorsInReach(copy, copy.tokens.thorn!, copy.fogTiles).map((d) => ("edge" in d.ref ? d.ref.edge : d.ref.id));
    assert.deepEqual(reached, ["6,5,w"]);
    assert.deepEqual(doorsInReach(conservative(copy), copy.tokens.thorn!, copy.fogTiles), []);
  });
});

describe("previews take the conservative test (5.2)", () => {
  test("a walking ruler holds at the wall the drop passes", () => {
    const { copy } = astra([hero(5, 6)]);
    const stops = [tokenStop(SQUARES, copy.tokens.thorn!), { x: 5.5, y: 5.5 }];
    const walk = measureWalk({ view: copy, sceneId: "s1", stops, viewer: { role: "player" }, everything: false });
    assert.ok(walk);
    const leg = walk.legs[0]!;
    assert.notDeepEqual(leg.to, { x: 5, y: 5 }, JSON.stringify(leg));
  });

  test("a preview view is kept per view and reads the build as a preview, a drop view as the gate", () => {
    const { copy } = astra([hero(5, 6)]);
    const view: DropView = dropView(copy, "player");
    assert.equal(previewView(view), previewView(view));
    assert.notEqual(previewView(view).buildChunks, view.buildChunks);
    assert.equal(planOne(previewView(view), copy.tokens.thorn!, { x: 5.3, y: 5.2 }, "walk").stop?.blocker, "wall");
  });
});

describe("every gate reads a piece within its band (MD4-ASTRA-1, MD4-LK-3)", () => {
  /** Astra's escape: wall (1, 1) to (7, 4), held as two pieces cut at x = 4 and rounded, and a Large creature at (2, 1) whose middle (3, 2) lies on the exact wall. */
  function escape(): { state: RoomState; copy: RoomState } {
    const state = fogRoom({ scene: { blockMovement: true } });
    wall(state, "aaaaaaaaaaaa", [1, 1], [7, 4]);
    lift(state, "dm", { x: 0, y: 0, w: 16, h: 12 });
    state.tokens = { thorn: hero(2, 1, { size: "large" }) };
    return { state, copy: projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState };
  }

  test("a creature overlapping a held wall leaves it every way the exact wall lets it, in a group and by the route search's step", () => {
    const { state, copy } = escape();
    assert.equal(Object.values(copy.buildChunks).flatMap((c) => c?.walls ?? []).length, 2, "the copy holds the wall as two pieces");
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1]] as const) {
      const to = { x: 2 + dx, y: 1 + dy, elevation: 0 };
      assert.equal(legStop(state, ownWalk(state.tokens.thorn!), to), null, `the exact wall lets it go (${dx}, ${dy})`);
      assert.deepEqual(planGroup(dropView(copy, "player"), [copy.tokens.thorn!], dx, dy, "walk").moves, [{ tokenId: "thorn", x: 2 + dx, y: 1 + dy }], `group (${dx}, ${dy})`);
      assert.equal(stepTester(copy, ownWalk(copy.tokens.thorn!))!.clear(2, 1, 2 + dx, 1 + dy), true, `step (${dx}, ${dy})`);
      // A preview, which nothing checks after, holds it there: the side its middle is on is not known within the band.
      assert.equal(stepTester(conservative(copy), ownWalk(copy.tokens.thorn!))!.clear(2, 1, 2 + dx, 1 + dy), false, `preview (${dx}, ${dy})`);
    }
  });

  test("a squeeze beside a tilted piece whose rounded end reaches a hair inside the squeezed footprint is allowed, as the exact wall allows it", () => {
    // A corridor between y = 5 and y = 6: its south wall runs from (14, 6) east, and a tilted wall meets it there from (12, 8).
    const state = fogRoom({ scene: { blockMovement: true } });
    wall(state, "nnnnnnnnnnnn", [10, 5], [16, 5]);
    wall(state, "mmmmmmmmmmmm", [16, 5], [20, 5]);
    wall(state, "ssssssssssss", [12, 8], [14, 6]);
    wall(state, "tttttttttttt", [14, 6], [20, 6]);
    lift(state, "dm", { x: 0, y: 0, w: 32, h: 16 });
    state.tokens = { thorn: hero(6, 4, { size: "large" }) };
    const copy = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const tilted = Object.values(copy.buildChunks).flatMap((c) => c?.walls ?? []).find((w) => w.a[1] > 8 && w.b[0] > 14);
    assert.ok(tilted, "the tilted piece's end is pushed past (14, 6), into the squeezed footprint");
    const at = { x: 13.5, y: 4.5 };
    assert.equal(squeezeFits(state, walkEnd(state, ownWalk(state.tokens.thorn!), at)), true, "the exact walls allow the squeeze");
    assert.equal(squeezeFits(copy, walkEnd(copy, ownWalk(copy.tokens.thorn!), at)), true, "and so does the gate");
  });
});

describe("a walk stopped at its first step sends nothing (D-261027-05)", () => {
  test("the plan holds no move, so the token stays in its square and its note has no walk to take back", () => {
    // Fully conservative, the walk stops where it starts: what a stop at the start would be on any device.
    const { copy } = astra([hero(5, 6)]);
    const plan = planOne(dropView(conservative(copy), "player"), copy.tokens.thorn!, { x: 5.3, y: 5.2 }, "walk");
    assert.deepEqual(plan.moves, []);
    assert.equal(plan.stop?.blocker, "wall");
    assert.ok(!("intended" in plan), JSON.stringify(plan));
    const sent: ClientOp[] = [];
    const notes: unknown[] = [];
    sendPlan(plan, { dispatch: (op) => (sent.push(op), 7), newId: () => "g", note: (n) => notes.push(n), shownNote: () => null, standing: () => null, attempts: new Map(), notify: () => {}, showActions: () => {} });
    assert.deepEqual(sent, []);
    assert.equal((notes[0] as { n: number | null }).n, null);
  });

  test("an arrow press into the wall sends nothing either, on fog on and fog off alike", () => {
    const { copy } = astra([hero(5, 6)]);
    for (const fogEnabled of [true, false]) {
      const view = { ...conservative(copy), scenes: { ...copy.scenes, s1: { ...copy.scenes.s1!, fogEnabled } } };
      const plan = planOne(dropView(view, "player"), copy.tokens.thorn!, { x: 5.3, y: 5.2 }, "walk");
      assert.deepEqual(plan.moves, [], `fog ${fogEnabled}`);
      assert.ok(plan.stop, `fog ${fogEnabled}`);
    }
  });
});
