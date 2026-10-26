import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, hexNeighbors, type HexGrid } from "#shared/rules/hex.ts";
import { hexAnchor, occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { walksOn, WALKING_NEEDS_SQUARES } from "./rulerStore.ts";
import {
  allStops,
  beginGesture,
  dragTo,
  drawnPoints,
  formatFeet,
  freeStop,
  isDoubleTap,
  keepPlan,
  keptDrawing,
  keptStops,
  lift,
  measureStops,
  release,
  stopAt,
  tokenStop,
  type LastTap,
  type RulerState,
  type RulerToken,
} from "./ruler.ts";

const five = { feetPerCell: 5, diagonal: "five" as const };
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" as const };
const euclid = { feetPerCell: 5, diagonal: "euclid" as const };

function tok(id: string, over: Partial<RulerToken> = {}): RulerToken {
  return { id, size: "medium", x: 0, y: 0, elevation: 0, ...over };
}

const none: Record<string, RulerToken> = {};
let ids = 0;
const newId = () => `r${++ids}`;

describe("ruler measurement", () => {
  test("free points snap to cell centers and count whole steps", () => {
    assert.deepEqual(freeStop(SQUARES, { x: 2.2, y: 7.9 }), { x: 2.5, y: 7.5 });
    const { totalFt, legsFt } = measureStops(SQUARES, [freeStop(SQUARES, { x: 0.2, y: 0.2 }), freeStop(SQUARES, { x: 3.6, y: 0.1 })], none, five);
    assert.equal(totalFt, 15);
    assert.deepEqual(legsFt, [15]);
  });

  test("waypoints sum their legs", () => {
    const stops = [freeStop(SQUARES, { x: 0, y: 0 }), freeStop(SQUARES, { x: 4, y: 0 }), freeStop(SQUARES, { x: 4, y: 3 })];
    assert.deepEqual(measureStops(SQUARES, stops, none, five), { totalFt: 35, legsFt: [20, 15] });
  });

  test("fiveTen carries its diagonal count across waypoints", () => {
    // Two legs of one diagonal step each. Alone each is 5 ft, but the second
    // diagonal of the path costs 10 ft, so the path is 15 ft, not 10.
    const stops = [freeStop(SQUARES, { x: 0, y: 0 }), freeStop(SQUARES, { x: 1, y: 1 }), freeStop(SQUARES, { x: 2, y: 2 })];
    assert.deepEqual(measureStops(SQUARES, stops, none, fiveTen), { totalFt: 15, legsFt: [5, 10] });
    // The same path in one leg reads the same total.
    assert.equal(measureStops(SQUARES, [stops[0]!, stops[2]!], none, fiveTen).totalFt, 15);
    // Three diagonals: 5 + 10 + 5.
    const three = [0, 1, 2, 3].map((i) => freeStop(SQUARES, { x: i, y: i }));
    assert.deepEqual(measureStops(SQUARES, three, none, fiveTen), { totalFt: 20, legsFt: [5, 10, 5] });
    assert.equal(measureStops(SQUARES, three, none, five).totalFt, 15);
  });

  test("starting on a token measures from its edge", () => {
    const ogre = tok("ogre", { size: "large", x: 0, y: 0 });
    const tokens = { ogre };
    // The Large ogre covers columns 0 and 1. Column 2 is adjacent: 5 ft.
    assert.equal(measureStops(SQUARES, [tokenStop(SQUARES, ogre), freeStop(SQUARES, { x: 2, y: 0 })], tokens, five).totalFt, 5);
    assert.equal(measureStops(SQUARES, [tokenStop(SQUARES, ogre), freeStop(SQUARES, { x: 5, y: 1 })], tokens, five).totalFt, 20);
    // From the ogre's center it would have been 25 ft.
    assert.equal(measureStops(SQUARES, [freeStop(SQUARES, { x: 1, y: 1 }), freeStop(SQUARES, { x: 5, y: 1 })], tokens, five).totalFt, 20);
    assert.equal(measureStops(SQUARES, [freeStop(SQUARES, { x: 0, y: 0 }), freeStop(SQUARES, { x: 5, y: 1 })], tokens, five).totalFt, 25);
  });

  test("elevation counts in 3D when stops are on tokens at different heights", () => {
    const thorn = tok("thorn", { x: 0, y: 0 });
    const vex = tok("vex", { x: 3, y: 0, elevation: 30 });
    const tokens = { thorn, vex };
    // 3 steps apart on the ground and 6 up (30 ft over a 5 ft tall Thorn): "five" takes the larger.
    assert.equal(measureStops(SQUARES, [tokenStop(SQUARES, thorn), tokenStop(SQUARES, vex)], tokens, five).totalFt, 30);
    assert.equal(measureStops(SQUARES, [tokenStop(SQUARES, thorn), tokenStop(SQUARES, vex)], tokens, euclid).totalFt, Math.round(Math.hypot(3, 0, 6) * 5));
    // A free stop stands on the ground.
    assert.equal(measureStops(SQUARES, [tokenStop(SQUARES, vex), freeStop(SQUARES, { x: 3, y: 0 })], tokens, five).totalFt, 30);
  });

  test("a free stop stands on the ground the measurer reads, left out at 0, and a stop on a token on none", () => {
    // A platform 10 ft up east of column 5, and the measurer cannot see column 8, so it reads 0 there.
    const ground = (c: { x: number; y: number }) => (c.x >= 8 ? 0 : c.x >= 6 ? 10 : 0);
    assert.deepEqual(freeStop(SQUARES, { x: 6.2, y: 12.7 }, ground), { x: 6.5, y: 12.5, z: 10 });
    assert.deepEqual(freeStop(SQUARES, { x: 5.9, y: 12.7 }, ground), { x: 5.5, y: 12.5 }, "no z at 0");
    assert.deepEqual(freeStop(SQUARES, { x: 8.1, y: 12.7 }, ground), { x: 8.5, y: 12.5 }, "no z on unseen ground");
    const ogre = tok("ogre", { x: 6, y: 12 });
    assert.deepEqual(stopAt(SQUARES, { x: 6.2, y: 12.7 }, ogre, ground), { x: 6.5, y: 12.5, tokenId: "ogre" }, "a token stands at its own height");
    assert.deepEqual(stopAt(SQUARES, { x: 6.2, y: 12.7 }, undefined, ground), { x: 6.5, y: 12.5, z: 10 });
    // A drag and a tap take the same reading, the start of a drag included.
    const g = beginGesture(null, { x: 5.5, y: 12.5 }, undefined, 40, SQUARES);
    assert.deepEqual(dragTo(null, g, { x: 6.5, y: 12.5 }, undefined, newId, ground).live, { x: 6.5, y: 12.5, z: 10 });
    assert.deepEqual(release(null, g, { x: 7.5, y: 13.5 }, undefined, newId, ground).stops, [{ x: 7.5, y: 13.5, z: 10 }]);
  });

  test("from a cell at 0 to the next cell 10 ft up reads 10 ft, and 11 ft in true distance", () => {
    const climb = [{ x: 5.5, y: 12.5 }, { x: 6.5, y: 12.5, z: 10 }];
    assert.equal(measureStops(SQUARES, climb, none, five).totalFt, 10);
    assert.equal(measureStops(SQUARES, climb, none, fiveTen).totalFt, 10);
    assert.equal(measureStops(SQUARES, climb, none, euclid).totalFt, 11);
    // Without the ground it read one step.
    assert.equal(measureStops(SQUARES, [climb[0]!, { x: 6.5, y: 12.5 }], none, five).totalFt, 5);
    // A pit 10 ft down reads the same way down.
    assert.equal(measureStops(SQUARES, [climb[0]!, { x: 6.5, y: 12.5, z: -10 }], none, five).totalFt, 10);
  });

  test("a stop whose token is gone measures from where it was drawn", () => {
    const stops = [{ x: 0.5, y: 0.5, tokenId: "hidden" }, freeStop(SQUARES, { x: 4, y: 0 })];
    assert.equal(measureStops(SQUARES, stops, none, five).totalFt, 20);
  });

  test("labels", () => {
    assert.equal(formatFeet(35), "35 ft");
    assert.equal(formatFeet(2.5), "2.5 ft");
  });

  test("a ruler on a token is drawn from the token's edge", () => {
    const ogre = tok("ogre", { size: "large", x: 0, y: 0 });
    const points = drawnPoints(SQUARES, [tokenStop(SQUARES, ogre), { x: 6.5, y: 1 }], { ogre });
    assert.deepEqual(points[0], { x: 2, y: 1 });
    assert.deepEqual(points[1], { x: 6.5, y: 1 });
  });

  test("a kept ruler between tokens is drawn between where they stand now, from each one's edge", () => {
    const a = tok("a", { x: 0, y: 0 });
    const kept = [tokenStop(SQUARES, a), tokenStop(SQUARES, tok("b", { x: 10, y: 0 }))];
    // The second token crossed to the other side of the first since the ruler was kept.
    const tokens = { a, b: tok("b", { x: -10, y: 0 }) };
    assert.deepEqual(drawnPoints(SQUARES, kept, tokens), [
      { x: 0, y: 0.5 },
      { x: -9, y: 0.5 },
    ]);
    const waypoint = drawnPoints(SQUARES, [freeStop(SQUARES, { x: 5, y: 5 }), tokenStop(SQUARES, tok("b", { x: 10, y: 0 })), freeStop(SQUARES, { x: 0, y: 5 })], tokens);
    assert.deepEqual(waypoint[1], { x: -9.5, y: 0.5 }, "a waypoint on a token is its center now");
  });
});

describe("ruler gestures", () => {
  const scale = 40;

  test("a drag measures from where it started to the finger, and stays on lift", () => {
    let state: RulerState | null = null;
    const g = beginGesture(state, { x: 1.2, y: 1.2 }, undefined, scale, SQUARES);
    g.dragging = true;
    state = dragTo(state, g, { x: 4.4, y: 1.3 }, undefined, newId);
    assert.deepEqual(allStops(state).map((s) => [s.x, s.y]), [[1.5, 1.5], [4.5, 1.5]]);
    state = release(state, g, { x: 4.4, y: 1.3 }, undefined, newId);
    assert.equal(state.live, null);
    assert.equal(state.stops.length, 2);
  });

  test("a tap adds a waypoint, and a drag from the last stop adds a leg", () => {
    let state: RulerState | null = null;
    const tap = (x: number, y: number) => {
      const g = beginGesture(state, { x, y }, undefined, scale, SQUARES);
      state = release(state, g, { x, y }, undefined, newId);
    };
    tap(0.5, 0.5);
    tap(3.5, 0.5);
    assert.equal(state!.stops.length, 2);
    const g = beginGesture(state, { x: 3.6, y: 0.6 }, undefined, scale, SQUARES);
    assert.equal(g.extend, true);
    g.dragging = true;
    state = dragTo(state, g, { x: 3.5, y: 4.5 }, undefined, newId);
    state = release(state, g, { x: 3.5, y: 4.5 }, undefined, newId);
    assert.deepEqual(measureStops(SQUARES, state.stops, none, five), { totalFt: 35, legsFt: [15, 20] });
  });

  test("a drag away from the ruler starts a new one with the same id", () => {
    let state: RulerState | null = { id: "keep", stops: [freeStop(SQUARES, { x: 0, y: 0 }), freeStop(SQUARES, { x: 3, y: 0 })], live: null, shared: true };
    const g = beginGesture(state, { x: 10, y: 10 }, undefined, scale, SQUARES);
    assert.equal(g.extend, false);
    g.dragging = true;
    state = dragTo(state, g, { x: 12, y: 10 }, undefined, newId);
    assert.equal(state.id, "keep");
    assert.equal(state.shared, true);
    assert.deepEqual(state.stops, [{ x: 10.5, y: 10.5 }]);
  });

  test("a ruler started on a token anchors on it", () => {
    const thorn = tok("thorn", { x: 5, y: 5 });
    const g = beginGesture(null, { x: 5.3, y: 5.6 }, thorn, scale, SQUARES);
    g.dragging = true;
    const state = dragTo(null, g, { x: 9, y: 5 }, undefined, newId);
    assert.deepEqual(state.stops[0], { x: 5.5, y: 5.5, tokenId: "thorn" });
  });
});

describe("kept rulers", () => {
  const thorn = tok("thorn", { x: 5, y: 5 });
  const stops = [tokenStop(SQUARES, thorn), freeStop(SQUARES, { x: 9, y: 5 }), freeStop(SQUARES, { x: 9, y: 8 })];
  const base = { id: "k1", sceneId: "s1", stops, ownerId: "p1", color: "#30a46c", shared: true };

  test("a double tap is two taps close in time and place", () => {
    const first = { at: 1000, screen: { x: 100, y: 100 } };
    assert.equal(isDoubleTap(null, first), false);
    assert.equal(isDoubleTap(first, { at: 1250, screen: { x: 110, y: 105 } }), true);
    assert.equal(isDoubleTap(first, { at: 1400, screen: { x: 100, y: 100 } }), false, "too slow");
    assert.equal(isDoubleTap(first, { at: 1100, screen: { x: 140, y: 100 } }), false, "too far apart: two waypoints");
  });

  test("keeps the stops, the tokens they stand on, and the sharing of the live ruler", () => {
    const d = keptDrawing(base)!;
    assert.deepEqual(d.points, [5.5, 5.5, 9.5, 5.5, 9.5, 8.5]);
    assert.deepEqual(d.anchors, ["thorn", null, null]);
    assert.equal(d.kind, "ruler");
    assert.equal(d.visibility, "all");
    assert.equal(keptDrawing({ ...base, shared: false })!.visibility, "dm", "the DM's private ruler stays private");
    assert.equal(keptDrawing({ ...base, stops: stops.slice(1) })!.anchors, undefined, "no anchors when no stop is on a token");
    assert.equal(keptDrawing({ ...base, stops: stops.slice(0, 1) }), null, "one stop measures nothing");
  });

  /** The ruler tool's taps as its pointer handlers make them: down, then up without a drag, `ms` into the session. */
  function taps(points: { world: { x: number; y: number }; ms: number }[], start: RulerState | null = null) {
    let state = start;
    let lastTap: LastTap | null = null;
    let kept: RulerState | null | undefined;
    for (const { world, ms } of points) {
      const screen = { x: world.x * 40, y: world.y * 40 };
      const gesture = { ...beginGesture(state, world, undefined, 40, SQUARES), before: state };
      const lifted = lift({ state, gesture, tap: { at: ms, screen }, lastTap, world, token: undefined, newId });
      lastTap = lifted.lastTap;
      if ("keep" in lifted) kept = lifted.keep;
      else state = lifted.ruler;
    }
    return { state, kept };
  }
  const plan = { id: "k2", sceneId: "s1", ownerId: "p1", color: "#30a46c", shared: true };

  test("a double tap keeps the ruler as it was before the first tap of the pair", () => {
    const { state, kept } = taps([
      { world: { x: 1.2, y: 1.2 }, ms: 0 },
      { world: { x: 4.2, y: 1.2 }, ms: 1000 },
      { world: { x: 8.2, y: 3.2 }, ms: 2000 },
      { world: { x: 8.3, y: 3.3 }, ms: 2150 },
    ]);
    assert.deepEqual(state!.stops.map((s) => [s.x, s.y]), [[1.5, 1.5], [4.5, 1.5], [8.5, 3.5]], "the first tap of the pair added a waypoint");
    assert.deepEqual(kept!.stops.map((s) => [s.x, s.y]), [[1.5, 1.5], [4.5, 1.5]]);
    const made = keepPlan(kept!, plan);
    assert.ok("create" in made);
    assert.deepEqual(made.create.points, [1.5, 1.5, 4.5, 1.5]);
  });

  test("a stray double tap with nothing measured leaves the map as it was", () => {
    const none = taps([
      { world: { x: 2.2, y: 2.2 }, ms: 0 },
      { world: { x: 2.3, y: 2.2 }, ms: 100 },
    ]);
    assert.equal(none.kept, null, "no ruler before the pair");
    assert.deepEqual(keepPlan(none.kept ?? null, plan), { leave: null });

    const one = taps([
      { world: { x: 1.2, y: 1.2 }, ms: 0 },
      { world: { x: 6.2, y: 6.2 }, ms: 1000 },
      { world: { x: 6.3, y: 6.2 }, ms: 1100 },
    ]);
    assert.deepEqual(one.kept!.stops.map((s) => [s.x, s.y]), [[1.5, 1.5]]);
    assert.deepEqual(keepPlan(one.kept!, plan), { leave: one.kept }, "a single stop stays as it was, kept as nothing");
  });

  test("taps too slow or too far apart, or after a drag, are waypoints, not a double tap", () => {
    const slow = taps([
      { world: { x: 1.2, y: 1.2 }, ms: 0 },
      { world: { x: 1.3, y: 1.2 }, ms: 500 },
    ]);
    assert.equal(slow.kept, undefined);
    const far = taps([
      { world: { x: 1.2, y: 1.2 }, ms: 0 },
      { world: { x: 4.2, y: 1.2 }, ms: 100 },
    ]);
    assert.equal(far.kept, undefined);
    assert.equal(far.state!.stops.length, 2);
    let state: RulerState | null = null;
    const dragged = { ...beginGesture(state, { x: 1.2, y: 1.2 }, undefined, 40, SQUARES), before: state, dragging: true };
    state = dragTo(state, dragged, { x: 5.2, y: 1.2 }, undefined, newId);
    const afterDrag = lift({ state, gesture: dragged, tap: { at: 0, screen: { x: 208, y: 48 } }, lastTap: null, world: { x: 5.2, y: 1.2 }, token: undefined, newId });
    assert.equal(afterDrag.lastTap, null, "a drag is no tap to pair with");
  });

  test("keeps each free stop's ground, 0 on a token and on ground the measurer could not see, and reads it back", () => {
    const climb = [tokenStop(SQUARES, thorn), { x: 9.5, y: 5.5, z: 10 }, freeStop(SQUARES, { x: 9, y: 8 }), { x: 2.5, y: 2.5, z: -10 }];
    const d = keptDrawing({ ...base, stops: climb })!;
    assert.deepEqual(d.z, [0, 10, 0, -10]);
    const back = keptStops({ points: d.points, anchors: d.anchors, z: d.z });
    assert.deepEqual(back, climb);
    assert.deepEqual(measureStops(SQUARES, back, { thorn }, five), measureStops(SQUARES, climb, { thorn }, five));
    assert.equal(keptDrawing(base)!.z, undefined, "no z when every stop is at 0");
    // A ruler kept before stops stood on the ground has no z and reads as it did.
    assert.deepEqual(keptStops({ points: [0.5, 0.5, 4.5, 0.5] }), [{ x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }]);
    assert.equal(measureStops(SQUARES, keptStops({ points: [0.5, 0.5, 4.5, 0.5] }), none, five).totalFt, 20);
  });

  test("measures the same kept as it did live, from where its tokens stand now", () => {
    const d = keptDrawing(base)!;
    const back = keptStops({ points: d.points, anchors: d.anchors });
    assert.deepEqual(back, stops);
    const tokens = { thorn };
    assert.deepEqual(measureStops(SQUARES, back, tokens, five), measureStops(SQUARES, stops, tokens, five));
    const moved = { thorn: { ...thorn, x: 2 } };
    assert.equal(measureStops(SQUARES, back, moved, five).totalFt, 50, "Thorn walked 3 squares further off");
  });
});

describe("the ruler on a hex scene (docs/design-v1-hex-grids.md 4.3)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const on = (id: string, size: RulerToken["size"], hex: { col: number; row: number }) => tok(id, { size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex) });

    test(`${orient}: a free stop sits on its hex's center, and every hex is one step, the room's rule only for height`, () => {
      const c = hexCenter(g, { col: 3, row: 5 });
      assert.deepEqual(freeStop(g, { x: c.x + 0.3, y: c.y - 0.2 }), { x: c.x, y: c.y });
      // Four hexes along a slant of the lattice: 20 ft under every rule, where squares would read the slant shorter.
      let far = { col: 3, row: 5 };
      for (let i = 0; i < 4; i++) far = hexNeighbors(g, far)[1]!;
      const end = hexCenter(g, far);
      for (const rules of [five, fiveTen, euclid]) assert.equal(measureStops(g, [freeStop(g, c), freeStop(g, end)], none, rules).totalFt, 20, rules.diagonal);
      // Height counts by the room's rule: 4 steps and 30 ft up.
      assert.equal(measureStops(g, [freeStop(g, c), { ...freeStop(g, end), z: 30 }], none, five).totalFt, 30);
      assert.equal(measureStops(g, [freeStop(g, c), { ...freeStop(g, end), z: 30 }], none, euclid).totalFt, Math.round(Math.hypot(20, 30)));
    });

    test(`${orient}: from a Gargantuan to a Medium whose hexes touch is 5 ft, and a line leaves each from the outline of its hexes`, () => {
      const garg = on("garg", "gargantuan", { col: 6, row: 6 });
      const hexes = occupiedHexes(g, garg);
      // A Medium on a hex beside one of the Gargantuan's that is not one of its own.
      const keys = new Set(hexes.map((h) => `${h.col},${h.row}`));
      const beside = hexes.flatMap((h) => hexNeighbors(g, h)).find((n) => !keys.has(`${n.col},${n.row}`))!;
      const imp = on("imp", "medium", beside);
      const tokens = { garg, imp };
      assert.equal(measureStops(g, [tokenStop(g, garg), tokenStop(g, imp)], tokens, five).totalFt, 5);
      // The drawn line starts where it leaves the Gargantuan's hexes: just inward is on them, just outward is not.
      const [a, b] = drawnPoints(g, [tokenStop(g, garg), freeStop(g, hexCenter(g, { col: 15, row: 2 }))], tokens);
      const anchor = hexAnchor(g, garg);
      const dir = { x: b!.x - anchor.x, y: b!.y - anchor.y };
      const len = Math.hypot(dir.x, dir.y);
      const at = (k: number) => hexAt(g, { x: a!.x + (dir.x / len) * k, y: a!.y + (dir.y / len) * k });
      assert.ok(keys.has(`${at(-1e-6).col},${at(-1e-6).row}`), "just inside is a hex of the Gargantuan");
      assert.ok(!keys.has(`${at(1e-6).col},${at(1e-6).row}`), "just outside is not");
      // A line between two hexes of one row leaves a Medium at a flat side's middle, half a cell out.
      const m = on("m", "medium", { col: 8, row: 8 });
      const across = hexNeighbors(g, hexNeighbors(g, { col: 8, row: 8 })[0]!)[0]!;
      const [start] = drawnPoints(g, [tokenStop(g, m), freeStop(g, hexCenter(g, across))], { m });
      const mid = hexCenter(g, { col: 8, row: 8 });
      assert.ok(Math.abs(Math.hypot(start!.x - mid.x, start!.y - mid.y) - 0.5) < 1e-9);
    });

    test(`${orient}: a drag of the ruler on hexes measures hex centers from where it began`, () => {
      const c = hexCenter(g, { col: 2, row: 2 });
      const gesture = beginGesture(null, { x: c.x + 0.1, y: c.y }, undefined, 40, g);
      const live = dragTo(null, gesture, hexCenter(g, { col: 5, row: 2 }), undefined, newId);
      assert.deepEqual(live.stops[0], { x: c.x, y: c.y });
      assert.equal(measureStops(g, allStops(live), none, five).totalFt, 15);
    });
  }

  test("Walking needs squares: on a hex scene the ruler measures straight whatever this device remembers", () => {
    assert.equal(walksOn(true, { gridShape: "hexRows" }), false);
    assert.equal(walksOn(true, { gridShape: "hexColumns" }), false);
    assert.equal(walksOn(true, {}), true);
    assert.equal(walksOn(false, {}), false);
    assert.equal(WALKING_NEEDS_SQUARES, "Walking needs squares.");
  });
});
