import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AoeCoverage, AoeInclusion, AreaTemplate } from "../model.ts";
import { template, token } from "../testutil.ts";
import { castFromToken, computeCoverage, creaturesInArea, emanationFootprint, type AreaContext, type AreaToken } from "./aoe.ts";
import { hexAnchor, occupiedHexes, placedOnHex, type SizeCategory } from "./footprint.ts";
import { gridOfShape } from "./grid.ts";
import { cornerAt, HEX_R, hexAt, hexCenter, hexCorners, hexDistance, hexKey, hexNeighbors, sceneHexes, type Hex, type HexGrid } from "./hex.ts";

/**
 * Areas on hexes (docs/design-v1-hex-grids.md HX-D11 and section 9):
 * true shapes graded per hex, emanations counted in steps from their
 * creature's hexes, and creatures caught by their hexes.
 */

const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;
const GRIDS: readonly [string, HexGrid][] = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
];

function ctx(g: HexGrid, tokens: Record<string, AreaToken> = {}, over: { coverage?: AoeCoverage; inclusion?: AoeInclusion } = {}): AreaContext {
  return { settings: { feetPerCell: 5, aoeCoverage: over.coverage ?? "half", aoeInclusion: over.inclusion ?? "anyCell", diagonal: "five" }, bounds: { w: 40, h: 40 }, grid: g, tokens };
}

function on(g: HexGrid, id: string, size: SizeCategory, hex: Hex, elevation = 0): AreaToken {
  return token(id, { size, elevation, ...placedOnHex(g, { size, x: 0, y: 0 }, hex) });
}

function hexSet(cov: { hexes?: { col: number; row: number }[] }): Set<string> {
  return new Set((cov.hexes ?? []).map((h) => `${h.col},${h.row}`));
}

const CASTER_HEX: Hex = { col: 15, row: 15 };

for (const [name, g] of GRIDS) {
  describe(`${name}: emanations count steps from their creature's hexes`, () => {
    for (const [ft, counts] of [
      [15, { medium: 37, large: 48, huge: 61, gargantuan: 75 }],
      [10, { medium: 19, large: 27, huge: 37, gargantuan: 48 }],
    ] as const) {
      test(`a ${ft} ft emanation covers ${Object.values(counts).join(", ")} hexes on a Medium, a Large, a Huge and a Gargantuan, attached or stationary`, () => {
        for (const size of ["medium", "large", "huge", "gargantuan"] as const) {
          const caster = on(g, "c", size, CASTER_HEX);
          const attached = template("a", { shape: "emanation", size: ft, attachedTo: "c", casterId: "c", includeOrigin: true });
          const covered = hexSet(computeCoverage(attached, ctx(g, { c: caster })));
          assert.equal(covered.size, counts[size], `${size} attached`);
          // Every hex within its steps of the creature's hexes, and no other.
          const own = occupiedHexes(g, caster);
          for (const k of covered) {
            const [col, row] = k.split(",").map(Number) as [number, number];
            assert.ok(Math.min(...own.map((h) => hexDistance(g, h, { col, row }))) <= ft / 5);
          }
          const a = hexAnchor(g, caster);
          const stationary = template("s", { shape: "emanation", size: ft, origin: { ...a, z: 0 }, footprint: emanationFootprint(g, caster, 5), includeOrigin: true });
          assert.deepEqual(hexSet(computeCoverage(stationary, ctx(g))), covered, `${size} stationary`);
          // Left out, its own hexes are not covered.
          const without = hexSet(computeCoverage({ ...attached, includeOrigin: false }, ctx(g, { c: caster })));
          assert.equal(without.size, counts[size] - own.length);
        }
      });
    }

    test("an older stationary emanation with a 2 by 2 box reads as Large", () => {
      const large = on(g, "c", "large", CASTER_HEX);
      const a = hexAnchor(g, large);
      const old = template("s", { shape: "emanation", size: 10, origin: { ...a, z: 0 }, footprint: { w: 2, h: 2, elevation: 0, height: 10 }, includeOrigin: true });
      assert.equal(hexSet(computeCoverage(old, ctx(g))).size, 27);
      assert.deepEqual(emanationFootprint(g, large, 5), { w: 2, h: 2, elevation: 0, height: 10, size: "large" });
    });

    test("a stationary emanation moved one step across an odd row takes its hexes with it, and back (section 10's mutant: the origin)", () => {
      const caster = on(g, "c", "medium", { col: 10, row: 10 });
      const a = hexAnchor(g, caster);
      const area = template("s", { shape: "emanation", size: 10, origin: { ...a, z: 0 }, footprint: emanationFootprint(g, caster, 5), includeOrigin: true });
      const before = hexSet(computeCoverage(area, ctx(g)));
      // One step to the neighbor in the next row, an odd one.
      const step = hexNeighbors(g, { col: 10, row: 10 })[1]!;
      const moved = { ...area, origin: { ...hexCenter(g, step), z: 0 } };
      const after = hexSet(computeCoverage(moved, ctx(g)));
      const want = new Set(sceneHexes(g, { w: 40, h: 40 }).filter((h) => hexDistance(g, h, step) <= 2).map(hexKey));
      assert.deepEqual(after, want, "the hexes around its new origin");
      assert.notDeepEqual(after, before);
      assert.deepEqual(hexSet(computeCoverage(area, ctx(g))), before, "moved back, its hexes are back");
    });

    test("height counts by the room's rule from the footprint's vertical extent", () => {
      const caster = on(g, "c", "medium", CASTER_HEX);
      const area = template("a", { shape: "emanation", size: 15, attachedTo: "c", casterId: "c", includeOrigin: false });
      const near = { col: CASTER_HEX.col + 1, row: CASTER_HEX.row };
      const caught = (elevation: number) => creaturesInArea(area, [caster, on(g, "f", "medium", near, elevation)], ctx(g, { c: caster }));
      // One hex across, as the ruler counts layers: a flier 15 ft up is 15 ft away under five, one 20 ft up 20 ft.
      assert.deepEqual(caught(0), ["f"]);
      assert.deepEqual(caught(15), ["f"]);
      assert.deepEqual(caught(20), []);
    });
  });

  describe(`${name}: shapes are graded per hex`, () => {
    test("a 20 ft sphere on a hex corner covers the hexes at least half inside, as a brute-force sampler counts", () => {
      const corner = cornerAt(g, hexCorners(g, { col: 12, row: 12 })[0]!);
      const sphere = template("s", { shape: "sphere", size: 20, origin: { ...corner, z: 0 } });
      const result = computeCoverage(sphere, ctx(g));
      const covered = hexSet(result);
      const touched = hexSet(computeCoverage(sphere, ctx(g, {}, { coverage: "any" })));
      const shares = new Map((result.hexes ?? []).map((h) => [`${h.col},${h.row}`, h.coverage]));
      let checked = 0;
      for (const h of sceneHexes(g, { w: 40, h: 40 })) {
        const c = hexCenter(g, h);
        if (Math.hypot(c.x - corner.x, c.y - corner.y) > 6) continue;
        // 64 samples a cell side over the hex's box, kept where the hex holds them.
        let inside = 0;
        let total = 0;
        for (let y = c.y - HEX_R; y < c.y + HEX_R; y += 1 / 64) {
          for (let x = c.x - 0.5; x < c.x + 0.5; x += 1 / 64) {
            const at = hexAt(g, { x, y });
            if (at.col !== h.col || at.row !== h.row) continue;
            total++;
            if (Math.hypot(x - corner.x, y - corner.y) <= 4) inside++;
          }
        }
        const share = inside / total;
        // Under "any" a hex is covered by any part inside, its center outside or not.
        if (share > 0.05) assert.ok(touched.has(hexKey(h)), `${hexKey(h)} touched at ${share.toFixed(3)}`);
        if (share === 0) assert.ok(!touched.has(hexKey(h)), `${hexKey(h)} untouched`);
        // Each hex's pattern grades it as finely as the sampler does, within a few samples.
        const graded = shares.get(hexKey(h));
        if (graded !== undefined) assert.ok(Math.abs(graded - share) < 0.03, `${hexKey(h)}: ${graded.toFixed(3)} graded, ${share.toFixed(3)} sampled`);
        if (Math.abs(share - 0.5) < 0.03) continue;
        checked++;
        assert.equal(covered.has(hexKey(h)), share >= 0.5, `${hexKey(h)} at ${share.toFixed(3)}`);
      }
      assert.ok(checked > 40);
    });

    test("a creature is caught by any of its hexes, and under majority by more than half of them", () => {
      const large: AreaToken = on(g, "l", "large", { col: 20, row: 20 });
      const [top, left, right] = occupiedHexes(g, large) as [Hex, Hex, Hex];
      // A sphere on the hex beside the Large's lower left hex alone, which it covers part of.
      const beside = hexNeighbors(g, left).find((h) => hexDistance(g, h, top) === 2 && hexDistance(g, h, right) === 2)!;
      const sphere = template("s", { shape: "sphere", size: 5, origin: { ...hexCenter(g, beside), z: 0 } });
      assert.deepEqual(creaturesInArea(sphere, [large], ctx(g, {}, { coverage: "any" })), ["l"], "any sample of one of its hexes");
      assert.deepEqual(creaturesInArea(sphere, [large], ctx(g)), [], "less than half of that hex");
      assert.deepEqual(creaturesInArea(sphere, [large], ctx(g, {}, { coverage: "any", inclusion: "majority" })), [], "far less than half of its three");
      const over = template("o", { shape: "sphere", size: 10, origin: { ...hexAnchor(g, large), z: 0 } });
      assert.deepEqual(creaturesInArea(over, [large], ctx(g, {}, { inclusion: "majority" })), ["l"]);
      // A 5 ft cube on its top hex covers most of that hex and little of the other two: a third of the creature.
      const cube = template("c", { shape: "cube", size: 5, origin: { ...hexCenter(g, top), z: 0 }, faceOffset: { u: 0, v: 0 }, includeOrigin: true });
      const centered = { ...cube, origin: { x: hexCenter(g, top).x - 0.5, y: hexCenter(g, top).y, z: 3 } };
      assert.deepEqual(creaturesInArea(centered, [large], ctx(g)), ["l"], "its top hex is more than half covered");
      assert.deepEqual(creaturesInArea(centered, [large], ctx(g, {}, { inclusion: "majority" })), [], "but not the most of its three hexes");
    });
  });
}

describe("a cone, line or cube cast from a token on hexes starts on its outline (HX-D11)", () => {
  test("a 15 ft cone cast east from a hex rows Medium starts at its east side's midpoint, and at 30° on its corner", () => {
    const t = on(ROWS, "t", "medium", { col: 6, row: 6 });
    const c = hexCenter(ROWS, { col: 6, row: 6 });
    const east = castFromToken(ROWS, { shape: "cone", size: 15, yaw: 0 }, t, 5).origin;
    assert.ok(Math.abs(east.x - (c.x + 0.5)) < 1 / 64 && Math.abs(east.y - c.y) < 1 / 64, JSON.stringify(east));
    const se = castFromToken(ROWS, { shape: "cone", size: 15, yaw: 30 }, t, 5).origin;
    assert.ok(Math.abs(se.x - (c.x + 0.5)) < 1 / 64 && Math.abs(se.y - (c.y + HEX_R / 2)) < 1 / 64, JSON.stringify(se));
    // A Large cast north starts on its top hex's point.
    const large = on(ROWS, "l", "large", { col: 6, row: 6 });
    const north = castFromToken(ROWS, { shape: "line", size: 30, yaw: 270 }, large, 5).origin;
    assert.ok(Math.abs(north.x - c.x) < 1 / 64 && Math.abs(north.y - (c.y - HEX_R)) < 1 / 64, JSON.stringify(north));
  });
});

describe("a stationary cast on hexes knows its caster by the footprint's outline (review HX2-ASTRA-02)", () => {
  for (const [name, g] of GRIDS) {
    test(`${name}: a Tiny and a Medium casting a cube, cone or line north or at 15°, left out, are never caught by it`, () => {
      for (const size of ["tiny", "medium"] as const) {
        for (const yaw of [270, 15]) {
          for (const shape of ["cube", "cone", "line"] as const) {
            const caster = on(g, "c", size, { col: 10, row: 10 });
            const cast = castFromToken(g, { shape, size: 15, yaw }, caster, 5);
            const area = template("a", { shape, size: 15, yaw, casterId: "c", origin: cast.origin, ...(cast.faceOffset ? { faceOffset: cast.faceOffset } : {}), includeOrigin: false });
            const caught = creaturesInArea(area, [caster], ctx(g, { c: caster }, { coverage: "any" }));
            assert.deepEqual(caught, [], `${size} ${shape} at ${yaw}°`);
          }
        }
      }
    });
  }
});

describe("a template on hexes reaches players' copies unchanged", () => {
  test("its footprint's size is plain data", () => {
    const t: AreaTemplate = template("s", { shape: "emanation", footprint: { w: 3, h: 3, elevation: 0, height: 15, size: "huge" } });
    assert.equal(t.footprint?.size, "huge");
  });
});
