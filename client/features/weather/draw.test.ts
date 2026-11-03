import assert from "node:assert/strict";
import { test } from "node:test";
import { isometric, TOP_DOWN } from "../../lib/view.ts";
import { drawWeather, sceneClip, SHEET_SCALE_AT } from "./draw.ts";
import { lookOf, type WeatherLook } from "./looks.ts";
import { createField, stepField, type Field } from "./sim.ts";
import type { TextureSource } from "./textures.ts";

/*
 * A canvas that writes down what it is told, and
 * whether a clip held at the time, so a test can read one path a
 * color, nothing outside the clip and two equal draws.
 */

type Call = { name: string; args: number[]; clipped: boolean; style?: unknown };

function recorder(): { g: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let clips = 0;
  let fillStyle: unknown = "";
  let strokeStyle: unknown = "";
  const clipStack: number[] = [];
  const record = (name: string, args: number[], style?: unknown) => calls.push({ name, args, clipped: clips > 0, style });
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
  return { g: g as unknown as CanvasRenderingContext2D, calls };
}

const textures: TextureSource = {
  noise: (color) => ({ noise: color }) as unknown as CanvasImageSource,
  leaves: () => ({ atlas: true }) as unknown as CanvasImageSource,
};

const camera = { x: 120, y: -40, scale: SHEET_SCALE_AT };

function field(w: WeatherLook, view = TOP_DOWN): Field {
  const f = createField(lookOf(w)!, { width: 390, height: 844, view, seed: 11 });
  for (let k = 0; k < 40; k++) stepField(f, 33);
  return f;
}

const paints = (calls: Call[]) => calls.filter((c) => c.name === "fill" || c.name === "stroke" || c.name === "fillRect" || c.name === "drawImage");

test("rain, sand and a clear day's wind are one stroked path a tick", () => {
  for (const w of [{ kind: "rain", wind: "moderate" }, { kind: "sand", wind: "strong" }, { kind: "clear", wind: "strong" }] as const) {
    const { g, calls } = recorder();
    drawWeather(g, field(w), { camera, clip: null }, textures);
    const strokes = calls.filter((c) => c.name === "stroke");
    assert.equal(strokes.length, 1, w.kind);
    assert.ok(calls.filter((c) => c.name === "moveTo").length > 20, `${w.kind} drew its marks`);
  }
});

test("snow is one filled path of arcs, ash one path a shade", () => {
  const snow = recorder();
  drawWeather(snow.g, field({ kind: "snow" }), { camera, clip: null }, textures);
  assert.deepEqual(paints(snow.calls).map((c) => c.name), ["fill"]);
  assert.ok(snow.calls.filter((c) => c.name === "arc").length > 20);
  const ash = recorder();
  drawWeather(ash.g, field({ kind: "ash" }), { camera, clip: null }, textures);
  const fills = paints(ash.calls).filter((c) => c.name === "fill");
  assert.deepEqual(fills.map((c) => c.style), ["#8a8a8a", "#a9a9a9", "#c9c9c9"]);
});

test("each leaf is one drawImage from the atlas", () => {
  const f = field({ kind: "leaves", heavy: true });
  const { g, calls } = recorder();
  drawWeather(g, f, { camera, clip: null }, textures);
  const images = calls.filter((c) => c.name === "drawImage");
  assert.ok(images.length > 0 && images.length <= f.active);
  for (const c of images) assert.ok(c.args[0]! % 24 === 0 && c.args[0]! < 144 && c.args[2] === 24);
  assert.equal(paints(calls).length, images.length);
});

test("fog is two pattern fills and nothing else, heavy rain adds one veil fill", () => {
  const fog = recorder();
  drawWeather(fog.g, field({ kind: "fog", heavy: true }), { camera, clip: null }, textures);
  const fills = paints(fog.calls);
  assert.equal(fills.length, 2);
  assert.ok(fills.every((c) => c.name === "fillRect" && typeof c.style === "object"));
  const rain = recorder();
  drawWeather(rain.g, field({ kind: "rain", heavy: true }), { camera, clip: null }, textures);
  const veil = paints(rain.calls).filter((c) => c.name === "fillRect");
  assert.equal(veil.length, 1);
  assert.equal(veil[0]!.style, "#1b2a3a");
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
    const { g, calls } = recorder();
    drawWeather(g, field(w), { camera, clip: [40, 60, 300, 60, 300, 500, 40, 500] }, textures);
    assert.equal(calls[0]!.name, "save");
    assert.deepEqual(calls[1], { name: "setTransform", args: [1, 0, 0, 1, 0, 0], clipped: false, style: undefined });
    assert.equal(calls.at(-1)!.name, "restore");
    for (const c of paints(calls)) assert.ok(c.clipped, `${w.kind} ${c.name} outside the clip`);
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

test("two draws of the same field and camera are the same, and a draw never steps the field", () => {
  for (const w of [{ kind: "rain", heavy: true, wind: "strong" }, { kind: "snow" }, { kind: "fog", heavy: true }, { kind: "leaves", wind: "strong" }, { kind: "ash" }, { kind: "sand", heavy: true, wind: "strong" }] as const) {
    for (const view of [TOP_DOWN, isometric(2)]) {
      const f = field(w, view);
      const before = JSON.stringify([...f.x, ...f.y, f.t, ...f.sheets, ...f.rings]);
      const a = recorder();
      const b = recorder();
      drawWeather(a.g, f, { camera, clip: sceneClip(view, { w: 30, h: 20 }, camera) }, textures);
      drawWeather(b.g, f, { camera, clip: sceneClip(view, { w: 30, h: 20 }, camera) }, textures);
      assert.deepEqual(a.calls, b.calls, w.kind);
      assert.equal(JSON.stringify([...f.x, ...f.y, f.t, ...f.sheets, ...f.rings]), before);
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
  assert.ok(same.length >= moved.length - 4, "all but the few that wrapped across an edge");
});

test("the scene's outline on screen: a rectangle in Top-down, a diamond in Isometric", () => {
  assert.deepEqual([...sceneClip(TOP_DOWN, { w: 10, h: 5 }, { x: 7, y: 3, scale: 2 })], [7, 3, 27, 3, 27, 13, 7, 13]);
  const d = sceneClip(isometric(0), { w: 10, h: 10 }, { x: 0, y: 0, scale: 1 });
  const r = Math.SQRT1_2;
  const expect = [0, 0, 10 * r, 5 * r, 0, 10 * r, -10 * r, 5 * r];
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(d[k]! - expect[k]!) < 1e-9);
});

test("fog's sheets scale with the zoom, within half and twice", () => {
  const f = field({ kind: "fog" });
  const scaleAt = (zoom: number) => {
    const { g, calls } = recorder();
    drawWeather(g, f, { camera: { x: 0, y: 0, scale: zoom }, clip: null }, textures);
    // Each sheet's own size, divided out, leaves the zoom's part.
    return calls.filter((c) => c.name === "setTransform" && c.args.join() !== "1,0,0,1,0,0").map((c, j) => +(c.args[0]! / f.look.sheets[j]!.scale).toFixed(9));
  };
  assert.deepEqual(scaleAt(SHEET_SCALE_AT), [1, 1]);
  assert.deepEqual(scaleAt(SHEET_SCALE_AT * 1.5), [1.5, 1.5]);
  assert.deepEqual(scaleAt(SHEET_SCALE_AT * 10), [2, 2]);
  assert.deepEqual(scaleAt(4), [0.5, 0.5]);
});
