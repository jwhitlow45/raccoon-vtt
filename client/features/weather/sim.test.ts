import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { isometric, TOP_DOWN } from "../../lib/view.ts";
import { lookOf, type Look } from "./looks.ts";
import { createField, motionOf, particleCount, resizeField, setFieldView, setHalf, spotOf, stepField, STEP_CLAMP_MS, WRAP_MARGIN, type Field } from "./sim.ts";

const HEAVY_RAIN = lookOf({ kind: "rain", heavy: true, wind: "strong" })!;
const SNOW = lookOf({ kind: "snow" })!;

function snapshot(f: Field): number[] {
  return [...f.x.subarray(0, f.count), ...f.y.subarray(0, f.count), f.t, ...f.sheets];
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
});

test("the same seed gives the same field, another seed another", () => {
  const a = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 7 });
  const b = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 7 });
  const c = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 8 });
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.notDeepEqual(snapshot(a), snapshot(c));
  for (let k = 0; k < 20; k++) {
    stepField(a, 33);
    stepField(b, 33);
  }
  assert.deepEqual(snapshot(a), snapshot(b));
});

test("after any pan and any steps, every mark shows inside the wrap box", () => {
  fc.assert(
    fc.property(
      fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      fc.array(fc.double({ min: 0, max: 5000, noNaN: true }), { maxLength: 30 }),
      fc.integer({ min: 0, max: 4 }),
      (px, py, steps, v) => {
        const view = v === 4 ? TOP_DOWN : isometric(v as 0 | 1 | 2 | 3);
        const f = createField(HEAVY_RAIN, { width: 390, height: 844, view, seed: 3 });
        for (const ms of steps) stepField(f, ms);
        for (let i = 0; i < f.active; i++) {
          const s = spotOf(f, i, { x: px, y: py });
          assert.ok(s.x >= -WRAP_MARGIN && s.x < 390 + WRAP_MARGIN, `x ${s.x}`);
          assert.ok(s.y >= -WRAP_MARGIN && s.y < 844 + WRAP_MARGIN, `y ${s.y}`);
          assert.ok(f.x[i]! >= 0 && f.x[i]! < f.boxW && f.y[i]! >= 0 && f.y[i]! < f.boxH, "drift stays in the box");
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("a pan carries the weather with the ground: every mark moves by the pan, wrapped", () => {
  const f = createField(SNOW, { width: 390, height: 844, view: TOP_DOWN, seed: 2 });
  for (let i = 0; i < f.active; i++) {
    const before = spotOf(f, i, { x: 0, y: 0 });
    const after = spotOf(f, i, { x: 10, y: -4 });
    const dx = (after.x - before.x + f.boxW) % f.boxW;
    const dy = (after.y - before.y + f.boxH) % f.boxH;
    assert.ok(Math.abs(dx - 10) < 1e-9 && Math.abs(dy - (f.boxH - 4)) < 1e-9);
  }
});

test("a 10 s step moves as far as a 50 ms one, so a tab back after a minute does not throw the field", () => {
  const a = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 5 });
  const b = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 5 });
  stepField(a, 10_000);
  stepField(b, STEP_CLAMP_MS);
  assert.deepEqual(snapshot(a), snapshot(b));
  const c = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 5 });
  stepField(c, 0);
  stepField(c, -40);
  assert.deepEqual(snapshot(c), snapshot(createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 5 })), "no time, no move");
});

test("a step moves each mark by its speed along the motion", () => {
  const f = createField(SNOW, { width: 390, height: 844, view: TOP_DOWN, seed: 9 });
  const pan = { x: 0, y: 0 };
  const before = Array.from({ length: f.active }, (_, i) => spotOf(f, i, pan));
  stepField(f, 40);
  for (let i = 0; i < f.active; i++) {
    const after = spotOf(f, i, pan);
    const dx = ((after.x - before[i]!.x + f.boxW * 1.5) % f.boxW) - f.boxW / 2;
    const dy = ((after.y - before[i]!.y + f.boxH * 1.5) % f.boxH) - f.boxH / 2;
    assert.ok(Math.abs(dx - f.vx * f.speed[i]! * 0.04) < 1e-6 && Math.abs(dy - f.vy * f.speed[i]! * 0.04) < 1e-6);
  }
  assert.equal(f.t, 40);
});

test("a resize recounts by area and keeps the first marks where they show", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 200, max: 2400 }),
      fc.integer({ min: 200, max: 1600 }),
      fc.double({ min: -5000, max: 5000, noNaN: true }),
      fc.double({ min: -5000, max: 5000, noNaN: true }),
      (w, h, px, py) => {
        const f = createField(HEAVY_RAIN, { width: 844, height: 390, view: TOP_DOWN, seed: 4 });
        stepField(f, 30);
        const pan = { x: px, y: py };
        const before = Array.from({ length: f.count }, (_, i) => spotOf(f, i, pan));
        resizeField(f, w, h, pan);
        assert.equal(f.count, particleCount(HEAVY_RAIN, w, h));
        for (let i = 0; i < Math.min(before.length, f.count); i++) {
          const s = before[i]!;
          // A mark inside the new box stays exactly where it showed.
          if (s.x < w + WRAP_MARGIN && s.y < h + WRAP_MARGIN) {
            const after = spotOf(f, i, pan);
            assert.ok(Math.abs(after.x - s.x) < 1e-6 && Math.abs(after.y - s.y) < 1e-6, `mark ${i} jumped`);
          }
        }
      },
    ),
    { numRuns: 150 },
  );
});

test("a resize that grows makes the same new marks a fresh field would", () => {
  const f = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 6 });
  resizeField(f, 844, 390, { x: 0, y: 0 });
  resizeField(f, 1440, 900, { x: 0, y: 0 });
  const fresh = createField(HEAVY_RAIN, { width: 1440, height: 900, view: TOP_DOWN, seed: 6 });
  assert.equal(f.count, fresh.count);
  for (let i = 329; i < f.count; i++) assert.equal(f.speed[i], fresh.speed[i]);
});

test("half keeps the first half, and a resize keeps it half", () => {
  const f = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 1 });
  setHalf(f, true);
  assert.equal(f.active, Math.ceil(329 / 2));
  resizeField(f, 1440, 900, { x: 0, y: 0 });
  assert.equal(f.active, 300);
  const h = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 1, half: true });
  assert.equal(h.active, 165);
  setHalf(h, false);
  assert.equal(h.active, 329);
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

test("a view change turns the motion and keeps the marks, and Isometric has no rings", () => {
  const f = createField(HEAVY_RAIN, { width: 390, height: 844, view: TOP_DOWN, seed: 1 });
  for (let k = 0; k < 200; k++) stepField(f, 33);
  assert.ok(f.rings.some((v, i) => i % 3 === 2 && v >= 0), "heavy rain rings in Top-down");
  const xs = [...f.x];
  setFieldView(f, isometric(1));
  assert.deepEqual([...f.x], xs);
  assert.deepEqual([f.vx, f.vy], [motionOf(HEAVY_RAIN, isometric(1)).x, motionOf(HEAVY_RAIN, isometric(1)).y]);
  assert.ok(f.rings.every((v, i) => i % 3 !== 2 || v < 0));
  for (let k = 0; k < 200; k++) {
    stepField(f, 33);
    assert.ok(f.rings.every((v, i) => i % 3 !== 2 || v < 0), "no rings while in Isometric");
  }
});

test("fog's sheets drift along the wind, slowly", () => {
  const f = createField(lookOf({ kind: "fog", wind: "moderate", toward: 90 })!, { width: 390, height: 844, view: TOP_DOWN, seed: 1 });
  const x0 = f.sheets[0]!;
  const x1 = f.sheets[2]!;
  for (let k = 0; k < 30; k++) stepField(f, 33.3333333);
  assert.ok(Math.abs(f.sheets[0]! - x0 - 3) < 1e-6 && Math.abs(f.sheets[2]! - x1 - 8) < 1e-6);
});
