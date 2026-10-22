import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiagonalRule } from "../model.ts";
import { legFeet } from "./distance.ts";
import { sizeCategory, sizeSteps } from "./footprint.ts";
import { legStop } from "./movement.ts";
import { onRouteLattice, routeFeet, routeLattice, routePoints, routeReach, routeSpots, routeStop, straightFeet, trueLength, type RoutePoint } from "./route.ts";
import { free, line, tok, world } from "./testWorld.ts";

const RULES: DiagonalRule[] = ["five", "fiveTen", "euclid"];
const at = (x: number, y: number, elevation = 0): RoutePoint => ({ x, y, elevation });
const plain = (n: number) => Array.from({ length: n }, () => ({ extra: 0, swim: 0 as const }));

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("routeFeet (docs/design-v1-movement.md 6.2)", () => {
  const opts = { swimSpeed: false, step: 1 };

  test("every diagonal 5 ft: each piece by its longer side, extras multiplying its feet", () => {
    const points = [at(0, 0), at(2, 0), at(4, 2), at(4, 4)];
    const out = routeFeet(points, [{ extra: 0, swim: 0 }, { extra: 1, swim: 0 }, { extra: 0, swim: 0 }], { feetPerCell: 5, diagonal: "five" }, { h: 0, v: 0 }, opts);
    assert.deepEqual(out, { moved: 30, cost: 40, diag: [0, 0] });
  });

  test("5-10-5: the count runs across pieces and from earlier legs, and a 10 ft diagonal into rubble costs 20 ft", () => {
    const rules = { feetPerCell: 5, diagonal: "fiveTen" as const };
    const first = routeFeet([at(0, 0), at(1, 1), at(2, 2)], [{ extra: 0, swim: 0 }, { extra: 1, swim: 0 }], rules, { h: 0, v: 0 }, opts);
    assert.deepEqual(first, { moved: 15, cost: 25, diag: [2, 0] });
    const second = routeFeet([at(2, 2), at(4, 4)], plain(1), rules, { h: 2, v: 0 }, opts);
    assert.deepEqual(second, { moved: 15, cost: 15, diag: [2, 0] });
    // An odd count carried in makes the first diagonal of the new leg the double one.
    const odd = routeFeet([at(0, 0), at(1, 1)], [{ extra: 1, swim: 0 }], rules, { h: 1, v: 0 }, opts);
    assert.deepEqual(odd, { moved: 10, cost: 20, diag: [1, 0] });
  });

  test("true distance: each piece its straight length, the leg rounded once", () => {
    const rules = { feetPerCell: 5, diagonal: "euclid" as const };
    assert.deepEqual(routeFeet([at(0, 0), at(3, 4)], plain(1), rules, { h: 0, v: 0 }, opts), { moved: 25, cost: 25, diag: [0, 0] });
    // 2 * sqrt(2) * 5 = 14.14, one rounding for the whole leg.
    const bent = routeFeet([at(0, 0), at(1, 1), at(2, 2), at(2, 3)], [{ extra: 0, swim: 0 }, { extra: 1, swim: 0 }, { extra: 0, swim: 0 }], rules, { h: 0, v: 0 }, opts);
    assert.deepEqual(bent, { moved: Math.round(10 * Math.SQRT2 + 5), cost: Math.round(15 * Math.SQRT2 + 5), diag: [0, 0] });
  });

  test("a leg rounds up to the token's own step: 5 ft on whole squares, 2.5 ft for Tiny", () => {
    const rules = { feetPerCell: 5, diagonal: "five" as const };
    assert.equal(routeFeet([at(0, 0), at(0.5, 0), at(0.5, 3)], plain(2), rules, { h: 0, v: 0 }, { swimSpeed: false, step: 1 }).moved, 20);
    assert.equal(routeFeet([at(0, 0), at(0.5, 0.5)], plain(1), rules, { h: 0, v: 0 }, { swimSpeed: false, step: 0.5 }).moved, 2.5);
    assert.equal(routeFeet([at(0, 0), at(0.5, 0)], [{ extra: 1, swim: 0 }], rules, { h: 0, v: 0 }, { swimSpeed: false, step: 0.5 }).cost, 5);
  });

  test("5-10-5 on half squares keeps four residues exactly", () => {
    const rules = { feetPerCell: 5, diagonal: "fiveTen" as const };
    // Eight half diagonals are four whole ones: 5, 10, 5, 10.
    const points = Array.from({ length: 9 }, (_, i) => at(i / 2, i / 2));
    const out = routeFeet(points, plain(8), rules, { h: 0, v: 0 }, { swimSpeed: false, step: 0.5 });
    assert.deepEqual(out, { moved: 30, cost: 30, diag: [4, 0] });
  });

  test("an elevation walk of +5, -10, +5 ft counts each rise", () => {
    const points = [at(0, 0, 0), at(1, 0, 5), at(2, 0, -5), at(3, 0, 0)];
    assert.equal(routeFeet(points, plain(3), { feetPerCell: 5, diagonal: "five" }, { h: 0, v: 0 }, opts).moved, 20);
    const counter = { h: 0, v: 0 };
    let expected = 0;
    for (let i = 1; i < points.length; i++) expected += legFeet(1, 0, Math.abs(points[i]!.elevation - points[i - 1]!.elevation) / 5, "fiveTen", 5, counter);
    const out = routeFeet(points, plain(3), { feetPerCell: 5, diagonal: "fiveTen" }, { h: 0, v: 0 }, opts);
    assert.equal(out.moved, expected);
    assert.deepEqual(out.diag, [counter.h, counter.v]);
  });

  test("a 1 ft rise on 5 ft squares stays exact in the vertical count", () => {
    const rules = { feetPerCell: 5, diagonal: "fiveTen" as const };
    // Ten rises of 1 ft add 2 squares to the vertical count, with no float drift on the way.
    const points = Array.from({ length: 11 }, (_, i) => at(i, 0, i));
    const out = routeFeet(points, plain(10), rules, { h: 0, v: 0 }, opts);
    assert.deepEqual(out.diag, [0, 2]);
  });

  test("the swimming foot comes off for a creature with a Swim Speed", () => {
    const rules = { feetPerCell: 5, diagonal: "five" as const };
    const swim = [{ extra: 1, swim: 1 as const }];
    assert.equal(routeFeet([at(0, 0), at(3, 0)], swim, rules, { h: 0, v: 0 }, { swimSpeed: false, step: 1 }).cost, 30);
    assert.equal(routeFeet([at(0, 0), at(3, 0)], swim, rules, { h: 0, v: 0 }, { swimSpeed: true, step: 1 }).cost, 15);
  });

  test("every open straight leg reads exactly as today's straight feet", () => {
    const rand = mulberry32(7);
    for (let run = 0; run < 2000; run++) {
      const diagonal = RULES[Math.floor(rand() * 3)]!;
      const feetPerCell = [5, 3, 1, 10][Math.floor(rand() * 4)]!;
      const size = (["tiny", "medium", "large", "huge"] as const)[Math.floor(rand() * 4)]!;
      const step = size === "tiny" ? 0.5 : 1;
      const token = { size, x: Math.floor(rand() * 10) * step, y: Math.floor(rand() * 10) * step };
      const k = 1 + Math.floor(rand() * 8);
      const [ux, uy] = ([[1, 0], [0, 1], [1, 1], [-1, 1], [-1, 0], [1, -1]] as const)[Math.floor(rand() * 6)]!;
      const to = { x: token.x + ux * k * step, y: token.y + uy * k * step };
      // A rise no steeper than the walk, so the rise never sets the leg's feet on its own.
      const rise = Math.floor(rand() * (Math.floor(k * step * feetPerCell) + 1));
      const counter = { h: Math.floor(rand() * 4), v: Math.floor(rand() * 3) };
      const rules = { feetPerCell, diagonal };
      const before = { ...counter };
      const today = straightFeet(token, { ...token, elevation: 0 }, { ...to, elevation: rise }, rules, before);
      const out = routeFeet([at(token.x, token.y), at(to.x, to.y, rise)], plain(1), rules, counter, { swimSpeed: false, step });
      assert.equal(out.moved, today, JSON.stringify({ diagonal, feetPerCell, size, token, to, rise, counter }));
      // The float count drifts where the exact one does not, a fifth of a square at a time.
      if (diagonal === "fiveTen") for (const [i, d] of [before.h - counter.h, before.v - counter.v].entries()) assert.ok(Math.abs(out.diag[i]! - d) < 1e-9);
    }
  });
});

describe("true distance's lengths", () => {
  test("a square root of a sum of squares, exact on whole triangles, so no engine's hypot decides a tie", () => {
    assert.equal(trueLength(3, 4, 0), 5);
    assert.equal(trueLength(2, 3, 6), 7);
    assert.equal(trueLength(1, 1, 0), Math.sqrt(2));
    assert.equal(trueLength(0.5, 0.5, 0), Math.sqrt(0.5));
  });
});

describe("routePoints and reach (6.1, section 10)", () => {
  test("a walker takes the ground at each piece's end, a flier keeps its height, the last the landing's", () => {
    const w = world({ heights: { "2,0": 5, "4,0": 10 } });
    const walker = tok(w, { x: 0, y: 0, elevation: 0 });
    const route = [[2, 0, 0, 0], [4, 0, 0, 0], [6, 0, 0, 0]] as const;
    assert.deepEqual(
      routePoints(w.buildChunks, walker, route, 0).map((p) => p.elevation),
      [0, 5, 10, 0],
    );
    const flier = tok(w, { x: 0, y: 0, elevation: 20 });
    assert.deepEqual(
      routePoints(w.buildChunks, flier, route, 20).map((p) => p.elevation),
      [20, 20, 20, 20],
    );
    assert.equal(routeReach([at(0, 0), at(3, 1), at(3, 1.5, 15)], 5), 3 + 3);
  });

  test("the lattice: half squares for Tiny and for creatures that squeeze, whole squares otherwise", () => {
    assert.equal(routeLattice({ size: "tiny", x: 0, y: 0 }), 0.5);
    assert.equal(routeLattice({ size: "medium", x: 0, y: 0 }), 1);
    assert.equal(routeLattice({ size: "large", x: 0, y: 0 }), 0.5);
    assert.equal(routeLattice({ size: "custom", w: 1, h: 3, x: 0, y: 0 }), 0.5);
    assert.ok(onRouteLattice({ x: 2.4, y: 0 }, { x: 3.9, y: 1.5 }));
    assert.ok(!onRouteLattice({ x: 2.4, y: 0 }, { x: 3, y: 1 }));
  });
});

describe("routeSpots (6.1, contract 4.3)", () => {
  const spotsOf = (s: ReturnType<typeof routeSpots>) => s.map((p) => [p.x, p.y]);

  test("straight and bent pieces step along the lattice, with progress on each", () => {
    const w = world({});
    const t = tok(w);
    const spots = routeSpots(w, [at(0, 0), at(2, 0), at(2, 2)], t);
    assert.deepEqual(spotsOf(spots), [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]);
    assert.deepEqual(
      spots.map((p) => p.progress),
      [[0, 0, 2], [0, 1, 2], [0, 2, 2], [1, 1, 2], [1, 2, 2]],
    );
    assert.ok(spots.every((p) => p.stand));
  });

  test("a piece off the eight directions snaps its spots as a stopped walk does", () => {
    const w = world({});
    const spots = routeSpots(w, [at(0, 0), at(3, 1)], tok(w));
    assert.deepEqual(spotsOf(spots), [[0, 0], [1, 0], [2, 1], [3, 1]]);
  });

  test("a Tiny creature steps by halves", () => {
    const w = world({});
    const spots = routeSpots(w, [at(0, 0), at(1, 0)], tok(w, { size: "tiny" }));
    assert.deepEqual(spotsOf(spots), [[0, 0], [0.5, 0], [1, 0]]);
    assert.ok(spots.every((p) => p.stand));
  });

  test("a Large creature squeezed along a 5 ft corridor stands only on its squeezed spots", () => {
    const w = world({ edges: { ...line("n", 3, 0, 12), ...line("n", 4, 0, 12) } });
    const ogre = tok(w, { size: "large", x: 0.5, y: 2.5, squeeze: true });
    const spots = routeSpots(w, [at(0.5, 2.5), at(4.5, 2.5)], ogre, undefined, { squeeze: true });
    assert.equal(spots.length, 9);
    for (const s of spots.slice(1)) {
      const whole = Number.isInteger(s.x - 0.5);
      assert.equal(s.squeezed, whole, `x ${s.x}`);
      assert.equal(s.stand, whole, `x ${s.x}`);
    }
  });

  test("a snapped spot whose cut piece clips a wall is no stand, though the straight leg is clear", () => {
    // Contract 4.3: a Medium creature from (0, 0) to (2, 1) past a wall from (1.25, 1.25) to (1.75, 1.25).
    const w = world({ walls: [free("w1", 1.25, 1.25, 1.75, 1.25)] });
    const t = tok(w);
    assert.equal(legStop(w, t, { x: 2, y: 1, elevation: 0 }), null);
    const spots = routeSpots(w, [at(0, 0), at(2, 1)], t);
    assert.deepEqual(spotsOf(spots), [[0, 0], [1, 1], [2, 1]]);
    assert.deepEqual(
      spots.map((p) => p.stand),
      [true, false, true],
    );
  });

  test("a spot past a wall a DM's straight leg crossed is no stand, and the start always is", () => {
    const w = world({ edges: line("w", 2, 0, 10) });
    const t = tok(w, { x: 0, y: 1 });
    const spots = routeSpots(w, [at(0, 1), at(4, 1)], t);
    assert.deepEqual(
      spots.map((p) => p.stand),
      [true, true, false, false, false],
    );
    const open = world({ blockMovement: false, edges: line("w", 2, 0, 10) });
    assert.deepEqual(
      routeSpots(open, [at(0, 1), at(4, 1)], tok(open, { x: 0, y: 1 })).map((p) => p.stand),
      [true, true, true, true, true],
    );
  });

  test("a walker's spots take the ground under them", () => {
    const w = world({ heights: { "1,0": 5, "2,0": 5 } });
    const spots = routeSpots(w, [at(0, 0), at(3, 0)], tok(w));
    assert.deepEqual(
      spots.map((p) => p.elevation),
      [0, 5, 5, 0],
    );
  });
});

describe("routeStop (6.1)", () => {
  test("a walk squeezes only where it starts: a later piece's ledges are judged on the full footprint, whichever way that falls", () => {
    // At (5, 7.5) its full footprint stands on the 10 ft cell (5, 9), so it walks on at 10 ft, and every ledge stops it, the 10 ft block at (7, 6) on its way. Its squeezed footprint there is off that cell, and would read it as flying at 10 ft, which that block does not stop.
    const block = world({ w: 14, h: 14, heights: { "7,6": 10, "5,9": 10 } });
    const ogre = tok(block, { size: "large", x: 3, y: 4, squeeze: true });
    assert.deepEqual(routeStop(block, ogre, [[5, 7.5, 0, 0], [6.5, 4.5, 0, 0], [1, 6.5, 0, 0]], 0), { piece: 1, blocker: "ledge" });
    // Here the walk starts inside the 5 ft cell (3, 3) and keeps its elevation. At (2, 1.5) its full footprint is still inside, where no ledge stops it. Its squeezed one there would stand on the ground, which every ledge stops.
    const rise = world({ w: 14, h: 14, heights: { "3,3": 5, "6,6": 5, "6,7": 10 } });
    const other = tok(rise, { size: "large", x: 2.5, y: 2, squeeze: true });
    assert.equal(routeStop(rise, other, [[2, 1.5, 0, 0], [6.5, 8, 0, 0]], 0), null);
  });
});

describe("sizeCategory (4.5)", () => {
  test("a standard size is itself, and a custom one is the smallest square that holds its longer side", () => {
    for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const) assert.equal(sizeCategory({ size }), size);
    const custom = (w: number, h: number) => sizeCategory({ size: "custom", w, h });
    assert.equal(custom(0.5, 0.5), "tiny");
    assert.equal(custom(0.7, 0.5), "medium");
    assert.equal(custom(1, 1), "medium");
    assert.equal(custom(2, 1), "large");
    assert.equal(custom(1, 3), "huge");
    assert.equal(custom(2.5, 2.5), "huge");
    assert.equal(custom(3.5, 1), "gargantuan");
  });

  test("sizeSteps counts the sizes between", () => {
    assert.equal(sizeSteps({ size: "tiny" }, { size: "large" }), 3);
    assert.equal(sizeSteps({ size: "medium" }, { size: "small" }), 1);
    assert.equal(sizeSteps({ size: "custom", w: 2, h: 2 }, { size: "huge" }), 1);
  });
});
