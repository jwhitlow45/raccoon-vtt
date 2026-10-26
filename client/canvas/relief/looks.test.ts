import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { rng } from "#shared/testutil.ts";
import { TERRAIN_COLORS, TERRAIN_SWATCHES } from "../../features/builder/textures.ts";
import { theme } from "../../lib/theme.ts";
import { FogView } from "./fogView.ts";
import { averageColor, cellLook, CellTints, pixelsInside, sideLook, type PixelRect } from "./looks.ts";

/** An image of `w` by `h` pixels, RGBA, from a color per pixel. */
function image(w: number, h: number, color: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  const read = (r: PixelRect) => {
    const out = new Uint8ClampedArray(r.sw * r.sh * 4);
    for (let y = 0; y < r.sh; y++) out.set(data.subarray(((r.sy + y) * w + r.sx) * 4, ((r.sy + y) * w + r.sx + r.sw) * 4), y * r.sw * 4);
    return out;
  };
  return { read, size: { width: w, height: h } };
}

describe("side looks", () => {
  test("a grass bank wears grass, a stone platform stone, a stair its swatch, a pit's or a pillar's cell stone", () => {
    assert.deepEqual(sideLook("grass", null), { texture: "grass", color: TERRAIN_COLORS.grass });
    assert.deepEqual(sideLook("stone", null), { texture: "stone", color: TERRAIN_COLORS.stone });
    assert.deepEqual(sideLook("stairs", null), { texture: null, color: TERRAIN_SWATCHES.stairs });
    assert.equal(sideLook("pillar", null).texture, "stone");
    assert.equal(sideLook("pit", null).texture, "stone");
    assert.deepEqual(sideLook(null, "rgb(1, 2, 3)"), { texture: null, color: "rgb(1, 2, 3)" });
    assert.deepEqual(sideLook(null, null), { texture: null, color: theme.relief.side });
  });

  test("a map-image platform takes the average color of its top's pixels", () => {
    // A 4 by 4 cell map, 16 px a cell, each cell its own color.
    const img = image(64, 64, (x, y) => [Math.floor(x / 16) * 60, Math.floor(y / 16) * 60, 7]);
    const tints = new CellTints(img.read, { x: 0, y: 0, width: 4, height: 4 }, img.size);
    assert.equal(tints.at(1, 2), "rgb(60, 120, 7)");
    assert.equal(tints.at(3, 0), "rgb(180, 0, 7)");
  });

  test("security: a revealed cell beside different hidden art takes the same tint, at any pixels to a cell", () => {
    const random = rng(26111);
    for (let round = 0; round < 40; round++) {
      // Pixels to a cell need not be whole: the cell's edge pixels then straddle it and its neighbors.
      const k = 6 + random() * 20;
      const rect = { x: -random() * 2, y: -random() * 2, width: 8, height: 8 };
      const size = { width: Math.round(8 * k), height: Math.round(8 * k) };
      const cell = { x: 2 + Math.floor(random() * 3), y: 2 + Math.floor(random() * 3) };
      const inside = pixelsInside(cell, rect, size)!;
      const inCell = (x: number, y: number) => x >= inside.sx && x < inside.sx + inside.sw && y >= inside.sy && y < inside.sy + inside.sh;
      const art = (seed: number) => (x: number, y: number): [number, number, number] => (inCell(x, y) ? [(x * 7) % 256, (y * 13) % 256, 90] : [(x * seed) % 256, (y * seed * 3) % 256, seed % 256]);
      const a = image(size.width, size.height, art(31));
      const b = image(size.width, size.height, art(101));
      assert.equal(new CellTints(a.read, rect, a.size).at(cell.x, cell.y), new CellTints(b.read, rect, b.size).at(cell.x, cell.y), `round ${round}`);
      // And every pixel read lies wholly inside the cell.
      const px = size.width / rect.width;
      assert.ok((inside.sx) / px + rect.x >= cell.x - 1e-9 && (inside.sx + inside.sw) / px + rect.x <= cell.x + 1 + 1e-9);
      const py = size.height / rect.height;
      assert.ok((inside.sy) / py + rect.y >= cell.y - 1e-9 && (inside.sy + inside.sh) / py + rect.y <= cell.y + 1 + 1e-9);
    }
  });

  test("a cell narrower than a pixel has no tint, and transparent pixels do not count", () => {
    assert.equal(pixelsInside({ x: 0, y: 0 }, { x: 0, y: 0, width: 400, height: 400 }, { width: 256, height: 256 }), null);
    assert.equal(averageColor([0, 0, 0, 0, 255, 255, 255, 255]), "rgb(255, 255, 255)");
    assert.equal(averageColor([0, 0, 0, 0]), null);
  });

  test("security: for a player only a cell with every sub-cell revealed takes the tint, the rest the neutral tone, and the DM sees every tint", () => {
    const img = image(64, 64, () => [200, 10, 10]);
    const tints = new CellTints(img.read, { x: 0, y: 0, width: 4, height: 4 }, img.size);
    const bits = new Uint8Array(TILE_BYTES);
    const reveal = (sx: number, sy: number) => {
      const i = sy * TILE_SUB + sx;
      bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
    };
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) reveal(sx, sy);
    // Cell 1, 0 has all its sub-cells but one revealed.
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (sx + sy > 0) reveal(FOG_SUBCELLS + sx, sy);
    const tiles: Record<string, FogTile> = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
    const fog = new FogView(tiles, "s1", { w: 4, h: 4 });
    assert.equal(cellLook(fog, tints, 0, 0, null).color, "rgb(200, 10, 10)");
    assert.equal(cellLook(fog, tints, 1, 0, null).color, theme.relief.side);
    assert.equal(cellLook(fog, tints, 2, 2, null).color, theme.relief.side);
    assert.equal(cellLook(new FogView(null, "s1", { w: 4, h: 4 }), tints, 2, 2, null).color, "rgb(200, 10, 10)");
    assert.equal(cellLook(fog, tints, 2, 2, "grass").texture, "grass");
  });
});
