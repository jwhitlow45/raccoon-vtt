import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AoeCoverage, AoeInclusion, AreaShape, BuildChunk, EdgeFeature } from "../model.ts";
import {
  castFromToken,
  computeCoverage,
  CoverageCache,
  coverageCacheKey,
  creaturesInArea,
  defaultIncludeOrigin,
  edgeOrigin,
  emanationFootprint,
  resolveArea,
  sampleCoord,
  type AreaContext,
  type AreaTemplateInput,
  type AreaToken,
} from "./aoe.ts";
import { deriveWalls, indexBuild, pointInPolygon, type WallSet } from "./walls.ts";
import { SQUARES } from "./grid.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tpl(over: Partial<AreaTemplateInput> = {}): AreaTemplateInput {
  const shape = over.shape ?? "sphere";
  return { id: "t1", rev: 1, shape, size: 20, origin: { x: 20, y: 20, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin(shape), ...over };
}

function tok(id: string, over: Partial<AreaToken> = {}): AreaToken {
  return { id, rev: 1, size: "medium", x: 0, y: 0, elevation: 0, ...over };
}

function ctx(over: Partial<AreaContext> & { coverage?: AoeCoverage; inclusion?: AoeInclusion } = {}): AreaContext {
  const { coverage = "half", inclusion = "anyCell", ...rest } = over;
  return { settings: { feetPerCell: 5, aoeCoverage: coverage, aoeInclusion: inclusion }, bounds: { w: 40, h: 40 }, grid: SQUARES, ...rest };
}

function covered(t: AreaTemplateInput, c: AreaContext): Set<string> {
  return new Set(computeCoverage(t, c).cells.map((cell) => `${cell.x},${cell.y}`));
}

function counts(t: AreaTemplateInput, extra: Partial<AreaContext> = {}): { half: number; any: number; center: number } {
  return {
    half: computeCoverage(t, ctx({ ...extra, coverage: "half" })).cells.length,
    any: computeCoverage(t, ctx({ ...extra, coverage: "any" })).cells.length,
    center: computeCoverage(t, ctx({ ...extra, coverage: "center" })).cells.length,
  };
}

test("ISOA1-PTIN: center inclusion clips all four scene edges, with old op behavior preserved", () => {
  const area = tpl({ size: 100, origin: { x: 10, y: 10, z: 0 }, includeOrigin: true });
  const tokens = [tok("in", { x: 19, y: 10 }), tok("right", { x: 19.5, y: 10 }), tok("bottom", { x: 10, y: 19.5 }), tok("left", { x: -1, y: 10 }), tok("top", { x: 10, y: -1 })];
  for (const opVersion of [32, 33, undefined]) {
    const context = ctx({ inclusion: "center", bounds: { w: 20, h: 20 }, opVersion });
    assert.deepEqual(creaturesInArea(area, tokens, context), opVersion === 32 ? tokens.map((t) => t.id) : ["in"], `version ${opVersion}`);
  }
});

function chunk(cells: string[], edges: Record<string, EdgeFeature> = {}): BuildChunk {
  return { sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges };
}

function rect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

/**
 * The definition in design section 9.3 with no shortcut: every cell of the
 * scene sampled at n x n points against the shape and the visibility
 * polygons, with the plain point-in-polygon test.
 */
function bruteForce(t: AreaTemplateInput, c: AreaContext): Map<string, { count: number; center: boolean }> {
  const area = resolveArea(t, c);
  assert.ok(area);
  const n = c.samples ?? 16;
  const z = area.originZ;
  // An aimed cone or line shades what it covers seen from above.
  const shape = area.shade ?? area.shape;
  const visible = (x: number, y: number) => area.polygons.length === 0 || area.polygons.some((p) => pointInPolygon(p, x, y));
  const out = new Map<string, { count: number; center: boolean }>();
  for (let j = 0; j < c.bounds.h; j++) {
    for (let i = 0; i < c.bounds.w; i++) {
      let count = 0;
      for (let r = 0; r < n; r++) {
        for (let k = 0; k < n; k++) {
          const x = sampleCoord(i, k, n);
          const y = sampleCoord(j, r, n);
          if (shape.inside(x, y, z) && visible(x, y)) count++;
        }
      }
      const center = shape.inside(i + 0.5, j + 0.5, z) && visible(i + 0.5, j + 0.5);
      if (count > 0 || center) out.set(`${i},${j}`, { count, center });
    }
  }
  return out;
}

function assertMatchesBruteForce(t: AreaTemplateInput, c: AreaContext, label: string): void {
  const expected = bruteForce(t, c);
  const got = computeCoverage(t, c);
  const seen = new Set<string>();
  for (let j = 0; j < got.h; j++) {
    for (let i = 0; i < got.w; i++) {
      const k = j * got.w + i;
      const key = `${got.x0 + i},${got.y0 + j}`;
      const want = expected.get(key) ?? { count: 0, center: false };
      assert.equal(got.counts[k], want.count, `${label}: count at ${key}`);
      assert.equal(got.centers[k] === 1, want.center, `${label}: center at ${key}`);
      seen.add(key);
    }
  }
  for (const key of expected.keys()) assert.ok(seen.has(key), `${label}: ${key} is inside but outside the window`);
}

describe("coverage matches the published counts", () => {
  test("20 ft sphere from an intersection: 52 under half, 60 under any", () => {
    assert.deepEqual(counts(tpl()), { half: 52, any: 60, center: 52 });
  });

  test("10 ft sphere: 12 under half, 16 under any", () => {
    assert.deepEqual(counts(tpl({ size: 10 })), { half: 12, any: 16, center: 12 });
  });

  test("15 ft cone along an axis from an intersection: 4 under half, 8 under any", () => {
    for (const yaw of [0, 90, 180, 270]) {
      assert.deepEqual(counts(tpl({ shape: "cone", size: 15, yaw })), { half: 4, any: 8, center: 4 }, `yaw ${yaw}`);
    }
  });

  test("30 ft cone along an axis: 18 under half, 24 under any", () => {
    assert.deepEqual(counts(tpl({ shape: "cone", size: 30 })), { half: 18, any: 24, center: 18 });
  });

  test("15 ft emanation: 44 and 48 around a Medium creature, 56 and 60 around a Large one", () => {
    const medium = tok("m", { x: 20, y: 20 });
    const large = tok("l", { size: "large", x: 20, y: 20 });
    const tokens = { m: medium, l: large };
    const em = (attachedTo: string) => tpl({ shape: "emanation", size: 15, attachedTo });
    assert.deepEqual(counts(em("m"), { tokens }), { half: 44, any: 48, center: 44 });
    assert.deepEqual(counts(em("l"), { tokens }), { half: 56, any: 60, center: 56 });
  });

  test("a cone from an edge midpoint and at 45 degrees", () => {
    assert.deepEqual(counts(tpl({ shape: "cone", size: 15, origin: { x: 20, y: 20.5, z: 0 } })), { half: 5, any: 7, center: 5 });
    assert.deepEqual(counts(tpl({ shape: "cone", size: 15, yaw: 45 })), { half: 5, any: 11, center: 5 });
  });
});

describe("shapes", () => {
  test("a cube cast from a token sits in front of it, bottom at its elevation", () => {
    const caster = tok("c", { x: 10, y: 10, elevation: 10 });
    const cast = castFromToken(SQUARES, { shape: "cube", size: 15, yaw: 0 }, caster, 5);
    assert.deepEqual(cast.origin, { x: 11, y: 10.5, z: 17.5 });
    assert.equal(cast.includeOrigin, false);
    const t = tpl({ shape: "cube", size: 15, ...cast });
    const cells = covered(t, ctx());
    assert.equal(cells.size, 9);
    for (let y = 9; y <= 11; y++) for (let x = 11; x <= 13; x++) assert.ok(cells.has(`${x},${y}`));
    const area = resolveArea(t, ctx());
    assert.ok(area);
    // Cells, with z in cells: the cube spans 10 ft to 25 ft.
    assert.ok(area.shape.inside(12, 10.5, 2.01));
    assert.ok(!area.shape.inside(12, 10.5, 1.99));
    assert.ok(area.shape.inside(12, 10.5, 4.99));
    assert.ok(!area.shape.inside(12, 10.5, 5.01));
  });

  test("the cube's face offset moves the origin across and up the face", () => {
    // u = 0.5 puts the origin at the clockwise edge of the face, so the cube extends counterclockwise (north here).
    const t = tpl({ shape: "cube", size: 15, origin: { x: 10, y: 10, z: 0 }, faceOffset: { u: 0.5, v: -0.5 } });
    const cells = covered(t, ctx());
    assert.deepEqual([...cells].sort(), ["10,7", "10,8", "10,9", "11,7", "11,8", "11,9", "12,7", "12,8", "12,9"]);
    const area = resolveArea(t, ctx());
    assert.ok(area?.shape.inside(11, 8, 2.9));
    assert.ok(!area?.shape.inside(11, 8, -0.1));
  });

  test("cones and lines from a token start on its edge", () => {
    const rect = { x: 10, y: 10, w: 1, h: 1 };
    assert.deepEqual(edgeOrigin(rect, 0), { x: 11, y: 10.5 });
    assert.deepEqual(edgeOrigin(rect, 90), { x: 10.5, y: 11 });
    assert.deepEqual(edgeOrigin(rect, 45), { x: 11, y: 11 });
    assert.deepEqual(edgeOrigin(rect, 200), { x: 10, y: 10.5 });
    assert.deepEqual(edgeOrigin({ x: 0, y: 0, w: 2, h: 2 }, 300), { x: 2, y: 0 });
    const caster = tok("c", { x: 10, y: 10 });
    const line = castFromToken(SQUARES, { shape: "line", size: 30, yaw: 0 }, caster, 5);
    assert.deepEqual(line.origin, { x: 11, y: 10.5, z: 2.5 });
    const cells = covered(tpl({ shape: "line", size: 30, ...line }), ctx());
    assert.deepEqual([...cells].sort(), ["11,10", "12,10", "13,10", "14,10", "15,10", "16,10"]);
  });

  test("origins are excluded by default for cones, cubes, lines and emanations", () => {
    const shapes: AreaShape[] = ["sphere", "cylinder", "cone", "cube", "line", "emanation"];
    assert.deepEqual(
      shapes.map((s) => defaultIncludeOrigin(s)),
      [true, true, false, false, false, false],
    );
  });

  test("the cone is a true 3D cone, narrower above its axis", () => {
    const area = resolveArea(tpl({ shape: "cone", size: 30, origin: { x: 0, y: 0, z: 0 } }), ctx());
    assert.ok(area);
    // 4 cells out, the cone's radius is 2 cells. One cell up it is sqrt(3) wide.
    assert.ok(area.shape.inside(4, 1.99, 0));
    assert.ok(!area.shape.inside(4, 1.99, 1));
    assert.ok(area.shape.inside(4, 1.7, 1));
    assert.ok(!area.shape.inside(4, 1.75, 1));
  });

  test("a cylinder rises from its bottom circle or hangs from its top one", () => {
    const fpc = 5;
    const bottom = resolveArea(tpl({ shape: "cylinder", size: 10, height: 20, origin: { x: 5, y: 5, z: 10 } }), ctx());
    const top = resolveArea(tpl({ shape: "cylinder", size: 10, height: 20, anchor: "top", origin: { x: 5, y: 5, z: 10 } }), ctx());
    assert.ok(bottom && top);
    assert.ok(bottom.shape.inside(5, 5, 25 / fpc) && !bottom.shape.inside(5, 5, 5 / fpc));
    assert.ok(top.shape.inside(5, 5, -5 / fpc) && !top.shape.inside(5, 5, 15 / fpc));
  });

  test("coverage is clipped to the scene", () => {
    const res = computeCoverage(tpl({ origin: { x: 0, y: 0, z: 0 } }), ctx());
    assert.equal(res.cells.length, 13);
    assert.ok(res.cells.every((c) => c.x >= 0 && c.y >= 0));
  });
});

describe("the shortcut agrees with full sampling", () => {
  const shapes: AreaShape[] = ["sphere", "cylinder", "cone", "cube", "line", "emanation"];

  function randomTemplate(rand: () => number, scene: number, tokens: Record<string, AreaToken>): AreaTemplateInput {
    const shape = shapes[Math.floor(rand() * shapes.length)]!;
    const sizes = [5, 10, 15, 20, 30, 40];
    const size = rand() < 0.8 ? sizes[Math.floor(rand() * sizes.length)]! : 5 + rand() * 50;
    const place = rand();
    const cx = Math.floor(scene / 4 + rand() * (scene / 2));
    const cy = Math.floor(scene / 4 + rand() * (scene / 2));
    const origin = {
      x: place < 0.5 ? cx : place < 0.75 ? cx + 0.5 : cx + rand(),
      y: place < 0.5 ? cy : place < 0.75 ? cy : cy + rand(),
      z: [0, 5, -5, 7.5][Math.floor(rand() * 4)]!,
    };
    const yaw = [0, 90, 45, 180, rand() * 360][Math.floor(rand() * 5)]!;
    const attach = shape === "emanation" || rand() < 0.2;
    const id = `k${Object.keys(tokens).length}`;
    if (attach) {
      tokens[id] = tok(id, {
        size: (["tiny", "medium", "large", "huge"] as const)[Math.floor(rand() * 4)]!,
        x: cx + rand(),
        y: cy + rand(),
        elevation: Math.floor(rand() * 4) * 5,
      });
    }
    return tpl({
      shape,
      size,
      origin,
      yaw,
      width: rand() < 0.5 ? 5 : 10,
      height: 10 + Math.floor(rand() * 4) * 10,
      anchor: rand() < 0.5 ? "bottom" : "top",
      faceOffset: { u: rand() - 0.5, v: rand() - 0.5 },
      attachedTo: attach ? id : undefined,
      includeOrigin: rand() < 0.5,
    });
  }

  function randomWalls(rand: () => number, scene: number): WallSet {
    const cells: string[] = [];
    for (let r = 0; r < 4; r++) {
      const w = 3 + Math.floor(rand() * 8);
      const h = 3 + Math.floor(rand() * 8);
      cells.push(...rect(Math.floor(rand() * (scene - w)), Math.floor(rand() * (scene - h)), w, h));
    }
    const edges: Record<string, EdgeFeature> = {};
    for (let e = 0; e < 20; e++) {
      const key = `${Math.floor(rand() * scene)},${Math.floor(rand() * scene)},${rand() < 0.5 ? "n" : "w"}`;
      edges[key] = rand() < 0.5 ? { kind: "wall" } : { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false };
    }
    return deriveWalls(indexBuild([chunk(cells, edges)]), "v1");
  }

  test("random templates on an open scene", () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 60; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, 24, tokens);
      assertMatchesBruteForce(t, ctx({ bounds: { w: 24, h: 24 }, tokens }), `open #${i} ${t.shape}`);
    }
  });

  test("random templates on scenes with walls", () => {
    const rand = mulberry32(2);
    for (let i = 0; i < 60; i++) {
      const tokens: Record<string, AreaToken> = {};
      const walls = randomWalls(rand, 24);
      const t = randomTemplate(rand, 24, tokens);
      assertMatchesBruteForce(t, ctx({ bounds: { w: 24, h: 24 }, tokens, walls }), `walled #${i} ${t.shape}`);
    }
  });

  test("cones and lines aimed up or down", () => {
    const rand = mulberry32(5);
    const pitches = [-90, -60, -30, -10, 15, 45, 75, 90];
    for (let i = 0; i < 60; i++) {
      const tokens: Record<string, AreaToken> = {};
      const walls = i % 2 === 0 ? randomWalls(rand, 24) : null;
      const t = randomTemplate(rand, 24, tokens);
      const aimed = { ...t, shape: rand() < 0.5 ? ("cone" as const) : ("line" as const), pitch: rand() < 0.8 ? pitches[Math.floor(rand() * pitches.length)]! : rand() * 180 - 90 };
      assertMatchesBruteForce(aimed, ctx({ bounds: { w: 24, h: 24 }, tokens, walls }), `aimed #${i} ${aimed.shape} ${aimed.pitch}`);
    }
  });

  test("the 4x4 aiming preview uses the same rule at its own resolution", () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 20; i++) {
      const tokens: Record<string, AreaToken> = {};
      const walls = i % 2 ? randomWalls(rand, 24) : null;
      const t = randomTemplate(rand, 24, tokens);
      assertMatchesBruteForce(t, ctx({ bounds: { w: 24, h: 24 }, tokens, walls, samples: 4 }), `preview #${i} ${t.shape}`);
    }
  });

  test("the answer is the 16x16 result whatever the size", () => {
    // Large areas are sampled exactly like small ones: no coarser grid for big templates.
    for (const size of [5, 50, 300, 1000]) {
      for (const shape of ["sphere", "line", "cone"] as const) {
        const t = tpl({ shape, size, origin: { x: 31.3, y: 30, z: 0 }, yaw: 33 });
        assertMatchesBruteForce(t, ctx({ bounds: { w: 64, h: 64 } }), `${shape} ${size} ft`);
      }
    }
  });

  test("coverage depends on size in cells, not on feet per cell", () => {
    for (const shape of ["sphere", "cone", "cube", "line", "cylinder"] as const) {
      const a = computeCoverage(tpl({ shape, size: 20, width: 10, yaw: 30 }), ctx());
      const b = computeCoverage(tpl({ shape, size: 40, width: 20, height: 80, yaw: 30 }), {
        ...ctx(),
        settings: { feetPerCell: 10, aoeCoverage: "half", aoeInclusion: "anyCell" },
      });
      const c = computeCoverage(tpl({ shape, size: 20, width: 10, yaw: 30 }), ctx());
      assert.deepEqual(
        b.cells.map((x) => `${x.x},${x.y},${x.coverage}`),
        a.cells.map((x) => `${x.x},${x.y},${x.coverage}`),
        shape,
      );
      assert.deepEqual(c.cells, a.cells);
    }
  });
});

describe("walls clip areas", () => {
  // A 10x10 room at (5,5) with a wall across it at x = 10, open at the bottom row.
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 5; y < 14; y++) edges[`10,${y},w`] = { kind: "wall" };
  const walls = deriveWalls(indexBuild([chunk(rect(5, 5, 10, 10), edges)]), 1);

  test("a cell behind a wall inside a fireball is not covered", () => {
    const fireball = tpl({ origin: { x: 8, y: 8, z: 0 } });
    const open = covered(fireball, ctx());
    const clipped = covered(fireball, ctx({ walls }));
    assert.ok(open.has("10,8") && open.has("11,8"));
    assert.ok(clipped.has("9,8"));
    assert.ok(!clipped.has("10,8"));
    assert.ok(!clipped.has("11,8"));
    // Outside the room's own wall.
    assert.ok(open.has("4,8") && !clipped.has("4,8"));
  });

  test("open doors let an area through, closed doors do not", () => {
    const door = (state: "open" | "closed") =>
      deriveWalls(indexBuild([chunk(rect(5, 5, 10, 10), { ...edges, "10,8,w": { kind: "door", state, secret: false, discovered: false } })]), state);
    const fireball = tpl({ origin: { x: 8, y: 8.5, z: 0 } });
    assert.ok(covered(fireball, ctx({ walls: door("open") })).has("10,8"));
    assert.ok(!covered(fireball, ctx({ walls: door("closed") })).has("10,8"));
  });

  test("a cone from a caster whose corner is on a wall stays on the caster's side", () => {
    // The caster stands against the wall at x = 10, west of it, and casts north along it.
    const caster = tok("c", { x: 9, y: 9 });
    const cast = castFromToken(SQUARES, { shape: "cone", size: 15, yaw: 300 }, caster, 5);
    assert.deepEqual({ x: cast.origin.x, y: cast.origin.y }, { x: 10, y: 9 });
    const cone = tpl({ shape: "cone", size: 15, yaw: 270, ...cast, casterId: "c" });
    const cells = covered(cone, ctx({ walls, tokens: { c: caster }, coverage: "any" }));
    assert.ok(cells.size > 0);
    assert.ok([...cells].every((k) => Number(k.split(",")[0]) < 10));
  });

  test("an emanation sees around a corner from any corner of its creature", () => {
    const creature = tok("e", { x: 9, y: 9 });
    const aura = tpl({ shape: "emanation", size: 10, attachedTo: "e" });
    const cells = covered(aura, ctx({ walls, tokens: { e: creature } }));
    assert.ok(cells.has("8,9"));
    assert.ok(!cells.has("10,9"));
  });

  test("walls change the cache key", () => {
    const fireball = tpl();
    assert.notEqual(coverageCacheKey(fireball, ctx({ walls })), coverageCacheKey(fireball, ctx()));
  });
});

describe("an area's origin on a free wall", () => {
  function freeWalls(walls: readonly (readonly [number, number, number, number])[]): WallSet {
    const chunk: BuildChunk = {
      sceneId: "s",
      cx: 0,
      cy: 0,
      rev: 1,
      cells: {},
      edges: {},
      walls: walls.map(([ax, ay, bx, by], i) => ({ id: `wall${String(i).padStart(8, "0")}`, a: [ax, ay], b: [bx, by], f: { kind: "wall" } })),
    };
    return deriveWalls(indexBuild([chunk]), 1);
  }

  test("a sphere on a diagonal wall sees one side of it", () => {
    // The wall runs along (3, 4), the direction a fixed nudge of (0.6, 0.8) would slide along.
    const walls = freeWalls([[0, 1, 3, 5]]);
    const area = resolveArea(tpl({ origin: { x: 0.75, y: 2, z: 0 }, size: 10 }), ctx({ walls }));
    assert.ok(area && area.polygons.length === 1);
    const sides = [pointInPolygon(area.polygons[0]!, 1.15, 1.7), pointInPolygon(area.polygons[0]!, 0.35, 2.3)];
    assert.equal(sides.filter(Boolean).length, 1, `sees ${sides}`);
  });

  test("a cone cast at 45 degrees from a creature a wall runs through sees one side of it", () => {
    // The wall passes through the creature's center and the corner the cone starts from, so the creature's side cannot choose.
    const walls = freeWalls([[3, 3, 6, 6]]);
    const creature = tok("e", { x: 4, y: 4 });
    const cast = castFromToken(SQUARES, { shape: "cone", size: 15, yaw: 45 }, creature, 5);
    assert.deepEqual({ x: cast.origin.x, y: cast.origin.y }, { x: 5, y: 5 });
    const area = resolveArea(tpl({ shape: "cone", size: 15, yaw: 45, attachedTo: "e" }), ctx({ walls, tokens: { e: creature } }));
    assert.ok(area && area.polygons.length === 1);
    const sides = [pointInPolygon(area.polygons[0]!, 5.4, 5.1), pointInPolygon(area.polygons[0]!, 5.1, 5.4)];
    assert.equal(sides.filter(Boolean).length, 1, `sees ${sides}`);
  });

  test("a cone from a creature's corner where a wall ends steps into the creature, so it still reaches past the wall's end", () => {
    // A wall runs south from the Large creature's southwest corner, and the cone aims southwest past its end.
    const walls = freeWalls([[7, 13, 7, 15]]);
    const creature = tok("e", { size: "large", x: 7, y: 11 });
    const cast = castFromToken(SQUARES, { shape: "cone", size: 20, yaw: 135 }, creature, 5);
    assert.deepEqual({ x: cast.origin.x, y: cast.origin.y }, { x: 7, y: 13 });
    const area = resolveArea(tpl({ shape: "cone", size: 20, yaw: 135, attachedTo: "e" }), ctx({ walls, tokens: { e: creature } }));
    assert.ok(area && area.polygons.length === 1);
    assert.ok(pointInPolygon(area.polygons[0]!, 5, 13.5));
    assert.ok(!pointInPolygon(area.polygons[0]!, 6.5, 14.5));
  });

  test("an origin that cannot step off its walls covers nothing", () => {
    // Eight walls through one point, along every direction the step may take.
    const lines = [
      [1, 2],
      [0, 1],
      [-1, 2],
      [-1, 1],
      [-2, 1],
      [1, 0],
      [2, 1],
      [1, 1],
    ] as const;
    const walls = freeWalls(lines.map(([a, b]) => [10 - a, 10 - b, 10 + a, 10 + b] as const));
    const fireball = tpl({ origin: { x: 10, y: 10, z: 0 } });
    const area = resolveArea(fireball, ctx({ walls }));
    assert.deepEqual(area?.polygons.map((p) => p.length), [0]);
    assert.deepEqual(computeCoverage(fireball, ctx({ walls })).cells, []);
  });
});

describe("creaturesInArea", () => {
  const base = { x: 20, y: 20 };

  test("a flier above the sphere's reach is skipped, the ground below is shaded", () => {
    const fireball = tpl({ origin: { x: 20, y: 20, z: 0 } });
    const ground = tok("g", { x: 20, y: 20 });
    const low = tok("low", { x: 20, y: 20, elevation: 15 });
    const high = tok("high", { x: 20, y: 20, elevation: 30 });
    assert.deepEqual(creaturesInArea(fireball, [ground, low, high], ctx()), ["g", "low"]);
    assert.ok(covered(fireball, ctx()).has("20,20"));
  });

  test("the slice is the point of the creature nearest the origin height", () => {
    // A 20 ft sphere at 40 ft altitude catches a tall creature whose top is at 25 ft.
    const sphere = tpl({ origin: { x: 20, y: 20, z: 40 } });
    const giant = tok("giant", { x: 19, y: 19, size: "large", height: 25 });
    const human = tok("human", { x: 20, y: 20 });
    assert.deepEqual(creaturesInArea(sphere, [giant, human], ctx()), ["giant"]);
  });

  test("anyCell uses the room's coverage rule on each occupied cell", () => {
    const sphere = tpl({ size: 10, origin: { x: 20, y: 20, z: 0 } });
    // Cell (21,21) is the corner cell of a 10 ft sphere: under a third covered.
    const corner = tok("corner", { x: 21, y: 21 });
    assert.deepEqual(creaturesInArea(sphere, [corner], ctx({ coverage: "half" })), []);
    assert.deepEqual(creaturesInArea(sphere, [corner], ctx({ coverage: "any" })), ["corner"]);
    // A Large creature with one cell well inside is caught.
    const large = tok("large", { size: "large", x: 21, y: 21 });
    assert.deepEqual(creaturesInArea(sphere, [large], ctx({ coverage: "half" })), []);
    const large2 = tok("large2", { size: "large", x: 20, y: 20 });
    assert.deepEqual(creaturesInArea(sphere, [large2], ctx({ coverage: "half" })), ["large2"]);
  });

  test("center and majority inclusion", () => {
    const sphere = tpl({ size: 10, origin: { x: 20, y: 20, z: 0 } });
    // A Large creature at (21,20): its center (22,21) is outside, under half its footprint is inside.
    const large = tok("large", { size: "large", x: 21, y: 20 });
    // A Large creature at (19,19): centered on the origin, everything inside.
    const centered = tok("centered", { size: "large", x: 19, y: 19 });
    assert.deepEqual(creaturesInArea(sphere, [large, centered], ctx({ inclusion: "center" })), ["centered"]);
    assert.deepEqual(creaturesInArea(sphere, [large, centered], ctx({ inclusion: "majority" })), ["centered"]);
    assert.deepEqual(creaturesInArea(sphere, [large, centered], ctx({ inclusion: "anyCell" })), ["large", "centered"]);
    // A Tiny creature counts only the quarter cell it stands on.
    const tinyIn = tok("tinyIn", { size: "tiny", x: 21, y: 21 });
    const tinyOut = tok("tinyOut", { size: "tiny", x: 21.5, y: 21.5 });
    assert.deepEqual(creaturesInArea(sphere, [tinyIn, tinyOut], ctx({ inclusion: "majority" })), ["tinyIn"]);
  });

  test("the origin creature is left out unless the template includes its origin", () => {
    const caster = tok("caster", base);
    const other = tok("other", { x: 21, y: 20 });
    const tokens = { caster, other };
    const aura = tpl({ shape: "emanation", size: 10, attachedTo: "caster" });
    assert.deepEqual(creaturesInArea(aura, [caster, other], ctx({ tokens })), ["other"]);
    assert.deepEqual(creaturesInArea({ ...aura, includeOrigin: true }, [caster, other], ctx({ tokens })), ["caster", "other"]);
    assert.ok(!covered(aura, ctx({ tokens })).has("20,20"));
    assert.ok(covered({ ...aura, includeOrigin: true }, ctx({ tokens })).has("20,20"));
  });

  test("a cone cast back over its own caster still spares the caster", () => {
    const caster = tok("caster", base);
    const cone = tpl({ shape: "cone", size: 30, yaw: 180, origin: { x: 21, y: 20.5, z: 2.5 }, casterId: "caster" });
    // The cone's tip covers a quarter of the caster's cell, which counts under the any rule.
    const c = ctx({ tokens: { caster }, coverage: "any" });
    assert.deepEqual(creaturesInArea(cone, [caster], c), []);
    assert.deepEqual(creaturesInArea({ ...cone, includeOrigin: true }, [caster], c), ["caster"]);
  });

  test("an emanation moves with its token", () => {
    const tokens = { a: tok("a", { x: 5, y: 5 }) };
    const aura = tpl({ shape: "emanation", size: 5, attachedTo: "a", origin: { x: 30, y: 30, z: 0 } });
    const before = covered(aura, ctx({ tokens }));
    assert.ok(before.has("4,4") && !before.has("30,30"));
    const moved = { a: tok("a", { x: 10, y: 5, rev: 2 }) };
    assert.ok(covered(aura, ctx({ tokens: moved })).has("11,6"));
    assert.notEqual(coverageCacheKey(aura, ctx({ tokens })), coverageCacheKey(aura, ctx({ tokens: moved })));
  });

  test("an emanation that stays put keeps the footprint it was cast from", () => {
    // Tiny Hut: a 10 ft emanation cast by a Medium caster, left where it was cast.
    const caster = tok("c", { x: 10, y: 10 });
    const hut = tpl({
      shape: "emanation",
      size: 10,
      origin: castFromToken(SQUARES, { shape: "emanation", size: 10, yaw: 0 }, caster, 5).origin,
      footprint: emanationFootprint(SQUARES, caster, 5),
      casterId: "c",
    });
    assert.deepEqual(hut.footprint, { w: 1, h: 1, elevation: 0, height: 5 });
    // A 5 by 5 square less its corners, less the caster's own cell while it stands there.
    const around = covered(hut, ctx({ tokens: { c: caster } }));
    assert.equal(around.size, 20);
    assert.ok(!around.has("10,10"));
    // The caster walks away, or is hidden from this viewer: the hut keeps its shape, its middle cell now included.
    const walked = { c: tok("c", { x: 30, y: 30, rev: 2 }) };
    const left = covered(hut, ctx({ tokens: walked }));
    assert.deepEqual(left, new Set([...around, "10,10"]));
    assert.deepEqual(covered(hut, ctx({ tokens: {} })), left);
    assert.equal(resolveArea(hut, ctx({ tokens: {} }))?.box?.w, 1);
    // An older template without the footprint shrinks to a point once its caster leaves.
    const { footprint: _, ...older } = hut;
    assert.notDeepEqual(covered(older, ctx({ tokens: walked })), left);
    // Creatures inside are caught, and the caster only while it stands there and is not included.
    const inside = tok("g", { x: 11, y: 10 });
    assert.deepEqual(creaturesInArea(hut, [caster, inside], ctx({ tokens: { c: caster } })), ["g"]);
    assert.deepEqual(creaturesInArea(hut, [inside], ctx({ tokens: walked })), ["g"]);
    assert.notEqual(coverageCacheKey(hut, ctx()), coverageCacheKey(older, ctx()));
  });

  test("tokens on another scene are ignored", () => {
    const sphere = tpl({ sceneId: "s1" });
    const here = tok("here", { ...base, sceneId: "s1" });
    const there = tok("there", { ...base, sceneId: "s2" });
    assert.deepEqual(creaturesInArea(sphere, [here, there], ctx()), ["here"]);
  });
});

describe("cones and lines aimed up or down", () => {
  // A cone from a Medium caster's edge at its middle height, 2.5 ft up, aimed east.
  const cone = (pitch?: number) => tpl({ shape: "cone", size: 30, origin: { x: 20, y: 20.5, z: 2.5 }, yaw: 0, ...(pitch === undefined ? {} : { pitch }) });

  test("a cone aimed up catches a flier that a level cone misses", () => {
    const flier = tok("flier", { x: 23, y: 20, elevation: 20 });
    const ground = tok("ground", { x: 23, y: 20 });
    assert.deepEqual(creaturesInArea(cone(), [flier, ground], ctx()), ["ground"]);
    assert.deepEqual(creaturesInArea(cone(45), [flier, ground], ctx()), ["flier"]);
  });

  test("a cone aimed straight up catches a creature right above it, and nothing beside it on the ground", () => {
    const up = tpl({ shape: "cone", size: 30, origin: { x: 20, y: 20, z: 5 }, pitch: 90 });
    const above = tok("above", { x: 19, y: 19, elevation: 20 });
    const beside = tok("beside", { x: 22, y: 20 });
    assert.deepEqual(creaturesInArea(up, [above, beside], ctx()), ["above"]);
    assert.deepEqual(creaturesInArea({ ...up, pitch: 0 }, [above, beside], ctx()), ["beside"]);
  });

  test("a line aimed down from a flier hits the ground ahead of it", () => {
    const line = tpl({ shape: "line", size: 60, width: 5, origin: { x: 20, y: 20.5, z: 30 }, yaw: 0, pitch: -45 });
    const target = tok("target", { x: 25, y: 20 });
    const under = tok("under", { x: 20, y: 20 });
    assert.deepEqual(creaturesInArea(line, [target, under], ctx()), ["target"]);
    assert.deepEqual(creaturesInArea({ ...line, pitch: undefined }, [target, under], ctx()), []);
  });

  test("an aimed cone catches a creature it covers at any height of its body, not only at its axis's height", () => {
    // 45 degrees up, the cone's lower rim reaches past the axis's height over the cell, where the axis has already ended.
    const steep = tpl({ shape: "cone", size: 60, origin: { x: 10, y: 30, z: 0 }, yaw: 0, pitch: 45 });
    const high = tok("high", { x: 19, y: 25, elevation: 35 });
    for (const inclusion of ["anyCell", "majority", "center"] as const) {
      assert.deepEqual(creaturesInArea(steep, [high], ctx({ inclusion, bounds: { w: 60, h: 60 } })), ["high"], inclusion);
    }
    // 30 ft at 45 degrees: a creature 25 ft out from 15 to 20 ft up is in the cone at its feet, though not at its head.
    const short = tpl({ shape: "cone", size: 30, origin: { x: 20, y: 20.5, z: 0 }, yaw: 0, pitch: 45 });
    assert.deepEqual(creaturesInArea(short, [tok("flier", { x: 25, y: 20, elevation: 15 })], ctx()), ["flier"]);
  });

  test("an aimed cone catches exactly the creatures it half covers at their best height", () => {
    const c = ctx({ bounds: { w: 40, h: 40 } });
    for (const pitch of [45, 60, -45]) {
      const aimed = tpl({ shape: "cone", size: 60, origin: { x: 10, y: 30, z: pitch < 0 ? 60 : 0 }, yaw: 0, pitch });
      const area = resolveArea(aimed, c);
      assert.ok(area);
      for (let x = 14; x <= 22; x += 2) {
        for (let y = 22; y <= 30; y += 2) {
          for (let e = 15; e <= 50; e += 5) {
            // Every 0.05 ft through the creature's 5 ft, with the cells sampled as coverage samples them.
            let best = 0;
            for (let k = 0; k <= 100; k++) {
              const z = (e + 0.05 * k) / 5;
              let count = 0;
              for (let r = 0; r < 16; r++) for (let q = 0; q < 16; q++) if (area.shape.inside(sampleCoord(x, q, 16), sampleCoord(y, r, 16), z)) count++;
              best = Math.max(best, count);
            }
            const caught = creaturesInArea(aimed, [tok("t", { x, y, elevation: e })], c).length === 1;
            assert.equal(caught, 2 * best >= 256, `pitch ${pitch} at ${x},${y} ${e} ft`);
          }
        }
      }
    }
  });

  test("an aimed cone shades and outlines what it covers seen from above", () => {
    // Aimed 60 degrees up, its slice through the origin is only the origin itself.
    const steep = cone(60);
    const area = resolveArea(steep, ctx());
    assert.ok(area?.shade && area.outline);
    assert.ok(!area.shape.inside(22.5, 20.5, area.originZ));
    const cells = covered(steep, ctx());
    assert.ok(cells.has("23,20") && cells.has("22,19"), [...cells].join(" "));
    assert.ok(!cells.has("19,20"));
    // The outline starts at the origin and reaches past the slice a level cone would show.
    const xs = area.outline.filter((_, i) => i % 2 === 0);
    assert.ok(Math.min(...xs) >= 20 - 1e-9 && Math.max(...xs) > 25);
    assert.equal(resolveArea(cone(), ctx())?.shade, undefined);
  });

  test("level is the same as no pitch, and other shapes ignore it", () => {
    assert.deepEqual(computeCoverage(cone(0), ctx()).cells, computeCoverage(cone(), ctx()).cells);
    const sphere = tpl({ size: 15 });
    assert.deepEqual(computeCoverage({ ...sphere, pitch: 45 }, ctx()).cells, computeCoverage(sphere, ctx()).cells);
    assert.equal(coverageCacheKey({ ...sphere, pitch: 45 }, ctx()), coverageCacheKey(sphere, ctx()));
    assert.notEqual(coverageCacheKey(cone(30), ctx()), coverageCacheKey(cone(), ctx()));
  });
});

describe("cache", () => {
  test("the key covers the template, attached token, settings, walls and resolution", () => {
    const tokens = { a: tok("a") };
    const t = tpl({ attachedTo: "a" });
    const key = coverageCacheKey(t, ctx({ tokens }));
    const variants = [
      coverageCacheKey({ ...t, rev: 2 }, ctx({ tokens })),
      coverageCacheKey({ ...t, origin: { x: 1, y: 2, z: 3 } }, ctx({ tokens })),
      coverageCacheKey(t, ctx({ tokens: { a: tok("a", { rev: 2 }) } })),
      coverageCacheKey(t, ctx({ tokens, coverage: "any" })),
      coverageCacheKey(t, ctx({ tokens, inclusion: "center" })),
      coverageCacheKey(t, { ...ctx({ tokens }), settings: { feetPerCell: 10, aoeCoverage: "half", aoeInclusion: "anyCell" } }),
      coverageCacheKey(t, ctx({ tokens, walls: deriveWalls(indexBuild([]), 7) })),
      coverageCacheKey(t, ctx({ tokens, samples: 4 })),
      coverageCacheKey(t, ctx({ tokens, bounds: { w: 30, h: 40 } })),
    ];
    for (const v of variants) assert.notEqual(v, key);
    assert.equal(new Set(variants).size, variants.length);
    assert.equal(coverageCacheKey(t, ctx({ tokens })), key);
  });

  test("the cache returns the same result for the same key", () => {
    const cache = new CoverageCache(2);
    const a = cache.get(tpl(), ctx());
    assert.equal(cache.get(tpl(), ctx()), a);
    assert.notEqual(cache.get(tpl({ rev: 2 }), ctx()), a);
  });
});

describe("bounded work", () => {
  test("a 1,000 ft line at an angle across a 200x200 walled scene", () => {
    const cells: string[] = [];
    const edges: Record<string, EdgeFeature> = {};
    // A grid of 10x10 rooms joined by open doors, so the line crosses many walls.
    for (let ry = 0; ry < 20; ry++) {
      for (let rx = 0; rx < 20; rx++) {
        cells.push(...rect(rx * 10, ry * 10, 10, 10));
        if (rx > 0) for (let y = 0; y < 10; y++) edges[`${rx * 10},${ry * 10 + y},w`] = y === 5 ? { kind: "door", state: "open", secret: false, discovered: false } : { kind: "wall" };
        if (ry > 0) for (let x = 0; x < 10; x++) edges[`${rx * 10 + x},${ry * 10},n`] = x === 5 ? { kind: "door", state: "open", secret: false, discovered: false } : { kind: "wall" };
      }
    }
    const walls = deriveWalls(indexBuild([chunk(cells, edges)]), 1);
    const line = tpl({ shape: "line", size: 1000, yaw: 37, origin: { x: 5.5, y: 5.5, z: 0 } });
    const c = ctx({ bounds: { w: 200, h: 200 }, walls });
    const started = performance.now();
    const res = computeCoverage(line, c);
    const ms = performance.now() - started;
    assert.ok(res.cells.length > 0);
    // Generous, so a slow machine does not fail it. The real budget is 8 ms on a phone (design section 9.3).
    assert.ok(ms < 2000, `took ${ms} ms`);
    const open = computeCoverage(line, ctx({ bounds: { w: 200, h: 200 } }));
    assert.ok(open.cells.length > res.cells.length);
  });
});
