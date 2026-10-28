import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, WallFeature } from "../model.ts";
import { hexStandSize, occupiedHexes, placedOnHex, tokenRefHex } from "./footprint.ts";
import { hexCenter, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import {
  coreBlocked,
  hexLegOf,
  hexLegStop,
  hexNarrow,
  hexStandAt,
  hexStandPlace,
  hexWallsOf,
  landing,
  legStop,
  onSqueezedLattice,
  ownWalk,
  squeezeFits,
  walkEnd,
  WALL_IN_THE_WAY,
  type HexStand,
} from "./movement.ts";
import { NO_ROOM_TO_GROW, resizeRefusal, resizeSpot } from "./resize.ts";
import { COLUMNS, freeWall, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "./hexWalls.testkit.ts";

/**
 * Blocking and squeezing on hexes (docs/design-v1-hex-grids.md HX-D8 and
 * HX-D17): a step is allowed when every hex's center-to-center step meets
 * no movement wall and the footprint fits at its end, and a creature
 * squeezes onto the size one smaller only where no full footprint fits.
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  /** The direction from a hex to its neighbor along the lattice's own run: east on rows, south on columns. */
  const ALONG = 0;

  const legTo = (s: RoomState, t: Token, ref: Hex) => legStop(s, ownWalk(t), { ...placedOnHex(g, t, ref), elevation: 0 });
  const step = (h: Hex, d: number) => hexNeighbors(g, h)[d]!;

  describe(`${name}: a step meets the walls between hex centers (HX-D8)`, () => {
    test("a wall on the side between two hexes stops the step across it, and never one beside it", () => {
      const from: Hex = { col: 4, row: 4 };
      for (let d = 0; d < 6; d++) {
        const s = hexWallRoom(shape, 20, 14, [sideWall(g, from, d)]);
        const t = onHex(g, "m", "medium", from);
        for (let e = 0; e < 6; e++) assert.equal(legTo(s, t, step(from, e))?.blocker ?? null, e === d ? "wall" : null, `wall ${d}, step ${e}`);
      }
    });

    test("a wall that reaches across the line between two centers stops the step, one stopping short of it does not", () => {
      const from: Hex = { col: 4, row: 4 };
      const a = hexCenter(g, from);
      const b = hexCenter(g, step(from, ALONG));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const lattice = (v: number) => Math.round(v * 64) / 64;
      // A stub from a quarter cell off the line, across the run, ending a 64th past the line or a 64th before it.
      const across = (past: number) =>
        g.orient === "rows"
          ? freeWall({ x: lattice(mid.x), y: lattice(mid.y - 0.25) }, { x: lattice(mid.x), y: lattice(mid.y) + past / 64 + (lattice(mid.y) < mid.y ? 1 / 64 : 0) })
          : freeWall({ x: lattice(mid.x - 0.25), y: lattice(mid.y) }, { x: lattice(mid.x) + past / 64 + (lattice(mid.x) < mid.x ? 1 / 64 : 0), y: lattice(mid.y) });
      const t = onHex(g, "m", "medium", from);
      assert.equal(legTo(hexWallRoom(shape, 20, 14, [across(0)]), t, step(from, ALONG))?.blocker, "wall");
      assert.equal(legTo(hexWallRoom(shape, 20, 14, [across(-2)]), t, step(from, ALONG)), null);
    });

    test("a closed door and a window stop a step, an open door lets it by", () => {
      const from: Hex = { col: 6, row: 6 };
      const run = (f: WallFeature) => legTo(hexWallRoom(shape, 20, 14, [sideWall(g, from, ALONG, f)]), onHex(g, "m", "medium", from), step(from, ALONG))?.blocker ?? null;
      assert.equal(run({ kind: "door", state: "closed", secret: false, discovered: false }), "wall");
      assert.equal(run({ kind: "door", state: "locked", secret: false, discovered: false }), "wall");
      assert.equal(run({ kind: "window" }), "wall");
      assert.equal(run({ kind: "door", state: "open", secret: false, discovered: false }), null);
    });

    test("a creature a wall runs through steps off it to either side, and a step onto the wall is stopped", () => {
      const from: Hex = { col: 6, row: 6 };
      const c = hexCenter(g, from);
      // Across the run through the center, which lies on the 1/64 lattice that way: x on hex rows, y on hex columns.
      const wall = g.orient === "rows" ? freeWall({ x: c.x, y: Math.round((c.y - 0.75) * 64) / 64 }, { x: c.x, y: Math.round((c.y + 0.75) * 64) / 64 }) : freeWall({ x: Math.round((c.x - 0.75) * 64) / 64, y: c.y }, { x: Math.round((c.x + 0.75) * 64) / 64, y: c.y });
      const s = hexWallRoom(shape, 20, 14, [wall]);
      const t = onHex(g, "m", "medium", from);
      assert.equal(legTo(s, t, step(from, 0)), null, "off it one way");
      assert.equal(legTo(s, t, step(from, 3)), null, "off it the other");
      const before = onHex(g, "m", "medium", step(from, 3));
      assert.equal(legTo(s, before, from)?.blocker, "wall", "onto it, touching counts");
      // Leaving is a leg's first step only: two steps that come back to the wall's hex stop.
      assert.equal(legTo(s, t, step(step(from, 0), 0)), null, "off it and on");
    });

    test("every hex of a footprint steps: one straddling a wall cannot drag its far hexes across it", () => {
      const ref: Hex = { col: 6, row: 6 };
      const t = onHex(g, "big", "large", ref);
      const [, se, sw] = occupiedHexes(g, t);
      // The wall between its two lower hexes, which the hex trailing a step along it crosses.
      const d = hexNeighbors(g, sw!).findIndex((n) => n.col === se!.col && n.row === se!.row);
      const s = hexWallRoom(shape, 20, 14, [sideWall(g, sw!, d)]);
      assert.equal(legTo(s, t, step(ref, d))?.blocker, "wall");
      assert.equal(legTo(s, t, step(ref, (d + 3) % 6))?.blocker, "wall", "nor the leading one the other way");
    });

    test("the footprint fits at every step of a leg: a wall along a side no hex's step crosses still stops a walk past it", () => {
      const ref: Hex = { col: 6, row: 6 };
      const t = onHex(g, "big", "large", ref);
      const [top, se] = occupiedHexes(g, t);
      // Halfway along the leg, a wall on the side between its top hex and the one below, along the leg's run.
      const mid = step(step(ref, ALONG), ALONG);
      const d = hexNeighbors(g, top!).findIndex((n) => n.col === se!.col && n.row === se!.row);
      const s = hexWallRoom(shape, 20, 14, [sideWall(g, mid, d)]);
      const far = step(step(mid, ALONG), ALONG);
      assert.equal(legTo(s, t, far)?.blocker, "wall");
      const after = onHex(g, "big", "large", step(mid, ALONG));
      assert.equal(legTo(s, after, far), null, "past it the walk goes on");
    });

    test("a Large footprint stands only where no wall meets the line between two of its hexes", () => {
      const ref: Hex = { col: 6, row: 6 };
      const t = onHex(g, "big", "large", ref);
      const [top, a, b] = occupiedHexes(g, t);
      assert.ok(top && a && b);
      const d = hexNeighbors(g, a).findIndex((n) => n.col === b.col && n.row === b.row);
      const s = hexWallRoom(shape, 20, 14, [sideWall(g, a, d)]);
      assert.equal(coreBlocked(s, walkEnd(s, ownWalk(t), placedOnHex(g, t, ref))), true, "the wall splits its footprint");
      assert.equal(coreBlocked(s, walkEnd(s, ownWalk(t), placedOnHex(g, t, { col: 12, row: 6 }))), false, "it fits away from the wall");
      // A walk that ends there is stopped, from either side.
      const away = onHex(g, "big", "large", { col: 2, row: 6 });
      assert.equal(legTo(s, away, ref)?.blocker, "wall");
    });
  });

  describe(`${name}: a resize on a scene that stops moves reads the walls by the hex rules (HX-D8)`, () => {
    const sameHex = (a: Hex, b: Hex) => a.col === b.col && a.row === b.row;
    const sideOf = (a: Hex, b: Hex) => hexNeighbors(g, a).findIndex((n) => sameHex(n, b));

    test("a Medium growing Large with a wall across the footprint that keeps its hex takes another that fits, the base spot refused", () => {
      const ref: Hex = { col: 8, row: 6 };
      const t = onHex(g, "m", "medium", ref);
      const base = onHex(g, "b", "large", ref);
      const [, below] = occupiedHexes(g, base);
      const s = hexWallRoom(shape, 20, 14, [sideWall(g, ref, sideOf(ref, below!))]);
      assert.equal(resizeRefusal(s, t, { size: "large", x: base.x, y: base.y }), NO_ROOM_TO_GROW, "the wall splits the base footprint");
      const spot = resizeSpot(s, t, { size: "large" }, { checked: true });
      assert.ok(!("refused" in spot) && spot.shifted, `another footprint: ${JSON.stringify(spot)}`);
      assert.equal(resizeRefusal(s, t, { size: "large", x: spot.x, y: spot.y }), null, "the server takes the spot it moved to");
      const grown = occupiedHexes(g, { size: "large", x: spot.x, y: spot.y });
      assert.ok(grown.some((h) => sameHex(h, ref)), "it still covers the old hex");
      assert.equal(grown.some((h) => sameHex(h, below!)), false, "and stays off the wall's far side");
      assert.deepEqual(resizeSpot(hexWallRoom(shape, 20, 14, []), t, { size: "large" }, { checked: true }), { x: base.x, y: base.y, shifted: false }, "with no wall it keeps the base");
    });

    test("a Medium walled in on every side has no room to grow, and the DM's unchecked resize is never stopped", () => {
      const ref: Hex = { col: 8, row: 6 };
      const t = onHex(g, "m", "medium", ref);
      const s = hexWallRoom(shape, 20, 14, [0, 1, 2, 3, 4, 5].map((d) => sideWall(g, ref, d)));
      assert.deepEqual(resizeSpot(s, t, { size: "large" }, { checked: true }), { refused: NO_ROOM_TO_GROW });
      const base = onHex(g, "b", "large", ref);
      assert.deepEqual(resizeSpot(s, t, { size: "large" }, { checked: false }), { x: base.x, y: base.y, shifted: false });
    });

    test("a Large shrinking Medium onto a hex across a wall from its own is stopped, onto its own hex it goes", () => {
      const ref: Hex = { col: 8, row: 6 };
      const t = onHex(g, "big", "large", ref);
      const [, other] = occupiedHexes(g, t);
      // A wall put down through the creature after it stood there, between its reference hex and another of its hexes.
      const s = hexWallRoom(shape, 20, 14, [sideWall(g, ref, sideOf(ref, other!))]);
      const across = placedOnHex(g, { size: "medium", x: 0, y: 0 }, other!);
      assert.equal(resizeRefusal(s, t, { size: "medium", ...across }), WALL_IN_THE_WAY);
      const own = placedOnHex(g, { size: "medium", x: 0, y: 0 }, ref);
      assert.equal(resizeRefusal(s, t, { size: "medium", ...own }), null);
      const spot = resizeSpot(s, t, { size: "medium" }, { checked: true, remembered: across });
      assert.ok(!("refused" in spot));
      assert.deepEqual(tokenRefHex(g, { size: "medium", x: spot.x, y: spot.y }), ref, "the remembered spot across the wall gives way to its own hex");
    });
  });

  describe(`${name}: corridors and squeezing (HX-D8, HX-D17)`, () => {
    // A block of rock across the scene, a corridor through it along the lattice's run.
    const W = 22;
    const H = 16;
    const corridor = (rows: readonly number[]) =>
      hexWallRoom(shape, W, H, wallsRound(g, { w: W, h: H }, (h) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && !rows.includes(across);
      }));
    const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });

    test("a Large creature walks a two-row corridor full size", () => {
      const s = corridor([6, 7]);
      const t = onHex(g, "big", "large", at(3, 6));
      assert.equal(legTo(s, t, at(15, 6)), null);
    });

    test("in a one-row corridor it is stopped full size and walks squeezed onto one hex", () => {
      const s = corridor([6]);
      const t = onHex(g, "big", "large", at(3, 5));
      assert.equal(legTo(s, t, at(15, 5))?.blocker, "wall", "full size it never fits");
      const walls = hexWallsOf(s, t)!;
      const inside: HexStand = { size: "medium", ref: at(9, 6), squeezed: true };
      assert.equal(hexNarrow(walls, t, inside), true, "inside the corridor is a narrow space");
      const placed = hexStandPlace(g, t, inside);
      assert.equal(onSqueezedLattice(g, t, placed), true, "the stop says by where it stands that it squeezes");
      assert.equal(squeezeFits(s, walkEnd(s, ownWalk(t), placed)), true);
      // Squeezed from a hex in the corridor's mouth, along it to the far end.
      const mouth = onHex(g, "big", "large", at(5, 6), { squeeze: true });
      assert.equal(occupiedHexes(g, mouth).length, 1, "a squeezing Large creature stands on one hex");
      assert.equal(legStop(s, ownWalk(mouth), { ...hexStandPlace(g, t, { ...inside, ref: at(13, 6) }), elevation: 0 }), null);
      // Its squeezed leg stands up where it ends, which needs the full footprint to fit there.
      const out = hexLegOf(g, hexStandAt(g, mouth, mouth, true), hexStandAt(g, t, placedOnHex(g, t, at(14, 6)), false));
      assert.equal(out.squeezed, true);
      assert.equal(hexLegStop(walls, out), null, "out of the corridor it stands up in the open");
    });

    test("beside one wall in open ground a squeeze is refused: a full footprint holding it fits", () => {
      const s = hexWallRoom(shape, W, H, [sideWall(g, at(9, 6), 1), sideWall(g, at(9, 6), 2)]);
      const t = onHex(g, "big", "large", at(3, 3));
      const beside: HexStand = { size: "medium", ref: at(9, 6), squeezed: true };
      assert.equal(hexNarrow(hexWallsOf(s, t)!, t, beside), false);
      assert.equal(squeezeFits(s, walkEnd(s, ownWalk(t), hexStandPlace(g, t, beside))), false);
    });

    test("a Huge creature squeezes onto a Large one's three hexes, a Gargantuan onto a Huge one's seven", () => {
      for (const [size, small, n] of [["large", "medium", 1], ["huge", "large", 3], ["gargantuan", "huge", 7]] as const) {
        const t: Token = { ...onHex(g, "x", size, at(9, 6)), squeeze: true };
        assert.equal(hexStandSize(t), small);
        assert.equal(occupiedHexes(g, t).length, n);
      }
    });

    test("a player's drop into the corridor lands squeezed on its hex, and one past the rock is held at the wall", () => {
      const s = corridor([6]);
      const t = onHex(g, "big", "large", at(3, 5));
      const into = placedOnHex(g, t, at(9, 5));
      const land = landing(s, ownWalk(t), { ...into, elevation: 0 }, "free");
      assert.equal(land.squeeze, true, "the full footprint does not fit there, a squeezed one inside it does");
      assert.equal(onSqueezedLattice(g, t, land), true);
      const held = landing(s, ownWalk(t), { ...placedOnHex(g, t, at(15, 2)), elevation: 0 }, "walk");
      assert.equal(held.stopped?.blocker, "wall");
      assert.equal(legStop(s, ownWalk(t), { x: held.x, y: held.y, elevation: 0 }), null, "where it is held, its leg is clear");
    });
  });
}

describe("H1's footprints stay as they were", () => {
  test("an unsqueezed creature reads its own size's hexes on hexes", () => {
    const g: HexGrid = ROWS;
    for (const [size, n] of [["medium", 1], ["large", 3], ["huge", 7], ["gargantuan", 12]] as const) {
      const t = onHex(g, "x", size, { col: 8, row: 8 });
      assert.equal(occupiedHexes(g, t).length, n);
      assert.equal(hexStandSize(t), size);
    }
  });
});
