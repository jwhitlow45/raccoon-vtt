import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CreatureSize, Token } from "../model.ts";
import { rng, token } from "../testutil.ts";
import { attachDistanceFt, getOffFits, getOffSpot, insideHolder, kindRefusal, linkHolds, overlaps, seatSpot, withinReach } from "./attach.ts";
import { dismountSplit } from "./dismount.ts";
import { hexAnchor, occupiedHexes, placedOnHex } from "./footprint.ts";
import { ownWalk } from "./movement.ts";
import { hexDistance, hexInScene, hexKey, hexLine, type Hex, type HexGrid } from "./hex.ts";

/**
 * Riding, carrying and dragging on hexes (docs/design-v1-hex-grids.md phase
 * H2): a seat is a set of hexes inside the holder's, two tokens overlap when
 * they share a hex, reach counts hex steps, and a place to get off is a hex
 * placed spot beside the holder.
 */
const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS = [ROWS, COLUMNS];
const NAMES = { carried: "Bree", holder: "Warhorse" };
const SIZES: CreatureSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const HEXES: Record<string, number> = { tiny: 1, small: 1, medium: 1, large: 3, huge: 7, gargantuan: 12 };
const RANK: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5 };
const rules = { feetPerCell: 5, diagonal: "five" as const };
const BOUNDS = { w: 30, h: 30 };

/** A creature of a size whose reference hex is `ref`, its box placed as a move on hexes places it. */
function on(g: HexGrid, id: string, size: CreatureSize, ref: Hex, overrides: Partial<Token> = {}): Token {
  const base = token(id, { size, x: 0, y: 0, ...overrides });
  return { ...base, ...placedOnHex(g, base, ref) };
}

function keys(g: HexGrid, t: Token): Set<string> {
  return new Set(occupiedHexes(g, t).map(hexKey));
}

describe("seats on hexes", () => {
  test("a Medium rider's seat on a Large horse is one of its three hexes, the nearest to where the rider stands", () => {
    for (const g of GRIDS) {
      const horse = on(g, "horse", "large", { col: 6, row: 6 });
      const held = keys(g, horse);
      const rider = on(g, "bree", "medium", { col: 9, row: 6 });
      const seat = seatSpot(g, rider, horse);
      assert.ok(seat, g.orient);
      const seated = { ...rider, ...seat };
      assert.ok(held.has(hexKey(occupiedHexes(g, seated)[0]!)), `${g.orient}: the seat is on the horse`);
      // The seat stands on its own hex's anchor, as a snap would put it.
      assert.deepEqual(hexAnchor(g, seated), { x: seated.x + 0.5, y: seated.y + 0.5 }, g.orient);
      assert.equal(linkHolds(g, rules, "ride", { ...seated, sceneId: "s1" }, { ...horse, sceneId: "s1" }), true, g.orient);
      // The nearest of the three: no other hex of the horse is nearer to where the rider stood.
      const from = hexAnchor(g, rider);
      const d = (t: Token) => Math.hypot(hexAnchor(g, t).x - from.x, hexAnchor(g, t).y - from.y);
      for (const h of occupiedHexes(g, horse)) assert.ok(d(seated) <= d({ ...rider, ...placedOnHex(g, rider, h) }) + 1e-9, `${g.orient}: ${hexKey(h)}`);
    }
  });

  test("every size seats inside every size with as many hexes or more, on random spots", () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const g = GRIDS[i % 2]!;
      const carriedSize = SIZES[Math.floor(r() * SIZES.length)]!;
      const holderSize = SIZES[Math.floor(r() * SIZES.length)]!;
      const holder = on(g, "h", holderSize, { col: 5 + Math.floor(r() * 10), row: 5 + Math.floor(r() * 10) });
      const carried = on(g, "c", carriedSize, { col: Math.floor(r() * 25), row: Math.floor(r() * 25) });
      const seat = seatSpot(g, carried, holder);
      const fits = HEXES[carriedSize]! <= HEXES[holderSize]!;
      assert.equal(seat !== null, fits, `${carriedSize} on ${holderSize}, ${g.orient}`);
      if (!seat) continue;
      const seated = { ...carried, ...seat };
      assert.equal(insideHolder(g, seated, holder), true, `${carriedSize} on ${holderSize}, ${g.orient}`);
      const held = keys(g, holder);
      for (const h of occupiedHexes(g, seated)) assert.ok(held.has(hexKey(h)), `${carriedSize} on ${holderSize}, ${g.orient}: ${hexKey(h)}`);
    }
  });

  test("a ride needs a mount at least one size larger whose hexes hold the rider's, for every pair of sizes", () => {
    for (const g of GRIDS) {
      for (const rider of SIZES) {
        for (const mount of SIZES) {
          const refusal = kindRefusal("ride", on(g, "r", rider, { col: 3, row: 3 }), on(g, "m", mount, { col: 8, row: 8 }), NAMES);
          const fits = rider !== "tiny" && RANK[mount]! - RANK[rider]! >= 1 && HEXES[rider]! <= HEXES[mount]!;
          assert.equal(refusal === null, fits, `${rider} on ${mount}, ${g.orient}: ${refusal}`);
        }
      }
      // A passenger on a cart only has to fit: a Medium crate on a Medium cart shares its one hex, a Large one does not fit.
      const cart = on(g, "cart", "medium", { col: 4, row: 4 }, { kind: "object" });
      assert.equal(kindRefusal("carry", on(g, "c", "small", { col: 1, row: 1 }, { kind: "object" }), cart, NAMES), null);
      assert.equal(kindRefusal("carry", on(g, "c", "large", { col: 1, row: 1 }, { kind: "object" }), cart, NAMES), "Warhorse is not big enough to carry Bree");
    }
  });

  test("a seat holds only on the holder's hexes, where the square boxes would say it holds beside them", () => {
    const horse = on(ROWS, "horse", "large", { col: 2, row: 2 });
    // The hex east of the horse's top hex: its box overlaps the horse's 2 by 2 box, yet it is no hex of the horse.
    const beside = on(ROWS, "bree", "medium", { col: 3, row: 2 });
    assert.equal(insideHolder(ROWS, beside, horse), false);
    assert.equal(overlaps(ROWS, beside, horse), false, "beside, sharing no hex");
    assert.equal(overlaps(ROWS, on(ROWS, "bree", "medium", { col: 2, row: 2 }), horse), true, "on its top hex");
  });
});

describe("reach on hexes", () => {
  test("a drag reaches the hexes next to the holder's and no farther, by hex steps", () => {
    for (const g of GRIDS) {
      const thorn = on(g, "thorn", "medium", { col: 6, row: 6 });
      for (let col = 2; col <= 10; col++) {
        for (let row = 2; row <= 10; row++) {
          const gob = on(g, "gob", "medium", { col, row });
          const steps = hexDistance(g, { col, row }, { col: 6, row: 6 });
          assert.equal(attachDistanceFt(g, rules, gob, thorn), steps * 5, `${g.orient} ${col},${row}`);
          assert.equal(withinReach(g, rules, gob, thorn), steps <= 1, `${g.orient} ${col},${row}`);
        }
      }
    }
  });
});

describe("getting off on hexes", () => {
  test("the place found is beside the holder: inside the scene, sharing no hex, in reach, its anchor a hex's", () => {
    const r = rng(5);
    for (let i = 0; i < 200; i++) {
      const g = GRIDS[i % 2]!;
      const holderSize = SIZES[3 + Math.floor(r() * 3)]!;
      const riderSize = SIZES[Math.floor(r() * 3)]!;
      const holder = on(g, "h", holderSize, { col: 1 + Math.floor(r() * 26), row: 1 + Math.floor(r() * 26) });
      const rider = on(g, "r", riderSize, { col: 0, row: 0 });
      const spot = getOffSpot(g, rules, BOUNDS, rider, holder);
      assert.ok(spot, `${riderSize} off ${holderSize}, ${g.orient}`);
      const off = { ...rider, ...spot };
      assert.equal(getOffFits(g, rules, BOUNDS, rider, holder, spot), true);
      assert.equal(overlaps(g, off, holder), false);
      assert.equal(withinReach(g, rules, off, holder), true);
      for (const h of occupiedHexes(g, off)) assert.ok(hexInScene(g, BOUNDS, h), hexKey(h));
      const ref = occupiedHexes(g, off)[0]!;
      assert.deepEqual(spot, placedOnHex(g, off, ref), "on its reference hex's anchor");
    }
  });

  test("the first place is due east of the holder's reference hex, then on round clockwise", () => {
    const horse = on(ROWS, "horse", "huge", { col: 8, row: 8 });
    const bree = on(ROWS, "bree", "medium", { col: 0, row: 0 });
    // A Huge horse covers its center and the six around it, so the first free ring is two steps out, from the east.
    assert.deepEqual(getOffSpot(ROWS, rules, BOUNDS, bree, horse), placedOnHex(ROWS, bree, { col: 10, row: 8 }));
    // With the east taken, the next clockwise hex on that ring.
    const taken = placedOnHex(ROWS, bree, { col: 10, row: 8 });
    const next = getOffSpot(ROWS, rules, BOUNDS, bree, horse, (s) => s.x !== taken.x || s.y !== taken.y);
    assert.deepEqual(next, placedOnHex(ROWS, bree, { col: 9, row: 9 }));
  });

  test("a place off the scene's hexes, on the holder or out of reach is refused", () => {
    // A Large horse on 1,0, 1,1 and 0,1: the hex west of 0,1 is beside it but past the scene's left edge.
    const horse = on(ROWS, "horse", "large", { col: 1, row: 0 });
    const bree = on(ROWS, "bree", "medium", { col: 0, row: 0 });
    assert.deepEqual(occupiedHexes(ROWS, horse).map(hexKey), ["1,0", "1,1", "0,1"]);
    assert.equal(getOffFits(ROWS, rules, BOUNDS, bree, horse, placedOnHex(ROWS, bree, { col: 1, row: 0 })), false, "on its top hex");
    assert.equal(getOffFits(ROWS, rules, BOUNDS, bree, horse, placedOnHex(ROWS, bree, { col: 6, row: 0 })), false, "out of reach");
    assert.equal(getOffFits(ROWS, rules, BOUNDS, bree, horse, placedOnHex(ROWS, bree, { col: -1, row: 1 })), false, "off the scene");
    assert.equal(getOffFits(ROWS, rules, BOUNDS, bree, horse, placedOnHex(ROWS, bree, { col: 0, row: 0 })), true, "beside it");
  });

  test("a rider walking off a Large mount clears it at the first hex of its hex line outside the mount's hexes", () => {
    for (const g of GRIDS) {
      const horse = on(g, "horse", "large", { col: 4, row: 4 });
      const held = keys(g, horse);
      const seat = ownWalk({ ...on(g, "bree", "medium", { col: 4, row: 4 }), sceneId: "s1" });
      for (const to of [{ col: 6, row: 9 }, { col: 1, row: 8 }, { col: 9, row: 5 }]) {
        const end = placedOnHex(g, seat, to);
        const split = dismountSplit(g, { buildChunks: {} }, seat, horse, [
          { x: seat.x, y: seat.y, elevation: 0 },
          { x: end.x, y: end.y, elevation: 0 },
        ]);
        const first = hexLine(g, { col: 4, row: 4 }, to).find((h) => !held.has(hexKey(h)))!;
        assert.deepEqual({ x: split.off.x, y: split.off.y }, placedOnHex(g, seat, first), `${g.orient} to ${hexKey(to)}`);
      }
    }
  });
});
