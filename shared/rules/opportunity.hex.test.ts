import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FreeWall, GridShape, RoomState, Token, Viewer } from "../model.ts";
import { actor, customMonster } from "../testutil.ts";
import { hexCenter, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { COLUMNS, ROWS, hexWallRoom, onHex, sideWall } from "./hexWalls.testkit.ts";
import { reachInput, reachScan, turnReach, type ReachLeave } from "./opportunity.ts";
import { orient } from "./segments.ts";

/**
 * Opportunity Attack notices on hexes (docs/design/design-v1-opportunity-attacks.md
 * 4 and 8): a walk steps hex by hex, a neighbor is one cell's feet, height
 * counts, and the two-sided point rule holds at hex vertices.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };
const NONE = { rolls: {}, monsters: [] } as const;

const E = 0;
const SE = 1;
const SW = 2;
const W = 3;
const NW = 4;

function step(g: HexGrid, h: Hex, d: number, n = 1): Hex {
  let at = h;
  for (let i = 0; i < n; i++) at = hexNeighbors(g, at)[d]!;
  return at;
}

function reacher(feet: number) {
  return customMonster("m1", { name: "Reacher", actions: [{ name: "Lash", text: `Melee Attack Roll: +5, reach ${feet} ft. Hit: 7.` }] });
}

function placed(state: RoomState, tokens: readonly Token[]): RoomState {
  state.tokens = Object.fromEntries(tokens.map((t) => [t.id, t]));
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off" };
  return state;
}

/** The leaves of a walk from the mover's hex through these hexes, the stops at the hexes' anchors for the mover's size. */
function walkOn(state: RoomState, g: HexGrid, moverId: string, hexes: readonly { hex: Hex; elevation?: number }[]): ReachLeave[] {
  const mover = state.tokens[moverId]!;
  const stops = hexes.map(({ hex, elevation }) => {
    const at = onHex(g, "x", mover.size, hex);
    return { x: at.x, y: at.y, elevation: elevation ?? 0 };
  });
  const read = reachInput(state, moverId, { turn: 1, stops }, NONE, DM);
  assert.ok(read);
  return turnReach(read.input, read.legs).flatMap((l) => (l.leaves === "over" ? [] : l.leaves));
}

for (const [name, g, shape] of [
  ["rows", ROWS, "hexRows"],
  ["columns", COLUMNS, "hexColumns"],
] as [string, HexGrid, GridShape][]) {
  describe(`on hex ${name}`, () => {
    const A: Hex = { col: 4, row: 4 };
    // A line from A's center to B's passes exactly through the vertex where P, P+E and P+SE meet, a third of the way.
    const B = step(g, step(g, A, E), SE, 4);
    const P = step(g, A, SE);
    const Q = step(g, P, E);
    const R = step(g, P, SE);
    const sides = (): FreeWall[] => [sideWall(g, P, E), sideWall(g, P, SE), sideWall(g, Q, SW)];

    const fight = (walls: readonly FreeWall[]) => {
      const state = placed(hexWallRoom(shape, 30, 30, walls), [onHex(g, "bree", "medium", A, { kind: "pc", disposition: "ally" }), onHex(g, "lash", "medium", B, { actor: { inline: actor({ monsterId: "m1" }) } })]);
      state.monsters = { m1: reacher(25) };
      return state;
    };
    // Two hexes away from B, past its 25 ft.
    const away = [{ hex: A }, { hex: step(g, A, NW) }];

    test("a walk away from a 25 ft reach leaves it with nothing between", () => {
      assert.equal(R.col !== Q.col || R.row !== Q.row, true);
      assert.deepEqual(walkOn(fight([]), g, "bree", away).map((l) => l.id), ["lash"]);
    });

    test("a vertex where three walls meet stops the line, being on both sides of it", () => {
      assert.deepEqual(walkOn(fight(sides()), g, "bree", away), []);
    });

    test("a vertex where two walls meet on one side of the line lets it pass, and two on both sides stop it", () => {
      const a = hexCenter(g, A);
      const b = hexCenter(g, B);
      const vertex = { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
      const all = sides();
      // Each side's end away from the shared vertex, on one side of the line or the other.
      const signs = all.map((w) => {
        const [x, y] = Math.hypot(w.a[0] - vertex.x, w.a[1] - vertex.y) < Math.hypot(w.b[0] - vertex.x, w.b[1] - vertex.y) ? w.b : w.a;
        return orient(a.x, a.y, b.x, b.y, x, y);
      });
      const pairs: [number, number][] = [
        [0, 1],
        [0, 2],
        [1, 2],
      ];
      const oneSide = pairs.find(([i, j]) => signs[i] === signs[j])!;
      const twoSides = pairs.find(([i, j]) => signs[i] !== signs[j])!;
      assert.ok(oneSide && twoSides, `sides at ${signs.join(", ")}`);
      assert.deepEqual(walkOn(fight([all[oneSide[0]]!, all[oneSide[1]]!]), g, "bree", away).map((l) => l.id), ["lash"]);
      assert.deepEqual(walkOn(fight([all[twoSides[0]]!, all[twoSides[1]]!]), g, "bree", away), []);
    });

    test("a line along a wall on a hex side is stopped, as a line along any wall is", () => {
      // From A to the hex past its east and south-east neighbors, the line runs along the side between them.
      const far = step(g, step(g, A, E), SE);
      const along = (walls: readonly FreeWall[]) => {
        const state = placed(hexWallRoom(shape, 30, 30, walls), [onHex(g, "bree", "medium", A, { kind: "pc", disposition: "ally" }), onHex(g, "lash", "medium", far, { actor: { inline: actor({ monsterId: "m1" }) } })]);
        state.monsters = { m1: reacher(10) };
        return walkOn(state, g, "bree", [{ hex: A }, { hex: step(g, A, W, 2) }]).map((l) => l.id);
      };
      assert.deepEqual(along([]), ["lash"]);
      assert.deepEqual(along([sideWall(g, step(g, A, E), SW)]), []);
    });

    test("a part joined across a resize walks at both sizes, the second walk starting again, which is no step", () => {
      // Walked toward the goblin at both sizes: the step from the first walk's end back to the part's start leaves nothing.
      const goblin = step(g, A, E, 6);
      const state = placed(hexWallRoom(shape, 30, 30, []), [onHex(g, "bree", "large", A, { kind: "pc", disposition: "ally" }), onHex(g, "g2", "medium", goblin, { actor: { inline: actor({ monsterId: "m1" }) } })]);
      // 15 ft, so the first walk ends within its reach and the second starts beyond it.
      state.monsters = { m1: reacher(15) };
      const from = onHex(g, "x", "medium", A);
      const to = onHex(g, "x", "large", step(g, goblin, W, 2));
      const read = reachInput(state, "bree", { turn: 1, stops: [{ x: from.x, y: from.y, elevation: 0, footprint: { w: 1, h: 1 } }, { x: to.x, y: to.y, elevation: 0 }] }, NONE, DM)!;
      assert.deepEqual(turnReach(read.input, read.legs).flatMap((l) => (l.leaves === "over" ? ["over"] : l.leaves.map((x) => x.id))), []);
    });

    test("a leg past the hard cap stops with over, and its slices report the work done", () => {
      const tokens = [onHex(g, "bree", "gargantuan", { col: 6, row: 10 }, { kind: "pc", disposition: "ally" })];
      for (let i = 0; i < 200; i++) tokens.push(onHex(g, `g${i}`, "gargantuan", { col: 10 + (i % 4), row: 10 + (Math.floor(i / 4) % 4) }, { actor: { inline: actor({ monsterId: "m1" }) } }));
      const state = placed(hexWallRoom(shape, 60, 60, []), tokens);
      state.monsters = { m1: reacher(30) };
      const start = state.tokens.bree!;
      // A walk back and forth within 30 ft of all of them, so none leaves and every spot tests every one.
      const via: number[] = [];
      for (let k = 0; k < 16; k++) via.push(start.x + (k % 2 ? 0 : 8), start.y + (k % 4) - 2);
      const read = reachInput(state, "bree", { turn: 1, stops: [{ x: start.x, y: start.y, elevation: 0 }, { x: start.x + 8, y: start.y, elevation: 0, via }] }, NONE, DM)!;
      const scan = reachScan(read.input, read.legs[0]!, new Set());
      let slices = 0;
      let step = scan.next();
      while (!step.done) {
        slices++;
        step = scan.next();
      }
      assert.equal(step.value, "over");
      assert.ok(slices >= 50, `about 100 slices of 20,000 units before 2,000,000 (${slices})`);
    });

    test("a neighbor on 10 ft hexes is 10 ft, beyond a 5 ft reach, so stepping away is no leave", () => {
      const state = placed(hexWallRoom(shape, 30, 30, []), [onHex(g, "bree", "medium", A, { kind: "pc", disposition: "ally" }), onHex(g, "g2", "medium", step(g, A, E))]);
      state.meta.settings = { ...state.meta.settings, feetPerCell: 10 };
      assert.deepEqual(walkOn(state, g, "bree", [{ hex: A }, { hex: step(g, A, W, 3) }]), []);
      state.meta.settings = { ...state.meta.settings, feetPerCell: 5 };
      assert.deepEqual(walkOn(state, g, "bree", [{ hex: A }, { hex: step(g, A, W, 3) }]).map((l) => l.id), ["g2"], "and 5 ft on 5 ft hexes");
    });

    test("a Large reactor on three hexes with 10 ft: the walk steps by hexes, and height counts", () => {
      const state = placed(hexWallRoom(shape, 30, 30, []), [onHex(g, "bree", "medium", A, { kind: "pc", disposition: "ally" }), onHex(g, "ogre", "large", step(g, A, E, 2), { actor: { inline: actor({ monsterId: "m1" }) } })]);
      state.monsters = { m1: reacher(10) };
      const leaves = walkOn(state, g, "bree", [{ hex: A }, { hex: step(g, A, W, 4) }]);
      assert.deepEqual(leaves.map((l) => [l.id, l.reach]), [["ogre", 10]]);
      const spot = leaves[0]!.spot;
      assert.ok(spot >= 1 && spot <= 3, `one hex a spot, leaving within three hexes (${spot})`);
      assert.deepEqual(walkOn(state, g, "bree", [{ hex: A }, { hex: A, elevation: 30 }]).map((l) => l.id), ["ogre"], "rising straight up");
      assert.deepEqual(walkOn(state, g, "bree", [{ hex: A }, { hex: A, elevation: 5 }]), [], "5 ft up is still within 10 ft");
    });
  });
}
