import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, wallChunk } from "../keys.ts";
import type { FreeWall, GridShape, RoomState, SightTile, Token } from "../model.ts";
import { withheldWhereItStands } from "../project.ts";
import { actor, int, pick, rng, room, scene, token } from "../testutil.ts";
import { footprintSubcells, type PlacedToken } from "./footprint.ts";
import { gridOfShape, SQUARES } from "./grid.ts";
import type { HexGrid } from "./hex.ts";
import { SegmentIndex, SIGHT } from "./segments.ts";
import { clearVisionCache, clipFootprint, coldPartySight, holderSight, seesCreature, seesPast, sightClipOf, sightFromTiles, sightRect, sightTileLevels, type VisionWorld } from "./vision.ts";
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

/** Free walls added to scene s1's chunks. */
function addWalls(s: RoomState, walls: FreeWall[]): RoomState {
  for (const w of walls) {
    const { cx, cy } = wallChunk(w);
    const key = chunkKey("s1", cx, cy);
    const chunk = s.buildChunks[key] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
    s.buildChunks[key] = { ...chunk, walls: [...(chunk.walls ?? []), w] };
  }
  return s;
}

let wallIds = 0;
function free(ax: number, ay: number, bx: number, by: number): FreeWall {
  return { id: `c${String(wallIds++).padStart(11, "0")}`, a: [ax, ay], b: [bx, by], f: { kind: "wall" } };
}

function clipOf(s: RoomState): SegmentIndex | null {
  return sightClipOf(sceneWalls(s.scenes.s1!, s.buildChunks));
}

describe("the wall clip on hexes (HX-D10)", () => {
  const g = gridOfShape("hexRows") as HexGrid;
  const WALL_X = 5.4375;
  const centerX = (sx: number) => (2 * sx + 1) / 8;

  /** A dark hex rows scene, a Medium monster at (5.49, 0.2), a wall at x = 5.4375 through its hex, and a player's eye in the dark at `eyeX`. */
  function clipRoom(eyeX: number, perPlayer = false): RoomState {
    const s = room({
      scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 16, h: 8 }, fogEnabled: true, vision: { on: true, light: "dark", ...(perPlayer ? { perPlayer: true } : {}) } }) },
    });
    s.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: eyeX, y: 0.1, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
    s.tokens.m = token("m", { x: 5.49, y: 0.2 });
    // A second player's eye far off, so the holder's sources are fewer than the union's and its sight is a point query.
    if (perPlayer) s.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 14, y: 6, actor: { inline: actor({ senses: "darkvision 10 ft" }) } });
    s.holders = perPlayer ? { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } } : {};
    return addWalls(s, [free(WALL_X, 0, WALL_X, 3)]);
  }

  /** The raster, a device's tiles and the point query, each by the clip. */
  function sees(eyeX: number): boolean[] {
    clearVisionCache();
    const s = clipRoom(eyeX);
    const m = s.tokens.m!;
    const party = coldPartySight(s, "s1", world);
    const device = sightFromTiles(Object.fromEntries([...party.tiles].map(([k, t]) => [`s1:${k}`, t])), "s1");
    clearVisionCache();
    const held = clipRoom(eyeX, true);
    // A holder's sight answers by the point query until its raster is drawn.
    const point = seesCreature(holderSight(held, "s1", "p1", world), m, g, clipOf(held));
    return [seesCreature(party, m, g, clipOf(s)), seesCreature(device, m, g, clipOf(s)), point];
  }

  test("a Medium at (5.49, 0.2) with a wall at x = 5.4375 through its hex: the 7 sub-cells left of the wall never show it", () => {
    clearVisionCache();
    const s = clipRoom(2);
    const m = s.tokens.m!;
    const { subs, kept } = clipFootprint(g, m, clipOf(s));
    const behind = subs.filter(([sx]) => centerX(sx) < WALL_X);
    assert.equal(subs.length, 14);
    assert.equal(behind.length, 7, "7 of its hex's sub-cells lie left of the wall");
    assert.deepEqual(kept, subs.filter(([sx]) => centerX(sx) > WALL_X), "the clip keeps the 7 on its stored center's side");
    const party = coldPartySight(s, "s1", world);
    const level = levelReader(party.tiles);
    assert.deepEqual(
      subs.filter(([sx, sy]) => level(sx, sy) > 0),
      behind,
      "the eye left of the wall sees exactly those 7 of the hex",
    );
    assert.equal(party.seesToken(m, g), true, "read unclipped, they would show it");
    assert.deepEqual(sees(2), [false, false, false], "the raster, a device's tiles and the point query: unseen from the left");
    assert.deepEqual(sees(8), [true, true, true], "and seen from the right, where its stored center is");
    clearVisionCache();
    assert.equal(withheldWhereItStands(clipRoom(2), m), true, "withheld from players");
    clearVisionCache();
    assert.equal(withheldWhereItStands(clipRoom(8), m), false);
  });

  test("a creature whose stored center lies on walls it cannot step off is unseen and withheld", () => {
    clearVisionCache();
    // Eight walls through its center, one along each line the sixteen step directions lie on: every direction slides along one.
    const lines = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
      [1, 2],
      [2, 1],
      [1, -2],
      [2, -1],
    ] as const;
    const s = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 24, h: 24 }, fogEnabled: true, vision: { on: true, light: "bright" } }) } });
    s.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 5.5, y: 9.5 });
    s.tokens.m = token("m", { x: 9.5, y: 9.5 });
    addWalls(
      s,
      lines.map(([a, b]) => free(10 - a, 10 - b, 10 + a, 10 + b)),
    );
    const m = s.tokens.m;
    const party = coldPartySight(s, "s1", world);
    assert.equal(party.seesToken(m, g), true, "the eye sees part of its hex");
    assert.deepEqual(clipFootprint(g, m, clipOf(s)).kept, [], "no sub-cell is kept");
    assert.equal(seesCreature(party, m, g, clipOf(s)), false);
    assert.equal(withheldWhereItStands(s, m), true);
  });

  test("a sight line is blocked by a crossing and by a touch, but not by a wall lying along it", () => {
    const index = (segs: number[]) => new SegmentIndex(Float64Array.from(segs), new Uint8Array(segs.length / 4).fill(SIGHT));
    const past = (segs: number[], px: number, py: number) => seesPast(0.5, 0.5, px, py, index(segs).xy, segs.length === 0 ? [] : [0]);
    assert.equal(past([], 3.5, 0.5), true);
    assert.equal(past([2, 0, 2, 1], 3.5, 0.5), false, "a crossing");
    assert.equal(past([2, 0.5, 2, 1], 3.5, 0.5), false, "a wall's end on the line, which may be a closed corner");
    assert.equal(past([2, 0, 2, 1], 2, 0.5), false, "the point on a wall");
    assert.equal(past([1.5, 0.5, 2.5, 0.5], 3.5, 0.5), true, "a wall along the line, with no width");
    assert.equal(past([1.5, 0.5, 3.5, 0.5], 3.5, 0.5), false, "the point on a wall along the line");
    assert.equal(past([2, 0.75, 2, 1], 3.5, 0.5), true, "a wall beside the line");
  });

  test("square scenes and hex scenes without sight walls read every sub-cell, as before", () => {
    clearVisionCache();
    const s = clipRoom(2);
    const squares: RoomState = { ...s, scenes: { s1: { ...s.scenes.s1!, gridShape: undefined } } };
    delete squares.scenes.s1!.gridShape;
    // Its box from x = 5 holds sub-cells on both sides of the wall, and the eye sees those on its own side.
    const straddling = token("m", { x: 5, y: 0.2 });
    assert.equal(coldPartySight(squares, "s1", world).seesToken(straddling, SQUARES), true);
    assert.equal(withheldWhereItStands(squares, straddling), false, "the same walls on squares keep the square rule");
    const open: RoomState = { ...s, buildChunks: {} };
    clearVisionCache();
    assert.equal(clipOf(open), null);
    assert.equal(withheldWhereItStands(open, s.tokens.m!), false, "without the wall the left eye sees it");
  });
});
