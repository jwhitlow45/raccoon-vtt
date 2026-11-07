import assert from "node:assert/strict";
import { test } from "node:test";
import { sceneMinScale, screenToView, zoomAt, type Camera } from "../../lib/camera.ts";
import { isometric, toView, TOP_DOWN, type View } from "../../lib/view.ts";
import { drawWeather, insidePolygon, sceneClip, SHEET_SCALE_AT, tierOf, type DrawProbe } from "./draw.ts";
import { lookOf, type WeatherLook } from "./looks.ts";
import { createField, particleCount, stepField, WRAP_MARGIN, type Field } from "./sim.ts";
import { NOISE_SIZE, type TextureSource } from "./textures.ts";

/*
 * A canvas that writes down what it is told, with the alpha and whether a
 * clip held at the time, so a test can read the batches, nothing outside
 * the clip, two equal draws and where each mark and texel lands.
 */

type Call = { name: string; args: number[]; clipped: boolean; style?: unknown; alpha: number };

function recorder(): { g: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let clips = 0;
  let fillStyle: unknown = "";
  let strokeStyle: unknown = "";
  const clipStack: number[] = [];
  const g = {
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    set fillStyle(v: unknown) { fillStyle = v; },
    get fillStyle() { return fillStyle; },
    set strokeStyle(v: unknown) { strokeStyle = v; },
    get strokeStyle() { return strokeStyle; },
    save() { clipStack.push(clips); record("save", []); },
    restore() { clips = clipStack.pop() ?? 0; record("restore", []); },
    setTransform(...a: number[]) { record("setTransform", a); },
    beginPath() { record("beginPath", []); },
    closePath() {},
    moveTo(x: number, y: number) { record("moveTo", [x, y]); },
    lineTo(x: number, y: number) { record("lineTo", [x, y]); },
    arc(...a: number[]) { record("arc", a); },
    rect(...a: number[]) { record("rect", a); },
    clip() { clips++; record("clip", []); },
    fill() { record("fill", [], fillStyle); },
    stroke() { record("stroke", [], strokeStyle); },
    fillRect(...a: number[]) { record("fillRect", a, fillStyle); },
    drawImage(_img: unknown, ...a: number[]) { record("drawImage", a); },
    createPattern(img: unknown) { return { pattern: img }; },
  };
  function record(name: string, args: number[], style?: unknown) {
    calls.push({ name, args, clipped: clips > 0, style, alpha: g.globalAlpha });
  }
  return { g: g as unknown as CanvasRenderingContext2D, calls };
}

const textures: TextureSource = {
  noise: (color) => ({ noise: color }) as unknown as CanvasImageSource,
  leaves: () => ({ atlas: true }) as unknown as CanvasImageSource,
};

const camera = { x: 120, y: -40, scale: SHEET_SCALE_AT };
const W = 390;
const H = 844;

function field(w: WeatherLook, view: View = TOP_DOWN, seed = 11): Field {
  const f = createField(lookOf(w)!, { width: W, height: H, view, seed });
  for (let k = 0; k < 40; k++) stepField(f, 33, camera);
  return f;
}

const paints = (calls: Call[]) => calls.filter((c) => c.name === "fill" || c.name === "stroke" || c.name === "fillRect" || c.name === "drawImage");

/** Everything a draw could write in a field. */
function written(f: Field): string {
  return JSON.stringify([f.x.map((a) => [...a]), f.y.map((a) => [...a]), f.wx.map((a) => [...a]), f.wy.map((a) => [...a]), f.t, [...f.sheets], [...f.rings], f.landed, f.count, f.active]);
}

test("a fade is drawn in thirds, rounded, so the thirds average it", () => {
  assert.deepEqual([0, 0.16, 0.17, 0.4, 0.5, 0.84, 1].map(tierOf), [0, 0, 1, 1, 2, 3, 3]);
});

test("moving rain, sand and a clear day's wind are one stroked path a color, and held still they fade in thirds", () => {
  for (const w of [{ kind: "rain", wind: "moderate" }, { kind: "sand", wind: "strong" }, { kind: "clear", wind: "strong" }] as const) {
    const f = field(w);
    const moving = recorder();
    drawWeather(moving.g, f, { camera, clip: null }, textures);
    const strokes = moving.calls.filter((c) => c.name === "stroke");
    assert.equal(strokes.length, 1, w.kind);
    assert.ok(moving.calls.filter((c) => c.name === "moveTo").length > 20, `${w.kind} drew its marks`);
    // Mid-octave both levels draw, so a fade band shows.
    const mid = { ...camera, scale: SHEET_SCALE_AT * Math.SQRT2 };
    const held = recorder();
    drawWeather(held.g, f, { camera: mid, clip: null, held: true }, textures);
    const thirds = held.calls.filter((c) => c.name === "stroke");
    assert.ok(thirds.length >= 2 && thirds.length <= 3, `${w.kind} held: ${thirds.length} strokes`);
    assert.equal(new Set(thirds.map((c) => c.alpha)).size, thirds.length, "one stroke a third");
  }
});

test("snow is at most three filled paths of arcs, one a third, and ash at most three a shade, from one counting pass", () => {
  const mid = { ...camera, scale: SHEET_SCALE_AT * Math.SQRT2 };
  const snow = recorder();
  drawWeather(snow.g, field({ kind: "snow" }), { camera: mid, clip: null }, textures);
  const fills = paints(snow.calls);
  assert.ok(fills.length >= 2 && fills.length <= 3 && fills.every((c) => c.name === "fill"));
  assert.ok(snow.calls.filter((c) => c.name === "arc").length > 20);
  const ash = recorder();
  drawWeather(ash.g, field({ kind: "ash" }), { camera: mid, clip: null }, textures);
  const styles = paints(ash.calls).filter((c) => c.name === "fill").map((c) => c.style);
  // Each shade's batches together, in the shades' order.
  const shades = styles.filter((s, i) => i === 0 || styles[i - 1] !== s);
  assert.deepEqual(shades, ["#8a8a8a", "#a9a9a9", "#c9c9c9"]);
  for (const s of shades) assert.ok(styles.filter((x) => x === s).length <= 3);
});

test("each leaf is one drawImage from the atlas, faded exactly", () => {
  const f = field({ kind: "leaves", heavy: true });
  const { g, calls } = recorder();
  drawWeather(g, f, { camera: { ...camera, scale: SHEET_SCALE_AT * Math.SQRT2 }, clip: null }, textures);
  const images = calls.filter((c) => c.name === "drawImage");
  assert.ok(images.length > 0);
  for (const c of images) assert.ok(c.args[0]! % 24 === 0 && c.args[0]! < 144 && c.args[2] === 24);
  assert.equal(paints(calls).length, images.length);
  assert.ok(images.some((c) => c.alpha < 0.95 * 0.9 && c.alpha > 0), "the fade band draws leaves part way");
});

test("fog is a fill a sheet at an octave's start and two a sheet within it, heavy rain adds one veil fill", () => {
  const at = (scale: number) => {
    const fog = recorder();
    drawWeather(fog.g, field({ kind: "fog", heavy: true }), { camera: { ...camera, scale }, clip: null }, textures);
    const fills = paints(fog.calls);
    assert.ok(fills.every((c) => c.name === "fillRect" && typeof c.style === "object"));
    return fills.length;
  };
  assert.equal(at(SHEET_SCALE_AT), 2);
  assert.equal(at(SHEET_SCALE_AT * 2), 2);
  assert.equal(at(SHEET_SCALE_AT * Math.SQRT2), 4);
  assert.equal(at(SHEET_SCALE_AT * 1.001), 2, "an octave under 2% alpha is skipped");
  const rain = recorder();
  drawWeather(rain.g, field({ kind: "rain", heavy: true }), { camera, clip: null }, textures);
  const veil = paints(rain.calls).filter((c) => c.name === "fillRect");
  assert.equal(veil.length, 1);
  assert.equal(veil[0]!.style, "#1b2a3a");
});

test("a sheet's pattern keeps each texel on its ground point through a zoom, at 60 and at 150 px a square, past the old clamp", () => {
  const f = field({ kind: "fog", heavy: true, wind: "moderate" });
  for (const before of [{ x: -800, y: -600, scale: 60 }, { x: -800, y: -600, scale: 150 }]) {
    const after = zoomAt(before, { x: 200, y: 500 }, 1.2);
    const fills = (cam: Camera) => {
      const { g, calls } = recorder();
      drawWeather(g, f, { camera: cam, clip: null }, textures);
      // Each fill's transform: the setTransform just before it.
      return calls.flatMap((c, k) => (c.name === "fillRect" && typeof c.style === "object" ? [calls.slice(0, k).findLast((t) => t.name === "setTransform")!.args] : []));
    };
    const a = fills(before);
    const b = fills(after);
    assert.equal(a.length, b.length);
    for (let k = 0; k < a.length; k++) {
      const ground = (cam: Camera, t: number[]) => ({ at: (t[4]! - cam.x) / cam.scale, period: (NOISE_SIZE * t[0]!) / cam.scale });
      const g1 = ground(before, a[k]!);
      const g2 = ground(after, b[k]!);
      assert.ok(Math.abs(g1.period - g2.period) < 1e-9, `at ${before.scale}: a texel is the same size on the ground`);
      const d = (((g1.at - g2.at) % g1.period) + g1.period) % g1.period;
      assert.ok(Math.min(d, g1.period - d) * after.scale < 1e-6, `texel 0 moved ${d} on the ground at ${before.scale}`);
    }
  }
});

test("through a zoom, a drawn center is within sway times |f - 1| of its ground point", () => {
  for (const w of [{ kind: "snow", heavy: true, wind: "moderate" }, { kind: "leaves", heavy: true, wind: "moderate" }, { kind: "ash", heavy: true, wind: "strong" }] as const) {
    const look = lookOf(w)!;
    const f = createField(look, { width: W, height: H, view: TOP_DOWN, seed: 8 });
    const before = { x: -700, y: -500, scale: 41 };
    for (let k = 0; k < 20; k++) stepField(f, 33, before);
    let worst = 0;
    let checked = 0;
    for (const factor of [1.11, 1.25, 1 / 1.25, 1.35, 2.5]) {
      const after = zoomAt(before, { x: 200, y: 400 }, factor);
      const pa: DrawProbe = { spots: {}, limit: 10_000, marks: 0 };
      const pb: DrawProbe = { spots: {}, limit: 10_000, marks: 0 };
      drawWeather(recorder().g, f, { camera: before, clip: null, probe: pa }, textures);
      drawWeather(recorder().g, f, { camera: after, clip: null, probe: pb }, textures);
      const bound = look.particles!.sway * Math.abs(factor - 1);
      for (const [key, s] of Object.entries(pa.spots)) {
        const t = pb.spots[key];
        if (!t) continue;
        const ground = screenToView(before, { x: s[2], y: s[3] });
        const err = Math.hypot(ground.x * after.scale + after.x - t[2], ground.y * after.scale + after.y - t[3]);
        assert.ok(err <= bound + 1e-6, `${look.key} at ${factor}: ${err} over ${bound}`);
        worst = Math.max(worst, err / bound);
        checked++;
      }
    }
    assert.ok(checked > 50, `${look.key}: ${checked} marks`);
    assert.ok(worst > 0.9, `${look.key}: the bound is tight, the worst used ${(worst * 100).toFixed(0)}%`);
  }
});

test("a ring draws where it fell on the ground at any camera", () => {
  const f = field({ kind: "rain", heavy: true, wind: "strong" });
  f.rings.fill(-1);
  f.rings.set([3.5, 7.25, 100]);
  for (const cam of [camera, { x: -40, y: 10, scale: 75 }]) {
    const { g, calls } = recorder();
    drawWeather(g, f, { camera: cam, clip: null }, textures);
    const arcs = calls.filter((c) => c.name === "arc");
    assert.equal(arcs.length, 1);
    assert.ok(Math.abs(arcs[0]!.args[0]! - (cam.x + 3.5 * cam.scale)) < 1e-9 && Math.abs(arcs[0]!.args[1]! - (cam.y + 7.25 * cam.scale)) < 1e-9);
    assert.equal(arcs[0]!.args[2], 3, "2 px plus a quarter of its growth");
  }
});

test("missing textures skip what needs them", () => {
  const none: TextureSource = { noise: () => null, leaves: () => null };
  const fog = recorder();
  drawWeather(fog.g, field({ kind: "fog" }), { camera, clip: null }, none);
  assert.equal(paints(fog.calls).length, 0);
  const leaves = recorder();
  drawWeather(leaves.g, field({ kind: "leaves" }), { camera, clip: null }, null);
  assert.equal(paints(leaves.calls).length, 0);
});

test("every paint is inside the clip, from an identity transform, and the context comes back as it was", () => {
  for (const w of [{ kind: "rain", heavy: true }, { kind: "snow", heavy: true }, { kind: "fog" }, { kind: "leaves" }, { kind: "ash", heavy: true }, { kind: "sand", heavy: true, wind: "strong" }, { kind: "clear", wind: "moderate" }] as const) {
    for (const held of [false, true]) {
      const { g, calls } = recorder();
      drawWeather(g, field(w), { camera, clip: [40, 60, 300, 60, 300, 500, 40, 500], held }, textures);
      assert.equal(calls[0]!.name, "save");
      assert.deepEqual(calls[1], { name: "setTransform", args: [1, 0, 0, 1, 0, 0], clipped: false, style: undefined, alpha: 1 });
      assert.equal(calls.at(-1)!.name, "restore");
      for (const c of paints(calls)) assert.ok(c.clipped, `${w.kind} ${c.name} outside the clip`);
    }
  }
});

test("marks far outside the scene on screen are skipped, not drawn into the clip", () => {
  const f = field({ kind: "snow", heavy: true });
  const all = recorder();
  drawWeather(all.g, f, { camera, clip: null }, textures);
  const small = recorder();
  drawWeather(small.g, f, { camera, clip: [100, 100, 200, 100, 200, 200, 100, 200] }, textures);
  const arcs = (calls: Call[]) => calls.filter((c) => c.name === "arc");
  assert.ok(arcs(small.calls).length < arcs(all.calls).length / 3);
  for (const c of arcs(small.calls)) assert.ok(c.args[0]! > 100 - 64 - 9 && c.args[0]! < 200 + 64 + 9 && c.args[1]! > 100 - 64 - 9 && c.args[1]! < 200 + 64 + 9);
  const off = recorder();
  drawWeather(off.g, f, { camera, clip: [-500, -500, -400, -500, -400, -400] }, textures);
  assert.equal(off.calls.length, 0, "a scene off the screen draws nothing");
});

test("two draws of the same field and camera are the same, and a draw, probe and all, writes no level, wrap, ring or sheet", () => {
  for (const w of [{ kind: "rain", heavy: true, wind: "strong" }, { kind: "snow" }, { kind: "fog", heavy: true }, { kind: "leaves", wind: "strong" }, { kind: "ash" }, { kind: "sand", heavy: true, wind: "strong" }] as const) {
    for (const view of [TOP_DOWN, isometric(2)]) {
      const f = field(w, view);
      const before = written(f);
      for (const held of [false, true]) {
        const a = recorder();
        const b = recorder();
        drawWeather(a.g, f, { camera, clip: sceneClip(view, { w: 30, h: 20 }, camera), held, probe: { spots: {}, limit: 64, marks: 0 } }, textures);
        drawWeather(b.g, f, { camera, clip: sceneClip(view, { w: 30, h: 20 }, camera), held }, textures);
        assert.deepEqual(a.calls, b.calls, w.kind);
      }
      for (let k = 0; k < 20; k++) drawWeather(recorder().g, f, { camera: { x: -k * 37, y: k * 11, scale: 4 + k * 19 }, clip: null, held: k % 2 === 0, probe: { spots: {}, limit: 64, marks: 0 } }, textures);
      assert.equal(written(f), before);
    }
  }
});

test("a pan moves every mark by the pan", () => {
  const f = field({ kind: "rain" });
  const a = recorder();
  const b = recorder();
  drawWeather(a.g, f, { camera: { x: 0, y: 0, scale: 50 }, clip: null }, textures);
  drawWeather(b.g, f, { camera: { x: 3, y: 2, scale: 50 }, clip: null }, textures);
  const moved = b.calls.filter((c) => c.name === "moveTo");
  const at = new Set(a.calls.filter((c) => c.name === "moveTo").map((c) => `${(c.args[0]! + 3).toFixed(6)},${(c.args[1]! + 2).toFixed(6)}`));
  const same = moved.filter((c) => at.has(`${c.args[0]!.toFixed(6)},${c.args[1]!.toFixed(6)}`));
  assert.ok(same.length >= moved.length - 4, "all but the few that crossed the drawn box's edge");
});

test("the scene's outline on screen: a rectangle in Top-down, a diamond in Isometric", () => {
  assert.deepEqual([...sceneClip(TOP_DOWN, { w: 10, h: 5 }, { x: 7, y: 3, scale: 2 })], [7, 3, 27, 3, 27, 13, 7, 13]);
  const d = sceneClip(isometric(0), { w: 10, h: 10 }, { x: 0, y: 0, scale: 1 });
  const r = Math.SQRT1_2;
  const expect = [0, 0, 10 * r, 5 * r, 0, 10 * r, -10 * r, 5 * r];
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(d[k]! - expect[k]!) < 1e-9);
  assert.ok(insidePolygon(d, 0, 5) && !insidePolygon(d, -6.5, 1) && !insidePolygon(d, 6.5, 1));
});

/** The area of a polygon clipped to the screen, by Sutherland and Hodgman's clip and the shoelace. */
function areaOnScreen(poly: ArrayLike<number>, w: number, h: number): number {
  let pts: [number, number][] = [];
  for (let k = 0; k + 1 < poly.length; k += 2) pts.push([poly[k]!, poly[k + 1]!]);
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= w, (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= h, (a, b) => [a[0] + ((b[0] - a[0]) * (h - a[1])) / (b[1] - a[1]), h]],
  ];
  for (const [inside, cut] of edges) {
    const next: [number, number][] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      if (inside(a)) next.push(a);
      if (inside(a) !== inside(b)) next.push(cut(a, b));
    }
    pts = next;
  }
  let area = 0;
  for (let k = 0; k < pts.length; k++) area += pts[k]![0] * pts[(k + 1) % pts.length]![1] - pts[(k + 1) % pts.length]![0] * pts[k]![1];
  return Math.abs(area) / 2;
}

test("the probe counts what is drawn and seen: marks inside the scene's outline on screen, as dense as the screen's count, zoomed out to the floor and in, in both views", () => {
  const bounds = { w: 40, h: 40 };
  const floor = sceneMinScale({ width: W, height: H }, bounds);
  for (const view of [TOP_DOWN, isometric(1)]) {
    for (const [w, scale] of [[{ kind: "rain", heavy: true, wind: "strong" }, floor], [{ kind: "rain", heavy: true, wind: "strong" }, 40], [{ kind: "snow", heavy: true }, floor], [{ kind: "snow", heavy: true }, 90]] as const) {
      const look = lookOf(w)!;
      // The map's middle at the screen's middle.
      const middle = toView(view, { x: 20, y: 20 });
      const cam = { x: W / 2 - middle.x * scale, y: H / 2 - middle.y * scale, scale };
      const clip = sceneClip(view, bounds, cam);
      const want = (particleCount(look, W, H) * areaOnScreen(clip, W, H)) / ((W + 2 * WRAP_MARGIN) * (H + 2 * WRAP_MARGIN));
      let sum = 0;
      const seeds = 64;
      for (let seed = 1; seed <= seeds; seed++) {
        const f = createField(look, { width: W, height: H, view, seed });
        const probe: DrawProbe = { spots: {}, limit: 10_000, marks: 0 };
        drawWeather(recorder().g, f, { camera: cam, clip }, textures);
        drawWeather(recorder().g, f, { camera: cam, clip, probe }, textures);
        for (const s of Object.values(probe.spots)) assert.ok(insidePolygon(clip, s[0], s[1]) && s[0] >= 0 && s[0] <= W && s[1] >= 0 && s[1] <= H, "only marks seen");
        // At the floor one draw counts 7 to 25 marks on average, which spread as a count of independent marks does, by about the root of the count (measured over 200 fields): so within four of those.
        assert.ok(Math.abs(probe.marks - want) <= 4 * Math.sqrt(want) + 1, `${look.key} ${view.kind} at ${scale.toFixed(2)}, seed ${seed}: ${probe.marks.toFixed(1)} against ${want.toFixed(1)}`);
        sum += probe.marks;
      }
      // Over 64 fields the mean is close.
      assert.ok(Math.abs(sum / seeds / want - 1) < 0.1, `${look.key} ${view.kind} at ${scale.toFixed(2)}: a mean of ${(sum / seeds).toFixed(1)} against ${want.toFixed(1)}`);
    }
  }
});
