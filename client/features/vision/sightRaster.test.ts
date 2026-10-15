import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, SightTile } from "#shared/model.ts";
import { clearVisionCache, coldPartySight, sightTileLevels } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { actor, room, scene, token } from "#shared/testutil.ts";
import { BRIGHT, decodeByTable, decodeSightBits, DIM, GREY, NOT_SEEN, PARTY_PALETTE, SIGHT_TILE_BYTES, SightRaster } from "./sightRaster.ts";

const TILE = 64;

/** A `b` tile from a level per tile sub-cell, packed as the server packs it: 2 bits each, low bits first. */
function tileFrom(level: (sx: number, sy: number) => number): SightTile {
  const bytes = new Uint8Array(SIGHT_TILE_BYTES);
  for (let sy = 0; sy < TILE; sy++) {
    for (let sx = 0; sx < TILE; sx++) {
      const i = sy * TILE + sx;
      bytes[i >> 2]! |= (level(sx, sy) & 3) << ((i & 3) << 1);
    }
  }
  return { b: Buffer.from(bytes).toString("base64") };
}

describe("the sight raster", () => {
  test("a tile's 2-bit levels land on their own sub-cells, row by row, low bits first", () => {
    const raster = new SightRaster({ w: 32, h: 32 }, PARTY_PALETTE);
    const tile = tileFrom((sx, sy) => (sx === 1 && sy === 0 ? BRIGHT : sx === 2 && sy === 0 ? GREY : sx === 3 && sy === 5 ? DIM : NOT_SEEN));
    const dirty = raster.update({ "s1:1,1": tile }, "s1");
    assert.deepEqual(dirty, [{ x: 64, y: 64, w: 64, h: 64 }]);
    assert.equal(raster.levelAt(64 + 1, 64), BRIGHT);
    assert.equal(raster.levelAt(64 + 2, 64), GREY);
    assert.equal(raster.levelAt(64 + 3, 64 + 5), DIM);
    assert.equal(raster.levelAt(64, 64), NOT_SEEN);
    // The tile beside it was never sent: not seen.
    assert.equal(raster.levelAt(1, 0), NOT_SEEN);
  });

  test("a uniform tile fills its tile, and only an object that changed is written again", () => {
    const raster = new SightRaster({ w: 32, h: 32 }, PARTY_PALETTE);
    const lit: SightTile = { f: 3 };
    const sight: Record<string, SightTile> = { "s1:0,0": lit, "s1:1,0": { f: 2 } };
    assert.equal(raster.update(sight, "s1").length, 2);
    assert.equal(raster.levelAt(10, 10), BRIGHT);
    assert.equal(raster.levelAt(70, 10), DIM);
    // The same objects again: nothing to write.
    assert.deepEqual(raster.update({ ...sight }, "s1"), []);
    // One tile replaced: one tile written.
    assert.deepEqual(raster.update({ ...sight, "s1:1,0": { f: 1 } }, "s1"), [{ x: 64, y: 0, w: 64, h: 64 }]);
    assert.equal(raster.levelAt(70, 10), GREY);
  });

  test("a tile the server took away goes back to not seen", () => {
    const raster = new SightRaster({ w: 32, h: 32 }, PARTY_PALETTE);
    raster.update({ "s1:0,0": { f: 3 }, "s1:1,1": { f: 3 } }, "s1");
    const dirty = raster.update({ "s1:0,0": { f: 3 } }, "s1");
    assert.deepEqual(dirty.at(-1), { x: 64, y: 64, w: 64, h: 64 });
    assert.equal(raster.levelAt(100, 100), NOT_SEEN);
    assert.equal(raster.levelAt(10, 10), BRIGHT, "a new object at 0,0 is written as sent");
  });

  test("fails closed: an unreadable tile draws as not seen", () => {
    const raster = new SightRaster({ w: 16, h: 16 }, PARTY_PALETTE);
    const good = tileFrom(() => BRIGHT) as { b: string };
    const cases: unknown[] = [
      { f: 7 },
      { f: 0 },
      { f: "3" },
      { b: "not base64" },
      { b: good.b.slice(0, -4) },
      { b: `${good.b.slice(0, -2)}A=` },
      // Valid characters, but the last group carries bits a 1,024-byte tile never has.
      { b: `${good.b.slice(0, -3)}B==` },
      { b: `${good.b.slice(0, 100)}*${good.b.slice(101)}` },
      null,
      "3",
      {},
    ];
    for (const bad of cases) {
      raster.update({ "s1:0,0": { f: 3 } }, "s1");
      assert.equal(raster.levelAt(5, 5), BRIGHT);
      raster.update({ "s1:0,0": bad as SightTile }, "s1");
      assert.equal(raster.levelAt(5, 5), NOT_SEEN, JSON.stringify(bad)?.slice(0, 40));
    }
    raster.update({ "s1:0,0": good }, "s1");
    assert.equal(raster.levelAt(5, 5), BRIGHT);
  });

  test("other scenes, keys that name no tile, and tiles past the scene are ignored", () => {
    const raster = new SightRaster({ w: 20, h: 20 }, PARTY_PALETTE);
    const dirty = raster.update(
      {
        "s2:0,0": { f: 3 },
        // A scene whose ID starts with this one's.
        "s1:x:0,0": { f: 3 },
        "s1:0,0,1": { f: 3 },
        "s1:-1,0": { f: 3 },
        "s1:0.5,0": { f: 3 },
        "s1:2,0": { f: 3 },
        "s1:0,2": { f: 3 },
      },
      "s1",
    );
    assert.deepEqual(dirty, []);
    assert.equal(raster.levelAt(0, 0), NOT_SEEN);
  });

  test("a tile at the scene's edge writes only the part inside the scene", () => {
    // 20 cells are 80 sub-cells: the second tile column holds 16 of its 64.
    const raster = new SightRaster({ w: 20, h: 18 }, PARTY_PALETTE);
    assert.equal(raster.width, 80);
    assert.equal(raster.height, 72);
    const dirty = raster.update({ "s1:1,1": tileFrom((sx, sy) => (sx === 15 && sy === 7 ? BRIGHT : DIM)) }, "s1");
    assert.deepEqual(dirty, [{ x: 64, y: 64, w: 16, h: 8 }]);
    assert.equal(raster.levelAt(79, 71), BRIGHT);
    assert.equal(raster.levelAt(64, 64), DIM);
    assert.equal(raster.rgba.length, 80 * 72 * 4);
  });

  test("the colors are RGBA bytes as ImageData holds them", () => {
    const raster = new SightRaster({ w: 16, h: 16 }, PARTY_PALETTE);
    raster.update({ "s1:0,0": tileFrom((sx) => (sx === 0 ? GREY : BRIGHT)) }, "s1");
    assert.deepEqual([...raster.rgba.subarray(0, 4)], [...PARTY_PALETTE[GREY]]);
    assert.deepEqual([...raster.rgba.subarray(4, 8)], [0, 0, 0, 0]);
  });

  test("decodes exactly one tile of base64", () => {
    const out = new Uint8Array(SIGHT_TILE_BYTES);
    const bytes = new Uint8Array(SIGHT_TILE_BYTES).map((_, i) => (i * 37) & 255);
    assert.equal(decodeSightBits(Buffer.from(bytes).toString("base64"), out), true);
    assert.deepEqual(out, bytes);
    assert.equal(decodeSightBits(Buffer.from(bytes.subarray(1)).toString("base64"), out), false);
    assert.equal(decodeSightBits(Buffer.from(new Uint8Array(SIGHT_TILE_BYTES + 1)).toString("base64"), out), false);
    assert.equal(decodeSightBits(undefined, out), false);
  });
});

describe("the server's own tiles", () => {
  test("a dark scene's sight, as shared/rules/vision.ts encodes it, draws every sub-cell at its own level", () => {
    // 40 by 36 cells: three tile columns and three rows, the last of each cut by the scene's edge.
    const wall: EdgeFeature = { kind: "wall" };
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 4; y < 14; y++) edges[`12,${y},w`] = wall;
    for (let x = 2; x < 9; x++) edges[`${x},10,n`] = wall;
    const state = room({
      scenes: { s1: scene("s1", { bounds: { w: 40, h: 36 }, fogEnabled: true, vision: { on: true, light: "dark" }, autoWalls: "off" }) },
      buildChunks: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges } },
      tokens: {
        // Darkvision gives grey, the torch bright and dim, and the walls cut both.
        elf: token("elf", { kind: "pc", ownerIds: ["p1"], x: 6, y: 6, actor: { inline: actor({ senses: "Darkvision 60 ft." }) }, light: { bright: 20, dim: 20 } }),
        scout: token("scout", { kind: "pc", ownerIds: ["p1"], x: 30, y: 26, actor: { inline: actor({ senses: "" }) }, light: { bright: 5, dim: 5 } }),
      },
      lights: { lamp: { id: "lamp", rev: 0, sceneId: "s1", x: 20.5, y: 20.5, bright: 15, dim: 30, on: true, walls: true } },
    });
    clearVisionCache();
    const sight = coldPartySight(state, "s1", { walls: sceneWalls });
    const map: Record<string, SightTile> = {};
    for (const [at, tile] of sight.tiles) map[`s1:${at}`] = tile;
    const packed = [...sight.tiles.values()].filter((t) => "b" in t);
    assert.ok(packed.length >= 2, "the scene must send tiles with mixed levels");

    const raster = new SightRaster({ w: 40, h: 36 }, PARTY_PALETTE);
    raster.update(map, "s1");
    const counts = [0, 0, 0, 0];
    for (let sy = 0; sy < raster.height; sy++) {
      for (let sx = 0; sx < raster.width; sx++) {
        const tile = sight.tiles.get(`${sx >> 6},${sy >> 6}`);
        const want = tile ? sightTileLevels(tile)![(sy & 63) * 64 + (sx & 63)]! : NOT_SEEN;
        const got = raster.levelAt(sx, sy);
        if (got !== want) assert.fail(`sub-cell ${sx},${sy}: drew ${got}, the server sent ${want}`);
        counts[want]!++;
      }
    }
    assert.ok(counts.every((n) => n > 0), `every level appears: ${counts.join(", ")}`);

    // The lookup table decodes the same bytes as the browser's decoder and the server's.
    for (const tile of packed) {
      const text = (tile as { b: string }).b;
      const byTable = new Uint8Array(SIGHT_TILE_BYTES);
      const native = new Uint8Array(SIGHT_TILE_BYTES);
      assert.equal(decodeByTable(text, byTable), true);
      assert.equal(decodeSightBits(text, native), true);
      assert.deepEqual(byTable, native);
      assert.deepEqual(byTable, new Uint8Array(Buffer.from(text, "base64")));
    }
  });
});

describe("spreading a large change", () => {
  test("a limit writes that many tiles, says it is behind, and the next update goes on", () => {
    const raster = new SightRaster({ w: 48, h: 48 }, PARTY_PALETTE);
    const sight: Record<string, SightTile> = {};
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) sight[`s1:${tx},${ty}`] = { f: 3 };
    assert.equal(raster.update(sight, "s1", 4).length, 4);
    assert.equal(raster.behind, true);
    assert.equal(raster.update(sight, "s1", 4).length, 4);
    assert.equal(raster.update(sight, "s1", 4).length, 1);
    assert.equal(raster.behind, false);
    assert.equal(raster.update(sight, "s1", 4).length, 0);
    for (let sy = 0; sy < 192; sy += 64) for (let sx = 0; sx < 192; sx += 64) assert.equal(raster.levelAt(sx, sy), BRIGHT);
    // Tiles taken away count against the limit too.
    assert.equal(raster.update({ "s1:0,0": sight["s1:0,0"]! }, "s1", 5).length, 5);
    assert.equal(raster.behind, true);
    assert.equal(raster.update({ "s1:0,0": sight["s1:0,0"]! }, "s1", 5).length, 3);
    assert.equal(raster.behind, false);
    assert.equal(raster.levelAt(100, 100), NOT_SEEN);
    assert.equal(raster.levelAt(10, 10), BRIGHT);
  });
});
