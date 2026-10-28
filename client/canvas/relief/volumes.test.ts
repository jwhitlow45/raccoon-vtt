import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import type { AreaTemplateInput } from "#shared/rules/aoe.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { ctxOf } from "../../features/areas/volumeTesting.ts";
import { FogView } from "./fogView.ts";
import type { LiveSub } from "./stand.ts";
import { BoardVolumes, viewBoxOf, type VolumeEntry, type VolumesNow, type VolumeWorld } from "./volumes.ts";

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

const flat = { at: () => 0 };

function world(fog: FogView = new FogView(null, "s1", BOUNDS), tiles: unknown = null, live: LiveSub | null = null): VolumeWorld {
  return { heights: flat, tiles, px: 32, fog, live };
}

/** What the board shows of `now`: the areas standing, and whether "Building area shapes" shows. */
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
