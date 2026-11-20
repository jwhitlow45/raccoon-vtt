import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AoeCoverage, AoeInclusion, AreaShape, BuildChunk } from "../model.ts";
import { creaturesInArea, defaultIncludeOrigin, partOverOpening, type AreaContext, type AreaTemplateInput, type AreaThrough, type AreaToken } from "./aoe.ts";
import { footprintRect, placedOnHex } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import type { HexGrid } from "./hex.ts";
import { deriveWalls, indexBuild } from "./walls.ts";

/*
 * Areas through openings (docs/design/design-v1-floors.md phase 4, 9.2): an
 * area on Upper floor ("up") over a 2 by 2 opening at 6, 6 down to Ground
 * floor ("g"), 10 ft below, and the same opening read from Ground floor.
 */

const HOLE = { x: 6, y: 6, w: 2, h: 2 };
const DOWN: AreaThrough = { sceneId: "g", rect: HOLE, dz: -10 };
const UP: AreaThrough = { sceneId: "up", rect: HOLE, dz: 10 };

function ctx(over: Partial<AreaContext> & { coverage?: AoeCoverage; inclusion?: AoeInclusion } = {}): AreaContext {
  const { coverage = "half", inclusion = "anyCell", ...rest } = over;
  return { settings: { feetPerCell: 5, aoeCoverage: coverage, aoeInclusion: inclusion }, bounds: { w: 20, h: 20 }, grid: SQUARES, ...rest };
}

function area(over: Partial<AreaTemplateInput> = {}): AreaTemplateInput {
  const shape = over.shape ?? "sphere";
  return { id: "a1", rev: 1, sceneId: "up", shape, size: 10, origin: { x: 7, y: 7, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin(shape), ...over };
}

function tok(id: string, over: Partial<AreaToken> = {}): AreaToken {
  return { id, rev: 1, size: "medium", x: 6, y: 6, elevation: 0, sceneId: "g", ...over };
}

/** A slab 5 ft thick from `z` up, wide enough to cover the whole hole: what it catches says the height a creature is read at. */
const slab = (z: number, sceneId = "up"): AreaTemplateInput => area({ sceneId, shape: "cylinder", size: 20, height: 5, origin: { x: 7, y: 7, z } });

describe("heights across an opening (D-261119-109)", () => {
  test("a creature below at 5 ft is read from above at -5 ft, by the floor's height alone", () => {
    const goblin = [tok("gob", { elevation: 5 })];
    const caught = (z: number) => creaturesInArea(slab(z), goblin, ctx({ through: [DOWN] })).length > 0;
    // Its 5 ft body spans -5 to 0 from above: a slab from -4 reaches it, one from 0.5 or from -11 does not.
    assert.equal(caught(-4), true);
    assert.equal(caught(0.5), false, "not read at its own height, nor above it");
    assert.equal(caught(-11), false, "not read past the floor's height");
    assert.equal(caught(-10), true, "a slab from -10 to -5 meets its feet");
  });

  test("a creature above at 0 ft is read from below at 10 ft", () => {
    const bird = [tok("owl", { sceneId: "up", elevation: 0 })];
    const caught = (z: number) => creaturesInArea(slab(z, "g"), bird, ctx({ through: [UP] })).length > 0;
    assert.equal(caught(10.5), true);
    assert.equal(caught(-0.5), false, "not read at its own height, nor below the floor between");
    assert.equal(caught(15.5), false);
  });

  test("a fireball over a hole catches a goblin below and one beside it on its own floor, and nothing without the opening", () => {
    const tokens = [tok("below"), tok("here", { sceneId: "up", x: 8, y: 7 })];
    const fireball = area({ size: 20 });
    assert.deepEqual(creaturesInArea(fireball, tokens, ctx({ through: [DOWN] })), ["below", "here"]);
    assert.deepEqual(creaturesInArea(fireball, tokens, ctx()), ["here"], "the server's rules give no openings, so only its own floor");
    assert.deepEqual(creaturesInArea(fireball, tokens, ctx({ through: [{ ...DOWN, sceneId: "other" }] })), ["here"], "an opening to another floor reaches none here");
  });
});

describe("only the part over the opening counts", () => {
  test("a creature below beside the hole is never caught, whatever covers its squares on the floor plan", () => {
    const beside = [tok("ogre", { size: "large", x: 3, y: 6 })];
    const fireball = area({ size: 30, origin: { x: 4, y: 7, z: 0 } });
    assert.deepEqual(creaturesInArea(fireball, [{ ...beside[0]!, sceneId: "up" }], ctx()), ["ogre"], "on the area's floor it would be caught");
    assert.deepEqual(creaturesInArea(fireball, beside, ctx({ through: [DOWN] })), []);
  });

  test("a Large ogre below half over the hole is caught only by an area reaching that half", () => {
    // Its space is 5 to 7 by 6 to 8: column 6 lies over the hole, column 5 does not.
    const ogre = [tok("ogre", { size: "large", x: 5, y: 6 })];
    const offHalf = area({ size: 5, origin: { x: 5.2, y: 7, z: -5 } });
    const onHalf = area({ size: 5, origin: { x: 6.8, y: 7, z: -5 } });
    for (const inclusion of ["anyCell", "majority", "center"] as const) {
      assert.deepEqual(creaturesInArea(offHalf, ogre, ctx({ inclusion, through: [DOWN] })), [], `${inclusion}: the half beside the hole`);
    }
    assert.deepEqual(creaturesInArea(onHalf, ogre, ctx({ through: [DOWN] })), ["ogre"]);
    // Under "center" and "majority" the part over the hole is the creature: its middle, and most of it, is in the sphere.
    assert.deepEqual(creaturesInArea(onHalf, ogre, ctx({ inclusion: "center", through: [DOWN] })), ["ogre"]);
    assert.deepEqual(creaturesInArea(onHalf, ogre, ctx({ inclusion: "majority", through: [DOWN] })), ["ogre"]);
  });

  test("the area's own floor's walls clip it: a wall upstairs between the origin and the hole shields the creature below", () => {
    const edges: BuildChunk["edges"] = Object.fromEntries(Array.from({ length: 16 }, (_, y) => [`5,${y},w`, { kind: "wall" as const }]));
    const chunk: BuildChunk = { sceneId: "up", cx: 0, cy: 0, rev: 1, cells: {}, edges };
    const walls = deriveWalls(indexBuild([chunk]), 1);
    const fireball = area({ size: 20, origin: { x: 3, y: 7, z: 0 } });
    const goblin = [tok("gob")];
    assert.deepEqual(creaturesInArea(fireball, goblin, ctx({ through: [DOWN] })), ["gob"]);
    assert.deepEqual(creaturesInArea(fireball, goblin, ctx({ walls, through: [DOWN] })), []);
  });

  test("the part's squares: a footprint cut to the hole, and none for a space beside it", () => {
    assert.deepEqual(partOverOpening(SQUARES, tok("o", { size: "large", x: 5, y: 7 }), HOLE), { kind: "squares", rect: { x: 6, y: 7, w: 1, h: 1 }, range: { x0: 6, y0: 7, x1: 7, y1: 8 } });
    assert.equal(partOverOpening(SQUARES, tok("o", { x: 8, y: 6 }), HOLE), null, "touching the rim is not over it");
    assert.deepEqual(partOverOpening(SQUARES, tok("t", { size: "tiny", x: 7.5, y: 6 }), HOLE), { kind: "squares", rect: { x: 7.5, y: 6, w: 0.5, h: 0.5 }, range: { x0: 7, y0: 6, x1: 8, y1: 7 } });
  });
});

describe("a creature across an opening is caught as one on the area's floor standing on just its part there, at its moved height", () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SHAPES: AreaShape[] = ["sphere", "cube", "cylinder", "cone", "line"];
  const SIZES = ["tiny", "small", "medium", "large", "huge"] as const;

  test("over 1,500 random areas, creatures and rules", () => {
    const rand = mulberry32(4402);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const hole = { x: 6, y: 6, w: 3, h: 2 };
    let caught = 0;
    let compared = 0;
    for (let i = 0; i < 1500; i++) {
      const j: AreaThrough = { sceneId: "g", rect: hole, dz: pick([-10, -15, 10, 20]) };
      const size = pick(SIZES);
      const step = size === "tiny" ? 0.5 : 1;
      const creature = tok("c", { size, x: 4 + Math.floor((rand() * 6) / step) * step, y: 4 + Math.floor((rand() * 5) / step) * step, elevation: pick([0, 5, 10, -5]) });
      const shape = pick(SHAPES);
      const t = area({ shape, size: pick([5, 10, 15, 20]), origin: { x: 5 + rand() * 5, y: 5 + rand() * 4, z: pick([-15, -10, -5, 0, 5, 10, 20]) }, yaw: Math.floor(rand() * 360), ...(shape === "cone" || shape === "line" ? { pitch: pick([0, 0, 30, -45]) } : {}) });
      const c = ctx({ inclusion: pick(["anyCell", "majority", "center"] as const), coverage: pick(["half", "any", "center"] as const), through: [j] });
      const across = creaturesInArea(t, [creature], c);
      const part = partOverOpening(SQUARES, creature, hole);
      if (!part || part.kind !== "squares") {
        assert.deepEqual(across, [], `${i}: nothing of it over the hole`);
        continue;
      }
      // The same creature's body on the area's floor, cut to its part: a custom footprint of the part's own size and place.
      const r = footprintRect(SQUARES, creature);
      const own: AreaToken = { id: "c", rev: 1, sceneId: "up", size: "custom", w: part.rect.w, h: part.rect.h, x: part.rect.x, y: part.rect.y, elevation: creature.elevation + j.dz, height: Math.min(r.w, r.h) * 5 };
      const here = creaturesInArea(t, [own], ctx({ ...c, through: undefined }));
      // A custom footprint snaps to whole cells once a side reaches a cell, so only a part at its own snapped place compares.
      if (footprintRect(SQUARES, own).x !== part.rect.x || footprintRect(SQUARES, own).y !== part.rect.y) continue;
      assert.deepEqual(across, here, `${i}: ${JSON.stringify({ t, creature, j, rule: c.settings })}`);
      compared++;
      if (across.length > 0) caught++;
    }
    assert.ok(compared > 400 && caught > 80 && caught < compared - 80, `the random rooms compare many and catch some but not all (${caught} of ${compared})`);
  });
});

describe("on hexes", () => {
  const g: HexGrid = { shape: "hex", orient: "rows" };
  const hexCtx = (over: Partial<AreaContext> & { inclusion?: AoeInclusion } = {}) => ctx({ ...over, grid: g });
  const onHex = (id: string, col: number, row: number, over: Partial<AreaToken> = {}): AreaToken => tok(id, { ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col, row }), ...over });

  test("a creature below on a hex of the hole is caught, one beside it is not, by the same fireball", () => {
    const fireball = area({ size: 20, origin: { x: 7.5, y: 7.5, z: 0 } });
    const tokens = [onHex("in", 7, 7), onHex("beside", 9, 7)];
    assert.deepEqual(creaturesInArea(fireball, tokens.map((t) => ({ ...t, sceneId: "up" })), hexCtx()), ["in", "beside"], "both are in reach on the floor plan");
    assert.deepEqual(creaturesInArea(fireball, tokens, hexCtx({ through: [DOWN] })), ["in"]);
    assert.deepEqual(creaturesInArea(fireball, tokens, hexCtx({ through: [DOWN], inclusion: "center" })), ["in"]);
  });

  test("its height moves as on squares", () => {
    const goblin = [onHex("gob", 7, 7, { elevation: 5 })];
    const caught = (z: number) => creaturesInArea({ ...slab(z), origin: { x: 7.5, y: 7.5, z } }, goblin, hexCtx({ through: [DOWN] })).length > 0;
    assert.equal(caught(-4), true);
    assert.equal(caught(0.5), false);
    assert.equal(caught(-11), false);
  });

  test("under \"center\" a creature partly over the hole is read at the middle of its hexes there, not at its anchor beside it", () => {
    // A Large ogre whose reference hex is 7, 5: only its hex 7, 6 lies over the hole, its anchor on the corner beside it.
    const ogre = [tok("ogre", { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 7, row: 5 }) })];
    const at = (x: number, y: number) => creaturesInArea(area({ size: 5, origin: { x, y, z: 0 } }), ogre, hexCtx({ through: [DOWN], inclusion: "center" }));
    assert.deepEqual(at(7, 6.4), ["ogre"], "a small burst on its part over the hole");
    assert.deepEqual(at(8.8, 5.1), [], "a small burst on its anchor, past the rim");
  });

  test("the part over the hole is its hexes there", () => {
    const large = tok("ogre", { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 7, row: 7 }) });
    const part = partOverOpening(g, large, HOLE);
    assert.ok(part?.kind === "hexes");
    assert.ok(part.hexes.length > 0 && part.hexes.every((h) => h.col >= 6 && h.col < 8 && h.row >= 6 && h.row < 8));
    assert.equal(partOverOpening(g, onHex("x", 12, 12), HOLE), null);
  });
});
