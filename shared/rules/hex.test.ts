import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FOG_SUBCELLS } from "../model.ts";
import { int, rng } from "../testutil.ts";
import {
  cornerAt,
  footprintHexes,
  HEX_R,
  HEX_S,
  hexAt,
  hexCenter,
  hexCorners,
  hexDistance,
  hexInScene,
  hexKey,
  hexLine,
  hexNeighbors,
  hexSubcells,
  parseHexKey,
  referenceHex,
  sameHex,
  sceneHexes,
  sceneHexSpan,
  snapAnchor,
  type Hex,
  type HexGrid,
  type HexSize,
} from "./hex.ts";

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS: readonly [string, HexGrid][] = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
];
const SIZES: readonly HexSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const RUNS = 3000;

function randomHex(r: () => number): Hex {
  return { col: int(r, -40, 240), row: int(r, -40, 240) };
}

function randomPoint(r: () => number): { x: number; y: number } {
  return { x: r() * 260 - 30, y: r() * 260 - 30 };
}

/** Every hex within `depth` steps of `from`, by walking neighbors, with the step it was first reached at. */
function bfs(g: HexGrid, from: Hex, depth: number): Map<string, number> {
  const seen = new Map([[hexKey(from), 0]]);
  let frontier = [from];
  for (let d = 1; d <= depth; d++) {
    const next: Hex[] = [];
    for (const h of frontier) {
      for (const n of hexNeighbors(g, h)) {
        if (seen.has(hexKey(n))) continue;
        seen.set(hexKey(n), d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Degrees clockwise from east on a y-down screen, -180 to 180. */
function angle(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

describe("hex constants", () => {
  test("are √3/2 and 1/√3, written as literals", () => {
    assert.ok(Math.abs(HEX_S - Math.sqrt(3) / 2) < 1e-15);
    assert.ok(Math.abs(HEX_R - 1 / Math.sqrt(3)) < 1e-15);
  });
});

for (const [name, g] of GRIDS) {
  describe(`${name}: geometry`, () => {
    test("a hex's center holds the hex", () => {
      const r = rng(11);
      for (let i = 0; i < RUNS; i++) {
        const h = randomHex(r);
        assert.deepEqual(hexAt(g, hexCenter(g, h)), h);
      }
    });

    test("a key reads back as its hex, and anything else as none", () => {
      const r = rng(12);
      for (let i = 0; i < 200; i++) {
        const h = randomHex(r);
        assert.deepEqual(parseHexKey(hexKey(h)), h);
      }
      for (const bad of ["", "1", "1,", ",2", "1,2,3", "a,b", "1.5,2"]) assert.equal(parseHexKey(bad), null, bad);
      assert.equal(hexKey(hexAt(g, { x: 0.5, y: 0.6 })), "0,0");
    });

    test("any point lies in the hex whose center is nearest", () => {
      const r = rng(13);
      for (let i = 0; i < RUNS; i++) {
        const p = randomPoint(r);
        const h = hexAt(g, p);
        const c = hexCenter(g, h);
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        for (const n of hexNeighbors(g, h)) {
          const m = hexCenter(g, n);
          assert.ok(d <= (m.x - p.x) ** 2 + (m.y - p.y) ** 2, `${hexKey(h)} is nearest to ${p.x},${p.y}`);
        }
      }
    });

    test("the six neighbors are distinct, one step away, and one cell apart", () => {
      const r = rng(14);
      for (let i = 0; i < RUNS; i++) {
        const h = randomHex(r);
        const ns = hexNeighbors(g, h);
        assert.equal(new Set(ns.map(hexKey)).size, 6);
        const c = hexCenter(g, h);
        for (const n of ns) {
          assert.equal(hexDistance(g, h, n), 1);
          const m = hexCenter(g, n);
          assert.ok(Math.abs(Math.hypot(m.x - c.x, m.y - c.y) - 1) < 1e-9, "neighbors' centers are one cell apart");
        }
      }
    });

    test("distance is symmetric, zero only for one hex, keeps the triangle inequality", () => {
      const r = rng(15);
      for (let i = 0; i < RUNS; i++) {
        const [a, b, c] = [randomHex(r), randomHex(r), randomHex(r)];
        assert.equal(hexDistance(g, a, b), hexDistance(g, b, a));
        assert.equal(hexDistance(g, a, b) === 0, sameHex(a, b));
        assert.ok(hexDistance(g, a, c) <= hexDistance(g, a, b) + hexDistance(g, b, c));
      }
    });

    test("distance equals a breadth-first walk over neighbors", () => {
      const r = rng(16);
      for (let i = 0; i < 40; i++) {
        const from = randomHex(r);
        const depth = int(r, 1, 12);
        const walked = bfs(g, from, depth);
        for (const [key, steps] of walked) assert.equal(hexDistance(g, from, parseHexKey(key)!), steps);
        // Every hex within the depth was reached: 1 + 3d(d + 1) of them.
        assert.equal(walked.size, 1 + 3 * depth * (depth + 1));
      }
    });

    test("a line has distance + 1 hexes, from a to b, each next to the last", () => {
      const r = rng(17);
      for (let i = 0; i < RUNS; i++) {
        const a = randomHex(r);
        const b = chance3(r) ? a : { col: a.col + int(r, -20, 20), row: a.row + int(r, -20, 20) };
        const line = hexLine(g, a, b);
        assert.equal(line.length, hexDistance(g, a, b) + 1);
        assert.deepEqual(line[0], a);
        assert.deepEqual(line[line.length - 1], b);
        for (let k = 1; k < line.length; k++) assert.equal(hexDistance(g, line[k - 1]!, line[k]!), 1);
        assert.ok(!line.some((h) => Object.is(h.col, -0) || Object.is(h.row, -0)), "a key never reads -0");
      }
    });

    test("cornerAt gives one point per corner whichever hex asks", () => {
      const r = rng(18);
      for (let i = 0; i < 400; i++) {
        const h = randomHex(r);
        const c = hexCenter(g, h);
        const names = hexCorners(g, h);
        assert.equal(names.length, 6);
        for (const name of names) {
          const p = cornerAt(g, name);
          // On the 1/64 lattice, within its rounding of the true corner.
          assert.equal(p.x * 64, Math.round(p.x * 64));
          assert.equal(p.y * 64, Math.round(p.y * 64));
          assert.ok(Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - HEX_R) <= 1 / 64, "a corner is HEX_R from the center");
          // The three hexes around the corner name it alike.
          const around = [h, ...hexNeighbors(g, h)].filter((n) => hexCorners(g, n).some((m) => sameCorner(m, name)));
          assert.equal(around.length, 3);
          for (const n of around) {
            const m = hexCenter(g, n);
            assert.ok(Math.abs(Math.hypot(p.x - m.x, p.y - m.y) - HEX_R) <= 1 / 64);
          }
        }
      }
    });

    test("snapping is idempotent and lands on the size's anchor lattice", () => {
      const r = rng(19);
      for (let i = 0; i < RUNS; i++) {
        const size = SIZES[i % SIZES.length]!;
        const p = randomPoint(r);
        const a = snapAnchor(g, size, p);
        assert.deepEqual(snapAnchor(g, size, a), a);
        const ref = referenceHex(g, size, a);
        if (size === "large" || size === "gargantuan") assert.deepEqual(a, cornerAt(g, { hex: ref, k: 1 }));
        else assert.deepEqual(a, hexCenter(g, ref));
        // Nothing nearer: the anchors of the reference hex's neighbors are no closer.
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        for (const n of hexNeighbors(g, ref)) {
          const b = size === "large" || size === "gargantuan" ? cornerAt(g, { hex: n, k: 1 }) : hexCenter(g, n);
          assert.ok(d <= Math.hypot(b.x - p.x, b.y - p.y) + 1 / 64);
        }
      }
    });

    test("a footprint has 1, 3, 7 or 12 distinct, connected hexes, its reference hex first", () => {
      const want: Record<HexSize, number> = { tiny: 1, small: 1, medium: 1, large: 3, huge: 7, gargantuan: 12 };
      const r = rng(20);
      for (let i = 0; i < RUNS; i++) {
        const size = SIZES[i % SIZES.length]!;
        const anchor = snapAnchor(g, size, randomPoint(r));
        const hexes = footprintHexes(g, size, anchor);
        assert.equal(hexes.length, want[size]);
        assert.equal(new Set(hexes.map(hexKey)).size, hexes.length);
        assert.deepEqual(hexes[0], referenceHex(g, size, anchor));
        const keys = new Set(hexes.map(hexKey));
        const reached = new Set([hexKey(hexes[0]!)]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const h of hexes) {
            if (reached.has(hexKey(h))) continue;
            if (hexNeighbors(g, h).some((n) => reached.has(hexKey(n)) && keys.has(hexKey(n)))) {
              reached.add(hexKey(h));
              grew = true;
            }
          }
        }
        assert.equal(reached.size, hexes.length, "connected");
        // The anchor is the middle of the shape: its hexes' centers average to it.
        const mid = hexes.reduce((m, h) => ({ x: m.x + hexCenter(g, h).x / hexes.length, y: m.y + hexCenter(g, h).y / hexes.length }), { x: 0, y: 0 });
        assert.ok(Math.hypot(mid.x - anchor.x, mid.y - anchor.y) <= 1 / 64, `${size} centered on its anchor`);
      }
    });

    test("every sub-cell of a scene belongs to exactly one of its hexes, or to none at its edge", () => {
      for (const bounds of [
        { w: 30, h: 20 },
        { w: 7, h: 11 },
      ]) {
        const owner = new Map<string, string>();
        const hexes = sceneHexes(g, bounds);
        const inside = new Set(hexes.map(hexKey));
        for (const h of hexes) {
          const subs = hexSubcells(g, h);
          assert.ok(subs.length >= 12 && subs.length <= 16, `${hexKey(h)} holds ${subs.length}`);
          for (const [sx, sy] of subs) {
            const key = `${sx},${sy}`;
            assert.equal(owner.get(key), undefined, `${key} is in one hex`);
            owner.set(key, hexKey(h));
          }
        }
        for (let sy = 0; sy < bounds.h * FOG_SUBCELLS; sy++) {
          for (let sx = 0; sx < bounds.w * FOG_SUBCELLS; sx++) {
            const at = hexKey(hexAt(g, { x: (sx + 0.5) / FOG_SUBCELLS, y: (sy + 0.5) / FOG_SUBCELLS }));
            assert.equal(owner.get(`${sx},${sy}`), inside.has(at) ? at : undefined, `${sx},${sy}`);
          }
        }
      }
    });
  });
}

describe("hex rows and hex columns agree under the mirror", () => {
  const swap = (p: { x: number; y: number }) => ({ x: p.y, y: p.x });
  const turn = (h: Hex): Hex => ({ col: h.row, row: h.col });

  test("centers, points, distances, lines, corners and footprints swap x and y", () => {
    const r = rng(21);
    for (let i = 0; i < 500; i++) {
      const h = randomHex(r);
      const k = randomHex(r);
      const p = randomPoint(r);
      assert.deepEqual(hexCenter(COLUMNS, turn(h)), swap(hexCenter(ROWS, h)));
      assert.deepEqual(hexAt(COLUMNS, swap(p)), turn(hexAt(ROWS, p)));
      assert.equal(hexDistance(COLUMNS, turn(h), turn(k)), hexDistance(ROWS, h, k));
      assert.deepEqual(hexNeighbors(COLUMNS, turn(h)), hexNeighbors(ROWS, h).map(turn));
      assert.deepEqual(hexLine(COLUMNS, turn(h), turn(k)), hexLine(ROWS, h, k).map(turn));
      assert.deepEqual(cornerAt(COLUMNS, { hex: turn(h), k: 1 }), swap(cornerAt(ROWS, { hex: h, k: 1 })));
      const size = SIZES[i % SIZES.length]!;
      assert.deepEqual(snapAnchor(COLUMNS, size, swap(p)), swap(snapAnchor(ROWS, size, p)));
      assert.deepEqual(footprintHexes(COLUMNS, size, swap(p)), footprintHexes(ROWS, size, p).map(turn));
    }
  });

  test("chirality: neighbors run clockwise from east on rows, counterclockwise from south on columns", () => {
    const h = { col: 4, row: 5 };
    const rows = hexNeighbors(ROWS, h).map((n) => angle(hexCenter(ROWS, h), hexCenter(ROWS, n)));
    assert.deepEqual(rows, [0, 60, 120, 180, -120, -60]);
    const turned = { col: 5, row: 4 };
    const columns = hexNeighbors(COLUMNS, turned).map((n) => angle(hexCenter(COLUMNS, turned), hexCenter(COLUMNS, n)));
    assert.deepEqual(columns, [90, 30, -30, -90, -150, 150]);
    // Corners follow the same hand: clockwise from north on rows, counterclockwise from west on columns. The 1/64
    // lattice moves each by under a degree and a half.
    const near = (got: number[], want: number[]) => got.forEach((a, i) => assert.ok(Math.abs(a - want[i]!) <= 1.5, `${got} near ${want}`));
    near(
      hexCorners(ROWS, h).map((c) => angle(hexCenter(ROWS, h), cornerAt(ROWS, c))),
      [-90, -30, 30, 90, 150, -150],
    );
    near(
      hexCorners(COLUMNS, turned).map((c) => angle(hexCenter(COLUMNS, turned), cornerAt(COLUMNS, c))),
      [180, 120, 60, 0, -60, -120],
    );
  });
});

describe("the scene's hexes (section 4.1)", () => {
  test("a 30 by 20 hex rows scene holds 22 rows, 30 hexes in even rows and 29 in odd", () => {
    const hexes = sceneHexes(ROWS, { w: 30, h: 20 });
    const rows = new Map<number, number>();
    for (const h of hexes) rows.set(h.row, (rows.get(h.row) ?? 0) + 1);
    assert.equal(rows.size, 22);
    for (const [row, n] of rows) assert.equal(n, row % 2 === 0 ? 30 : 29, `row ${row}`);
    assert.deepEqual(sceneHexSpan(ROWS, { w: 30, h: 20 }), { cols: 30, rows: 22 });
    assert.deepEqual(sceneHexSpan(COLUMNS, { w: 20, h: 30 }), { cols: 22, rows: 30 });
    for (const h of hexes) {
      const c = hexCenter(ROWS, h);
      assert.ok(c.x - 0.5 >= 0 && c.x + 0.5 <= 30 && c.y - HEX_R >= 0 && c.y + HEX_R <= 20, `${hexKey(h)} lies wholly inside`);
    }
  });

  test("the last row of a 200 by 200 hex rows scene is 229, and the last column of a hex columns one too", () => {
    const big = { w: 200, h: 200 };
    assert.ok(hexInScene(ROWS, big, { col: 0, row: 229 }));
    assert.ok(hexInScene(ROWS, big, { col: 198, row: 229 }));
    assert.ok(!hexInScene(ROWS, big, { col: 199, row: 229 }), "an odd row is one short");
    assert.ok(!hexInScene(ROWS, big, { col: 0, row: 230 }));
    assert.ok(hexInScene(COLUMNS, big, { col: 229, row: 0 }));
    assert.ok(!hexInScene(COLUMNS, big, { col: 230, row: 0 }));
    // Chunk row 14 of 16 by 16 hexes, inside the import's -100 to 100.
    assert.equal(Math.floor(229 / 16), 14);
    assert.equal(sceneHexes(ROWS, big).length, 115 * 200 + 115 * 199);
  });

  test("a hex is in the scene exactly when it is one of its hexes", () => {
    const r = rng(22);
    for (const [, g] of GRIDS) {
      const bounds = { w: int(r, 1, 40), h: int(r, 1, 40) };
      const inside = new Set(sceneHexes(g, bounds).map(hexKey));
      for (let col = -3; col < 50; col++) for (let row = -3; row < 50; row++) assert.equal(hexInScene(g, bounds, { col, row }), inside.has(`${col},${row}`));
    }
  });

  test("a scene too shallow for a hex holds none", () => {
    assert.equal(sceneHexes(ROWS, { w: 10, h: 1 }).length, 0);
    assert.equal(sceneHexes(COLUMNS, { w: 1, h: 10 }).length, 0);
    assert.equal(sceneHexes(ROWS, { w: 1, h: 2 }).length, 1, "one even row, its odd row none");
  });
});

describe("hex cases (section 9)", () => {
  test("a Medium dropped between hexes lands on the nearest center, ties to the smaller row, then the smaller column", () => {
    assert.deepEqual(snapAnchor(ROWS, "medium", { x: 0.9, y: 0.7 }), hexCenter(ROWS, { col: 0, row: 0 }));
    assert.deepEqual(snapAnchor(ROWS, "medium", { x: 1.1, y: 0.7 }), hexCenter(ROWS, { col: 1, row: 0 }));
    assert.deepEqual(snapAnchor(ROWS, "medium", { x: 1.2, y: 1.4 }), hexCenter(ROWS, { col: 0, row: 1 }), "odd rows sit half a hex right");
    // Exactly on the upright side between two hexes of a row: the smaller column.
    assert.deepEqual(hexAt(ROWS, { x: 1, y: HEX_R }), { col: 0, row: 0 });
    assert.deepEqual(hexAt(COLUMNS, { x: HEX_R, y: 1 }), { col: 0, row: 0 });
  });

  test("a Large's three hexes are a hex and the two below it, standing on the corner they share", () => {
    const anchor = snapAnchor(ROWS, "large", { x: 3.1, y: 2.4 });
    const [top, a, b] = footprintHexes(ROWS, "large", anchor);
    assert.deepEqual(anchor, cornerAt(ROWS, { hex: top!, k: 1 }));
    assert.equal(a!.row, top!.row + 1);
    assert.equal(b!.row, top!.row + 1);
    assert.equal(hexDistance(ROWS, a!, b!), 1);
  });

  test("a Gargantuan's twelve are the Large three and the nine around them", () => {
    const anchor = snapAnchor(ROWS, "gargantuan", { x: 9, y: 9 });
    const hexes = footprintHexes(ROWS, "gargantuan", anchor);
    const large = footprintHexes(ROWS, "large", anchor);
    assert.deepEqual(hexes.slice(0, 3), large);
    for (const h of hexes.slice(3)) assert.ok(large.some((l) => hexDistance(ROWS, h, l) === 1));
  });

  test("a Huge's seven are a hex and its six neighbors", () => {
    const anchor = snapAnchor(ROWS, "huge", { x: 9, y: 9 });
    const [center, ...ring] = footprintHexes(ROWS, "huge", anchor);
    assert.deepEqual(ring, hexNeighbors(ROWS, center!));
  });

  test("a line along the side between two hexes falls by its nudge, not by which way rounding goes at a half", () => {
    // Both lines pass exactly between hexes. Unnudged, rounding a half toward +infinity sends the first one's third
    // hex up a row early and the second one's along its row.
    const a = { col: 0, row: 0 };
    assert.deepEqual(hexLine(ROWS, a, { col: -4, row: -1 }), [a, { col: -1, row: 0 }, { col: -2, row: 0 }, { col: -3, row: -1 }, { col: -4, row: -1 }]);
    assert.deepEqual(hexLine(ROWS, a, { col: -3, row: -3 }), [a, { col: -1, row: -1 }, { col: -2, row: -1 }, { col: -2, row: -2 }, { col: -3, row: -3 }]);
  });
});

function sameCorner(a: { hex: Hex; k: 0 | 1 }, b: { hex: Hex; k: 0 | 1 }): boolean {
  return a.k === b.k && sameHex(a.hex, b.hex);
}

function chance3(r: () => number): boolean {
  return r() < 0.03;
}

describe("determinism", () => {
  /*
   * The reducer reads hex.ts on replay, and sight will, so it and what it
   * imports call none of what engines may round differently: the same list
   * segments.test.ts holds sight to.
   */
  const banned = /Math\.(atan2|sin|cos|sqrt|hypot|pow|exp|ceil|trunc|cbrt|log)\b|\*\*/;

  function closure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
        if (!m[1] && m[2]!.startsWith(".")) queue.push(resolve(dirname(file), m[2]!));
      }
    }
    return [...seen];
  }

  test("hex.ts and grid.ts, with their imports, use only + - * /, floor, round, abs, min and max", () => {
    for (const entry of ["./hex.ts", "./grid.ts"]) {
      const files = closure(fileURLToPath(new URL(entry, import.meta.url)));
      for (const file of files) {
        const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        const hit = source.match(banned);
        assert.equal(hit, null, `${file} uses ${hit?.[0]}`);
      }
    }
  });
});
