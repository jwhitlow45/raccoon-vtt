import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AreaShape } from "../model.ts";
import { defaultIncludeOrigin, hexStackPrisms, resolveArea, type AreaContext, type AreaSolid, type AreaTemplateInput, type AreaToken, type ResolvedArea } from "./aoe.ts";
import { axisSteps, hexSetSteps, legFeet } from "./distance.ts";
import { gridOfShape, SQUARES } from "./grid.ts";
import { hexInScene, sceneHexes, type HexGrid } from "./hex.ts";

/**
 * The solid an area catches with (docs/design-v1-iso-area-shapes.md 4.1):
 * every shape reports the heights over a map point that lie inside it,
 * one interval since every shape is convex, and names its parameters in
 * cells so the isometric drawing reads the rules' own numbers.
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tok(id: string, over: Partial<AreaToken> = {}): AreaToken {
  return { id, rev: 1, size: "medium", x: 10, y: 10, elevation: 0, ...over };
}

function ctx(tokens: Record<string, AreaToken> = {}): AreaContext {
  return { settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell" }, bounds: { w: 40, h: 40 }, grid: SQUARES, tokens };
}

const SHAPES: readonly AreaShape[] = ["sphere", "cylinder", "cone", "cube", "line", "emanation"];

/** A random template of every kind the case table names: both cylinder anchors, cones and lines level and aimed to ±90, cubes with face offsets, emanations attached, stationary and from a point. */
function randomTemplate(rand: () => number, tokens: Record<string, AreaToken>, i: number): AreaTemplateInput {
  const shape = SHAPES[i % SHAPES.length]!;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const size = rand() < 0.7 ? pick([5, 10, 15, 20, 30, 60]) : 5 + rand() * 80;
  const origin = { x: 10 + rand() * 20, y: 10 + rand() * 20, z: pick([0, 5, -10, 12.5, 40]) };
  const pitch = pick([0, 90, -90, 40, -40, rand() * 180 - 90, 63.43494882292201]);
  const base: AreaTemplateInput = {
    id: `t${i}`,
    rev: 1,
    shape,
    size,
    origin,
    yaw: pick([0, 90, 45, 180, 270, rand() * 360]),
    includeOrigin: defaultIncludeOrigin(shape),
    pitch,
    width: pick([5, 10, 15]),
    height: pick([10, 20, 40, 5 + rand() * 60]),
    anchor: pick(["bottom", "top"] as const),
    faceOffset: { u: rand() - 0.5, v: rand() - 0.5 },
  };
  if (shape !== "emanation") return base;
  const kind = pick(["attached", "stationary", "point"] as const);
  if (kind === "point") return base;
  const id = `k${i}`;
  tokens[id] = tok(id, { size: pick(["tiny", "medium", "large", "huge", "gargantuan"] as const), x: origin.x - 1, y: origin.y - 1, elevation: pick([0, 10, -5]) });
  if (kind === "attached") return { ...base, attachedTo: id };
  return { ...base, footprint: { w: 1 + Math.floor(rand() * 3), h: 1 + Math.floor(rand() * 3), elevation: pick([0, 15]), height: pick([0, 5, 10]) } };
}

/** Whether a point lies in the solid as its own parameters describe it, read without the shape's predicate. */
function inSolid(s: AreaSolid, x: number, y: number, z: number): boolean {
  switch (s.kind) {
    case "sphere":
      return Math.hypot(x - s.c.x, y - s.c.y, z - s.c.z) <= s.r + 1e-12;
    case "cylinder":
      return Math.hypot(x - s.c.x, y - s.c.y) <= s.r + 1e-12 && z >= s.z0 - 1e-12 && z <= s.z1 + 1e-12;
    case "cone": {
      const r = { x: x - s.apex.x, y: y - s.apex.y, z: z - s.apex.z };
      const u = r.x * s.a.x + r.y * s.a.y + r.z * s.a.z;
      const w = r.x * s.n.x + r.y * s.n.y + r.z * s.n.z;
      const h = r.x * s.m.x + r.y * s.m.y + r.z * s.m.z;
      return u >= -1e-12 && u <= s.L + 1e-12 && 2 * Math.hypot(w, h) <= u + 1e-12;
    }
    case "box":
      return localBox(s, x, y, z).every((v, k) => Math.abs(v) <= s.half[k]! + 1e-12);
    case "rounded": {
      const local = localBox(s.box, x, y, z);
      const out = local.map((v, k) => Math.max(0, Math.abs(v) - s.box.half[k]!));
      return Math.hypot(...out) <= s.D + 1e-12;
    }
    case "hexStack":
      throw new Error("a hex stack is read by its prisms");
  }
}

function localBox(b: { c: { x: number; y: number; z: number }; axes: readonly { x: number; y: number; z: number }[] }, x: number, y: number, z: number): number[] {
  const r = { x: x - b.c.x, y: y - b.c.y, z: z - b.c.z };
  return b.axes.map((e) => r.x * e.x + r.y * e.y + r.z * e.z);
}

/**
 * The map points and heights where a shape's span is most likely to go
 * wrong: its axis and apex columns, a sphere's poles, the columns of a
 * box's corners and edges, and the cell centers and corners lined up with
 * the origin, where grid-aligned casts are read.
 */
function singularPoints(s: AreaSolid, origin: { x: number; y: number }): { columns: [number, number][]; heights: number[] } {
  const columns: [number, number][] = [];
  const heights: number[] = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) columns.push([origin.x + i / 2, origin.y + j / 2]);
  const boxPoints = (b: { c: { x: number; y: number; z: number }; axes: readonly { x: number; y: number; z: number }[]; half: readonly number[] }) => {
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        for (const k of [-1, 0, 1]) {
          const w = [i, j, k].map((v, n) => v * b.half[n]!);
          const p = b.axes.reduce((q, e, n) => ({ x: q.x + w[n]! * e.x, y: q.y + w[n]! * e.y, z: q.z + w[n]! * e.z }), b.c);
          columns.push([p.x, p.y]);
          heights.push(p.z);
        }
      }
    }
  };
  switch (s.kind) {
    case "sphere":
      columns.push([s.c.x, s.c.y], [s.c.x + s.r, s.c.y], [s.c.x, s.c.y - s.r]);
      heights.push(s.c.z - s.r, s.c.z, s.c.z + s.r);
      break;
    case "cylinder":
      columns.push([s.c.x, s.c.y], [s.c.x + s.r, s.c.y], [s.c.x, s.c.y + s.r], [s.c.x - s.r, s.c.y]);
      heights.push(s.z0, s.z1);
      break;
    case "cone": {
      const base = { x: s.apex.x + s.a.x * s.L, y: s.apex.y + s.a.y * s.L, z: s.apex.z + s.a.z * s.L };
      columns.push([s.apex.x, s.apex.y], [base.x, base.y]);
      heights.push(s.apex.z, base.z);
      for (const [p, q] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ] as const) {
        const r = { x: base.x + (s.L / 2) * (p * s.n.x + q * s.m.x), y: base.y + (s.L / 2) * (p * s.n.y + q * s.m.y), z: base.z + (s.L / 2) * (p * s.n.z + q * s.m.z) };
        columns.push([r.x, r.y]);
        heights.push(r.z);
      }
      break;
    }
    case "box":
      boxPoints(s);
      break;
    case "rounded":
      boxPoints(s.box);
      boxPoints({ ...s.box, half: s.box.half.map((h) => h + s.D) });
      break;
    case "hexStack":
      break;
  }
  return { columns, heights };
}

/** Within a hair of the surface, where rounding may fall either way. */
function nearSurface(area: ResolvedArea, x: number, y: number, z: number): boolean {
  return Math.abs(area.shape.sd(x, y, z)) < 1e-9;
}

describe("every shape's span holds exactly the heights inside it", () => {
  test("random templates and random points: inside exactly when the span holds the height", () => {
    const rand = mulberry32(7);
    let inside = 0;
    let spans = 0;
    for (let i = 0; i < 600; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, tokens, i);
      const area = resolveArea(t, ctx(tokens));
      assert.ok(area, `template ${i}`);
      const b = area.shape.bounds;
      for (let k = 0; k < 60; k++) {
        const x = b.x0 - 1 + rand() * (b.x1 - b.x0 + 2);
        const y = b.y0 - 1 + rand() * (b.y1 - b.y0 + 2);
        const span = area.shape.span(x, y);
        if (span) {
          spans++;
          assert.ok(span[0] <= span[1], `${t.shape} #${i}: span ${span}`);
          // Both ends lie on the surface, and the middle inside.
          assert.ok(area.shape.inside(x, y, (span[0] + span[1]) / 2), `${t.shape} #${i}: middle of the span`);
          assert.ok(Math.abs(area.shape.sd(x, y, span[0])) < 1e-7 && Math.abs(area.shape.sd(x, y, span[1])) < 1e-7, `${t.shape} #${i}: ends on the surface`);
        }
        for (let q = 0; q < 8; q++) {
          const z: number = (span ? (span[0] + span[1]) / 2 : area.originZ) + (rand() - 0.5) * 2.5 * (b.x1 - b.x0 + 2);
          if (nearSurface(area, x, y, z)) continue;
          const want = area.shape.inside(x, y, z);
          if (want) inside++;
          assert.equal(span !== null && z >= span[0] && z <= span[1], want, `${t.shape} #${i} at ${x}, ${y}, ${z}: span ${span}`);
        }
      }
    }
    // Enough of both answers that the property says something.
    assert.ok(inside > 5000 && spans > 10000, `${inside} inside, ${spans} spans`);
  });

  test("random templates at their singular points: apexes, axis columns, poles, box edges and corners, and the cells lined up with the origin", () => {
    const rand = mulberry32(11);
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, tokens, i);
      const area = resolveArea(t, ctx(tokens));
      assert.ok(area, `template ${i}`);
      const { columns, heights } = singularPoints(area.solid, t.origin);
      for (const [x, y] of columns) {
        const span = area.shape.span(x, y);
        const zs: number[] = [...heights, ...(span ?? [])];
        for (let k = -40; k <= 40; k++) zs.push(area.originZ + k / 2);
        for (const z0 of zs) {
          for (const z of [z0 - 0.01, z0, z0 + 0.01]) {
            if (nearSurface(area, x, y, z)) continue;
            checked++;
            assert.equal(span !== null && z >= span[0] && z <= span[1], area.shape.inside(x, y, z), `${t.shape} #${i} pitch ${t.pitch} at ${x}, ${y}, ${z}: span ${span}`);
          }
        }
      }
    }
    assert.ok(checked > 1000000, `${checked} points`);
  });

  test("a cone's apex column: up, down and steeper than its slant", () => {
    const L = 6;
    for (const [pitch, from, to] of [
      [90, 0, L],
      [-90, -L, 0],
      [70, 0, L / Math.sin((70 * Math.PI) / 180)],
      [-70, -L / Math.sin((70 * Math.PI) / 180), 0],
      [64, 0, L / Math.sin((64 * Math.PI) / 180)],
    ] as const) {
      const area = resolveArea({ id: "c", rev: 1, shape: "cone", size: 30, origin: { x: 10, y: 10, z: 0 }, yaw: 30, pitch, includeOrigin: false }, ctx());
      assert.ok(area?.solid.kind === "cone");
      const { apex } = area.solid;
      const span = area.shape.span(apex.x, apex.y);
      assert.ok(span, `pitch ${pitch}`);
      assert.ok(Math.abs(span[0] - (apex.z + from)) < 1e-9 && Math.abs(span[1] - (apex.z + to)) < 1e-9, `pitch ${pitch}: ${span}`);
      assert.ok(area.shape.inside(apex.x, apex.y, apex.z + (from + to) / 2));
    }
  });

  test("a sphere's span is its center height plus and minus the half chord", () => {
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x: 10, y: 10, z: 10 }, yaw: 0, includeOrigin: true }, ctx());
    assert.ok(area);
    // 4 cells across, 2 cells up from the ground: 3 cells off the middle leaves a half chord of √7.
    const span = area.shape.span(13, 10);
    assert.ok(span);
    assert.ok(Math.abs(span[0] - (2 - Math.sqrt(7))) < 1e-12 && Math.abs(span[1] - (2 + Math.sqrt(7))) < 1e-12, `${span}`);
    assert.equal(area.shape.span(14.01, 10), null);
  });

  test("a cone aimed straight up starts at twice the distance off its axis", () => {
    const area = resolveArea({ id: "c", rev: 1, shape: "cone", size: 30, origin: { x: 10, y: 10, z: 0 }, yaw: 0, pitch: 90, includeOrigin: false }, ctx());
    assert.ok(area);
    const span = area.shape.span(11, 10);
    assert.ok(span);
    assert.ok(Math.abs(span[0] - 2) < 1e-12 && Math.abs(span[1] - 6) < 1e-12, `${span}`);
    assert.equal(area.shape.span(13.01, 10), null);
  });

  test("the top view of an aimed cone stays a shape with no span", () => {
    const area = resolveArea({ id: "c", rev: 1, shape: "cone", size: 30, origin: { x: 10, y: 10, z: 0 }, yaw: 0, pitch: 40, includeOrigin: false }, ctx());
    assert.ok(area?.shade);
    assert.equal("span" in area.shade, false);
  });
});

describe("the solid names the rules' own parameters", () => {
  test("random templates: a point is in the named solid exactly when the shape holds it", () => {
    const rand = mulberry32(11);
    const kinds = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, tokens, i);
      const area = resolveArea(t, ctx(tokens));
      assert.ok(area);
      kinds.add(area.solid.kind);
      const b = area.shape.bounds;
      for (let k = 0; k < 200; k++) {
        const x = b.x0 - 1 + rand() * (b.x1 - b.x0 + 2);
        const y = b.y0 - 1 + rand() * (b.y1 - b.y0 + 2);
        const z: number = area.originZ + (rand() - 0.5) * 2 * (b.x1 - b.x0 + 2);
        if (Math.abs(area.shape.sd(x, y, z)) < 1e-7) continue;
        assert.equal(inSolid(area.solid, x, y, z), area.shape.inside(x, y, z), `${t.shape} #${i} ${area.solid.kind} at ${x}, ${y}, ${z}`);
      }
    }
    assert.deepEqual([...kinds].sort(), ["box", "cone", "cylinder", "rounded", "sphere"]);
  });

  test("cubes and lines are boxes, an emanation its creature's box grown by its distance, a point emanation a box of no size", () => {
    const c = tok("c", { size: "large", x: 10, y: 10, elevation: 5 });
    const em = resolveArea({ id: "e", rev: 1, shape: "emanation", size: 15, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: false, attachedTo: "c" }, ctx({ c }));
    assert.equal(em?.solid.kind, "rounded");
    if (em?.solid.kind === "rounded") {
      assert.deepEqual(em.solid.box.c, { x: 11, y: 11, z: 2 });
      assert.deepEqual(em.solid.box.half, [1, 1, 1]);
      assert.equal(em.solid.D, 3);
    }
    const point = resolveArea({ id: "p", rev: 1, shape: "emanation", size: 10, origin: { x: 4, y: 5, z: 5 }, yaw: 0, includeOrigin: false }, ctx());
    assert.ok(point?.solid.kind === "rounded" && point.solid.box.half.every((h) => h === 0) && point.solid.D === 2);
    const line = resolveArea({ id: "l", rev: 1, shape: "line", size: 30, origin: { x: 4, y: 5, z: 0 }, yaw: 0, pitch: 30, includeOrigin: false }, ctx());
    assert.ok(line?.solid.kind === "box" && line.solid.half[0] === 3);
    const cube = resolveArea({ id: "b", rev: 1, shape: "cube", size: 10, origin: { x: 4, y: 5, z: 0 }, yaw: 0, includeOrigin: false }, ctx());
    assert.ok(cube?.solid.kind === "box" && cube.solid.half.every((h) => h === 1));
  });
});

const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;

describe("a hex emanation's solid is its stack of prisms (design 4.6)", () => {
  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    for (const diagonal of ["five", "euclid", "fiveTen"] as const) {
      test(`${name}, ${diagonal}: each hex its reach covers, from the lowest to the highest layer within reach`, () => {
        // In the open, a Large creature in the scene's corner, and a Huge one at its far edge, partly off it.
        for (const c of [tok("c", { size: "medium", x: 15, y: 15, elevation: 10 }), tok("c", { size: "large", x: 0.5, y: 0.5 }), tok("c", { size: "huge", x: 38.5, y: 20, elevation: 5 })]) {
          const context: AreaContext = { ...ctx({ c }), grid: g, settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell", diagonal } };
          const area = resolveArea({ id: "e", rev: 1, shape: "emanation", size: 15, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c" }, context);
          assert.ok(area?.reach && area.solid.kind === "hexStack");
          const prisms = hexStackPrisms(area.solid);
          const byKey = new Map(prisms.map((p) => [`${p.hex.col},${p.hex.row}`, p]));
          assert.equal(byKey.size, prisms.length, "each hex once");
          const reach = area.reach;
          let reached = 0;
          for (const hex of sceneHexes(g, context.bounds)) {
            const d = hexSetSteps(g, reach.from, [hex]);
            const p = byKey.get(`${hex.col},${hex.row}`);
            if (d > reach.steps) {
              assert.equal(p, undefined);
              continue;
            }
            reached++;
            assert.ok(p, `${hex.col},${hex.row} at ${d} steps`);
            // Every layer of the prism is within reach, and the layers just past it are not, as the ruler counts them.
            const within = (layer: number) => {
              const ft = legFeet(d, 0, axisSteps(reach.z0, reach.z1, layer, layer + 1), diagonal, 5);
              return (diagonal === "euclid" ? Math.round(ft) : ft) <= 15;
            };
            for (let layer = p.lo; layer < p.hi; layer++) assert.ok(within(layer), `${hex.col},${hex.row} layer ${layer}`);
            assert.ok(!within(p.lo - 1) && !within(p.hi), `${hex.col},${hex.row} past ${p.lo}..${p.hi}`);
            assert.ok(hexInScene(g, context.bounds, hex));
          }
          assert.equal(prisms.length, reached, "no prism off the scene or out of reach");
          if (c.size !== "medium") continue;
          // The source's own hex holds its layers and three past them each way under five.
          const own = byKey.get(`${reach.from[0]!.col},${reach.from[0]!.row}`);
          assert.ok(own && own.lo === reach.z0 - 3 && own.hi === reach.z1 + 3);
        }
      });
    }
  }
});
