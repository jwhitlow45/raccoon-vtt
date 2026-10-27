import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature } from "#shared/model.ts";
import { creaturesInArea, resolveArea, type AreaContext, type AreaTemplateInput, type AreaToken, type ResolvedArea } from "#shared/rules/aoe.ts";
import { gridOfShape, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { hexAt, hexKey, type HexGrid } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild, type WallSet } from "#shared/rules/walls.ts";
import { bandAt, buildVolume, capLoops, everySubcell, segmentsAround, towardViewer, VolumeCache, zoomOctave, type Volume, type VolumeLine } from "./volume.ts";
import {
  assertBanded,
  assertClosed,
  assertLoops,
  chordTolerance,
  ctxOf,
  dungeonWalls,
  faceIndex,
  flatGround,
  inClip,
  meshIntervals,
  mulberry32,
  onClipLine,
  randomGround,
  randomTemplate,
  randomWalls,
  rect,
  SHAPES,
  tok,
  truth,
  TURNS,
  turnAxesOf,
  wallsAround,
  type Ground,
} from "./volumeTesting.ts";

/**
 * The mesh of an area's solid (docs/design-v1-iso-area-shapes.md 4.2 and
 * the case table, section 8): closed and wound outward after every cut
 * but where it lies on the drawn ground, each face in one depth band at
 * every turn, and the very solid the rules catch with, cut by the clip
 * and the ground.
 */

/** More random cases and other seeds for a long local run: VOLUME_FUZZ=20. */
const FUZZ = Math.max(1, Number(process.env.VOLUME_FUZZ ?? 1));
const SEED = Number(process.env.VOLUME_SEED ?? 0);
const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;

type Built = { area: ResolvedArea; vol: Volume; ground: Ground; bounds: { w: number; h: number }; px: number; coarse: boolean };

function checkMesh({ area, vol, ground, bounds }: Built, rand: () => number, label: string, rays = 40): void {
  assert.equal(vol.failed, 0, `${label}: caps left edges open`);
  vol.ensureAll();
  assertClosed(vol, label);
  if (vol.banded) assertBanded(vol, label);
  const tol = chordTolerance(vol);
  // Every vertex of a face lies on the surface within its chord tolerance, or on a clip line, inside the clip and above the ground.
  const used = new Set<number>();
  for (const f of vol.faces()) for (const i of f.v) used.add(i);
  for (const i of used) {
    const [x, y, z] = vol.vertex(i);
    const clip = onClipLine(area, bounds, x, y);
    if (!clip) assert.ok(inClip(area, bounds, x, y), `${label}: vertex ${i} at ${x}, ${y} outside the clip`);
    const g = Math.min(...[Math.floor(x - 1e-7), Math.floor(x + 1e-7)].flatMap((cx) => [Math.floor(y - 1e-7), Math.floor(y + 1e-7)].map((cy) => ground.at(cx, cy))));
    assert.ok(z >= g - 1e-7, `${label}: vertex ${i} at ${x}, ${y}, ${z} below the ground`);
    if (area.solid.kind === "hexStack") continue;
    const sd = area.shape.sd(x, y, z);
    assert.ok(sd <= tol + 1e-7, `${label}: vertex ${i} at ${x}, ${y}, ${z} lies ${sd} outside the shape`);
    assert.ok(sd >= -tol - 1e-7 || clip, `${label}: vertex ${i} at ${x}, ${y}, ${z} lies ${-sd} inside the surface, on no clip line`);
  }
  // Over random points, the mesh holds exactly the heights the cut solid does.
  const at = faceIndex(vol);
  const b = area.shape.bounds;
  for (let r = 0; r < rays; r++) {
    const x = b.x0 - 0.5 + rand() * (b.x1 - b.x0 + 1);
    const y = b.y0 - 0.5 + rand() * (b.y1 - b.y0 + 1);
    if (area.solid.kind === "hexStack") {
      const g = area.solid.reach.g;
      const hex = hexKey(hexAt(g, { x, y }));
      if ([-0.02, 0.02].some((dx) => [-0.02, 0.02].some((dy) => hexKey(hexAt(g, { x: x + dx, y: y + dy })) !== hex))) continue;
    }
    if (Math.abs(x - Math.round(x)) < 1e-6 || Math.abs(y - Math.round(y)) < 1e-6) continue;
    const spans = meshIntervals(vol, at(x, y), x, y, ground.at(Math.floor(x), Math.floor(y)), label);
    const inMesh = (z: number) => spans.some(([lo, hi]) => z > lo && z < hi);
    const zs = [area.originZ, b.x1 - b.x0, -(b.x1 - b.x0), 0.5, -0.5];
    for (let q = 0; q < 24; q++) {
      const z = area.originZ + (rand() - 0.5) * 1.5 * (b.x1 - b.x0 + 4) + (zs[q % zs.length]! - area.originZ) * 0;
      const want = truth(area, bounds, ground, tol, x, y, z);
      if (want === undefined) continue;
      if (spans.some(([lo, hi]) => Math.abs(z - lo) < 1e-6 || Math.abs(z - hi) < 1e-6)) continue;
      assert.equal(inMesh(z), want, `${label}: at ${x}, ${y}, ${z} the mesh holds ${JSON.stringify(spans)}`);
    }
  }
}

function build(area: ResolvedArea, bounds: { w: number; h: number }, ground: Ground, px = 40, coarse = false, banded = true): Built {
  return { area, ground, bounds, px, coarse, vol: buildVolume({ area, bounds, ground: ground.at, px, coarse, banded }) };
}

describe("the mesh is closed and wound outward after every cut (design 4.2)", () => {
  test("every shape alone in open ground", () => {
    const rand = mulberry32(1 + SEED);
    const bounds = { w: 40, h: 40 };
    for (let i = 0; i < 60 * FUZZ; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, 40, 40, tokens, i);
      const area = resolveArea(t, ctxOf(bounds, null, tokens));
      assert.ok(area);
      checkMesh(build(area, bounds, flatGround(40, 40), 12 + rand() * 60, rand() < 0.2), rand, `open #${i} ${t.shape}`);
    }
  });

  test("random walls, scene edges, platforms and pits, coarse and fine, banded and whole", () => {
    const rand = mulberry32(2 + SEED);
    for (let i = 0; i < 120 * FUZZ; i++) {
      const w = 16 + Math.floor(rand() * 24);
      const h = 16 + Math.floor(rand() * 24);
      const bounds = { w, h };
      const walls = rand() < 0.8 ? randomWalls(rand, w, h) : null;
      const ground = rand() < 0.8 ? randomGround(rand, w, h) : flatGround(w, h);
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, w, h, tokens, i);
      const area = resolveArea(t, ctxOf(bounds, walls, tokens));
      assert.ok(area);
      checkMesh(build(area, bounds, ground, 12 + rand() * 60, rand() < 0.2, rand() < 0.85), rand, `walled #${i} ${t.shape}`);
    }
  });

  test("walls, shapes and ground all on whole cells, where cuts meet vertices and corners exactly", () => {
    const rand = mulberry32(3 + SEED);
    for (let i = 0; i < 80 * FUZZ; i++) {
      const bounds = { w: 24, h: 24 };
      const cells = [...rect(4, 4, 8, 8), ...rect(12, 6, 6, 6)];
      const edges: Record<string, EdgeFeature> = { "8,7,w": { kind: "wall" }, "8,8,w": { kind: "wall" }, "9,10,n": { kind: "wall" }, "12,8,w": { kind: "door", state: "open", secret: false, discovered: false } };
      const walls = deriveWalls(indexBuild([{ sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges }]), "grid");
      const ground = flatGround(24, 24);
      for (const [x, y, z] of [
        [6, 6, 2],
        [7, 6, 2],
        [10, 9, -2],
        [14, 8, 1],
      ] as const)
        ground.z[y * 24 + x] = z;
      const shape = SHAPES[i % SHAPES.length]!;
      const t: AreaTemplateInput = {
        id: `g${i}`,
        rev: 1,
        shape,
        size: [5, 10, 15, 20][i % 4]!,
        origin: { x: 5 + Math.floor(rand() * 10), y: 5 + Math.floor(rand() * 10), z: [0, 5, 10, -5][Math.floor(rand() * 4)]! },
        yaw: [0, 90, 180, 270][Math.floor(rand() * 4)]!,
        includeOrigin: true,
        width: 5,
        height: 10,
        pitch: [0, 90, -90][Math.floor(rand() * 3)]!,
      };
      const area = resolveArea(t, ctxOf(bounds, walls));
      assert.ok(area);
      checkMesh(build(area, bounds, ground, 32), rand, `grid #${i} ${shape}`);
    }
  });

  test("a hex emanation's stack, cut by walls and the scene's edge", () => {
    const rand = mulberry32(4 + SEED);
    for (let i = 0; i < 20 * FUZZ; i++) {
      const bounds = { w: 24, h: 24 };
      const c = tok("c", { size: (["medium", "large", "huge"] as const)[i % 3]!, x: 2 + rand() * 18, y: 2 + rand() * 18, elevation: [0, 10][i % 2]! });
      const walls = i % 2 === 0 ? randomWalls(rand, 24, 24) : null;
      const ctx = { ...ctxOf(bounds, walls, { c }, ROWS), settings: { feetPerCell: 5, aoeCoverage: "half" as const, aoeInclusion: "anyCell" as const, diagonal: (["five", "euclid", "fiveTen"] as const)[i % 3]! } };
      const area = resolveArea({ id: `h${i}`, rev: 1, shape: "emanation", size: [5, 10, 15][i % 3]!, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c" }, ctx);
      assert.ok(area?.solid.kind === "hexStack");
      checkMesh(build(area, bounds, flatGround(24, 24)), rand, `hex #${i}`, 60);
    }
    // At the scene's edge a hex's side faces no hex, and its upright edges hold the heights of the shorter prisms beside it.
    for (let i = 0; i < 6 * FUZZ; i++) {
      const bounds = { w: 24, h: 24 };
      const c = tok("c", { size: "medium", x: i % 2 === 0 ? 0.5 + rand() * 2 : 21.5 - rand() * 2, y: 2 + rand() * 20, elevation: 0 });
      const ctx = { ...ctxOf(bounds, null, { c }, ROWS), settings: { feetPerCell: 5, aoeCoverage: "half" as const, aoeInclusion: "anyCell" as const, diagonal: "euclid" as const } };
      const area = resolveArea({ id: `e${i}`, rev: 1, shape: "emanation", size: 15, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c" }, ctx);
      assert.ok(area?.solid.kind === "hexStack");
      checkMesh(build(area, bounds, flatGround(24, 24)), rand, `hex at the edge #${i}`, 60);
    }
    // A foot a cell: a stack hundreds of layers tall, its vertices named by corner and layer.
    for (const g of [ROWS, COLUMNS]) {
      const bounds = { w: 24, h: 24 };
      const c = tok("c", { size: "medium", x: 11, y: 11, elevation: 40 });
      const ctx = { ...ctxOf(bounds, randomWalls(rand, 24, 24), { c }, g), settings: { feetPerCell: 1, aoeCoverage: "half" as const, aoeInclusion: "anyCell" as const, diagonal: "euclid" as const } };
      const area = resolveArea({ id: "tall", rev: 1, shape: "emanation", size: 200, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c" }, ctx);
      assert.ok(area?.solid.kind === "hexStack");
      checkMesh(build(area, bounds, flatGround(24, 24)), rand, `tall hex stack on ${g.orient}`, 60);
    }
  });
});

describe("the band split (design 4.2 step 5)", () => {
  test("every face after the split lies in one band at every turn, radii 1 to 100 cells", () => {
    const bounds = { w: 200, h: 200 };
    for (const r of [1, 2.5, 7, 20, 50, 100]) {
      // Off the ground, so its equator guide stands.
      const area = resolveArea({ id: `r${r}`, rev: 1, shape: "sphere", size: r * 5, origin: { x: 100.3, y: 99.7, z: (r + 1) * 5 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
      assert.ok(area);
      const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
      vol.ensureAll();
      assertBanded(vol, `sphere r ${r}`);
      assert.ok(vol.guides().length > 0);
      for (const turn of TURNS) {
        for (const g of vol.guides()) {
          const band = bandAt(turn, (g.ax + g.bx) / 2, (g.ay + g.by) / 2);
          const { c, s } = turnAxesOf(turn);
          for (const [x, y] of [
            [g.ax, g.ay],
            [g.bx, g.by],
          ] as const)
            assert.ok(s * x + c * y >= band - 1e-9 && s * x + c * y <= band + 1 + 1e-9, `guide at turn ${turn}`);
        }
      }
    }
  });

  test("without the split a face spans many bands", () => {
    const bounds = { w: 60, h: 60 };
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 50, origin: { x: 30, y: 30, z: 0 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40, banded: false });
    vol.ensureAll();
    assert.throws(() => assertBanded(vol, "whole"));
  });
});

describe("near and far, edges and loops (design 4.2 steps 7 and 8)", () => {
  const bounds = { w: 40, h: 40 };
  const sphere = () => {
    // 20 ft round, its bottom 5 ft off the ground.
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 25 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    vol.ensureAll();
    return vol;
  };

  test("a face is near when it faces the viewer: the top of a floating sphere always, its bottom never", () => {
    for (const turn of TURNS) {
      assert.ok(towardViewer(turn, 0, 0, 1) > 0);
      assert.ok(towardViewer(turn, 0, 0, -1) < 0);
      const { c, s } = turnAxesOf(turn);
      // A side facing down the depth axis, toward larger depth, faces the viewer.
      assert.ok(towardViewer(turn, s, c, 0) > 0 && towardViewer(turn, -s, -c, 0) < 0);
    }
  });

  test("a sphere's outline is its silhouette and its equator, with no crease and nothing on the ground", () => {
    const vol = sphere();
    for (const turn of TURNS) {
      const lines = vol.lines(turn);
      const kinds = new Set(lines.map((l) => l.kind));
      assert.deepEqual([...kinds].sort(), ["guide", "silhouette"]);
      // The silhouette of a sphere seen orthographically is a circle of its radius around its middle.
      const { c, s } = turnAxesOf(turn);
      for (const l of lines.filter((x) => x.kind === "silhouette")) {
        for (const [x, y, z] of [
          [l.ax, l.ay, l.az],
          [l.bx, l.by, l.bz],
        ] as const) {
          const u = c * (x - 20) - s * (y - 20);
          const v = (s * (x - 20) + c * (y - 20)) / 2 - 0.8660254037844386 * (z - 5);
          const r = Math.hypot(u, v / 1);
          assert.ok(r <= 4 + 1e-9, `turn ${turn}: silhouette point ${r} off the middle`);
        }
      }
      // The silhouette runs whole around the sphere, solid all the way, since a near face is beside every piece of it.
      const silhouette = lines.filter((x) => x.kind === "silhouette");
      assert.ok(silhouette.every((l) => l.near));
      assertLoops(silhouette, `turn ${turn} silhouette`);
      // The near guide pieces are the front half of the equator.
      const guides = lines.filter((x) => x.kind === "guide");
      assert.ok(guides.some((g) => g.near) && guides.some((g) => !g.near));
    }
  });

  test("the near loops of a whole sphere bound its near half: one loop, the far ones too", () => {
    const vol = sphere();
    for (const turn of TURNS) {
      const { near, far } = vol.loops(turn);
      assert.equal(near.length, 1, `turn ${turn} near`);
      assert.equal(far.length, 1, `turn ${turn} far`);
      // The two loops are the silhouette run opposite ways.
      assert.equal(near[0]!.length, far[0]!.length);
    }
  });

  test("a run's loops cover its bands alone, and each band's loops add up to the whole", () => {
    const vol = sphere();
    for (const turn of TURNS) {
      const bands = vol.bands(turn);
      assert.ok(bands.length >= 8, `${bands.length} bands`);
      let pieces = 0;
      for (const band of bands) {
        const { near, far } = vol.loops(turn, vol.keys, [band, band]);
        for (const loop of [...near, ...far]) {
          for (let k = 0; k < loop.length; k += 3) {
            const { c, s } = turnAxesOf(turn);
            const d = s * loop[k]! + c * loop[k + 1]!;
            assert.ok(d >= band - 1e-9 && d <= band + 1 + 1e-9);
          }
        }
        pieces += near.length + far.length;
      }
      assert.ok(pieces >= bands.length);
      // Every edge belongs to one run: the lines of the bands one by one are the lines of the whole.
      const whole = vol.lines(turn).length;
      const byBand = bands.reduce((n, band) => n + vol.lines(turn, vol.keys, [band, band]).length, 0);
      assert.equal(byBand, whole);
    }
  });

  test("a cube's edges are creases, solid where a near face is beside them and dashed where only far ones are", () => {
    // A 20 ft cube from 10 ft up to 30 ft, clear of the ground.
    const area = resolveArea({ id: "b", rev: 1, shape: "cube", size: 20, origin: { x: 20, y: 20, z: 20 }, yaw: 0, includeOrigin: false }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40, banded: false });
    vol.ensureAll();
    assert.ok(area.solid.kind === "box");
    const { c, half } = area.solid;
    const corners = [-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k) => [c.x + i * half[0], c.y + j * half[1], c.z + k * half[2]] as const)));
    for (const turn of TURNS) {
      const lines = vol.lines(turn);
      // A cube seen from above at 45 degrees shows three faces: six silhouette edges, three near creases and three hidden ones.
      const silhouette = lines.filter((l) => l.kind === "silhouette");
      assert.equal(silhouette.length, 6);
      assert.ok(silhouette.every((l) => l.near));
      assertLoops(silhouette, `turn ${turn} silhouette`);
      // The near creases meet at the corner nearest the viewer, the hidden ones at the farthest.
      const byNearness = [...corners].sort((p, q) => towardViewer(turn, ...q) - towardViewer(turn, ...p));
      const touches = (l: VolumeLine, [x, y, z]: readonly [number, number, number]) => [[l.ax, l.ay, l.az], [l.bx, l.by, l.bz]].some(([px, py, pz]) => Math.hypot(px! - x, py! - y, pz! - z) < 1e-9);
      const near = lines.filter((l) => l.kind === "crease" && l.near);
      const hidden = lines.filter((l) => l.kind === "crease" && !l.near);
      assert.equal(near.length, 3);
      assert.equal(hidden.length, 3);
      assert.ok(near.every((l) => touches(l, byNearness[0]!)), `turn ${turn}: near creases`);
      assert.ok(hidden.every((l) => touches(l, byNearness[7]!)), `turn ${turn}: hidden creases`);
    }
  });

  test("an edge on a band plane belongs to the nearer band beside it", () => {
    // A 20 ft cube whose corner at (x1, y0) lies on the plane of depth 28 at turn 0, so the upright edge there parts a face in band 28 from one in band 27.
    const y0 = 18.3;
    const x1 = 28 * Math.SQRT2 - y0;
    // A cube grows along its aim from the middle of one face.
    const area = resolveArea({ id: "b", rev: 1, shape: "cube", size: 20, origin: { x: x1 - 4, y: y0 + 2, z: 20 }, yaw: 0, includeOrigin: false }, ctxOf(bounds, null));
    assert.ok(area?.solid.kind === "box");
    assert.ok(Math.abs(area.solid.c.x + area.solid.half[0] - x1) < 1e-12 && Math.abs(area.solid.c.y - area.solid.half[1] - y0) < 1e-12);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    vol.ensureAll();
    const upright = (l: VolumeLine) => [l.ax, l.bx].every((x) => Math.abs(x - x1) < 1e-9) && [l.ay, l.by].every((y) => Math.abs(y - y0) < 1e-9);
    assert.equal(vol.lines(0, vol.keys, [28, 28]).filter(upright).length, 1);
    assert.equal(vol.lines(0, vol.keys, [27, 27]).filter(upright).length, 0);
  });

  test("a wall's cap is rimmed, and a sphere sitting on the ground has a ground rim and no bottom", () => {
    const cells = rect(0, 0, 20, 40);
    const walls = deriveWalls(indexBuild([{ sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges: {} }]), 1);
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x: 18.3, y: 20.4, z: 0 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, walls));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    assert.equal(vol.failed, 0);
    vol.ensureAll();
    const caps = vol.faces().filter((f) => f.cap);
    assert.ok(caps.length > 0 && caps.every((f) => f.nx === 1 && f.ny === 0));
    for (const turn of TURNS) {
      const kinds = new Set(vol.lines(turn).map((l) => l.kind));
      assert.ok(kinds.has("cap") && kinds.has("ground"), `turn ${turn}: ${[...kinds]}`);
    }
    // It sits on the ground, which closes it: no face lies on the ground.
    assert.ok(vol.faces().every((f) => !(f.nz < -1 + 1e-9 && [...f.v].every((i) => Math.abs(vol.vertex(i)[2]) < 1e-9))));
  });
});

describe("caps at hair-thin corners and pinches (design 4.2 step 3)", () => {
  // On the plane x = 0, where a point's place along the line is its y.
  const at = (y: number, z: number) => [0, y, z] as const;
  const plane = { a: 1, b: 0, e: 0 };
  const sorted = (loops: number[][]) => loops.map((l) => [...l].sort((p, q) => p - q).join(",")).sort();

  test("each chain's end joins the nearest start above or below it, not one a hair along the line", () => {
    // Two caps side by side, the second starting 5e-8 cells past the first, given as their bottom and top chains with the upright edges to find.
    const hair = 0.5e-7;
    const points = [at(0, 0), at(1, 0), at(1, 1), at(0, 1), at(1 + hair, 0), at(2, 0), at(2, 1), at(1 + hair, 1)];
    const loops = capLoops(points, [[0, 1], [2, 3], [4, 5], [6, 7]], plane);
    assert.deepEqual(sorted(loops), ["0,1,2,3", "4,5,6,7"]);
  });

  test("where two caps touch at a corner, the walk keeps to the cap it came along", () => {
    // Two squares meeting at point 2, the second's edge from the pinch listed before the first's.
    const points = [at(0, 0), at(1, 0), at(1, 1), at(0, 1), at(2, 1), at(2, 2), at(1, 2)];
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 4], [4, 5], [5, 6], [6, 2], [2, 3], [3, 0]];
    assert.deepEqual(sorted(capLoops(points, edges, plane)), ["0,1,2,3", "2,4,5,6"]);
    assert.deepEqual(sorted(capLoops(points, [...edges].reverse(), plane)), ["0,1,2,3", "2,4,5,6"]);
  });
});

describe("ground and pits (design 4.2 step 4, D-261026-30)", () => {
  const bounds = { w: 30, h: 30 };

  test("a 5 ft sphere at -10 ft over a 20 ft pit stands inside the opening down to the floor", () => {
    const ground = flatGround(30, 30);
    for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) ground.z[y * 30 + x] = -4;
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 5, origin: { x: 12, y: 12, z: -10 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const built = build(area, bounds, ground);
    checkMesh(built, mulberry32(5), "pit");
    // The whole sphere is there, below 0: no part of it is cut away.
    const zs = built.vol.faces().flatMap((f) => [...f.v].map((i) => built.vol.vertex(i)[2]));
    assert.ok(Math.min(...zs) < -2.99 && Math.max(...zs) > -1.01 && Math.max(...zs) < 0);
    // Cut at 0 instead, as if the pit were flat ground, nothing stands.
    const flat = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    flat.ensureAll();
    assert.equal(flat.faces().length, 0);
  });

  test("a sphere over a pit's edge stands into the pit and stops at the ground beside it", () => {
    const ground = flatGround(30, 30);
    for (let y = 10; y < 20; y++) for (let x = 15; x < 20; x++) ground.z[y * 30 + x] = -3;
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 15, origin: { x: 15.2, y: 14.6, z: -5 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    checkMesh(build(area, bounds, ground), mulberry32(6), "pit edge", 200);
  });

  test("a creature at 0 ft under a 10 ft column in a 5 ft sphere: caught by the rules, no solid over it", () => {
    const ground = flatGround(30, 30);
    ground.z[10 * 30 + 10] = 2;
    const c = tok("c", { x: 10, y: 10, elevation: 0 });
    const t: AreaTemplateInput = { id: "s", rev: 1, shape: "sphere", size: 5, origin: { x: 10.5, y: 10.5, z: 2.5 }, yaw: 0, includeOrigin: true };
    const area = resolveArea(t, ctxOf(bounds, null, { c }));
    assert.ok(area);
    const built = build(area, bounds, ground);
    checkMesh(built, mulberry32(7), "buried");
    assert.deepEqual(creaturesInArea(t, [c], ctxOf(bounds, null, { c })), ["c"]);
    // No face lies over the column's cell: the sphere's top is below the column's.
    const over = built.vol.faces().filter((f) =>
      [...f.v].every((i) => {
        const [x, y] = built.vol.vertex(i);
        return x >= 10 && x <= 11 && y >= 10 && y <= 11;
      }),
    );
    assert.equal(over.length, 0);
  });

  test("the ground cut reads the ground it is given, not the real heights", () => {
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 15, origin: { x: 15, y: 15, z: 0 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const raised = flatGround(30, 30);
    raised.z[15 * 30 + 15] = 2;
    const a = buildVolume({ area, bounds, ground: raised.at, px: 40 });
    const b = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    a.ensureAll();
    b.ensureAll();
    assert.notEqual(a.faces().length, b.faces().length);
  });
});

describe("segments and the zoom octave (design 4.2 step 1)", () => {
  test("a chord strays about a pixel, 16 to 64 around, 16 while it moves", () => {
    assert.equal(segmentsAround(4, 40), 4 * Math.ceil((Math.PI * Math.sqrt(160)) / 4));
    assert.equal(segmentsAround(0.2, 12), 16);
    assert.equal(segmentsAround(100, 40), 64);
    assert.equal(segmentsAround(100, 40, true), 16);
    for (const [r, px] of [
      [4, 40],
      [2, 20],
      [10, 24],
    ] as const) {
      const n = segmentsAround(r, px);
      // The sagitta of a chord in screen pixels.
      assert.ok(r * px * (1 - Math.cos(Math.PI / n)) <= 1.2, `${r} at ${px}`);
    }
  });

  test("the mesh is built for the octave below the zoom, and coarse while it moves", () => {
    assert.equal(zoomOctave(40), 32);
    assert.equal(zoomOctave(63.9), 32);
    assert.equal(zoomOctave(64), 64);
    const bounds = { w: 40, h: 40 };
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 0 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    assert.equal(buildVolume({ area, bounds, ground: () => 0, px: 40, coarse: true }).segments, 16);
    assert.equal(buildVolume({ area, bounds, ground: () => 0, px: 40 }).segments, segmentsAround(4, 40));
  });
});

describe("the cache (design 4.4)", () => {
  const cells = rect(2, 2, 20, 10);
  const door = (state: "open" | "closed") =>
    deriveWalls(indexBuild([{ sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges: { "12,2,w": { kind: "wall" }, "12,3,w": { kind: "wall" }, "12,4,w": { kind: "wall" }, "12,5,w": { kind: "wall" }, "12,6,w": { kind: "door", state, secret: false, discovered: false }, "12,7,w": { kind: "wall" }, "12,8,w": { kind: "wall" }, "12,9,w": { kind: "wall" }, "12,10,w": { kind: "wall" }, "12,11,w": { kind: "wall" } } }]), `door-${state}`);
  const t: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 20, origin: { x: 10.5, y: 6.5, z: 0 }, yaw: 0, includeOrigin: true };
  const heights = { at: () => 0 };

  test("a door in sight opened and closed, no fog change: the volume rebuilt each time", () => {
    const cache = new VolumeCache();
    const tiles = {};
    const req = (walls: WallSet) => ({ template: t, ctx: ctxOf({ w: 30, h: 20 }, walls), heights, tiles, px: 40, coarse: false });
    const closed = cache.get(req(door("closed")));
    assert.equal(cache.get(req(door("closed"))), closed, "the same inputs keep the volume");
    const open = cache.get(req(door("open")));
    assert.ok(closed && open && open !== closed);
    const reclosed = cache.get(req(door("closed")));
    assert.ok(reclosed && reclosed !== open);
    // Through the open door the sphere reaches past the wall.
    open.ensureAll();
    reclosed.ensureAll();
    const past = (v: Volume) => v.faces().some((f) => [...f.v].some((i) => v.vertex(i)[0] > 12.5));
    assert.ok(past(open) && !past(reclosed));
  });

  test("new drawn heights, new fog tiles, a new zoom octave or coarse rebuild it", () => {
    const cache = new VolumeCache();
    const walls = door("closed");
    const base = { template: t, ctx: ctxOf({ w: 30, h: 20 }, walls), heights, tiles: {}, px: 40, coarse: false };
    const a = cache.get(base);
    assert.equal(cache.get({ ...base, px: 50 }), a, "the same octave");
    assert.equal(a?.segments, segmentsAround(4, 32), "built fine for the octave below 40 px");
    assert.equal(cache.get({ ...base, coarse: true })?.segments, 16, "coarse while it moves");
    for (const change of [{ heights: { at: () => 0 } }, { tiles: {} }, { px: 70 }, { coarse: true }]) {
      const before = cache.get(base);
      assert.notEqual(cache.get({ ...base, ...change }), before, JSON.stringify(Object.keys(change)));
    }
  });
});

describe("the stand rule's footprint (design 4.2 step 9)", () => {
  const bounds = { w: 30, h: 30 };

  test("every sub-cell under the plan, and none past a wall that cuts it", () => {
    const cells = rect(0, 0, 15, 30);
    const walls = deriveWalls(indexBuild([{ sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges: {} }]), 1);
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x: 13.3, y: 15.2, z: 5 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, walls));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    const subs = new Set<string>();
    everySubcell(vol.footprint, (sx, sy) => (subs.add(`${sx},${sy}`), true));
    assert.equal(subs.size, vol.footprint.count);
    // The wall at x = 15 cuts the sphere: no sub-cell past it.
    assert.ok([...subs].every((k) => Number(k.split(",")[0]) < 60));
    // Every sub-cell the cut plan covers is there: points of the plan inside the clip.
    const rand = mulberry32(8);
    for (let k = 0; k < 2000; k++) {
      const x = 9.3 + rand() * 5.7;
      const y = 11.2 + rand() * 8;
      if (Math.hypot(x - 13.3, y - 15.2) > 4 || x >= 15) continue;
      assert.ok(subs.has(`${Math.floor(x * 4)},${Math.floor(y * 4)}`), `${x}, ${y}`);
    }
  });

  test("random volumes clipped by the scene's edges and by walls: every sub-cell lies in the scene (review ISOA1-F-2)", () => {
    const rand = mulberry32(7 + SEED);
    let edged = 0;
    for (let i = 0; i < 1500 * FUZZ; i++) {
      const tokens: Record<string, AreaToken> = {};
      const t = randomTemplate(rand, 30, 30, tokens, i);
      // Anywhere, so the scene's edges cut it as often as not.
      const at = { ...t, origin: { ...t.origin, x: -2 + rand() * 34, y: -2 + rand() * 34 } };
      const area = resolveArea(at, ctxOf(bounds, i % 3 === 0 ? randomWalls(rand, 30, 30) : null, tokens));
      if (!area) continue;
      const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
      let touches = false;
      everySubcell(vol.footprint, (sx, sy) => {
        assert.ok(sx >= 0 && sy >= 0 && sx < 120 && sy < 120, `${t.shape} #${i}: sub-cell ${sx}, ${sy}`);
        touches ||= sx === 0 || sy === 0 || sx === 119 || sy === 119;
        return true;
      });
      if (touches) edged++;
    }
    assert.ok(edged > 200, `${edged} volumes reach the scene's edge`);
  });

  test("a solid cut at the scene's far edge, where the cut lands a hair past it, takes no sub-cell beyond", () => {
    // A 20 ft aura round a Huge creature three cells from the edge at x = 30: the cut there lands at 30.000000000000004.
    const tokens = { k: tok("k", { size: "huge", x: 25, y: 3, elevation: 10 }) };
    const area = resolveArea({ id: "e", rev: 1, shape: "emanation", size: 20, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: false, attachedTo: "k" }, ctxOf(bounds, null, tokens));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    let edge = 0;
    everySubcell(vol.footprint, (sx) => {
      assert.ok(sx < 120, `sub-cell column ${sx}`);
      if (sx === 119) edge++;
      return true;
    });
    assert.ok(edge > 0, "the aura reaches the edge");
  });

  test("a sub-cell whose column hides the solid still counts: the plan is read before the ground cut", () => {
    const ground = flatGround(30, 30);
    for (let y = 14; y < 17; y++) for (let x = 14; x < 17; x++) ground.z[y * 30 + x] = 4;
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 10, origin: { x: 15.5, y: 15.5, z: 5 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: ground.at, px: 40 });
    vol.ensureAll();
    // The column at 20 ft rises above the sphere (5 to 15 ft) over its middle cell: nothing stands there.
    assert.ok(vol.faces().every((f) => [...f.v].some((i) => {
      const [x, y] = vol.vertex(i);
      return x < 14.99 || x > 16.01 || y < 14.99 || y > 16.01;
    })));
    const subs = new Set<string>();
    everySubcell(vol.footprint, (sx, sy) => (subs.add(`${sx},${sy}`), true));
    for (let sy = 60; sy < 64; sy++) for (let sx = 60; sx < 64; sx++) assert.ok(subs.has(`${sx},${sy}`), `${sx},${sy}`);
  });

  test("the test stops at the first sub-cell that fails", () => {
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 10, origin: { x: 15.5, y: 15.5, z: 5 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    let asked = 0;
    assert.equal(
      everySubcell(vol.footprint, () => {
        asked++;
        return asked < 5;
      }),
      false,
    );
    assert.equal(asked, 5);
    assert.ok(everySubcell(vol.footprint, () => true));
  });
});

describe("drawing between slices (review ISOA1-ASTRA-08)", () => {
  type Turn = (typeof TURNS)[number];
  const pt = (x: number, y: number, z: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
  const segment = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  const lineKey = (l: VolumeLine) => `${l.kind} ${l.near ? "near" : "far"} ${segment(pt(l.ax, l.ay, l.az), pt(l.bx, l.by, l.bz))}`;
  /** A loop as its edges, each from one point to the next, so a walk that starts elsewhere or splits a pinch the other way reads the same. */
  const loopEdges = (loops: readonly Float64Array[]) =>
    loops.flatMap((l) => {
      const n = l.length / 3;
      return Array.from({ length: n }, (_, k) => {
        const j = (k + 1) % n;
        return `${pt(l[3 * k]!, l[3 * k + 1]!, l[3 * k + 2]!)} > ${pt(l[3 * j]!, l[3 * j + 1]!, l[3 * j + 2]!)}`;
      });
    });

  /** What one draw reads: points to a millionth of a cell, every list sorted, since faces and vertices are numbered in the order the buckets were cut. */
  function draw(vol: Volume, turn: Turn, keys: readonly string[], range?: readonly [number, number]): string {
    const { near, far } = vol.loops(turn, keys, range);
    return JSON.stringify({ bands: vol.bands(turn, keys), lines: vol.lines(turn, keys, range).map(lineKey).sort(), near: loopEdges(near).sort(), far: loopEdges(far).sort() });
  }

  /** Everything the volume gives once every bucket is cut, every band of every turn alone and all together. */
  function finished(vol: Volume): string[] {
    vol.ensureAll();
    const box = (b: ReturnType<Volume["boxOf"]>) => (b ? [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].map((v) => Math.round(v * 1e6)).join(",") : "none");
    const out = [`${vol.faceCount} faces, ${vol.vertexCount} vertices`, vol.guides().map((g) => segment(pt(g.ax, g.ay, g.az), pt(g.bx, g.by, g.bz))).sort().join(" ")];
    for (const key of vol.keys) out.push(`${key}: ${box(vol.boxOf(key))}`);
    for (const turn of TURNS) {
      out.push(draw(vol, turn, vol.keys));
      for (const band of vol.bands(turn)) out.push(`${turn} ${band} ${draw(vol, turn, vol.keys, [band, band])}`);
    }
    return out;
  }

  test("a 40 ft sphere drawn bucket by bucket while the next is cut: every guide piece, near and far as built whole", () => {
    // The reviewer's case: each cut bucket drawn between the slices of the next, which links its faces to theirs before its guides are in.
    const bounds = { w: 40, h: 40 };
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 40, origin: { x: 16, y: 16, z: 50 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const make = () => buildVolume({ area, bounds, ground: () => 0, px: 40 });
    const whole = make();
    const want = finished(whole);
    const vol = make();
    while (!vol.prepare(0));
    let k = 0;
    for (const key of vol.keys) {
      while (!vol.ensure(key, 0)) {
        vol.lines(TURNS[k++ % TURNS.length]!, vol.keys.filter((q) => vol.ready(q)));
      }
    }
    assert.ok(vol.keys.length >= 4 && k > 100);
    const banded = (v: Volume) => v.bands(0).reduce((n, band) => n + v.lines(0, v.keys, [band, band]).filter((l) => l.kind === "guide").length, 0);
    assert.equal(banded(vol), banded(whole));
    assert.ok(banded(whole) > 100);
    assert.deepEqual(finished(vol), want);
  });

  test("random solids and scenes, cut in random slices and orders and drawn between them: a draw changes only when a cut ends, and the end is as built whole", () => {
    const rand = mulberry32(11 + SEED);
    let beside = 0;
    let repeats = 0;
    const cases = 30 * FUZZ;
    for (let i = 0; i < cases; i++) {
      const w = 24 + Math.floor(rand() * 24);
      const h = 24 + Math.floor(rand() * 24);
      const bounds = { w, h };
      const walls = rand() < 0.5 ? randomWalls(rand, w, h) : null;
      const ground = rand() < 0.6 ? randomGround(rand, w, h) : flatGround(w, h);
      const tokens: Record<string, AreaToken> = {};
      // Spheres every other case, since only they carry guides, and each solid near a bucket corner, so it spans buckets that link to each other.
      const t = randomTemplate(rand, w, h, tokens, i % 2 === 0 ? 0 : i >> 1);
      const corner = (n: number) => 16 * Math.max(1, Math.floor((rand() * n) / 16)) + (rand() - 0.5) * 6;
      t.origin = { ...t.origin, x: Math.min(w - 2, corner(w)), y: Math.min(h - 2, corner(h)) };
      if (t.attachedTo) tokens[t.attachedTo] = { ...tokens[t.attachedTo]!, x: Math.floor(t.origin.x), y: Math.floor(t.origin.y) };
      const area = resolveArea(t, ctxOf(bounds, walls, tokens));
      assert.ok(area);
      const input = { area, bounds, ground: ground.at, px: 12 + rand() * 60, coarse: rand() < 0.2, banded: rand() < 0.9 };
      const label = `#${i} ${t.shape}`;
      const whole = buildVolume(input);
      const want = finished(whole);
      // What a view asks again and again: every turn whole, by its middle band, and by its far half, and now and then one bucket.
      const asks = TURNS.flatMap((turn) => {
        const bands = whole.bands(turn);
        const lo = bands[0] ?? 0;
        const mid = bands[bands.length >> 1] ?? 0;
        return [{ turn, range: undefined }, { turn, range: [mid, mid] as const }, { turn, range: [lo, mid] as const }];
      });
      const vol = buildVolume(input);
      // A read in the middle of the build finishes it, as any read does.
      while (!vol.prepare(0)) if (rand() < 0.01) vol.lines(TURNS[Math.floor(rand() * TURNS.length)]!);
      const keys = vol.keys;
      // Each draw by what it asked, since the cut buckets were last the same.
      let cut = "";
      const since = new Map<string, string>();
      let current: string | null = null;
      let inOne = false;
      for (;;) {
        const left = keys.filter((key) => !vol.ready(key));
        if (left.length === 0) break;
        // Mostly the bucket begun, sometimes another begun or new, as a view slices whichever buckets come into sight, and now and then one cut whole.
        if (!current || vol.ready(current) || rand() < 0.15) {
          current = left[Math.floor(rand() * left.length)]!;
          inOne = rand() < 0.1;
        }
        vol.ensure(current, inOne ? Infinity : 0);
        if (rand() < 0.5) continue;
        const ready = keys.filter((key) => vol.ready(key));
        if (ready.join() !== cut) {
          cut = ready.join();
          since.clear();
        }
        if (ready.length > 0 && ready.length < keys.length) beside++;
        const { turn, range } = asks[Math.floor(rand() * asks.length)]!;
        const asked = rand() < 0.2 ? [keys[Math.floor(rand() * keys.length)]!] : keys;
        const ask = `${turn} ${asked.join()} ${range?.join() ?? "all"}`;
        const got = draw(vol, turn, asked, range);
        const before = since.get(ask);
        if (before !== undefined) {
          repeats++;
          assert.equal(got, before, `${label}: ${ask} changed while no cut ended`);
        }
        since.set(ask, got);
      }
      assert.deepEqual(finished(vol), want, label);
    }
    // Most draws come beside a bucket still to cut, where a half-built neighbor could be read, and many repeat one made since the last cut ended.
    assert.ok(beside > 10 * cases && repeats > 4 * cases, `${beside} draws beside an unfinished bucket, ${repeats} repeated`);
  });
});

describe("bounded work (design 6)", () => {
  /** The largest solids, the commonest auras in a dense dungeon, hex stacks, and the largest size at the finest grid on squares and both hex orientations, on scenes of 20 and 200 cells, with ground that steps every few cells. */
  const large = { w: 200, h: 200 };
  const small = { w: 20, h: 20 };
  const ground = (x: number, y: number) => (((x >> 3) + (y >> 3)) % 5 === 0 ? 2 : (x >> 4) % 3 === 0 && (y >> 4) % 2 === 0 ? -1 : 0);
  const dungeon = dungeonWalls(mulberry32(5), 200, 200);
  const around = wallsAround(mulberry32(9), 100.3, 99.6, 200, 200);
  const caster = { c: tok("c", { size: "medium", x: 100, y: 99, elevation: 0 }) };
  /** A foot a cell, the finest grid a room can set. */
  const fine = (bounds: { w: number; h: number }, grid: Grid): AreaContext => ({ ...ctxOf(bounds, null, {}, grid), settings: { feetPerCell: 1, aoeCoverage: "half", aoeInclusion: "anyCell", diagonal: "five" } });
  const sphere = (size: number, at = { x: 100.3, y: 99.6 }): AreaTemplateInput => ({ id: `sphere ${size}`, rev: 1, shape: "sphere", size, origin: { ...at, z: 0 }, yaw: 0, includeOrigin: true });
  const aura = (size: number): AreaTemplateInput => ({ id: `aura ${size}`, rev: 1, shape: "emanation", size, origin: { x: 0, y: 0, z: 0 }, yaw: 0, includeOrigin: false, attachedTo: "c" });
  const point = (size: number, at: { x: number; y: number }): AreaTemplateInput => ({ id: `point ${size}`, rev: 1, shape: "emanation", size, origin: { ...at, z: 0 }, yaw: 0, includeOrigin: true });
  const middle = { x: 100, y: 100 };
  const corner = { x: 10, y: 10 };
  const scenes: { name: string; t: AreaTemplateInput; ctx: AreaContext; bounds: { w: number; h: number } }[] = [
    { name: "open, a sphere 100 cells round", t: sphere(500), ctx: ctxOf(large, null), bounds: large },
    { name: "open, a cylinder 100 cells round", t: { id: "cylinder", rev: 1, shape: "cylinder", size: 500, height: 200, origin: { x: 100.3, y: 99.6, z: 0 }, yaw: 0, includeOrigin: true }, ctx: ctxOf(large, null), bounds: large },
    { name: "open, an emanation 99 cells out", t: { id: "emanation", rev: 1, shape: "emanation", size: 495, origin: { x: 100.5, y: 100.5, z: 0 }, yaw: 0, includeOrigin: false }, ctx: ctxOf(large, null), bounds: large },
    { name: "hex rows, a 500 ft point emanation", t: point(500, middle), ctx: ctxOf(large, null, {}, ROWS), bounds: large },
    { name: "hex rows, a 500 ft point emanation on a 20 cell scene (review ISOA1-ASTRA-05)", t: point(500, corner), ctx: ctxOf(small, null, {}, ROWS), bounds: small },
    { name: "a foot a cell, a cylinder 1,000 ft round (review ISOA1-ASTRA-06)", t: { id: "cylinder", rev: 1, shape: "cylinder", size: 1000, height: 20, origin: { x: 100, y: 100, z: 10 }, yaw: 0, includeOrigin: true }, ctx: fine(large, SQUARES), bounds: large },
    { name: "a foot a cell, a sphere 1,000 ft round on a 20 cell scene", t: sphere(1000, corner), ctx: fine(small, SQUARES), bounds: small },
    { name: "a foot a cell, a sphere 1,000 ft round", t: sphere(1000, middle), ctx: fine(large, SQUARES), bounds: large },
    { name: "a foot a cell on hex rows, a 1,000 ft point emanation on a 20 cell scene", t: point(1000, corner), ctx: fine(small, ROWS), bounds: small },
    { name: "a foot a cell on hex columns, a 1,000 ft point emanation on a 20 cell scene", t: point(1000, corner), ctx: fine(small, COLUMNS), bounds: small },
    { name: "a foot a cell on hex rows, a 1,000 ft point emanation", t: point(1000, middle), ctx: fine(large, ROWS), bounds: large },
    { name: "a foot a cell on hex columns, a 1,000 ft point emanation", t: point(1000, middle), ctx: fine(large, COLUMNS), bounds: large },
    { name: "a sphere 10 cells round among 32 short free walls", t: sphere(50), ctx: ctxOf(large, around), bounds: large },
    { name: "dungeon, a 15 ft aura", t: aura(15), ctx: ctxOf(large, dungeon, caster), bounds: large },
    { name: "dungeon, a 30 ft aura", t: aura(30), ctx: ctxOf(large, dungeon, caster), bounds: large },
    { name: "dungeon, a 20 ft sphere", t: sphere(20), ctx: ctxOf(large, dungeon), bounds: large },
    { name: "dungeon, a 40 ft sphere", t: sphere(40), ctx: ctxOf(large, dungeon), bounds: large },
    { name: "dungeon, a sphere 100 cells round", t: sphere(500), ctx: ctxOf(large, dungeon), bounds: large },
  ];

  test("every step of every build comes in slices, however big the solid, fine the grid or dense the walls", () => {
    for (const { name, t, ctx, bounds } of scenes) {
      const area = resolveArea(t, ctx);
      assert.ok(area, name);
      // A deadline already past at every call: each call still moves the work on, and stops it after about CHECK units and one step, whatever the machine. Its work is counted four ways: the units the build charged, and apart from them the vertices it made, the hexes it visited and the ground it read.
      let reads = 0;
      const counted = (x: number, y: number) => {
        reads++;
        return ground(x, y);
      };
      const started = performance.now();
      const vol = buildVolume({ area, bounds, ground: counted, px: 40 });
      const most = { work: 0, vertices: 0, visits: 0, reads: 0 };
      let calls = 0;
      const call = (step: () => boolean) => {
        const before = { work: vol.work, vertices: vol.vertexCount, visits: vol.hexVisits, reads };
        const done = step();
        most.work = Math.max(most.work, vol.work - before.work);
        most.vertices = Math.max(most.vertices, vol.vertexCount - before.vertices);
        most.visits = Math.max(most.visits, vol.hexVisits - before.visits);
        most.reads = Math.max(most.reads, reads - before.reads);
        calls++;
        return done;
      };
      while (!call(() => vol.prepare(0)));
      let bucketMost = 0;
      for (const key of vol.keys) {
        const start = vol.vertexCount;
        while (!call(() => vol.ensure(key, 0)));
        bucketMost = Math.max(bucketMost, vol.vertexCount - start);
      }
      const ms = performance.now() - started;
      assert.equal(vol.failed, 0, name);
      assert.ok(calls > 2 * vol.keys.length, `${name}: ${calls} calls`);
      assert.ok(most.work <= 1024 && most.vertices <= 400 && most.visits <= 128 && most.reads <= 512, `${name}: at most ${JSON.stringify(most)} in one call`);
      // Generous, so a slow machine does not fail it. The slices' time is the bench's (VOLUME_BENCH=1 below).
      assert.ok(ms < 5000, `${name} took ${ms} ms`);
      if (t.id !== "sphere 500" || ctx.walls) continue;
      // Slicing changes nothing: the same mesh as a build in one go.
      const whole = buildVolume({ area, bounds, ground, px: 40 });
      whole.ensureAll();
      assert.ok(bucketMost > 400);
      assert.equal(whole.faceCount, vol.faceCount);
      assert.equal(whole.vertexCount, vol.vertexCount);
    }
  });

  /**
   * The bench rows (design 6): each slice against the 6 ms slice of the
   * phone stand-in, which runs at a quarter of this machine's speed or
   * less, so a slice here gets 1.5 ms, and how far past it the longest
   * runs. Run it with VOLUME_BENCH=1.
   */
  test("bench: the scenes above against the 6 ms slice", { skip: !process.env.VOLUME_BENCH }, () => {
    const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)]!;
    for (const { name, t, ctx, bounds } of scenes) {
      const area = resolveArea(t, ctx);
      assert.ok(area);
      const first: number[] = [];
      const slices: number[] = [];
      let faces = 0;
      let whole = 0;
      // The first builds are left out: they time the compiler warming up, which a session pays once.
      for (let rep = -2; rep < 8; rep++) {
        const t0 = performance.now();
        const vol = buildVolume({ area, bounds, ground, px: 40 });
        let k = 0;
        const slice = (step: (deadline: number) => boolean) => {
          const a = performance.now();
          const done = step(a + 1.5);
          if (rep >= 0) (k++ === 0 ? first : slices).push(performance.now() - a);
          return done;
        };
        while (!slice((d) => vol.prepare(d)));
        for (const key of vol.keys) while (!slice((d) => vol.ensure(key, d)));
        if (rep >= 0) whole += performance.now() - t0;
        faces = vol.faceCount;
      }
      const all = [...first, ...slices];
      const max = Math.max(...all);
      console.log(`${name}: ${faces} faces, built in ${(whole / 8).toFixed(1)} ms; first slice ${Math.max(...first).toFixed(2)} ms, slices p99 ${p99(all).toFixed(2)}, max ${max.toFixed(2)} (${(max - 1.5).toFixed(2)} past the deadline)`);
    }
  });
});
