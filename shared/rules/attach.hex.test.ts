import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CreatureSize, Token } from "../model.ts";
import { rng, token } from "../testutil.ts";
import { attachDistanceFt, getOffFits, getOffSpot, hexPlacements, insideHolder, kindRefusal, linkHolds, overlaps, seatedAt, seatSpot, squeezedSeatsApart, withinReach } from "./attach.ts";
import { dismountCost, dismountSplit } from "./dismount.ts";
import { hexAnchor, occupiedHexes, placedOnHex } from "./footprint.ts";
import { ownWalk } from "./movement.ts";
import { hexDistance, hexInScene, hexKey, hexLine, type Hex, type HexGrid } from "./hex.ts";
import type { RoutePiece } from "./route.ts";

/**
 * Riding, carrying and dragging on hexes (docs/design/design-v1-hex-grids.md phase
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

  test("a routed walk off a Large mount counts hex steps for both parts, as the straight walk does", () => {
    for (const g of GRIDS) {
      const horse = on(g, "horse", "large", { col: 5, row: 3 });
      const seat = ownWalk({ ...on(g, "bree", "medium", { col: 5, row: 3 }), sceneId: "s1" });
      assert.ok(keys(g, horse).has("5,3"), "the seat is on the horse");
      const end = placedOnHex(g, seat, { col: 5, row: 13 });
      const points = [
        { x: seat.x, y: seat.y, elevation: 0 },
        { x: end.x, y: end.y, elevation: 0 },
      ];
      const route: RoutePiece[] = [[end.x, end.y, 0, 0]];
      const cost = (r?: RoutePiece[]) => dismountCost(g, { buildChunks: {} }, seat, horse, points, r, rules, { h: 0, v: 0 }, 15, false);
      // 10 hex steps: on hex rows two to the first hex clear of the horse for the 15 ft charge and 8 more at 5 ft each, on hex columns one and 9.
      const charged = g.orient === "rows" ? 15 + 8 * 5 : 15 + 9 * 5;
      assert.deepEqual({ moved: cost(route).moved, cost: cost(route).cost }, { moved: 50, cost: charged }, `${g.orient}: routed`);
      assert.deepEqual(cost(route), cost(), `${g.orient}: as the straight walk`);
    }
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

/**
 * Seats apart on hexes (SEAT-TIE-HEX, D-261107-173, D-261107-253,
 * DR-ASTRA-16, migrate.ts seatsApartOnHexes): where a holder stands
 * squeezed, each passenger takes a placement whose hexes all lie on the
 * squeezed stand and are free, nearest the seat the walk carries it to
 * first. One left with none free shares its nearest valid one, and one
 * with no valid placement at all keeps its carried seat.
 */
describe("seats apart on a squeezed hex holder", () => {
  /** A Huge mount whose stored box stands squeezed onto three hexes at `ref`, its box as the move leaves it. */
  function squeezedHuge(g: HexGrid, ref: Hex): { mount: Token; at: { x: number; y: number }; stand: Set<string> } {
    const mount = on(g, "mount", "huge", { col: 8, row: 8 });
    const small = on(g, "probe", "large", ref);
    // A squeezed Huge creature stands on a Large one's anchor, with its own box round it.
    const at = { x: small.x - 0.5, y: small.y - 0.5 };
    const stand = keys(g, { ...mount, ...at, squeeze: true });
    assert.equal(stand.size, 3, `${g.orient}: three hexes squeezed`);
    return { mount, at, stand };
  }

  test("4 riders on a squeezed Huge mount, one of them Large: the Large one on its one valid placement, which covers all three hexes, and the rest share, whichever is taken first", () => {
    for (const g of GRIDS) {
      const { mount, at, stand } = squeezedHuge(g, { col: 8, row: 8 });
      const large = on(g, "a-large", "large", { col: 8, row: 8 });
      const mediums = [...stand].map((k, i) => {
        const [col, row] = k.split(",").map(Number) as [number, number];
        return on(g, `m${i}`, "medium", { col, row });
      });
      const placements = hexPlacements(g, large, [...stand].map((k) => ({ col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })));
      assert.equal(placements.length, 1, `${g.orient}: the Large rider has one placement`);
      assert.deepEqual(new Set(placements[0]!.hexes.map(hexKey)), stand, `${g.orient}: and it covers the whole stand`);
      // Its carried seat lies on the placement where it rides the middle of the mount, so it is taken first. Offset far, a Medium
      // rider on a stand hex is taken first, and the Large one then shares its one placement.
      for (const [label, rider] of [["first", large], ["after a Medium one", { ...large, x: large.x + 3, y: large.y + 3 }]] as const) {
        const seats = squeezedSeatsApart(g, mount, at, [[rider, ...mediums]]);
        const seat = seats.get(large.id)!;
        assert.deepEqual(keys(g, { ...large, ...seat }), stand, `${g.orient}, Large ${label}: on its one placement`);
        for (const m of mediums) assert.ok(stand.has(hexKey(occupiedHexes(g, { ...m, ...seats.get(m.id)! })[0]!)), `${g.orient}, Large ${label}: ${m.id} on the stand`);
        const free = [...stand].filter((k) => ![rider, ...mediums].some((t) => keys(g, { ...t, ...seats.get(t.id)! }).has(k)));
        assert.deepEqual(free, [], `${g.orient}, Large ${label}: no hex left free`);
      }
    }
  });

  test("a Large rider taken first reserves every hex of its placement: a Medium one beside it shares its nearest hex, never one the Large covers as if free", () => {
    for (const g of GRIDS) {
      const { mount, at, stand } = squeezedHuge(g, { col: 8, row: 8 });
      const probe = on(g, "a-large", "large", { col: 8, row: 8 });
      const place = hexPlacements(g, probe, [...stand].map((k) => ({ col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })))[0]!;
      // The walk carries each seat by the mount's move to `at`: the Large one's onto its placement exactly, so it goes first, and the
      // Medium one's a hair off the placement's first hex.
      const by = { x: at.x - mount.x, y: at.y - mount.y };
      const large = { ...probe, x: place.spot.x - by.x, y: place.spot.y - by.y };
      const first = place.hexes[0]!;
      const spot = placedOnHex(g, { ...probe, size: "medium" }, first);
      const medium = { ...on(g, "b-medium", "medium", first), x: spot.x - by.x + 0.05, y: spot.y - by.y };
      const seats = squeezedSeatsApart(g, mount, at, [[large, medium]]);
      assert.deepEqual(keys(g, { ...large, ...seats.get(large.id)! }), stand, `${g.orient}: the Large one on the stand`);
      assert.equal(hexKey(occupiedHexes(g, { ...medium, ...seats.get(medium.id)! })[0]!), hexKey(first), `${g.orient}: the Medium one on its nearest hex, shared`);
    }
  });

  test("three Medium riders take the three hexes, a fourth shares its nearest, and a Huge one with no placement at all keeps its carried seat", () => {
    for (const g of GRIDS) {
      const { mount, at, stand } = squeezedHuge(g, { col: 8, row: 8 });
      const riders = [0, 1, 2, 3].map((i) => on(g, `m${i}`, "medium", occupiedHexes(g, mount)[i]!));
      const seats = squeezedSeatsApart(g, mount, at, [riders]);
      const hexes = riders.map((t) => hexKey(occupiedHexes(g, { ...t, ...seats.get(t.id)! })[0]!));
      assert.ok(hexes.every((k) => stand.has(k)), `${g.orient}: every one on the stand`);
      assert.equal(new Set(hexes).size, 3, `${g.orient}: the stand's three hexes taken, and the fourth shares one`);
      // A Huge passenger on a Huge cart squeezed onto three hexes has no placement there: it keeps the seat the walk carries it to.
      const huge = on(g, "huge", "huge", { col: 8, row: 8 });
      assert.equal(hexPlacements(g, huge, occupiedHexes(g, { ...mount, ...at, squeeze: true })).length, 0);
      const alone = squeezedSeatsApart(g, mount, at, [[huge, ...riders.slice(0, 3)]]);
      assert.deepEqual(alone.get("huge"), seatedAt(g, huge, mount, at, true), `${g.orient}: its carried seat`);
      assert.deepEqual(alone.get("huge"), { x: huge.x + at.x - mount.x, y: huge.y + at.y - mount.y }, `${g.orient}: carried by the mount's move`);
      assert.equal(new Set(riders.slice(0, 3).map((t) => hexKey(occupiedHexes(g, { ...t, ...alone.get(t.id)! })[0]!))).size, 3, `${g.orient}: the Medium ones still take all three`);
    }
  });

  test("passengers no player sees are seated after the rest and move no public seat", () => {
    const r = rng(73);
    for (const g of GRIDS) {
      for (let i = 0; i < 60; i++) {
        const { mount, at, stand } = squeezedHuge(g, { col: 8, row: 8 });
        const own = occupiedHexes(g, mount);
        const shown = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => on(g, `s${k}`, r() < 0.2 ? "large" : "medium", own[Math.floor(r() * own.length)]!));
        const hidden = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => on(g, `h${k}`, r() < 0.2 ? "large" : "medium", own[Math.floor(r() * own.length)]!));
        const without = squeezedSeatsApart(g, mount, at, [shown, []]);
        const withHidden = squeezedSeatsApart(g, mount, at, [shown, hidden]);
        for (const t of shown) assert.deepEqual(withHidden.get(t.id), without.get(t.id), `${g.orient} ${i}: ${t.id}`);
        // No two share a hex while one of them has a placement free of every other passenger's hexes.
        const all = [...shown, ...hidden];
        const taken = (id: string) => keys(g, { ...all.find((t) => t.id === id)!, ...withHidden.get(id)! });
        for (const t of all) {
          const mine = taken(t.id);
          const others = new Set(all.filter((o) => o.id !== t.id).flatMap((o) => [...taken(o.id)]));
          if (![...mine].some((k) => others.has(k))) continue;
          const spots = hexPlacements(g, t, [...stand].map((k) => ({ col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })));
          assert.ok(spots.every((p) => p.hexes.some((h) => others.has(hexKey(h)))), `${g.orient} ${i}: ${t.id} shares with a free placement left`);
        }
      }
    }
  });
});
