import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { MAX_SCALE, MIN_SCALE, screenToView, zoomAt, type Camera } from "../../lib/camera.ts";
import { isometric, TOP_DOWN, type View } from "../../lib/view.ts";
import { lookOf, type Look } from "./looks.ts";
import { HELD_STEP_MS } from "./mode.ts";
import { createField, eachMark, LEVEL_MAX, LEVEL_MIN, levelsAt, motionOf, particleCount, resizeField, setFieldLook, setFieldView, setHalf, stepField, STEP_CLAMP_MS, tileCount, tileFits, tileFor, WRAP_MARGIN, type Field } from "./sim.ts";

/*
 * The weather's particles in the stage's plane (the weather design note 5.2
 * and 5.3, and the zoom note design-v1-weather-zoom.md 3 and 7): a pan and
 * a zoom move every mark's center with the ground, the marks per screen
 * stay as dense at every zoom, marks keep their screen speed, and a copy
 * keeps its name and phase for its whole life.
 */

const HEAVY_RAIN = lookOf({ kind: "rain", heavy: true, wind: "strong" })!;
const SNOW = lookOf({ kind: "snow" })!;
const HEAVY_SNOW = lookOf({ kind: "snow", heavy: true, wind: "moderate" })!;
const LEAVES = lookOf({ kind: "leaves", heavy: true, wind: "moderate" })!;
const W = 390;
const H = 844;
const AT: Camera = { x: -700, y: -500, scale: 40 };

const VIEWS: View[] = [TOP_DOWN, isometric(0), isometric(1), isometric(2), isometric(3)];

/** Every level's particles: where they stand and how often they wrapped. */
function particles(f: Field): number[] {
  const out: number[] = [];
  for (let l = 0; l < f.x.length; l++) out.push(...f.x[l]!.subarray(0, f.count), ...f.y[l]!.subarray(0, f.count), ...f.wx[l]!.subarray(0, f.count), ...f.wy[l]!.subarray(0, f.count));
  return out;
}

function snapshot(f: Field): number[] {
  return [...particles(f), f.t, ...f.sheets, ...f.rings, f.landed];
}

type Mark = { i: number; x: number; y: number; alpha: number; turn: number };

/** Every mark a camera draws over the screen and its margin, by the copy's name. */
function marksOf(f: Field, cam: Camera, w = W, h = H): Map<string, Mark> {
  const out = new Map<string, Mark>();
  eachMark(f, cam, -WRAP_MARGIN, -WRAP_MARGIN, w + WRAP_MARGIN, h + WRAP_MARGIN, (i, x, y, alpha, turn, level, cx, cy) => out.set(`${level} ${i} ${cx} ${cy}`, { i, x, y, alpha, turn }));
  return out;
}

test("counts by the screen's area and caps: the alignment sizes and a big tablet", () => {
  const sizes: [number, number][] = [[1440, 900], [390, 844], [320, 568], [2048, 1536]];
  const expect = (look: Look, w: number, h: number) => Math.min(look.particles!.cap, Math.round((look.particles!.perArea * w * h) / 100_000));
  for (const look of [HEAVY_RAIN, SNOW, lookOf({ kind: "sand", heavy: true, wind: "strong" })!, lookOf({ kind: "leaves" })!]) {
    for (const [w, h] of sizes) assert.equal(particleCount(look, w, h), expect(look, w, h), `${look.key} at ${w}x${h}`);
  }
  assert.equal(particleCount(HEAVY_RAIN, 390, 844), 329, "a phone upright shows about 330,000 px²");
  assert.equal(particleCount(HEAVY_RAIN, 1440, 900), 600, "capped");
  assert.equal(particleCount(lookOf({ kind: "sand", heavy: true, wind: "strong" })!, 2048, 1536), 900);
  assert.equal(particleCount(lookOf({ kind: "fog" })!, 1440, 900), 0);
  assert.equal(particleCount(HEAVY_RAIN, 0, 900), 0);
  // The screen's count spread over the wrap box, as the field always spread it, held over one tile.
  assert.equal(tileCount(HEAVY_RAIN, 390, 844, 1024), Math.round((329 * 1024 * 1024) / (518 * 972)));
  assert.equal(createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN }).count, 685);
});

test("the same seed gives the same field, another seed another", () => {
  const a = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 7 });
  const b = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 7 });
  const c = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 8 });
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.notDeepEqual(snapshot(a), snapshot(c));
  for (let k = 0; k < 20; k++) {
    stepField(a, 33, AT);
    stepField(b, 33, AT);
  }
  assert.deepEqual(snapshot(a), snapshot(b));
});

test("at any zoom about any point, in every view, every copy's center keeps its ground point and its phase", () => {
  fc.assert(
    fc.property(
      fc.double({ min: MIN_SCALE, max: MAX_SCALE, noNaN: true }),
      fc.double({ min: -20000, max: 2000, noNaN: true }),
      fc.double({ min: -20000, max: 2000, noNaN: true }),
      fc.double({ min: 0, max: W, noNaN: true }),
      fc.double({ min: 0, max: H, noNaN: true }),
      fc.double({ min: 0.5, max: 2, noNaN: true }),
      fc.integer({ min: 0, max: 4 }),
      (scale, x, y, ax, ay, factor, v) => {
        const f = createField(HEAVY_RAIN, { width: W, height: H, view: VIEWS[v]!, seed: 5 });
        const before: Camera = { x, y, scale };
        for (let k = 0; k < 5; k++) stepField(f, 33, before);
        const after = zoomAt(before, { x: ax, y: ay }, factor, MIN_SCALE);
        const a = marksOf(f, before);
        const b = marksOf(f, after);
        let shared = 0;
        for (const [key, m] of a) {
          const n = b.get(key);
          if (!n) continue;
          shared++;
          const g1 = screenToView(before, m);
          const g2 = screenToView(after, n);
          assert.ok(Math.hypot(g1.x - g2.x, g1.y - g2.y) * after.scale < 1e-6, `mark ${key} moved off its ground`);
          assert.equal(m.turn, n.turn, "a copy's phase is the same at every zoom");
        }
        // A zoom of a whole octave can swap every mark for the next level's, so only a small one must share some.
        if (Math.abs(Math.log2(after.scale / before.scale)) < 0.3 && a.size > 20) assert.ok(shared > 0, "a small zoom keeps some marks");
      },
    ),
    { numRuns: 300 },
  );
});

test("a pan moves every mark by the pan, exactly", () => {
  const f = createField(SNOW, { width: W, height: H, view: TOP_DOWN, seed: 2 });
  const a = marksOf(f, AT);
  const b = marksOf(f, { ...AT, x: AT.x + 10, y: AT.y - 4 });
  let shared = 0;
  for (const [key, m] of a) {
    const n = b.get(key);
    if (!n) continue;
    shared++;
    assert.ok(Math.abs(n.x - m.x - 10) < 1e-9 && Math.abs(n.y - m.y + 4) < 1e-9, key);
  }
  assert.ok(shared > 50);
});

test("marks per screen stay within 15% of today's at every zoom from 4 to 400, on a phone and a big tablet", () => {
  for (const [look, w, h] of [[HEAVY_RAIN, W, H], [LEAVES, W, H], [HEAVY_RAIN, 2048, 1536]] as const) {
    // Today's count spread over the wrap box, so the screen's share of it.
    const want = (particleCount(look, w, h) * w * h) / ((w + 2 * WRAP_MARGIN) * (h + 2 * WRAP_MARGIN));
    const f = createField(look, { width: w, height: h, view: TOP_DOWN, seed: 9 });
    let lo = Infinity;
    let hi = 0;
    for (let s = MIN_SCALE; s <= MAX_SCALE; s *= 1.03) {
      let sum = 0;
      const tries = 64;
      for (let t = 0; t < tries; t++) eachMark(f, { x: -t * 997.3, y: -t * 431.7, scale: s }, 0, 0, w, h, (_i, _x, _y, alpha) => (sum += alpha));
      const ratio = sum / tries / want;
      lo = Math.min(lo, ratio);
      hi = Math.max(hi, ratio);
    }
    assert.ok(lo > 0.85 && hi < 1.15, `${look.key} at ${w}x${h}: ${lo.toFixed(3)} to ${hi.toFixed(3)} of today's ${want.toFixed(0)}`);
  }
});

test("a step moves a mark its speed times the time on screen, at any zoom", () => {
  for (const scale of [5, 11, 40, 63, 128, 255, 390]) {
    const f = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 4 });
    const cam = { x: -1234, y: -777, scale };
    const a = marksOf(f, cam);
    stepField(f, 20, cam);
    const b = marksOf(f, cam);
    let checked = 0;
    for (const [key, m] of a) {
      const n = b.get(key);
      if (!n) continue;
      const want = f.speed[m.i]! * 0.02 * Math.hypot(f.vx, f.vy);
      assert.ok(Math.abs(Math.hypot(n.x - m.x, n.y - m.y) - want) < 1e-6, `at ${scale}: ${key}`);
      checked++;
    }
    assert.ok(checked > 20, `at ${scale}: ${checked} marks`);
  }
});

test("over 600 ticks and many tile crossings down and across, no copy changes its phase or moves other than its step", () => {
  // Snow falls down a phone, and sand blows straight across a wide window, where a copy that jumped a tile would still be on screen.
  for (const [look, w, h] of [[HEAVY_SNOW, W, H], [lookOf({ kind: "sand", heavy: true, wind: "strong", toward: 90 })!, 1440, 900]] as const) {
    const f = createField(look, { width: w, height: h, view: TOP_DOWN, seed: 3 });
    const cam = { x: -500, y: -300, scale: 40 };
    let a = marksOf(f, cam, w, h);
    const crossings = { x: 0, y: 0 };
    for (let k = 0; k < 600; k++) {
      const wx = f.wx.map((v) => [...v]);
      const wy = f.wy.map((v) => [...v]);
      stepField(f, 33, cam);
      const b = marksOf(f, cam, w, h);
      for (let l = 0; l < f.wx.length; l++) {
        for (let i = 0; i < f.count; i++) {
          if (f.wx[l]![i] !== wx[l]![i]) crossings.x++;
          if (f.wy[l]![i] !== wy[l]![i]) crossings.y++;
        }
      }
      for (const [key, m] of a) {
        const n = b.get(key);
        if (!n) continue;
        const step = f.speed[m.i]! * 0.033 * Math.hypot(f.vx, f.vy);
        assert.ok(Math.abs(Math.hypot(n.x - m.x, n.y - m.y) - step) < 1e-6, `${look.key}: ${key} jumped`);
        assert.equal(n.turn, m.turn, `${look.key}: ${key} changed its phase`);
      }
      a = b;
    }
    assert.ok(Math.max(crossings.x, crossings.y) >= 50, `${look.key}: only ${JSON.stringify(crossings)} crossings`);
  }
});

test("levels: the shares hold the density, each ends at 0, and the camera's whole range draws inside the levels unclamped", () => {
  for (let s = MIN_SCALE; s <= MAX_SCALE; s *= 1.01) {
    const l = levelsAt(s);
    const p = 4 ** l.u;
    // Marks per screen area: the coarse share over its tile's area, the fine share over a quarter of it.
    assert.ok(Math.abs(l.coarseShare / p + (4 * l.fineShare) / p - 1) < 1e-9, `at ${s}`);
    assert.ok(l.coarse >= LEVEL_MIN && l.coarse + 1 <= LEVEL_MAX && l.u >= 0 && l.u < 1, `at ${s}`);
  }
  const octave = levelsAt(64);
  assert.equal(octave.coarse, 6);
  assert.equal(octave.coarseShare, 1);
  assert.equal(octave.fineShare, 0);
  assert.ok(Math.abs(levelsAt(127.999).coarseShare) < 1e-4, "the coarse share ends at 0 where the next level takes over");
  assert.equal(levelsAt(MIN_SCALE).coarse, LEVEL_MIN);
  assert.equal(levelsAt(MAX_SCALE).coarse + 1, LEVEL_MAX);
  assert.ok(Math.log2(MAX_SCALE) - levelsAt(MAX_SCALE).coarse < 1);
});

test("the tile is the wrap box's long side in 256 px steps, 1,024 at least, and it still fits a resize within it", () => {
  assert.equal(tileFor(390, 844), 1024);
  assert.equal(tileFor(844, 390), 1024);
  assert.equal(tileFor(320, 568), 1024);
  assert.equal(tileFor(1440, 900), 1792);
  assert.equal(tileFor(2048, 1536), 2304);
  assert.ok(tileFits(1024, 320, 568) && tileFits(1024, 844, 390) && tileFits(1536, 1280, 800));
  assert.ok(!tileFits(1024, 1440, 900), "a box past the tile");
  assert.ok(!tileFits(2304, 390, 844), "a box under half the tile");
});

test("a resize the tile fits keeps every mark on its ground and makes the same new particles a fresh field would", () => {
  const f = createField(HEAVY_RAIN, { width: 320, height: 568, view: TOP_DOWN, seed: 7 });
  const cam = { x: -900, y: -600, scale: 50 };
  for (let k = 0; k < 10; k++) stepField(f, 33, cam);
  const a = marksOf(f, cam);
  const count = f.count;
  resizeField(f, W, H);
  assert.ok(f.count > count, `${count} to ${f.count}`);
  const b = marksOf(f, cam);
  let shared = 0;
  for (const [key, m] of a) {
    const n = b.get(key);
    if (!n) continue;
    shared++;
    assert.ok(Math.hypot(n.x - m.x, n.y - m.y) < 1e-9, `${key} jumped`);
  }
  assert.ok(shared > 100);
  const fresh = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 7 });
  assert.equal(fresh.tile, f.tile);
  assert.equal(fresh.count, f.count);
  for (let i = count; i < f.count; i++) assert.equal(f.speed[i], fresh.speed[i]);
});

test("a level no share draws holds still, and a stage not yet scaled draws nothing", () => {
  const f = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 1 });
  const cam = { x: -300, y: -200, scale: 40 };
  const { coarse } = levelsAt(40);
  const idle = [...f.x[coarse + 2 - LEVEL_MIN]!];
  for (let k = 0; k < 30; k++) stepField(f, 33, cam);
  assert.deepEqual([...f.x[coarse + 2 - LEVEL_MIN]!], idle);
  let marks = 0;
  eachMark(f, { x: 0, y: 0, scale: 1 }, 0, 0, W, H, () => marks++);
  assert.equal(marks, 0);
});

test("a 10 s step moves as far as the mode's longest one, after a held frame, so a tab back after a minute does not throw the field", () => {
  assert.equal(STEP_CLAMP_MS, HELD_STEP_MS);
  const a = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 5 });
  const b = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 5 });
  stepField(a, 10_000, AT);
  stepField(b, STEP_CLAMP_MS, AT);
  assert.deepEqual(snapshot(a), snapshot(b));
  const c = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 5 });
  stepField(c, 0, AT);
  stepField(c, -40, AT);
  assert.deepEqual(snapshot(c), snapshot(createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 5 })), "no time, no move");
});

test("half draws the first half of each share, and a resize keeps it half", () => {
  const f = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 1 });
  const full = marksOf(f, AT);
  setHalf(f, true);
  assert.equal(f.active, Math.ceil(685 / 2));
  const half = marksOf(f, AT);
  const sum = (m: Map<string, Mark>) => [...m.values()].reduce((s, x) => s + x.alpha, 0);
  assert.ok(Math.abs(sum(half) / sum(full) - 0.5) < 0.1, `${sum(half)} of ${sum(full)}`);
  for (const m of half.values()) assert.ok(m.i < f.active);
  resizeField(f, 844, 390);
  assert.equal(f.active, Math.ceil(f.count / 2));
  const h = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 1, half: true });
  assert.equal(h.active, 343);
  setHalf(h, false);
  assert.equal(h.active, 685);
});

test("calm rain falls 15 degrees off vertical in Top-down and straight down in Isometric", () => {
  const calm = lookOf({ kind: "rain" })!;
  const top = motionOf(calm, TOP_DOWN);
  assert.ok(Math.abs(Math.atan2(top.x, top.y) - (15 * Math.PI) / 180) < 1e-9);
  assert.deepEqual(motionOf(calm, isometric(0)), { x: 0, y: 1 });
});

test("the wind leads the motion along the map in Top-down, and Isometric turns and halves it", () => {
  const towardTop = lookOf({ kind: "rain", wind: "strong", toward: 0 })!;
  assert.ok(motionOf(towardTop, TOP_DOWN).y < -1, "a strong wind toward the top carries rain up the screen");
  for (const turn of [0, 1, 2, 3] as const) {
    const m = motionOf(towardTop, isometric(turn));
    assert.ok(m.y > 0, `rain always falls in Isometric, turn ${turn}`);
  }
  const sand = lookOf({ kind: "sand", wind: "moderate", toward: 90 })!;
  const m = motionOf(sand, TOP_DOWN);
  assert.ok(Math.abs(m.x - 1) < 1e-9 && Math.abs(m.y) < 1e-9, "sand blows along the wind, toward the right");
  // At turn 0 the map's right edge faces down and to the right, halved in height.
  const iso = motionOf(sand, isometric(0));
  assert.ok(Math.abs(iso.x - Math.SQRT1_2) < 1e-9 && Math.abs(iso.y - Math.SQRT1_2 / 2) < 1e-9);
});

test("a view change turns the motion and keeps the particles, and Isometric has no rings", () => {
  const f = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 1 });
  for (let k = 0; k < 200; k++) stepField(f, 33, AT);
  assert.ok(f.rings.some((v, i) => i % 3 === 2 && v >= 0), "heavy rain rings in Top-down");
  const before = particles(f);
  setFieldView(f, isometric(1));
  assert.deepEqual(particles(f), before);
  assert.deepEqual([f.vx, f.vy], [motionOf(HEAVY_RAIN, isometric(1)).x, motionOf(HEAVY_RAIN, isometric(1)).y]);
  assert.ok(f.rings.every((v, i) => i % 3 !== 2 || v < 0));
  for (let k = 0; k < 200; k++) {
    stepField(f, 33, AT);
    assert.ok(f.rings.every((v, i) => i % 3 !== 2 || v < 0), "no rings while in Isometric");
  }
});

test("heavy rain's rings land at about the rate the screen's marks fall through it, on the ground in view", () => {
  const f = createField(HEAVY_RAIN, { width: W, height: H, view: TOP_DOWN, seed: 1 });
  const cam = { x: -300, y: -200, scale: 40 };
  const rings = new Set<string>();
  for (let k = 0; k < 300; k++) {
    stepField(f, 33, cam);
    for (let r = 0; r < f.rings.length; r += 3) {
      if (f.rings[r + 2]! !== 0) continue;
      rings.add(`${k} ${r}`);
      const x = cam.x + f.rings[r]! * cam.scale;
      const y = cam.y + f.rings[r + 1]! * cam.scale;
      assert.ok(x >= 0 && x <= W && y >= 0 && y <= H, "a ring lands on screen");
    }
  }
  // Today's 329 marks at 900 px a second on average, crossing the 972 px wrap box down the screen, one landing in 200 rings.
  const want = (329 * 900 * Math.abs(f.vy)) / (H + 2 * WRAP_MARGIN) / HEAVY_RAIN.particles!.splashEvery;
  const perSecond = rings.size / 9.9;
  assert.ok(Math.abs(perSecond / want - 1) < 0.25, `${perSecond.toFixed(2)} rings a second, against ${want.toFixed(2)}`);
});

test("fog's sheets drift along the wind at their screen speed, in view units", () => {
  const f = createField(lookOf({ kind: "fog", wind: "moderate", toward: 90 })!, { width: W, height: H, view: TOP_DOWN, seed: 1 });
  const x0 = f.sheets[0]!;
  const x1 = f.sheets[2]!;
  for (let k = 0; k < 30; k++) stepField(f, 33.3333333, { x: 0, y: 0, scale: 50 });
  assert.ok(Math.abs((f.sheets[0]! - x0) * 50 - 3) < 1e-6 && Math.abs((f.sheets[2]! - x1) * 50 - 8) < 1e-6);
});

test("the same weather blowing another way keeps every particle and moves them, and fog's sheets, along the new direction", () => {
  for (const view of [TOP_DOWN, isometric(1)]) {
    for (const w of [{ kind: "snow", wind: "strong" }, { kind: "fog", wind: "moderate" }] as const) {
      const east = lookOf({ ...w, toward: 90 })!;
      const west = lookOf({ ...w, toward: 270 })!;
      const field = createField(east, { width: W, height: H, view, seed: 4 });
      stepField(field, 40, AT);
      const before = snapshot(field);
      setFieldLook(field, west);
      assert.deepEqual(snapshot(field), before, "the particles stay where they are");
      assert.deepEqual({ x: field.vx, y: field.vy }, motionOf(west, view), "and move along the new wind");
      const sheet = field.sheets[0];
      stepField(field, 40, AT);
      if (sheet !== undefined && view === TOP_DOWN) assert.ok(field.sheets[0]! < sheet, `${w.kind}: the sheets drift west now`);
    }
  }
  const rain = createField(lookOf({ kind: "rain", wind: "strong" })!, { width: 100, height: 100, view: TOP_DOWN });
  assert.throws(() => setFieldLook(rain, lookOf({ kind: "rain", heavy: true, wind: "strong" })!), /cannot draw/, "a new strength makes particles of its own");
});
