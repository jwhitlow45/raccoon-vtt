import assert from "node:assert/strict";
import { flatHeights, type DrawnHeights } from "../../lib/view.ts";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { groundSurface } from "../../lib/groundCells.ts";
import { drawVolume } from "./drawRelief.ts";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import type { AreaTemplateInput } from "#shared/rules/aoe.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { ctxOf } from "../../features/areas/volumeTesting.ts";
import { FogView } from "./fogView.ts";
import type { LiveSub } from "./stand.ts";
import { BoardVolumes, standOf, viewBoxOf, viewKeys, type VolumeEntry, type VolumesNow, type VolumeWorld } from "./volumes.ts";

/*
 * The board's areas standing as their real shapes
 * (docs/design-v1-iso-area-shapes.md 4.4 and 6): built in slices nearest
 * the middle first, standing only once every bucket in view is drawn, kept
 * standing while a new volume builds only while the stand rule still
 * holds for it, and fine meshes at rest.
 */

const BOUNDS = { w: 48, h: 48 };
const VIEW = { x0: -1e4, y0: -1e4, x1: 1e4, y1: 1e4 };
const LOOK = { color: "#3fa7ff", dm: false, selected: false, preview: false };

function sphere(id: string, x: number, y: number, size = 20): AreaTemplateInput {
  return { id, rev: 1, shape: "sphere", size, origin: { x, y, z: 10 }, yaw: 0, includeOrigin: true };
}

function entry(t: AreaTemplateInput): VolumeEntry {
  return { id: t.id, template: t, ctx: ctxOf(BOUNDS, null), look: LOOK };
}

/** A player's fog: every sub-cell revealed but these. */
function fogBut(fogged: readonly (readonly [number, number])[]): { tiles: Record<string, FogTile>; view: FogView } {
  const tiles: Record<string, FogTile> = {};
  for (let ty = 0; ty * 16 < BOUNDS.h; ty++) {
    for (let tx = 0; tx * 16 < BOUNDS.w; tx++) {
      const bits = new Uint8Array(TILE_BYTES).fill(255);
      for (const [sx, sy] of fogged) {
        if (Math.floor(sx / TILE_SUB) !== tx || Math.floor(sy / TILE_SUB) !== ty) continue;
        const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
        bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
      }
      tiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) };
    }
  }
  return { tiles, view: new FogView(tiles, "s1", BOUNDS) };
}

const flat = flatHeights(BOUNDS);

function world(fog: FogView = new FogView(null, "s1", BOUNDS), tiles: unknown = null, live: LiveSub | null = null): VolumeWorld {
  return { heights: flat, tiles, px: 32, fog, live };
}

/** What the board shows of `now`: the areas standing, and whether "Building area shapes…" shows. */
function shows(n: VolumesNow): string {
  return `${[...n.standing].sort().join(",")}${n.waiting ? " waiting" : ""}`;
}

/**
 * Steps as the board does until nothing is left, each with a deadline
 * already past, holding that a step which changes what `now` gives says
 * so: the board lays out again only then (IsoBoard's slice loop).
 */
function asTheBoard(v: BoardVolumes, w: VolumeWorld, view = VIEW, turn: 0 | 1 | 2 | 3 = 0): void {
  let shown = shows(v.now(turn, view, w));
  for (let i = 0; i < 100_000; i++) {
    const step = v.step(turn, view, w, -Infinity);
    const now = shows(v.now(turn, view, w));
    assert.ok(now === shown || step.changed, `step ${i} took the board from "${shown}" to "${now}" without saying it changed`);
    shown = now;
    if (!step.more) return;
  }
  assert.fail("never settled");
}

/** Steps until nothing is left, each with a deadline already past, and how many it took. */
function settle(v: BoardVolumes, w: VolumeWorld, turn: 0 | 1 | 2 | 3 = 0): number {
  let steps = 0;
  while (v.step(turn, VIEW, w, -Infinity).more) steps++;
  return steps;
}

describe("the board's areas standing as their real shapes", () => {
  test("an area stands only once its build, its stand test and every bucket in view are done, and lies flat meanwhile, saying it waits", () => {
    const v = new BoardVolumes();
    const w = world();
    v.sync([entry(sphere("a", 16, 16, 40))], w);
    const before = v.now(0, VIEW, w);
    assert.equal(before.pieces.length, 0);
    assert.ok(before.waiting);
    let stood = -1;
    for (let i = 0; i < 100_000 && stood < 0; i++) {
      const more = v.step(0, VIEW, w, -Infinity).more;
      const now = v.now(0, VIEW, w);
      if (now.standing.has("a")) stood = i;
      else assert.equal(now.pieces.length, 0, "never a part of it");
      if (!more) break;
    }
    assert.ok(stood > 10, `stood after ${stood} slices`);
    assert.ok(!v.now(0, VIEW, w).waiting);
  });

  test("the area nearest the view's middle stands first", () => {
    const v = new BoardVolumes();
    const w = world();
    // At turn 0 a cell x, y shows at view x (x - y) / sqrt 2 and y (x + y) / (2 sqrt 2): the middle of this box is about the cell 24, 24.
    const mid = { x0: -10, y0: 7, x1: 10, y1: 27 };
    v.sync([entry(sphere("far", 4, 4)), entry(sphere("near", 24, 24)), entry(sphere("edge", 40, 40))], w);
    let first: string | null = null;
    for (let i = 0; i < 100_000 && first === null; i++) {
      v.step(0, mid, w, -Infinity);
      const now = v.now(0, mid, w);
      if (now.standing.size > 0) first = [...now.standing][0]!;
    }
    assert.equal(first, "near");
  });

  test("with a panel over part of the board, the area nearest the middle of what shows stands first", () => {
    const v = new BoardVolumes();
    const w = world();
    const whole = { x0: -30, y0: 0, x1: 30, y1: 40 };
    // The cell 40, 40 shows at view 0, 28.3: the middle left clear when a panel covers the board's top.
    const shown = { x: 0, y: 40 / Math.SQRT2 };
    v.sync([entry(sphere("far", 4, 4)), entry(sphere("near", 24, 24)), entry(sphere("edge", 40, 40))], w);
    let first: string | null = null;
    for (let i = 0; i < 100_000 && first === null; i++) {
      v.step(0, whole, w, -Infinity, shown);
      const now = v.now(0, whole, w);
      if (now.standing.size > 0) first = [...now.standing][0]!;
    }
    assert.equal(first, "edge");
  });

  test("security: a volume that stood keeps standing while its next one builds only while its own stand test passes on the viewer's ground as it is now", () => {
    const v = new BoardVolumes();
    const open = fogBut([]);
    const w0 = world(open.view, open.tiles);
    v.sync([entry(sphere("a", 16, 16))], w0);
    settle(v, w0);
    assert.ok(v.now(0, VIEW, w0).standing.has("a"));
    // New fog tiles make a new volume. With nothing fogged under it, the old one stands while the new one builds.
    const same = fogBut([[0, 0]]);
    const w1 = world(same.view, same.tiles);
    v.sync([entry(sphere("a", 16, 16))], w1);
    const kept = v.now(0, VIEW, w1);
    assert.ok(kept.standing.has("a"), "kept while the next builds");
    assert.ok(!kept.waiting, "and nothing waits");
    // A sub-cell under its plan fogged: the old one lies flat at once, before the new one is built.
    const under = fogBut([[16 * FOG_SUBCELLS, 16 * FOG_SUBCELLS]]);
    const w2 = world(under.view, under.tiles);
    v.sync([entry(sphere("a", 16, 16))], w2);
    assert.equal(v.now(0, VIEW, w2).pieces.length, 0, "never over fog, not even for a frame");
    settle(v, w2);
    assert.equal(v.now(0, VIEW, w2).pieces.length, 0);
    assert.ok(!v.now(0, VIEW, w2).waiting, "decided flat, nothing waits");
  });

  test("a stand test that ends on a large footprint says what stands has changed, for the volume shown and the one before it (review ISOA2-ASTRA-02)", () => {
    // A 60 ft sphere covers about 7,400 sub-cells, past what a render tests at once.
    const big = entry(sphere("a", 24, 24, 60));
    const open = fogBut([]);
    const v = new BoardVolumes();
    const w0 = world(open.view, open.tiles, { subLive: () => true });
    v.sync([big], w0);
    settle(v, w0);
    assert.ok(v.now(0, VIEW, w0).standing.has("a"));
    // The viewer's sight moves within ground they already see: new live ground, the same volume and drawings.
    const w1 = world(open.view, open.tiles, { subLive: () => true });
    v.sync([big], w1);
    assert.equal(shows(v.now(0, VIEW, w1)), " waiting", "flat while its test is read");
    asTheBoard(v, w1);
    assert.equal(shows(v.now(0, VIEW, w1)), "a");
    // New fog tiles with nothing new fogged: a new volume builds, and the one shown stands once its own test passes.
    const same = fogBut([[0, 0]]);
    const w2 = world(same.view, same.tiles, w1.live);
    v.sync([big], w2);
    assert.equal(shows(v.now(0, VIEW, w2)), " waiting");
    asTheBoard(v, w2);
    assert.equal(shows(v.now(0, VIEW, w2)), "a");
  });

  test("a tall cylinder or a steep line seen only at its top builds and says it waits before its first build (review ISOA2-ASTRA-01)", () => {
    const at = { x: 24.5, y: 24.5, z: 0 };
    const tall: AreaTemplateInput[] = [
      { id: "pillar", rev: 1, shape: "cylinder", size: 5, height: 100, origin: at, yaw: 0, includeOrigin: true },
      { id: "beam", rev: 1, shape: "line", size: 100, width: 5, pitch: 90, origin: at, yaw: 0, includeOrigin: true },
    ];
    for (const t of tall) {
      const v = new BoardVolumes();
      const w = world();
      v.sync([entry(t)], w);
      // A view of its top 15 ft alone, 85 ft over the ground.
      const top = viewBoxOf({ x0: 23.5, y0: 23.5, z0: 17, x1: 25.5, y1: 25.5, z1: 20 }, 0);
      assert.equal(shows(v.now(0, top, w)), " waiting", t.shape);
      let steps = 0;
      while (v.step(0, top, w, -Infinity).more) steps++;
      assert.ok(steps > 0, `${t.shape} built`);
      assert.equal(shows(v.now(0, top, w)), t.id, t.shape);
    }
  });

  test("a pan that brings buckets into view lies the area flat and waiting until they are drawn, never standing with them missing (review ISOA2-ASTRA-03)", () => {
    // A 30 ft sphere on the corner of four buckets.
    const v = new BoardVolumes();
    const w = world();
    v.sync([entry(sphere("a", 16, 16, 30))], w);
    v.volumeOf("a")!.prepare();
    // At turn 0 a cell shows at view x (x - y) / sqrt 2: only bucket 0,1 holds cells with y more than 8 past x.
    const left = { x0: -9, y0: -1e4, x1: -6, y1: 1e4 };
    assert.deepEqual(viewKeys(v.volumeOf("a")!, 0, left), ["0,1"]);
    assert.equal(viewKeys(v.volumeOf("a")!, 0, VIEW).length, 4);
    asTheBoard(v, w, left);
    assert.equal(shows(v.now(0, left, w)), "a");
    assert.equal(shows(v.now(0, VIEW, w)), " waiting", "three buckets in view are not drawn");
    asTheBoard(v, w, VIEW);
    assert.equal(shows(v.now(0, VIEW, w)), "a");
    assert.ok(viewKeys(v.volumeOf("a")!, 0, VIEW).every((key) => v.volumeOf("a")!.drawnNow(key, 0) !== null));
    // The same, with a new volume building while the old one stands: missing buckets lie it flat as well.
    const same = fogBut([[0, 0]]);
    const v2 = new BoardVolumes();
    const w0 = world(fogBut([]).view, fogBut([]).tiles);
    v2.sync([entry(sphere("a", 16, 16, 30))], w0);
    asTheBoard(v2, w0, left);
    const w1 = world(same.view, same.tiles);
    v2.sync([entry(sphere("a", 16, 16, 30))], w1);
    assert.equal(shows(v2.now(0, left, w1)), "a", "the old one stands where it is drawn");
    assert.equal(shows(v2.now(0, VIEW, w1)), " waiting", "and not where it is not");
    asTheBoard(v2, w1, VIEW);
    assert.equal(shows(v2.now(0, VIEW, w1)), "a");
  });

  test("FU39-C: a passing old stand test reports no change while its newly visible buckets are undrawn (ISOA2-ASTRA-03-SURVIVOR)", () => {
    const v = new BoardVolumes();
    const open = fogBut([]);
    const w0 = world(open.view, open.tiles);
    const area = entry(sphere("a", 16, 16, 60));
    const left = { x0: -18, y0: -1e4, x1: -12, y1: 1e4 };
    v.sync([area], w0);
    asTheBoard(v, w0, left);
    assert.equal(shows(v.now(0, left, w0)), "a");
    const old = v.volumeOf("a")!;
    assert.ok(viewKeys(old, 0, VIEW).some((key) => old.drawnNow(key, 0) === null));

    const same = fogBut([[0, 0]]);
    const w1 = world(same.view, same.tiles);
    v.sync([area], w1);
    assert.notEqual(v.volumeOf("a"), old, "a replacement volume must build");
    assert.equal(shows(v.now(0, VIEW, w1)), " waiting");
    const retest = standOf(old, w1.fog, w1.live);
    assert.equal(retest.result, null, "the old footprint needs sliced work");
    // A passing retest cannot stand the old volume without the missing buckets.
    for (let i = 0; retest.result === null && i < 1_000; i++) {
      const step = v.step(0, VIEW, w1, -Infinity);
      assert.equal(step.more, true);
      assert.equal(shows(v.now(0, VIEW, w1)), " waiting");
      assert.equal(step.changed, false, "an undrawn old volume must not request another layout");
    }
    assert.equal(retest.result, true, "the assertion covered a completed passing retest");
    asTheBoard(v, w1);
    assert.equal(shows(v.now(0, VIEW, w1)), "a");
  });

  test("a turn's drawing is made once: a later visit to that turn stands at once", () => {
    const v = new BoardVolumes();
    const w = world();
    v.sync([entry(sphere("a", 16, 16))], w);
    settle(v, w, 0);
    assert.ok(v.now(0, VIEW, w).standing.has("a"));
    assert.ok(!v.now(1, VIEW, w).standing.has("a"), "a new turn lies flat until drawn");
    settle(v, w, 1);
    assert.ok(v.now(1, VIEW, w).standing.has("a"));
    assert.ok(v.now(0, VIEW, w).standing.has("a"), "back at turn 0 at once");
    assert.equal(settle(v, w, 0), 0, "with nothing to do");
  });

  test("at rest an area is built fine, not coarse as it is while it moves", () => {
    const v = new BoardVolumes();
    const w = world();
    v.sync([entry(sphere("a", 24, 24, 100))], w);
    assert.ok(v.volumeOf("a")!.segments > 16, `${v.volumeOf("a")!.segments} segments`);
  });

  test("security: the board's volumes read the viewer's drawn heights and fog, never the real heights", () => {
    const src = readFileSync(new URL("./IsoBoard.tsx", import.meta.url), "utf8");
    assert.match(src, /const heights = useMemo\(\(\) => drawnHeights\(src, feet\), \[src, feet\]\);/);
    assert.match(src, /\(\{ heights, tiles: props\.viewerFog, px: octave, fog, live: liveGround \}\)/);
  });
});

/** Drawn heights on a grid from cells in cells of height, every other cell 0. */
function heightsOn(grid: Grid, bounds: { w: number; h: number }, cells: Record<string, number>): DrawnHeights {
  const surface = groundSurface(grid, bounds, (c) => cells[`${c.col},${c.row}`] ?? 0);
  const values = Object.values(cells);
  return { ...surface, low: Math.min(0, ...values), high: Math.max(0, ...values), at: (x, y) => surface.atCell({ col: x, row: y }) };
}

/** How many fills cover a view point, inside every clip in force: a canvas that reads paths in view units, with no transform. */
function fillsAt(point: { x: number; y: number }): { g: CanvasRenderingContext2D; count: () => number } {
  type Sub = { x: number; y: number }[];
  let path: Sub[] = [];
  let clips: Sub[][] = [];
  const stack: Sub[][][] = [];
  let n = 0;
  const inside = (subs: Sub[]) =>
    subs.some((poly) => {
      let odd = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
      }
      return odd;
    });
  const g = {
    save: () => stack.push(clips),
    restore: () => {
      clips = stack.pop()!;
    },
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push([{ x, y }]),
    lineTo: (x: number, y: number) => path[path.length - 1]!.push({ x, y }),
    closePath: () => {},
    clip: () => {
      clips = [...clips, path];
    },
    fill: () => {
      if (inside(path) && clips.every(inside)) n++;
    },
    stroke: () => {},
    setLineDash: () => {},
    fillStyle: "",
    strokeStyle: "",
    lineJoin: "",
    lineCap: "",
    lineWidth: 1,
    globalAlpha: 1,
  };
  return { g: g as unknown as CanvasRenderingContext2D, count: () => n };
}

describe("an area below 0 shows only through its own pits (review HXR1-ASTRA-1)", () => {
  test("squares, lone pits (2,2) and (4,4) at -4 cells, a 5 ft cube in (2,2) at -0.8 cells: (4,4)'s opening admits none of it over the flat ground between", () => {
    const bounds = { w: 8, h: 8 };
    const heights = heightsOn(SQUARES, bounds, { "2,2": -4, "4,4": -4 });
    const fog = new FogView(null, "s1", bounds);
    const w: VolumeWorld = { heights, tiles: null, px: 32, fog, live: null };
    const cube: AreaTemplateInput = { id: "c", rev: 1, shape: "cube", size: 5, origin: { x: 2.5, y: 2.5, z: -4 }, yaw: 0, includeOrigin: true };
    const v = new BoardVolumes();
    v.sync([{ id: "c", template: cube, ctx: ctxOf(bounds, null), look: LOOK }], w);
    settle(v, w);
    const now = v.now(0, VIEW, w);
    assert.ok(now.standing.has("c"));
    const pits = now.pieces[0]!.pits;
    assert.deepEqual(pits, [heights.polygon({ col: 2, row: 2 })], "its own pit's opening alone");
    // The sample over flat ground (3.4798, 3.4798), where (4,4)'s opening swept up would let the cube's fill through.
    const at = fillsAt({ x: 0, y: 2.460587276 });
    const high = now.pieces.flatMap((p) => p.draws.map((d) => d.high));
    const low = now.pieces.flatMap((p) => p.draws.map((d) => d.low));
    drawVolume(at.g, high, low, pits, LOOK, 0, 1 / 32);
    assert.equal(at.count(), 0);
    // With (4,4)'s opening too, the sample is filled: it tells the two apart.
    const both = fillsAt({ x: 0, y: 2.460587276 });
    drawVolume(both.g, high, low, [...pits, heights.polygon({ col: 4, row: 4 })], LOOK, 0, 1 / 32);
    assert.ok(both.count() > 0);
  });

  test("a pit joined to the one under the plan, side by side, still opens: the part shows through its region's neighbor", () => {
    const bounds = { w: 8, h: 8 };
    // (4,2) lies past the cube's plan, joined to it only through (3,2).
    const heights = heightsOn(SQUARES, bounds, { "2,2": -4, "3,2": -4, "4,2": -4, "5,5": -4 });
    const w: VolumeWorld = { heights, tiles: null, px: 32, fog: new FogView(null, "s1", bounds), live: null };
    const cube: AreaTemplateInput = { id: "c", rev: 1, shape: "cube", size: 5, origin: { x: 2.5, y: 2.5, z: -4 }, yaw: 0, includeOrigin: true };
    const v = new BoardVolumes();
    v.sync([{ id: "c", template: cube, ctx: ctxOf(bounds, null), look: LOOK }], w);
    settle(v, w);
    const pits = v.now(0, VIEW, w).pieces[0]!.pits;
    assert.deepEqual(new Set(pits), new Set([heights.polygon({ col: 2, row: 2 }), heights.polygon({ col: 3, row: 2 }), heights.polygon({ col: 4, row: 2 })]));
  });
});
