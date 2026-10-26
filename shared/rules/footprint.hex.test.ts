import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, SIZE_CELLS, type FogTile } from "../model.ts";
import { tileKey } from "../keys.ts";
import { int, pick, rng } from "../testutil.ts";
import { encodeTile, isTokenFullyFogged, TILE_BYTES, TILE_SUB } from "./fog.ts";
import {
  footprintRect,
  footprintSubcells,
  hexAnchor,
  occupiedCells,
  occupiedHexes,
  occupiedRange,
  placedOnHex,
  sizeCategory,
  storedCenter,
  tokenRefHex,
  type PlacedToken,
  type SizeCategory,
} from "./footprint.ts";
import { footprintHexes, hexAt, hexDistance, hexKey, hexNeighbors, hexSubcells, referenceHex, sameHex, snapAnchor, type Hex, type HexGrid } from "./hex.ts";

/**
 * Footprints on hexes (docs/design-v1-hex-grids.md 4.2 and section 10): a
 * creature takes its size's 1, 3, 7 or 12 connected hexes around the anchor
 * nearest the middle of its stored box, and fog and sight read the
 * sub-cells inside those hexes.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS: readonly [string, HexGrid][] = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
];
const SIZES: readonly SizeCategory[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const RUNS = 3000;

function randomToken(r: () => number): PlacedToken {
  if (r() < 0.2) return { size: "custom", w: 0.5 + r() * 5, h: 0.5 + r() * 5, x: r() * 180, y: r() * 180 };
  return { size: pick(r, SIZES), x: r() * 180, y: r() * 180 };
}

function connected(g: HexGrid, hexes: readonly Hex[]): boolean {
  const keys = new Set(hexes.map(hexKey));
  const seen = new Set([hexKey(hexes[0]!)]);
  const stack = [hexes[0]!];
  while (stack.length > 0) {
    const h = stack.pop()!;
    for (const n of hexNeighbors(g, h)) {
      const k = hexKey(n);
      if (keys.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push(n);
      }
    }
  }
  return seen.size === keys.size;
}

const COUNTS: Record<SizeCategory, number> = { tiny: 1, small: 1, medium: 1, large: 3, huge: 7, gargantuan: 12 };

for (const [name, g] of GRIDS) {
  describe(`${name}: a creature's hexes`, () => {
    test("1, 3, 7 or 12 distinct connected hexes, the reference hex first, around the anchor nearest the box's middle", () => {
      const r = rng(41);
      for (let i = 0; i < RUNS; i++) {
        const t = randomToken(r);
        const size = sizeCategory(t);
        const hexes = occupiedHexes(g, t);
        assert.equal(hexes.length, COUNTS[size]);
        assert.equal(new Set(hexes.map(hexKey)).size, hexes.length, "distinct");
        assert.ok(connected(g, hexes), "connected");
        assert.ok(sameHex(hexes[0]!, tokenRefHex(g, t)), "the reference hex first");
        const anchor = snapAnchor(g, size, storedCenter(t));
        assert.deepEqual(hexAnchor(g, t), anchor);
        assert.deepEqual(hexes, footprintHexes(g, size, anchor));
      }
    });

    test("placed on a reference hex, a creature stands with that hex as its reference, for every size", () => {
      const r = rng(42);
      for (let i = 0; i < RUNS; i++) {
        const t = randomToken(r);
        const ref: Hex = { col: int(r, 0, 150), row: int(r, 0, 150) };
        const at = placedOnHex(g, t, ref);
        const placed = { ...t, ...at };
        assert.ok(sameHex(tokenRefHex(g, placed), ref), `${t.size} on ${hexKey(ref)}`);
        assert.deepEqual(placedOnHex(g, placed, ref), at, "placing again moves nothing");
        // Snapping is idempotent: the anchor of a creature already on one is that one.
        assert.deepEqual(hexAnchor(g, { ...placed, ...placedOnHex(g, placed, tokenRefHex(g, placed)) }), hexAnchor(g, placed));
      }
    });

    test("the rect is the size's box around the anchor, and the range holds every sub-cell of the hexes", () => {
      const r = rng(43);
      for (let i = 0; i < RUNS; i++) {
        const t = randomToken(r);
        const rect = footprintRect(g, t);
        const a = hexAnchor(g, t);
        const side = SIZE_CELLS[sizeCategory(t)];
        assert.deepEqual([rect.w, rect.h], [side, side]);
        assert.ok(Math.abs(rect.x + side / 2 - a.x) < 1e-9 && Math.abs(rect.y + side / 2 - a.y) < 1e-9, "centered on the anchor");
        const subs = footprintSubcells(g, t);
        const range = occupiedRange(g, t);
        const keys = new Set<string>();
        for (const [sx, sy] of subs) {
          keys.add(`${sx},${sy}`);
          const cx = Math.floor(sx / FOG_SUBCELLS);
          const cy = Math.floor(sy / FOG_SUBCELLS);
          assert.ok(cx >= range.x0 && cx < range.x1 && cy >= range.y0 && cy < range.y1, "inside the range");
          const hex = hexAt(g, { x: (sx + 0.5) / FOG_SUBCELLS, y: (sy + 0.5) / FOG_SUBCELLS });
          assert.ok(occupiedHexes(g, t).some((h) => sameHex(h, hex)), "a sub-cell of one of its hexes");
        }
        assert.equal(keys.size, subs.length, "no sub-cell twice");
        assert.equal(subs.length, occupiedHexes(g, t).reduce((n, h) => n + hexSubcells(g, h).length, 0));
        assert.equal(occupiedCells(g, t).length, (range.x1 - range.x0) * (range.y1 - range.y0));
      }
    });
  });
}

describe("custom sizes on hexes read as their category (4.2)", () => {
  test("a 2 by 3 creature is Huge, seven hexes around the middle of its stored box", () => {
    const t: PlacedToken = { size: "custom", w: 2, h: 3, x: 10, y: 10 };
    assert.equal(sizeCategory(t), "huge");
    const hexes = occupiedHexes(ROWS, t);
    assert.equal(hexes.length, 7);
    assert.ok(sameHex(hexes[0]!, hexAt(ROWS, { x: 11, y: 11.5 })));
    assert.deepEqual([footprintRect(ROWS, t).w, footprintRect(ROWS, t).h], [3, 3]);
  });
});

describe("the reference hex (section 10's mutant: the Large lattice offset)", () => {
  test("a Large's reference is the top hex, whose second point is its anchor, and the two below it follow", () => {
    for (const [, g] of GRIDS) {
      const t: PlacedToken = { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 5, row: 4 }) };
      const hexes = occupiedHexes(g, t);
      assert.deepEqual(hexes[0], { col: 5, row: 4 });
      assert.ok(sameHex(referenceHex(g, "large", hexAnchor(g, t)), { col: 5, row: 4 }));
      // Both others are one step from the top and from each other.
      assert.deepEqual(
        hexes.slice(1).map((h) => hexDistance(g, h, hexes[0]!)),
        [1, 1],
      );
      assert.equal(hexDistance(g, hexes[1]!, hexes[2]!), 1);
    }
  });
});

describe("fog on hexes reads the sub-cells inside the hexes (HX-D10)", () => {
  /** Fog tiles revealing exactly the given scene-wide sub-cells. */
  function revealing(subs: readonly (readonly [number, number])[]): Record<string, FogTile> {
    const bits = new Map<string, Uint8Array>();
    for (const [sx, sy] of subs) {
      const tx = Math.floor(sx / TILE_SUB);
      const ty = Math.floor(sy / TILE_SUB);
      const key = tileKey("s1", tx, ty);
      let b = bits.get(key);
      if (!b) bits.set(key, (b = new Uint8Array(TILE_BYTES)));
      const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
      b[i >> 3] = b[i >> 3]! | (1 << (i & 7));
    }
    return Object.fromEntries([...bits].map(([k, b]) => {
      const [, tx, ty] = /^s1:(\d+),(\d+)$/.exec(k)!.map(Number) as [number, number, number];
      return [k, { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(b) }];
    }));
  }

  test("one revealed sub-cell inside any of its hexes shows the creature, and one in its box but outside its hexes does not", () => {
    const r = rng(44);
    for (const [, g] of GRIDS) {
      for (let i = 0; i < 400; i++) {
        const t = { ...randomToken(r), sceneId: "s1" };
        const subs = footprintSubcells(g, t);
        assert.ok(isTokenFullyFogged(g, {}, "s1", t), "fully fogged without tiles");
        assert.ok(!isTokenFullyFogged(g, revealing([subs[int(r, 0, subs.length - 1)]!]), "s1", t), "one sub-cell inside shows it");
        const inside = new Set(subs.map(([sx, sy]) => `${sx},${sy}`));
        const rect = footprintRect(g, t);
        const outside: [number, number][] = [];
        for (let sy = Math.floor(rect.y * FOG_SUBCELLS); sy < Math.ceil((rect.y + rect.h) * FOG_SUBCELLS); sy++) {
          for (let sx = Math.floor(rect.x * FOG_SUBCELLS); sx < Math.ceil((rect.x + rect.w) * FOG_SUBCELLS); sx++) {
            if (sx >= 0 && sy >= 0 && !inside.has(`${sx},${sy}`)) outside.push([sx, sy]);
          }
        }
        if (outside.length > 0) assert.ok(isTokenFullyFogged(g, revealing(outside), "s1", t), "its box revealed around its hexes keeps it hidden");
      }
    }
  });
});
