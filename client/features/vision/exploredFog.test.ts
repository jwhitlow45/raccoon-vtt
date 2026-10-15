import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogTile } from "#shared/model.ts";
import { encodeTileFrom, revealedMask } from "../../lib/fogTiles.ts";
import { ExploredOutline, exploredOutline, withExplored } from "./exploredFog.ts";

/** A tile of scene s1 revealing the sub-cells (in tile sub-cell coordinates) the predicate picks. */
function tile(tx: number, ty: number, revealed: (sx: number, sy: number) => boolean): FogTile {
  return { sceneId: "s1", tx, ty, rev: 1, bits: encodeTileFrom(revealed) };
}

describe("explored ground in the DM's fog", () => {
  test("the DM's fog image reveals what either layer reveals, where both hold a tile", () => {
    const fog = { "s1:0,0": tile(0, 0, (sx) => sx < 4) };
    const explored = { "s1:0,0": tile(0, 0, (sx) => sx >= 60), "s1:1,0": tile(1, 0, () => true) };
    const both = withExplored(fog, explored);
    const mask = revealedMask({ w: 32, h: 16 }, "s1", both);
    const at = (x: number, y: number) => mask.revealed[y * mask.width + x];
    assert.equal(at(0, 0), 1, "the DM's reveal");
    assert.equal(at(61, 3), 1, "the party's exploration in the same tile");
    assert.equal(at(30, 3), 0);
    assert.equal(at(100, 10), 1, "a tile only the party explored");
    // The same layers give the same object, so the fog image is not rebuilt for nothing.
    assert.equal(withExplored(fog, explored), both);
    assert.equal(withExplored(fog, {}), fog);
    assert.equal(withExplored(fog, undefined), fog);
  });

  test("the outline runs around ground only the party revealed, in cells, one segment per straight run", () => {
    // Explored: sub-cells 4 to 7 of rows 4 to 7, a one-cell square at cell (1, 1).
    const explored = { "s1:0,0": tile(0, 0, (sx, sy) => sx >= 4 && sx < 8 && sy >= 4 && sy < 8) };
    const lines = exploredOutline({ w: 16, h: 16 }, "s1", {}, explored);
    const segments = [];
    for (let i = 0; i < lines.length; i += 4) segments.push(lines.slice(i, i + 4));
    assert.deepEqual(
      segments.sort(),
      [
        [1, 1, 2, 1],
        [1, 2, 2, 2],
        [1, 1, 1, 2],
        [2, 1, 2, 2],
      ].sort(),
    );
  });

  test("ground the DM revealed too is the DM's, so the outline leaves it out", () => {
    const explored = { "s1:0,0": tile(0, 0, (sx, sy) => sx < 8 && sy < 4) };
    const fog = { "s1:0,0": tile(0, 0, (sx, sy) => sx < 4 && sy < 4) };
    const lines = exploredOutline({ w: 16, h: 16 }, "s1", fog, explored);
    const segments = [];
    for (let i = 0; i < lines.length; i += 4) segments.push(lines.slice(i, i + 4));
    // Cell (1, 0) only: the scene's top edge is left out, so three sides.
    assert.deepEqual(
      segments.sort(),
      [
        [1, 1, 2, 1],
        [1, 0, 1, 1],
        [2, 0, 2, 1],
      ].sort(),
    );
  });

  test("nothing explored on this scene, nothing to outline", () => {
    assert.deepEqual(exploredOutline({ w: 16, h: 16 }, "s1", {}, undefined), []);
    assert.deepEqual(exploredOutline({ w: 16, h: 16 }, "s1", {}, { "s2:0,0": { ...tile(0, 0, () => true), sceneId: "s2" } }), []);
  });
});

describe("the explored outline kept tile by tile", () => {
  /** Every unit sub-cell side a list of segments covers, as "x,y,h|v" in sub-cells. */
  function units(lines: number[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < lines.length; i += 4) {
      const [x0, y0, x1, y1] = lines.slice(i, i + 4).map((v) => Math.round(v * 4)) as [number, number, number, number];
      if (y0 === y1) for (let x = x0; x < x1; x++) out.add(`${x},${y0},h`);
      else for (let y = y0; y < y1; y++) out.add(`${x0},${y},v`);
    }
    return out;
  }

  function rng(seed: number): () => number {
    let x = seed;
    return () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x / 2 ** 32;
    };
  }

  test("after any sequence of changes to either layer it draws the same sides as the whole-scene outline", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = rng(seed);
      const bounds = { w: 8 + Math.floor(r() * 40), h: 8 + Math.floor(r() * 40) };
      const outline = new ExploredOutline(bounds, "s1");
      let fog: Record<string, FogTile> = {};
      let explored: Record<string, FogTile> = {};
      for (let step = 0; step < 20; step++) {
        const layer = r() < 0.6 ? "explored" : "fog";
        const tx = Math.floor(r() * 3);
        const ty = Math.floor(r() * 3);
        const a = Math.floor(r() * 64);
        const b = Math.floor(r() * 64);
        const roll = r();
        const next = layer === "explored" ? { ...explored } : { ...fog };
        if (roll < 0.15) delete next[`s1:${tx},${ty}`];
        else next[`s1:${tx},${ty}`] = tile(tx, ty, (sx, sy) => Math.abs(sx - a) + Math.abs(sy - b) < 20 || (sx + sy) % 11 === 0);
        if (layer === "explored") explored = next;
        else fog = next;
        const got = units(outline.update(fog, explored).flat());
        const want = units(exploredOutline(bounds, "s1", fog, explored));
        assert.deepEqual([...got].sort(), [...want].sort(), `seed ${seed}, step ${step}`);
      }
    }
  });
});
