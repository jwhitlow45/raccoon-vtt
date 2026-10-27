import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type AoeCoverage, type AoeInclusion, type BuildChunk, type EdgeFeature, type FogTile, type FreeWall } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { computeCoverage, creaturesInArea, hexStackPrisms, resolveArea, type AreaContext, type AreaTemplateInput, type AreaToken, type ResolvedArea } from "#shared/rules/aoe.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { occupiedHexes, occupiedRange, verticalExtentFt } from "#shared/rules/footprint.ts";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { HEX_R, hexCenter, hexKey, hexInScene, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild, pointInPolygon, type Polygon, type WallSet } from "#shared/rules/walls.ts";
import { drawnHeights } from "../../lib/view.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { standingStretches } from "../../canvas/relief/runs.ts";
import { buildVolume, everySubcell, type Volume } from "./volume.ts";
import { chordTolerance, ctxOf, faceIndex, flatGround, inClip, meshIntervals, mulberry32, randomGround, randomTemplate, randomWalls, rect, tok, type Ground } from "./volumeTesting.ts";

/**
 * What the solid promises (docs/design-v1-iso-area-shapes.md 4.1, 4.4 and
 * the case table): a creature the area may catch whose cells lie inside
 * the DM's solid through its height is caught under every coverage and
 * inclusion rule, and one whose cells miss it is caught under none, for
 * bodies above the drawn ground under their cells, a pit's floor
 * included. And for a player, a standing volume is cut only where walls
 * stand on that player's screen, and nothing under the fog changes it.
 */

const COVERAGE: readonly AoeCoverage[] = ["half", "any", "center"];
const INCLUSION: readonly AoeInclusion[] = ["anyCell", "center", "majority"];
const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;
const FUZZ = Math.max(1, Number(process.env.VOLUME_FUZZ ?? 1));
const SEED = Number(process.env.VOLUME_SEED ?? 0);

type P = { x: number; y: number };

/** Whether segments ab and cd meet, ends and touching included, so a near miss never counts as clear. */
function meet(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: P, q: P, r: P) => Math.abs(o(p, q, r)) < 1e-12 && Math.min(p.x, q.x) - 1e-12 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-12 && Math.min(p.y, q.y) - 1e-12 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-12;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

function polyPoints(poly: Polygon): P[] {
  const out: P[] = [];
  for (let i = 0; i < poly.length; i += 2) out.push({ x: poly[i]!, y: poly[i + 1]! });
  return out;
}

function inConvex(ring: readonly P[], p: P): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-12) return true;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/** No edge of the polygon meets the ring and no corner of it lies in the ring: the ring lies wholly inside or wholly outside. */
function apart(ring: readonly P[], poly: readonly P[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (inConvex(ring, a)) return false;
    for (let k = 0; k < ring.length; k++) if (meet(a, b, ring[k]!, ring[(k + 1) % ring.length]!)) return false;
  }
  return true;
}

/** Whether a convex ring lies wholly in the area's clip, wholly out of it, or neither for sure. */
function ringInClip(area: ResolvedArea, bounds: { w: number; h: number }, ring: readonly P[]): "in" | "out" | null {
  const inScene = ring.every((p) => p.x > 0 && p.y > 0 && p.x < bounds.w && p.y < bounds.h);
  const outScene = ring.every((p) => p.x < 0) || ring.every((p) => p.y < 0) || ring.every((p) => p.x > bounds.w) || ring.every((p) => p.y > bounds.h);
  if (outScene) return "out";
  if (!inScene) return null;
  if (area.polygons.length === 0) return "in";
  const polys = area.polygons.map(polyPoints);
  if (polys.some((poly, i) => apart(ring, poly) && ring.every((p) => pointInPolygon(area.polygons[i]!, p.x, p.y)))) return "in";
  if (polys.every((poly, i) => apart(ring, poly) && ring.every((p) => !pointInPolygon(area.polygons[i]!, p.x, p.y)))) return "out";
  return null;
}

/** Whether a prism, a convex ring from lo to hi, lies inside the convex shape with a margin, misses it, or neither for sure. */
function prismInShape(area: ResolvedArea, ring: readonly P[], lo: number, hi: number, margin: number): "in" | "out" | null {
  // The shape is convex, so a prism whose corners lie inside lies inside, and its signed distance is convex too.
  if (ring.every((p) => area.shape.sd(p.x, p.y, lo) < -margin && area.shape.sd(p.x, p.y, hi) < -margin)) return "in";
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const n = 6;
  const dx = (x1 - x0) / n;
  const dy = (y1 - y0) / n;
  const dz = (hi - lo) / n;
  // Points a grid step apart: nothing lies nearer the shape than the nearest one less half the step's diagonal.
  const reach = Math.hypot(dx, dy, dz) / 2;
  let near = Infinity;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) near = Math.min(near, area.shape.sd(x0 + i * dx, y0 + j * dy, lo + k * dz));
  return near > reach + 1e-9 ? "out" : null;
}

/** A hex's exact outline, its points on the hex's own lattice before rounding. */
function hexRing(g: HexGrid, h: Hex, shrink = 1e-6): P[] {
  const c = hexCenter(g, h);
  const r = HEX_R - shrink;
  const out: P[] = [];
  for (let k = 0; k < 6; k++) {
    const t = (Math.PI / 3) * k + Math.PI / 2;
    const p = { x: r * Math.cos(t), y: r * Math.sin(t) };
    out.push(g.orient === "rows" ? { x: c.x + p.x, y: c.y + p.y } : { x: c.x + p.y, y: c.y + p.x });
  }
  return out;
}

function randomCreature(rand: () => number, id: string, near: { x: number; y: number }, spread: number): AreaToken {
  const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;
  const size = sizes[Math.floor(rand() * sizes.length)]!;
  const custom = size === "custom" ? [[1.5, 1.5], [6, 6], [2, 3], [0.5, 1]][Math.floor(rand() * 4)]! : null;
  return tok(id, {
    size,
    ...(custom ? { w: custom[0], h: custom[1] } : {}),
    x: near.x + (rand() - 0.5) * spread,
    y: near.y + (rand() - 0.5) * spread,
    elevation: -30 + Math.floor(rand() * 19) * 5,
    ...(rand() < 0.3 ? { height: [0, 2.5, 10, 30][Math.floor(rand() * 4)]! } : {}),
  });
}

/** Raised onto the drawn ground under its cells when it was below it: the promise is for bodies above the ground. */
function aboveGround(t: AreaToken, ground: Ground, fpc: number): AreaToken {
  const r = occupiedRange(SQUARES, t);
  let top = -Infinity;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) top = Math.max(top, ground.at(x, y) * fpc);
  return t.elevation < top ? { ...t, elevation: Math.ceil(top) } : t;
}

function caughtUnder(t: AreaTemplateInput, c: AreaToken, base: AreaContext, coverage: AoeCoverage, inclusion: AoeInclusion): boolean {
  const ctx: AreaContext = { ...base, settings: { ...base.settings, aoeCoverage: coverage, aoeInclusion: inclusion }, tokens: { ...base.tokens, [c.id]: c } };
  return creaturesInArea(t, [c], ctx).includes(c.id);
}

/** Whether the mesh holds the whole column from lo to hi over a point. */
function meshHolds(vol: Volume, at: (x: number, y: number) => number[], p: P, lo: number, hi: number, ground: number): boolean {
  return meshIntervals(vol, at(p.x, p.y), p.x, p.y, ground, "promise").some(([a, b]) => a <= lo + 1e-7 && b >= hi - 1e-7);
}

function meshMeets(vol: Volume, at: (x: number, y: number) => number[], p: P, lo: number, hi: number, ground: number): boolean {
  return meshIntervals(vol, at(p.x, p.y), p.x, p.y, ground, "promise").some(([a, b]) => a < hi - 1e-7 && b > lo + 1e-7);
}

describe("the owner's case: caught exactly when its cells lie inside the drawn solid (design 4.1)", () => {
  test("squares: every shape, walls, platforms and pits, every coverage and inclusion rule", () => {
    const rand = mulberry32(31 + SEED);
    let inside = 0;
    let missed = 0;
    let origins = 0;
    for (let i = 0; i < 150 * FUZZ; i++) {
      const w = 24 + Math.floor(rand() * 16);
      const h = 24 + Math.floor(rand() * 16);
      const bounds = { w, h };
      const walls = rand() < 0.7 ? randomWalls(rand, w, h) : null;
      const ground = rand() < 0.7 ? randomGround(rand, w, h) : flatGround(w, h);
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, w, h, tokens, i);
      const base = ctxOf(bounds, walls, tokens);
      const area = resolveArea(t, base);
      assert.ok(area);
      const vol = buildVolume({ area, bounds, ground: ground.at, px: 40 });
      vol.ensureAll();
      const at = faceIndex(vol);
      const tol = chordTolerance(vol);
      const b = area.shape.bounds;
      const middle = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      // Half of them near the middle, where they can lie wholly inside.
      const creatures = Array.from({ length: 32 }, (_, k) => aboveGround(randomCreature(rand, `c${k}`, middle, k % 2 ? (b.x1 - b.x0) / 2 : b.x1 - b.x0 + 6), ground, 5));
      // The origin creature, inside its own area, is left out where the area leaves it out.
      if (area.originTokenId) creatures.push(tokens[area.originTokenId]!);
      for (const c of creatures) {
        const r = occupiedRange(SQUARES, c);
        const ring = [
          { x: r.x0 + 1e-6, y: r.y0 + 1e-6 },
          { x: r.x1 - 1e-6, y: r.y0 + 1e-6 },
          { x: r.x1 - 1e-6, y: r.y1 - 1e-6 },
          { x: r.x0 + 1e-6, y: r.y1 - 1e-6 },
        ];
        const ext = verticalExtentFt(c, 5);
        const lo = ext.lo / 5;
        const hi = ext.hi / 5;
        let gTop = -Infinity;
        for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) gTop = Math.max(gTop, ground.at(x, y));
        if (lo < gTop - 1e-9) continue;
        // Tokens stand on the scene: off it, "center" reads a point no clip holds (aoe.ts pointInside), which the board never asks.
        if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) continue;
        const clip = ringInClip(area, bounds, ring);
        const shape = prismInShape(area, ring, lo, hi, tol + 1e-7);
        const isOrigin: boolean = c.id === area.originTokenId;
        const want: boolean | null = clip === "in" && shape === "in" ? !isOrigin || t.includeOrigin : clip === "out" || shape === "out" ? false : null;
        if (want === null) continue;
        if (clip === "in" && shape === "in") {
          if (isOrigin) origins++;
          else inside++;
          // The drawn solid stands round it, through its height.
          // Its middle a hair off, so the ray never runs down a vertex or an edge.
          const center = { x: (r.x0 + r.x1) / 2 + 0.0123, y: (r.y0 + r.y1) / 2 + 0.0071 };
          assert.ok(meshHolds(vol, at, center, lo, hi, ground.at(Math.floor(center.x), Math.floor(center.y))), `#${i} ${t.shape}: ${c.id} inside, the mesh does not hold it`);
        } else {
          missed++;
          const center = { x: (r.x0 + r.x1) / 2 + 0.0123, y: (r.y0 + r.y1) / 2 + 0.0071 };
          assert.ok(!meshMeets(vol, at, center, lo, hi, ground.at(Math.floor(center.x), Math.floor(center.y))), `#${i} ${t.shape}: ${c.id} misses, the mesh meets it`);
        }
        for (const coverage of COVERAGE) {
          for (const inclusion of INCLUSION) {
            assert.equal(caughtUnder(t, c, base, coverage, inclusion), want, `#${i} ${t.shape} ${JSON.stringify(t.origin)} size ${t.size}: ${c.id} (${c.size} at ${c.x}, ${c.y}, ${c.elevation} ft) under ${coverage}, ${inclusion}`);
          }
        }
      }
    }
    assert.ok(inside > 150 && missed > 1000 && origins > 3, `${inside} inside, ${missed} missed, ${origins} origins`);
  });

  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`${name}: true shapes by their hexes and emanations by their stacks, every rule`, () => {
      const rand = mulberry32(37 + SEED + (g === ROWS ? 0 : 1));
      let inside = 0;
      let missed = 0;
      for (let i = 0; i < 80 * FUZZ; i++) {
        const bounds = { w: 30, h: 30 };
        const walls = rand() < 0.6 ? randomWalls(rand, 30, 30) : null;
        const tokens: Record<string, AreaToken> = {};
        const t = randomTemplate(rand, 30, 30, tokens, i);
        const diagonal = (["five", "euclid", "fiveTen"] as const)[i % 3]!;
        const base: AreaContext = { ...ctxOf(bounds, walls, tokens, g), settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell", diagonal } };
        const area = resolveArea(t, base);
        assert.ok(area);
        // Hex scenes hold no heights yet (the hex design's H3), so the drawn ground is flat.
        const ground = flatGround(30, 30);
        const vol = buildVolume({ area, bounds, ground: ground.at, px: 40 });
        vol.ensureAll();
        const at = faceIndex(vol);
        const tol = chordTolerance(vol);
        const stack = area.solid.kind === "hexStack" ? new Map(hexStackPrisms(area.solid).map((p) => [hexKey(p.hex), p])) : null;
        const b = area.shape.bounds;
        const middle = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        // Hexes take sized creatures only, and half of them near the middle, where they can lie wholly inside.
        const creatures: AreaToken[] = Array.from({ length: 32 }, (_, k) => {
          const c = randomCreature(rand, `c${k}`, middle, k % 2 ? (b.x1 - b.x0) / 2 : Math.min(30, b.x1 - b.x0 + 4));
          return { ...c, size: c.size === "custom" ? "medium" : c.size, elevation: Math.max(0, c.elevation) };
        });
        if (area.originTokenId) creatures.push(tokens[area.originTokenId]!);
        for (const c of creatures) {
          const hexes: Hex[] = occupiedHexes(g, c);
          if (!hexes.every((h) => hexInScene(g, bounds, h))) continue;
          const ext = verticalExtentFt(c, 5);
          if (ext.lo < 0) continue;
          const lo = ext.lo / 5;
          const hi = ext.hi / 5;
          const rings: P[][] = hexes.map((h) => hexRing(g, h));
          const clips: ("in" | "out" | null)[] = rings.map((ring) => ringInClip(area, bounds, ring));
          let shape: "in" | "out" | null;
          if (stack) {
            const prisms = hexes.map((h) => stack.get(hexKey(h)));
            shape = prisms.every((p) => p && p.lo < lo - 1e-6 && p.hi > hi + 1e-6) ? "in" : prisms.every((p) => !p || p.hi < lo - 1e-6 || p.lo > hi + 1e-6) ? "out" : null;
          } else {
            const each: ("in" | "out" | null)[] = rings.map((ring) => prismInShape(area, ring, lo, hi, tol + 1e-7));
            shape = each.every((s) => s === "in") ? "in" : each.every((s) => s === "out") ? "out" : null;
          }
          const allIn: boolean = clips.every((x) => x === "in") && shape === "in";
          const allOut: boolean = shape === "out" || clips.every((x) => x === "out");
          const isOrigin: boolean = c.id === area.originTokenId;
          const want: boolean | null = allIn ? !isOrigin || t.includeOrigin : allOut ? false : null;
          if (want === null) continue;
          if (allIn && !isOrigin) {
            inside++;
            for (const h of hexes) assert.ok(meshHolds(vol, at, nudgedCenter(g, h), lo, hi, 0), `${name} #${i} ${t.shape}: ${c.id} inside, the mesh does not hold its hex`);
          }
          if (allOut) missed++;
          for (const coverage of COVERAGE) {
            for (const inclusion of INCLUSION) {
              assert.equal(caughtUnder(t, c, base, coverage, inclusion), want, `${name} #${i} ${t.shape} ${area.solid.kind}: ${c.id} (${c.size} at ${c.x}, ${c.y}, ${c.elevation} ft) under ${coverage}, ${inclusion}`);
            }
          }
        }
      }
      assert.ok(inside > 25 && missed > 300, `${inside} inside, ${missed} missed`);
    });
  }
});

/** A hex's middle a hair off, so the ray test there never runs down a vertex or an edge. */
function nudgedCenter(g: HexGrid, h: Hex): P {
  const c = hexCenter(g, h);
  return { x: c.x + 0.0123, y: c.y + 0.0071 };
}

describe("cases of the case table (design 8)", () => {
  test("a caster inside its own Spirit Guardians: the solid whole round it, and it is not caught", () => {
    const caster = tok("c", { size: "medium", x: 10, y: 10, elevation: 0 });
    const t: AreaTemplateInput = { id: "sg", rev: 1, shape: "emanation", size: 15, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: false, attachedTo: "c", casterId: "c" };
    const bounds = { w: 30, h: 30 };
    const ctx = ctxOf(bounds, null, { c: caster });
    const area = resolveArea(t, ctx);
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    vol.ensureAll();
    const at = faceIndex(vol);
    // Its body, from its feet to 5 ft, at its middle and its corners.
    for (const p of [
      { x: 10.5, y: 10.5 },
      { x: 10.01, y: 10.02 },
      { x: 10.99, y: 10.98 },
    ])
      assert.ok(meshHolds(vol, at, p, 0, 1, 0), `${p.x}, ${p.y}`);
    for (const coverage of COVERAGE) for (const inclusion of INCLUSION) assert.equal(caughtUnder(t, caster, ctx, coverage, inclusion), false);
    const goblin = tok("g", { x: 12, y: 10 });
    assert.ok(caughtUnder(t, goblin, ctx, "half", "anyCell"));
  });

  test("a 30 ft cone aimed 40 degrees up: a goblin under its far half is shaded flat, outside the drawn cone, and not caught", () => {
    const caster = tok("c", { size: "medium", x: 10, y: 10, elevation: 0 });
    const goblin = tok("g", { size: "small", x: 15, y: 10, elevation: 0 });
    const tokens = { c: caster, g: goblin };
    const bounds = { w: 30, h: 30 };
    const ctx = ctxOf(bounds, null, tokens);
    const t: AreaTemplateInput = { id: "cone", rev: 1, shape: "cone", size: 30, origin: { x: 11, y: 10.5, z: 2.5 }, yaw: 0, pitch: 40, includeOrigin: false, casterId: "c" };
    const cov = computeCoverage(t, ctx);
    assert.ok(cov.cells.some((cell) => cell.x === 15 && cell.y === 10), "the flat shading covers the goblin's square");
    for (const coverage of COVERAGE) for (const inclusion of INCLUSION) assert.equal(caughtUnder(t, goblin, ctx, coverage, inclusion), false);
    const area = resolveArea(t, ctx);
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    vol.ensureAll();
    const at = faceIndex(vol);
    assert.ok(!meshMeets(vol, at, { x: 15.51, y: 10.49 }, 0, 0.8, 0), "the drawn cone stays above the goblin");
    // Higher up over the same square the cone is there.
    assert.ok(meshMeets(vol, at, { x: 15.51, y: 10.49 }, 2, 4, 0));
  });

  test("a hex emanation stands as one prism per hex and layer it catches", () => {
    for (const g of [ROWS, COLUMNS]) {
      const c = tok("c", { size: "large", x: 12, y: 12, elevation: 10 });
      const ctx: AreaContext = { ...ctxOf({ w: 30, h: 30 }, null, { c }, g), settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell", diagonal: "euclid" } };
      const area = resolveArea({ id: "e", rev: 1, shape: "emanation", size: 10, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c" }, ctx);
      assert.ok(area?.solid.kind === "hexStack");
      const prisms = hexStackPrisms(area.solid);
      const vol = buildVolume({ area, bounds: { w: 30, h: 30 }, ground: () => 0, px: 40 });
      vol.ensureAll();
      const at = faceIndex(vol);
      for (const p of prisms) {
        const spans = meshIntervals(vol, at(nudgedCenter(g, p.hex).x, nudgedCenter(g, p.hex).y), nudgedCenter(g, p.hex).x, nudgedCenter(g, p.hex).y, 0, "hex");
        const lo = Math.max(0, p.lo);
        assert.equal(spans.length, 1, `${hexKey(p.hex)}`);
        assert.ok(Math.abs(spans[0]![0] - lo) < 1e-9 && Math.abs(spans[0]![1] - p.hi) < 1e-9, `${hexKey(p.hex)}: ${spans} against ${lo}..${p.hi}`);
      }
      // A hex beyond its reach has nothing over it.
      const far = { x: 25.3, y: 25.2 };
      assert.equal(meshIntervals(vol, at(far.x, far.y), far.x, far.y, 0, "far").length, 0);
    }
  });
});

// ---------------------------------------------------------------- security (design 9)

/** A player's fog over a scene up to 32 cells across: these cell rectangles [x0, y0, x1, y1) revealed. */
function fogOf(sceneId: string, bounds: { w: number; h: number }, rects: readonly (readonly [number, number, number, number])[]): { tiles: Record<string, FogTile>; view: FogView } {
  const tiles: Record<string, FogTile> = {};
  for (let ty = 0; ty * 16 < bounds.h; ty++) {
    for (let tx = 0; tx * 16 < bounds.w; tx++) {
      const bits = new Uint8Array(TILE_BYTES);
      for (const [x0, y0, x1, y1] of rects) {
        for (let sy = Math.max(y0 * FOG_SUBCELLS, ty * TILE_SUB); sy < Math.min(y1 * FOG_SUBCELLS, (ty + 1) * TILE_SUB); sy++) {
          for (let sx = Math.max(x0 * FOG_SUBCELLS, tx * TILE_SUB); sx < Math.min(x1 * FOG_SUBCELLS, (tx + 1) * TILE_SUB); sx++) {
            const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
            bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
          }
        }
      }
      tiles[tileKey(sceneId, tx, ty)] = { sceneId, tx, ty, rev: 1, bits: encodeTile(bits) };
    }
  }
  return { tiles, view: new FogView(tiles, sceneId, bounds) };
}

/** Rooms and walls and doors on grid lines only, so every piece of a wall lies on the free walls' lattice. */
function gridWalls(rand: () => number, w: number, h: number, extra: Record<string, EdgeFeature> = {}): { cells: string[]; edges: Record<string, EdgeFeature> } {
  const cells: string[] = [];
  for (let r = 0; r < 3; r++) {
    const rw = 5 + Math.floor(rand() * 9);
    const rh = 5 + Math.floor(rand() * 9);
    cells.push(...rect(Math.floor(rand() * (w - rw)), Math.floor(rand() * (h - rh)), rw, rh));
  }
  const edges: Record<string, EdgeFeature> = { ...extra };
  for (let e = 0; e < 14; e++) {
    const key = `${Math.floor(rand() * w)},${Math.floor(rand() * h)},${rand() < 0.5 ? "n" : "w"}`;
    edges[key] = rand() < 0.6 ? { kind: "wall" } : { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false };
  }
  return { cells, edges };
}

function chunksOf(cells: readonly string[], edges: Record<string, EdgeFeature>, walls: readonly FreeWall[] = [], w = 32, h = 32): BuildChunk[] {
  const out = new Map<string, BuildChunk>();
  const at = (x: number, y: number) => {
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const key = `${cx},${cy}`;
    let c = out.get(key);
    if (!c) out.set(key, (c = { sceneId: "s", cx, cy, rev: 1, cells: {}, edges: {} }));
    return c;
  };
  for (let cy = 0; cy * 16 < h; cy++) for (let cx = 0; cx * 16 < w; cx++) at(cx * 16, cy * 16);
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    at(x, y).cells[k] = "stone";
  }
  for (const [k, f] of Object.entries(edges)) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    at(x, y).edges[k] = f;
  }
  for (const wall of walls) {
    const c = at((wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2);
    (c.walls ??= []).push(wall);
  }
  return [...out.values()];
}

/** The walls that stand for this player, as free walls: each piece that stops areas, cut to its stretches that stand by the quarter-run rule (runs.ts). */
function standingWalls(walls: WallSet, fog: FogView, version: string): WallSet {
  const segs = walls.blockers;
  const free: FreeWall[] = [];
  for (let k = 0; k < segs.length; k += 4) {
    const a = { x: segs[k]!, y: segs[k + 1]! };
    const b = { x: segs[k + 2]!, y: segs[k + 3]! };
    for (const [t0, t1] of standingStretches(fog, a, b)) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) * (t1 - t0);
      const parts = Math.max(1, Math.ceil(len / 8));
      for (let p = 0; p < parts; p++) {
        const s0 = t0 + ((t1 - t0) * p) / parts;
        const s1 = t0 + ((t1 - t0) * (p + 1)) / parts;
        const q = (s: number): [number, number] => [Math.round((a.x + (b.x - a.x) * s) * 64) / 64, Math.round((a.y + (b.y - a.y) * s) * 64) / 64];
        free.push({ id: `s${String(free.length).padStart(11, "0")}`, a: q(s0), b: q(s1), f: { kind: "wall" } });
      }
    }
  }
  return deriveWalls(indexBuild(chunksOf([], {}, free)), version);
}

/** A point within a hair of a polygon edge, where the two clips may fall either way. */
function nearEdge(area: ResolvedArea, x: number, y: number): boolean {
  for (const p of area.polygons) {
    const k = p.length >> 1;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      const ax = p[2 * i]!;
      const ay = p[2 * i + 1]!;
      const bx = p[2 * j]!;
      const by = p[2 * j + 1]!;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      if (Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) < 1e-5) return true;
    }
  }
  return false;
}

function randomPlayerTemplate(rand: () => number, i: number): AreaTemplateInput {
  const shapes = ["sphere", "cylinder", "cone", "cube", "line"] as const;
  const shape = shapes[i % shapes.length]!;
  return {
    id: `p${i}`,
    rev: 1,
    shape,
    size: [5, 10, 15, 20, 30][Math.floor(rand() * 5)]!,
    origin: { x: 4 + Math.floor(rand() * 24) + 0.37, y: 4 + Math.floor(rand() * 24) + 0.61, z: [0, 5, 10][Math.floor(rand() * 3)]! },
    yaw: rand() * 360,
    pitch: [0, 30, -30][Math.floor(rand() * 3)]!,
    includeOrigin: true,
    width: 5,
    height: 20,
  };
}

function randomRevealed(rand: () => number): [number, number, number, number][] {
  return Array.from({ length: 2 + Math.floor(rand() * 3) }, () => {
    const x = Math.floor(rand() * 24);
    const y = Math.floor(rand() * 24);
    return [x, y, x + 6 + Math.floor(rand() * 14), y + 6 + Math.floor(rand() * 14)] as [number, number, number, number];
  });
}

describe("a player's volume (design 4.4 and 9)", () => {
  const bounds = { w: 32, h: 32 };

  test("random scenes, a standing player volume: the rules' polygons inside its plan cut it exactly as the walls standing for that player would", () => {
    const rand = mulberry32(41 + SEED);
    let stood = 0;
    let cut = 0;
    for (let i = 0; i < 200 * FUZZ; i++) {
      const { cells, edges } = gridWalls(rand, 32, 32);
      const walls = deriveWalls(indexBuild(chunksOf(cells, edges)), `w${i}`);
      const fog = fogOf("s", bounds, randomRevealed(rand)).view;
      const t = randomPlayerTemplate(rand, i);
      const area = resolveArea(t, ctxOf(bounds, walls));
      assert.ok(area);
      const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
      if (!everySubcell(vol.footprint, (sx, sy) => fog.revealed(sx, sy))) continue;
      stood++;
      const standing = resolveArea(t, ctxOf(bounds, standingWalls(walls, fog, `s${i}`)));
      assert.ok(standing);
      const b = area.shape.bounds;
      let outside = 0;
      for (let k = 0; k < 400; k++) {
        const x = b.x0 + rand() * (b.x1 - b.x0);
        const y = b.y0 + rand() * (b.y1 - b.y0);
        if (x <= 0 || y <= 0 || x >= 32 || y >= 32) continue;
        // Inside the shape's plan, at any height.
        if (!area.shape.span(x, y) && !area.shade?.inside(x, y, 0)) continue;
        if (nearEdge(area, x, y) || nearEdge(standing, x, y)) continue;
        const want = inClip(area, bounds, x, y);
        if (!want) outside++;
        assert.equal(inClip(standing, bounds, x, y), want, `#${i} ${t.shape} at ${x}, ${y}`);
      }
      if (outside > 0) cut++;
    }
    // Enough standing volumes that walls cut for the property to say something.
    assert.ok(stood > 30 && cut > 10, `${stood} stood, ${cut} cut by walls`);
  });

  test("two rooms differing only in walls wholly under a player's fog: the same stand decision and volume", () => {
    const rand = mulberry32(43 + SEED);
    let stood = 0;
    let flat = 0;
    for (let i = 0; i < 120 * FUZZ; i++) {
      const { cells, edges } = gridWalls(rand, 32, 32);
      // A fogged block, and walls well inside it, every sub-cell on both sides fogged.
      const bx = Math.floor(rand() * 20);
      const by = Math.floor(rand() * 20);
      const block: [number, number, number, number] = [bx, by, bx + 8, by + 8];
      const extra: Record<string, EdgeFeature> = {};
      for (let e = 0; e < 6; e++) extra[`${bx + 2 + Math.floor(rand() * 4)},${by + 2 + Math.floor(rand() * 4)},${rand() < 0.5 ? "n" : "w"}`] = { kind: "wall" };
      const revealed = randomRevealed(rand).flatMap((r) => cutOut(r, [block[0] - 1, block[1] - 1, block[2] + 1, block[3] + 1]));
      const fog = fogOf("s", bounds, revealed).view;
      const w0 = deriveWalls(indexBuild(chunksOf(cells, edges)), `a${i}`);
      const w1 = deriveWalls(indexBuild(chunksOf(cells, { ...edges, ...extra })), `b${i}`);
      const t = randomPlayerTemplate(rand, i);
      const a0 = resolveArea(t, ctxOf(bounds, w0));
      const a1 = resolveArea(t, ctxOf(bounds, w1));
      assert.ok(a0 && a1);
      const v0 = buildVolume({ area: a0, bounds, ground: () => 0, px: 40 });
      const v1 = buildVolume({ area: a1, bounds, ground: () => 0, px: 40 });
      const s0 = everySubcell(v0.footprint, (sx, sy) => fog.revealed(sx, sy));
      const s1 = everySubcell(v1.footprint, (sx, sy) => fog.revealed(sx, sy));
      assert.equal(s1, s0, `#${i} ${t.shape}: the stand decision`);
      if (!s0) {
        flat++;
        continue;
      }
      stood++;
      assert.deepEqual([...v1.footprint.runs], [...v0.footprint.runs], `#${i}: the footprint`);
      assertSameSolid(v0, v1, a0, rand, `#${i} ${t.shape}`);
    }
    assert.ok(stood > 10 && flat > 20, `${stood} stood, ${flat} flat`);
  });

  test("the same rooms differing only in heights on cells that player has not seen: the same stand decision and volume", () => {
    const rand = mulberry32(47 + SEED);
    for (let i = 0; i < 40 * FUZZ; i++) {
      const revealed = randomRevealed(rand);
      const { tiles, view: fog } = fogOf("s", bounds, revealed);
      const seenCell = (x: number, y: number) => fog.cellSeen(x, y);
      const feet = (hidden: number) => {
        const out = new Map<string, Int16Array>();
        for (let cy = 0; cy < 2; cy++) {
          for (let cx = 0; cx < 2; cx++) {
            const h = new Int16Array(256);
            for (let j = 0; j < 16; j++) {
              for (let k = 0; k < 16; k++) {
                const x = cx * 16 + k;
                const y = cy * 16 + j;
                // The same seen ground in both rooms, different ground wherever the player has seen nothing.
                h[j * 16 + k] = seenCell(x, y) ? ((x * 7 + y * 3) % 5) * 5 - 5 : hidden * (((x + y) % 3) - 1);
              }
            }
            out.set(`${cx},${cy}`, h);
          }
        }
        return out;
      };
      const chunks = (hidden: number) => {
        const out: Record<string, BuildChunk> = {};
        for (const [key, h] of feet(hidden)) {
          const [cx, cy] = key.split(",").map(Number) as [number, number];
          out[`s:${cx},${cy}`] = { sceneId: "s", cx, cy, rev: 1, cells: {}, edges: {}, heights: encodeHeights(h) };
        }
        return out;
      };
      const t = randomPlayerTemplate(rand, i);
      const area = resolveArea(t, ctxOf(bounds, null));
      assert.ok(area);
      const vols = [10, 40].map((hidden) => {
        const heights = drawnHeights({ chunks: chunks(hidden), sceneId: "s", bounds, fog: tiles, stand: true }, 5);
        const v = buildVolume({ area, bounds, ground: heights.at, px: 40 });
        v.ensureAll();
        return v;
      });
      const [v0, v1] = vols as [Volume, Volume];
      assert.equal(everySubcell(v1.footprint, (sx, sy) => fog.revealed(sx, sy)), everySubcell(v0.footprint, (sx, sy) => fog.revealed(sx, sy)));
      assert.equal(v1.faceCount, v0.faceCount, `#${i}`);
      const f0 = v0.faces();
      const f1 = v1.faces();
      for (let k = 0; k < f0.length; k++) {
        assert.deepEqual([...f1[k]!.v].map((q) => v1.vertex(q)), [...f0[k]!.v].map((q) => v0.vertex(q)), `#${i} face ${k}`);
      }
    }
  });
});

/** The parts of rectangle r outside rectangle hole. */
function cutOut(r: readonly [number, number, number, number], hole: readonly [number, number, number, number]): [number, number, number, number][] {
  const [x0, y0, x1, y1] = r;
  const [hx0, hy0, hx1, hy1] = hole;
  if (hx1 <= x0 || hx0 >= x1 || hy1 <= y0 || hy0 >= y1) return [[x0, y0, x1, y1]];
  const out: [number, number, number, number][] = [];
  if (y0 < hy0) out.push([x0, y0, x1, hy0]);
  if (hy1 < y1) out.push([x0, hy1, x1, y1]);
  const my0 = Math.max(y0, hy0);
  const my1 = Math.min(y1, hy1);
  if (x0 < hx0) out.push([x0, my0, hx0, my1]);
  if (hx1 < x1) out.push([hx1, my0, x1, my1]);
  return out.filter(([a, b, c, d]) => c > a && d > b);
}

/** Two volumes hold the same heights over every point of the plan: the same solid, however their faces are cut. */
function assertSameSolid(v0: Volume, v1: Volume, area: ResolvedArea, rand: () => number, label: string): void {
  v0.ensureAll();
  v1.ensureAll();
  const at0 = faceIndex(v0);
  const at1 = faceIndex(v1);
  const b = area.shade?.bounds ?? area.shape.bounds;
  for (let k = 0; k < 60; k++) {
    const x = b.x0 + rand() * (b.x1 - b.x0);
    const y = b.y0 + rand() * (b.y1 - b.y0);
    if (nearEdge(area, x, y)) continue;
    const s0 = meshIntervals(v0, at0(x, y), x, y, 0, label);
    const s1 = meshIntervals(v1, at1(x, y), x, y, 0, label);
    assert.equal(s1.length, s0.length, `${label} at ${x}, ${y}`);
    s0.forEach(([lo, hi], j) => assert.ok(Math.abs(s1[j]![0] - lo) < 1e-7 && Math.abs(s1[j]![1] - hi) < 1e-7, `${label} at ${x}, ${y}`));
  }
}
