import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogTile } from "#shared/model.ts";
import { decodeTile, getBit, TILE_BYTES } from "#shared/rules/fog.ts";
import { encodeTileFrom, FogRaster, fogPixels, revealedMask } from "./fogTiles.ts";

const tile = (tx: number, ty: number, bits: string, sceneId = "s1"): FogTile => ({ sceneId, tx, ty, rev: 1, bits });

describe("tile encoding for fixtures", () => {
  test("round trips through the shared decoder: row-major, least significant bit first", () => {
    const bytes = decodeTile(encodeTileFrom((sx, sy) => sx === 3 && sy === 0))!;
    assert.equal(bytes.length, TILE_BYTES);
    assert.equal(bytes[0], 0b0000_1000);
    assert.equal(getBit(bytes, 3, 0), true);
    assert.equal(getBit(bytes, 4, 0), false);
  });

  test("bit 64 is the first sub-cell of the second row", () => {
    const bytes = decodeTile(encodeTileFrom((sx, sy) => sx === 0 && sy === 1))!;
    assert.equal(bytes[8], 1);
    assert.equal(getBit(bytes, 0, 1), true);
  });
});

describe("scene mask (fails closed)", () => {
  const allRevealed = encodeTileFrom(() => true);

  test("no tiles means the whole scene is fogged", () => {
    const mask = revealedMask({ w: 20, h: 10 }, "s1", {});
    assert.equal(mask.width, 80);
    assert.equal(mask.height, 40);
    assert.ok(mask.revealed.every((v) => v === 0));
  });

  test("a revealed tile reveals exactly its 16 x 16 cells, clipped to the bounds", () => {
    const mask = revealedMask({ w: 20, h: 10 }, "s1", { "s1:1,0": tile(1, 0, allRevealed) });
    const at = (cx: number, cy: number) => mask.revealed[cy * 4 * mask.width + cx * 4];
    assert.equal(at(15, 0), 0);
    assert.equal(at(16, 0), 1);
    assert.equal(at(19, 9), 1);
    assert.equal(mask.revealed.reduce((n, v) => n + v, 0), 4 * 4 * 4 * 10);
  });

  test("corrupt tiles, other scenes and odd coordinates stay fogged", () => {
    const mask = revealedMask({ w: 32, h: 32 }, "s1", {
      "s1:0,0": tile(0, 0, "!!!"),
      "s1:1,0": tile(1, 0, btoa("too short")),
      "s2:0,1": tile(0, 1, allRevealed, "s2"),
      "s1:0,1": tile(0.5, 1, allRevealed),
      "s1:-1,0": tile(-1, 0, allRevealed),
      "s1:9,9": tile(9, 9, allRevealed),
    });
    assert.ok(mask.revealed.every((v) => v === 0));
  });

  test("a tile whose bits are not a string stays fogged", () => {
    const bad = { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: 42 } as unknown as FogTile;
    const mask = revealedMask({ w: 16, h: 16 }, "s1", { "s1:0,0": bad });
    assert.ok(mask.revealed.every((v) => v === 0));
  });
});

describe("fog pixels", () => {
  test("fogged pixels are fully opaque and open ones clear, with a light edge on the open side", () => {
    // A 2 x 1 cell scene: the left cell revealed, the right one fogged.
    const bits = encodeTileFrom((sx) => sx < 4);
    const mask = revealedMask({ w: 2, h: 1 }, "s1", { "s1:0,0": tile(0, 0, bits) });
    const px = fogPixels(mask, [10, 20, 30], 0.4);
    const alpha = (x: number, y: number) => px[(y * mask.width + x) * 4 + 3];
    for (let y = 0; y < 4; y++) for (let x = 4; x < 8; x++) assert.equal(alpha(x, y), 255);
    assert.equal(alpha(1, 1), 0, "interior of the revealed cell is clear");
    assert.equal(alpha(3, 1), 102, "revealed next to fog is tinted, never see-through fog");
    assert.equal(alpha(0, 0), 102, "the scene edge counts as fog");
    assert.deepEqual([...px.slice(0, 3)], [10, 20, 30]);
  });
});

describe("the fog image kept tile by tile", () => {
  /** A small random generator, so a failure repeats. */
  function rng(seed: number): () => number {
    let x = seed;
    return () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x / 2 ** 32;
    };
  }

  test("after any sequence of tile changes it holds the pixels a fresh build gives", () => {
    const rgb = [13, 13, 18] as const;
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const bounds = { w: 1 + Math.floor(r() * 40), h: 1 + Math.floor(r() * 40) };
      const raster = new FogRaster(bounds, rgb);
      let tiles: Record<string, FogTile> = {};
      for (let step = 0; step < 25; step++) {
        const next = { ...tiles };
        const changes = 1 + Math.floor(r() * 4);
        for (let c = 0; c < changes; c++) {
          const tx = Math.floor(r() * 4);
          const ty = Math.floor(r() * 4);
          // Two layers at one place, as a DM's view draws them, under keys of their own.
          const key = `${r() < 0.5 ? "" : "explored:"}s1:${tx},${ty}`;
          const roll = r();
          if (roll < 0.2) delete next[key];
          else if (roll < 0.25) next[key] = tile(tx, ty, "corrupt!");
          else if (roll < 0.3) next[key] = tile(tx, ty, encodeTileFrom(() => true), "s2");
          else {
            const a = Math.floor(r() * 64);
            const b = Math.floor(r() * 64);
            next[key] = tile(tx, ty, encodeTileFrom((sx, sy) => (sx * 7 + sy * 3 + a) % 64 < b));
          }
        }
        tiles = next;
        raster.update(tiles, "s1");
        const fresh = fogPixels(revealedMask(bounds, "s1", tiles), rgb);
        assert.deepEqual(raster.rgba, fresh, `seed ${seed}, step ${step}`);
      }
    }
  });

  test("only a changed place is rewritten, with the ring of pixels around it", () => {
    const raster = new FogRaster({ w: 40, h: 40 }, [0, 0, 0]);
    const a = tile(0, 0, encodeTileFrom(() => true));
    const b = tile(1, 1, encodeTileFrom(() => true));
    assert.equal(raster.update({ a, b }, "s1").length, 2);
    assert.deepEqual(raster.update({ a, b }, "s1"), []);
    assert.deepEqual(raster.update({ a, b: { ...b } }, "s1"), [{ x: 63, y: 63, w: 66, h: 66 }]);
    // A place left with no tile goes back to fog.
    assert.deepEqual(raster.update({ a }, "s1"), [{ x: 63, y: 63, w: 66, h: 66 }]);
  });
});
