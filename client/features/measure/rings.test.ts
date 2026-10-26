import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pointDistanceFt, tokenCellBox, boxDistanceFt, pointCellBox } from "#shared/rules/distance.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import { cellInRange, ringShape, ringsText } from "./rings.ts";
import type { DistanceRules } from "./ruler.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { HEX_R, hexAt, hexCenter, hexDistance, hexNeighbors, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { hexAnchor, occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";

const five = { feetPerCell: 5, diagonal: "five" as const };
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" as const };
const euclid = { feetPerCell: 5, diagonal: "euclid" as const };
const scene = { w: 40, h: 30 };

function tok(over: Partial<FootprintToken> = {}): FootprintToken {
  return { size: "medium", x: 10, y: 10, elevation: 0, ...over };
}

/** The cells a ring encloses, as "x,y" around the token, for comparing shapes. */
function cells(token: FootprintToken, ft: number, rules: DistanceRules): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) if (cellInRange(SQUARES, token, x, y, ft, rules)) out.add(`${x - token.x},${y - token.y}`);
  return out;
}

describe("range rings", () => {
  test("enclose the cells a ruler from the token reads in range, under each diagonal rule", () => {
    assert.equal(cells(tok(), 10, five).size, 25, "every diagonal 5 ft: a 5 by 5 square");
    const octagon = cells(tok(), 10, fiveTen);
    assert.equal(octagon.size, 21, "5-10-5: the square without its corners");
    assert.ok(!octagon.has("2,2") && octagon.has("2,1"));
    const circle = cells(tok(), 10, euclid);
    assert.ok(circle.has("1,1") && circle.has("2,0") && !circle.has("2,1"), "true distance: 11 ft is out");
    // The same reading as the ruler's: from the footprint's edge, so a Large creature's ring is wider.
    const large = tok({ size: "large" });
    for (const [x, y] of [[13, 10], [14, 10], [7, 7], [8, 15]] as const) {
      const ruler = boxDistanceFt(tokenCellBox(SQUARES, large, 5), pointCellBox(SQUARES, { x, y }, 5), five);
      assert.equal(cellInRange(SQUARES, large, x, y, 15, five), ruler <= 15, `${x},${y}`);
    }
    assert.equal(pointDistanceFt(SQUARES, { x: 10, y: 10 }, { x: 12, y: 10 }, five), 10);
  });

  test("a flier's ring counts its height, and is gone when the ground is out of reach", () => {
    assert.equal(cells(tok({ elevation: 20 }), 30, five).size, 13 * 13, "five: height within range leaves the square");
    assert.ok(cells(tok({ elevation: 20 }), 30, euclid).size < cells(tok(), 30, euclid).size, "true distance: the ground circle shrinks");
    assert.equal(cells(tok({ elevation: 40 }), 30, five).size, 0);
    assert.deepEqual(ringShape(SQUARES, tok({ elevation: 40 }), 30, five, scene), { segments: [], label: null });
  });

  test("the outline runs along the ring's edge, merged into straight runs, with the label on top", () => {
    const shape = ringShape(SQUARES, tok(), 10, five, scene);
    assert.deepEqual(shape.segments, [8, 8, 13, 8, 8, 13, 13, 13, 8, 8, 8, 13, 13, 8, 13, 13]);
    assert.deepEqual(shape.label, { x: 10.5, y: 8, below: false });
  });

  test("the scene's edge cuts a ring without drawing along it", () => {
    const shape = ringShape(SQUARES, tok({ x: 0, y: 0 }), 10, five, scene);
    assert.deepEqual(shape.segments, [0, 3, 3, 3, 3, 0, 3, 3]);
    assert.deepEqual(shape.label, { x: 0.5, y: 3, below: true }, "the top of the ring is off the scene, so the label goes under");
    assert.equal(ringShape(SQUARES, tok({ x: 0, y: 0 }), 200, five, scene).label, null, "a ring larger than the scene has no edge to label");
  });

  test("the menu's summary", () => {
    assert.equal(ringsText([]), "None");
    assert.equal(ringsText([30, 60, 120]), "30/60/120 ft");
  });
});

describe("range rings on a hex scene (docs/design-v1-hex-grids.md 4.3)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const bounds = { w: 30, h: 30 };
    const on = (size: FootprintToken["size"], hex: { col: number; row: number }, over: Partial<FootprintToken> = {}) => tok({ size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex), ...over });
    /** The ring's sides as keys, ends rounded so a side reads the same from either hex. */
    const sidesOf = (shape: { segments: number[] }) => {
      const out = new Set<string>();
      for (let i = 0; i < shape.segments.length; i += 4) {
        const a = `${shape.segments[i]!.toFixed(5)},${shape.segments[i + 1]!.toFixed(5)}`;
        const b = `${shape.segments[i + 2]!.toFixed(5)},${shape.segments[i + 3]!.toFixed(5)}`;
        out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
      return out;
    };

    test(`${orient}: a ring runs along the hex sides round the hexes within its steps, each side once`, () => {
      const medium = on("medium", { col: 12, row: 12 });
      for (const [ft, sides] of [[5, 18], [10, 30], [30, 78]] as const) {
        const shape = ringShape(g, medium, ft, five, bounds);
        assert.equal(shape.segments.length / 4, sides, `${ft} ft: 6 (2r + 1) sides`);
        assert.equal(sidesOf(shape).size, sides, `${ft} ft: no side twice`);
      }
      // What it encloses is what a ruler from the token reads in range: the hexes within its steps.
      const ref = tokenRefHex(g, medium);
      for (const h of sceneHexes(g, bounds)) {
        const c = hexCenter(g, h);
        assert.equal(cellInRange(g, medium, c.x, c.y, 10, five), hexDistance(g, ref, h) <= 2, `${h.col},${h.row}`);
      }
    });

    test(`${orient}: a Large ring counts from all three of its hexes, a flier's shrinks by its height, and the label sits over the anchor`, () => {
      const large = on("large", { col: 12, row: 12 });
      const own = occupiedHexes(g, large);
      const inRange = sceneHexes(g, bounds).filter((h) => own.some((o) => hexDistance(g, o, h) <= 1));
      const shape = ringShape(g, large, 5, five, bounds);
      // Every side drawn lies between a hex in range and one out of it.
      const keys = new Set(inRange.map((h) => `${h.col},${h.row}`));
      for (let i = 0; i < shape.segments.length; i += 4) {
        const mid = { x: (shape.segments[i]! + shape.segments[i + 2]!) / 2, y: (shape.segments[i + 1]! + shape.segments[i + 3]!) / 2 };
        const n = { x: shape.segments[i + 3]! - shape.segments[i + 1]!, y: shape.segments[i]! - shape.segments[i + 2]! };
        const k = 1e-3 / Math.hypot(n.x, n.y);
        const one = hexAt(g, { x: mid.x + n.x * k, y: mid.y + n.y * k });
        const two = hexAt(g, { x: mid.x - n.x * k, y: mid.y - n.y * k });
        assert.notEqual(keys.has(`${one.col},${one.row}`), keys.has(`${two.col},${two.row}`), `side ${i / 4} parts in from out`);
      }
      // 15 ft up, a 10 ft ring reaches no ground.
      assert.equal(ringShape(g, { ...large, elevation: 15 }, 10, five, bounds).segments.length, 0);
      // The label hangs on the ring's top over the anchor, and below where the scene cuts the top.
      const anchor = hexAnchor(g, large);
      const label = shape.label!;
      assert.equal(label.below, false);
      assert.ok(label.y < anchor.y && Math.abs(label.x - anchor.x) <= 0.6);
      const edge = on("medium", orient === "rows" ? { col: 12, row: 0 } : { col: 0, row: 12 });
      const cut = ringShape(g, edge, 10, five, bounds).label;
      assert.equal(cut?.below, orient === "rows");
    });
  }
});

describe("hex rings against every scene hex (HX3-ASTRA-03, HX3-ASTRA-04)", () => {
  const sides = (shape: { segments: number[] }) => {
    const out: string[] = [];
    for (let i = 0; i < shape.segments.length; i += 4) {
      const a = `${shape.segments[i]!.toFixed(4)},${shape.segments[i + 1]!.toFixed(4)}`;
      const b = `${shape.segments[i + 2]!.toFixed(4)},${shape.segments[i + 3]!.toFixed(4)}`;
      out.push(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    return out.sort();
  };
  /** The ring as the definition reads it: every side between a scene hex in range and a scene hex out of it, and the label over the anchor. */
  function brute(g: HexGrid, token: FootprintToken, ft: number, rules: DistanceRules, bounds: { w: number; h: number }) {
    const scene = sceneHexes(g, bounds);
    const key = (h: { col: number; row: number }) => `${h.col},${h.row}`;
    const inScene = new Set(scene.map(key));
    const held = (h: { col: number; row: number }) => {
      const c = hexCenter(g, h);
      return cellInRange(g, token, c.x, c.y, ft, rules);
    };
    const segments: number[] = [];
    const kept: { col: number; row: number }[] = [];
    for (const h of scene) {
      if (!held(h)) continue;
      kept.push(h);
      const c = hexCenter(g, h);
      for (const n of hexNeighbors(g, h)) {
        if (!inScene.has(key(n)) || held(n)) continue;
        // The side two hexes share: a hex's side long, across the line between their centers at its middle.
        const d = hexCenter(g, n);
        const m = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
        const len = Math.hypot(d.x - c.x, d.y - c.y);
        const p = { x: (-(d.y - c.y) / len) * (HEX_R / 2), y: ((d.x - c.x) / len) * (HEX_R / 2) };
        segments.push(m.x + p.x, m.y + p.y, m.x - p.x, m.y - p.y);
      }
    }
    const a = hexAnchor(g, token);
    const half = g.orient === "rows" ? { x: 0.5, y: HEX_R } : { x: HEX_R, y: 0.5 };
    type End = { h: { col: number; row: number }; x: number; y: number };
    let top: End | null = null;
    let bottom: End | null = null;
    for (const h of kept) {
      const c = hexCenter(g, h);
      if (Math.abs(c.x - a.x) > half.x + 1e-9) continue;
      if (!top || c.y < top.y || (c.y === top.y && c.x < top.x)) top = { h, x: c.x, y: c.y };
      if (!bottom || c.y > bottom.y || (c.y === bottom.y && c.x < bottom.x)) bottom = { h, x: c.x, y: c.y };
    }
    const opens = (h: { col: number; row: number }, up: boolean) =>
      hexNeighbors(g, h).some((n) => (hexCenter(g, n).y < hexCenter(g, h).y) === up && hexCenter(g, n).y !== hexCenter(g, h).y && inScene.has(key(n)) && !held(n));
    const label = top && opens(top.h, true) ? { x: top.x, y: top.y - half.y, below: false } : bottom && opens(bottom.h, false) ? { x: bottom.x, y: bottom.y + half.y, below: true } : null;
    return { segments, label, held: kept.length };
  }

  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const on = (size: FootprintToken["size"], hex: { col: number; row: number }, over: Partial<FootprintToken> = {}) => tok({ size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex), ...over });

    test(`${orient}: random tokens, sizes, heights, rules and scenes, on and off the scene, draw what the definition draws`, () => {
      const random = rng(26128);
      const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
      const rules = [five, fiveTen, euclid];
      let offScene = 0;
      for (let i = 0; i < 160; i++) {
        const bounds = { w: 6 + Math.floor(random() * 16), h: 6 + Math.floor(random() * 16) };
        const size = sizes[Math.floor(random() * sizes.length)]!;
        const hex = { col: Math.floor(random() * (bounds.w + 10)) - 5, row: Math.floor(random() * (bounds.h + 10)) - 5 };
        const token = on(size, hex, { elevation: [0, 0, 5, 10, 20][Math.floor(random() * 5)]! });
        const ft = [5, 10, 15, 30, 60][Math.floor(random() * 5)]!;
        const rule = rules[Math.floor(random() * rules.length)]!;
        if (!occupiedHexes(g, token).some((h) => sceneHexes(g, bounds).some((s) => s.col === h.col && s.row === h.row))) offScene++;
        const want = brute(g, token, ft, rule, bounds);
        const got = ringShape(g, token, ft, rule, bounds);
        const at = `${i}: ${size} on ${hex.col},${hex.row} in ${bounds.w} by ${bounds.h}, ${ft} ft`;
        assert.deepEqual(sides(got), sides(want), at);
        assert.deepEqual(got.label && { x: +got.label.x.toFixed(9), y: +got.label.y.toFixed(9), below: got.label.below }, want.label && { x: +want.label.x.toFixed(9), y: +want.label.y.toFixed(9), below: want.label.below }, `${at}: the label`);
      }
      assert.ok(offScene > 20, `${offScene} tokens stood wholly off the scene`);
    });

    test(`${orient}: a token standing off the scene still rings the scene hexes in its range, one hex or several out`, () => {
      // A Medium on the last hex of a 30 by 20 scene's odd row, as a drop onto the edge leaves it (HX3-OPUS-01).
      const bounds = orient === "rows" ? { w: 30, h: 20 } : { w: 20, h: 30 };
      const edge = on("medium", orient === "rows" ? { col: 29, row: 1 } : { col: 1, row: 29 });
      const want = brute(g, edge, 30, five, bounds);
      assert.ok(want.segments.length > 0);
      assert.deepEqual(sides(ringShape(g, edge, 30, five, bounds)), sides(want));
      // A square scene switched to hexes keeps a Medium at (5, 19), whose hex is off the 20 by 20 scene (HX3-ASTRA-03).
      const square = { w: 20, h: 20 };
      const kept = tok({ size: "medium", ...(orient === "rows" ? { x: 5, y: 19 } : { x: 19, y: 5 }) });
      const ref = tokenRefHex(g, kept);
      assert.ok(!sceneHexes(g, square).some((h) => h.col === ref.col && h.row === ref.row), "its hex is off the scene");
      const switched = brute(g, kept, 15, five, square);
      assert.ok(switched.held > 0 && switched.segments.length > 0);
      assert.deepEqual(sides(ringShape(g, kept, 15, five, square)), sides(switched));
      // Four hexes out, a 30 ft ring still reaches in.
      const far = on("medium", orient === "rows" ? { col: 10, row: 25 } : { col: 25, row: 10 });
      const farWant = brute(g, far, 30, five, bounds);
      assert.ok(farWant.segments.length > 0);
      assert.deepEqual(sides(ringShape(g, far, 30, five, bounds)), sides(farWant));
    });
  }
});
