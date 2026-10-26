import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GridShape, RoomState, SightTile, Token } from "../model.ts";
import { actor, int, pick, rng, room, scene, token } from "../testutil.ts";
import { footprintSubcells, type PlacedToken } from "./footprint.ts";
import { gridOfShape, SQUARES } from "./grid.ts";
import type { HexGrid } from "./hex.ts";
import { clearVisionCache, coldPartySight, holderSight, sightFromTiles, sightRect, sightTileLevels, type VisionWorld } from "./vision.ts";
import { sceneWalls } from "./walls.ts";

/**
 * Sight on hexes reads the sub-cells inside a creature's hexes
 * (docs/design-v1-hex-grids.md HX-D10), never its rectangle: the raster,
 * the tiles a device holds and the point query a sweep's moment asks all
 * answer alike.
 */

const world: VisionWorld = { walls: sceneWalls };
const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;

/** A dark hex scene of 32 by 24 cells, two players' creatures seeing in the dark, one lending its sight to the party. */
function hexRoom(shape: GridShape, perPlayer = false): RoomState {
  const s = room({
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 32, h: 24 }, fogEnabled: true, vision: { on: true, light: "dark", ...(perPlayer ? { perPlayer: true } : {}) } }) },
  });
  s.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 6.3, y: 8.1, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
  s.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 22.6, y: 14.4, actor: { inline: actor({ senses: "darkvision 20 ft" }) } });
  s.holders = perPlayer ? { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } } : {};
  return s;
}

function randomProbe(r: () => number): PlacedToken {
  const size = pick(r, SIZES);
  const at = { x: r() * 36 - 2, y: r() * 28 - 2 };
  return size === "custom" ? { size, w: 0.5 + r() * 4, h: 0.5 + r() * 4, ...at } : { size, ...at };
}

/** Each sub-cell's level, from the tiles. */
function levelReader(tiles: ReadonlyMap<string, SightTile>): (sx: number, sy: number) => number {
  const decoded = new Map([...tiles].map(([k, t]) => [k, sightTileLevels(t)!]));
  return (sx, sy) => {
    if (sx < 0 || sy < 0) return 0;
    const lv = decoded.get(`${Math.floor(sx / 64)},${Math.floor(sy / 64)}`);
    return lv ? lv[(sy % 64) * 64 + (sx % 64)]! : 0;
  };
}

function bruteSees(g: HexGrid, level: (sx: number, sy: number) => number, probe: PlacedToken): boolean {
  return footprintSubcells(g, probe).some(([sx, sy]) => level(sx, sy) > 0);
}

/** The square rule's answer for the same probe: any sub-cell center inside its unsnapped rectangle. */
function rectSees(level: (sx: number, sy: number) => number, probe: PlacedToken): boolean {
  const r = sightRect(probe);
  for (let sy = Math.floor(r.y0 * 4); sy < Math.ceil(r.y1 * 4); sy++) {
    for (let sx = Math.floor(r.x0 * 4); sx < Math.ceil(r.x1 * 4); sx++) {
      const cx = (sx + 0.5) / 4;
      const cy = (sy + 0.5) / 4;
      if (cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1 && level(sx, sy) > 0) return true;
    }
  }
  return false;
}

for (const shape of ["hexRows", "hexColumns"] as const) {
  const g = gridOfShape(shape) as HexGrid;
  describe(`${shape}: sight reads a creature's hexes`, () => {
    test("the raster, a device's tiles and the point query see a random creature exactly when a sub-cell of its hexes is seen", () => {
      clearVisionCache();
      const r = rng(81);
      const s = hexRoom(shape, true);
      const party = coldPartySight(s, "s1", world);
      const level = levelReader(party.tiles);
      const device = sightFromTiles(Object.fromEntries([...party.tiles].map(([k, t]) => [`s1:${k}`, t])), "s1");
      // A holder's sight answers by the point query until its raster is drawn.
      const holder = holderSight(s, "s1", "p1", world);
      const probes = Array.from({ length: 1500 }, () => randomProbe(r));
      const byPoint = probes.map((p) => holder.seesToken(p, g));
      const holderLevel = levelReader(holder.tiles);
      let differ = 0;
      for (const [i, p] of probes.entries()) {
        const want = bruteSees(g, level, p);
        assert.equal(party.seesToken(p, g), want, `party ${JSON.stringify(p)}`);
        assert.equal(device.seesToken(p, g), want, `device ${JSON.stringify(p)}`);
        assert.equal(byPoint[i], bruteSees(g, holderLevel, p), `point query ${JSON.stringify(p)}`);
        assert.equal(holder.seesToken(p, g), byPoint[i], `raster ${JSON.stringify(p)}`);
        if (rectSees(level, p) !== want) differ++;
      }
      // Section 10's mutant, the rect in the sight test: many creatures read otherwise by their rectangle.
      assert.ok(differ > 20, `${differ} probes tell the hexes from the rectangle`);
    });

    test("a creature whose box reaches into sight but whose hexes do not is unseen, and the square rule on the same box sees it", () => {
      clearVisionCache();
      const s = hexRoom(shape);
      const party = coldPartySight(s, "s1", world);
      const level = levelReader(party.tiles);
      const r = rng(82);
      let found: PlacedToken | null = null;
      for (let i = 0; i < 20000 && !found; i++) {
        const p: PlacedToken = { size: pick(r, ["medium", "large", "huge"] as const), x: int(r, 0, 31 * 8) / 8, y: int(r, 0, 23 * 8) / 8 };
        if (rectSees(level, p) && !bruteSees(g, level, p)) found = p;
      }
      assert.ok(found, "such a spot exists at the edge of sight");
      assert.equal(party.seesToken(found, g), false);
      assert.equal(party.seesToken(found, SQUARES), true);
    });
  });
}

describe("a token of a scene the state holds by its grid", () => {
  test("the same creature on a square copy of the scene is read by its rectangle, as before hex grids", () => {
    clearVisionCache();
    const s = hexRoom("hexRows");
    const squares: RoomState = { ...s, scenes: { s1: { ...s.scenes.s1!, gridShape: undefined } } };
    delete squares.scenes.s1!.gridShape;
    const sight = coldPartySight(squares, "s1", world);
    const level = levelReader(sight.tiles);
    const r = rng(83);
    for (let i = 0; i < 500; i++) {
      const p = randomProbe(r) as Token;
      assert.equal(sight.seesToken(p, SQUARES), rectSees(level, p));
    }
  });
});
