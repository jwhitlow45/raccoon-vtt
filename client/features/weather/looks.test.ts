import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TOWARD, lookOf, type WeatherKind, type WeatherLook } from "./looks.ts";

const KINDS: readonly WeatherKind[] = ["clear", "rain", "snow", "fog", "leaves", "ash", "sand"];
const WINDS = [undefined, "moderate", "strong"] as const;

function every(): WeatherLook[] {
  const out: WeatherLook[] = [];
  for (const kind of KINDS) for (const heavy of [false, true]) for (const wind of WINDS) out.push({ kind, ...(heavy ? { heavy: true } : {}), ...(wind ? { wind } : {}) });
  return out;
}

test("no weather and clear with calm draw nothing", () => {
  assert.equal(lookOf(null), null);
  assert.equal(lookOf(undefined), null);
  assert.equal(lookOf({ kind: "clear" }), null);
});

test("a clear day with a wind draws faint streaks, more in a strong wind", () => {
  const moderate = lookOf({ kind: "clear", wind: "moderate" })!;
  const strong = lookOf({ kind: "clear", wind: "strong" })!;
  assert.equal(moderate.key, "clear light moderate");
  assert.equal(moderate.particles?.shape, "streak");
  assert.equal(moderate.particles?.alpha, 0.15);
  assert.deepEqual([moderate.particles?.perArea, moderate.particles?.cap], [8, 60]);
  assert.deepEqual([strong.particles?.perArea, strong.particles?.cap], [20, 150]);
  assert.equal(moderate.veil, null);
});

test("each kind's counts and caps follow the design's table, light then heavy", () => {
  const counts: Record<Exclude<WeatherKind, "clear" | "fog">, [number, number, number, number]> = {
    rain: [40, 250, 100, 600],
    snow: [25, 150, 70, 400],
    leaves: [6, 40, 16, 100],
    ash: [30, 200, 80, 500],
    sand: [60, 400, 160, 900],
  };
  for (const [kind, [light, lightCap, heavy, heavyCap]] of Object.entries(counts)) {
    const l = lookOf({ kind: kind as WeatherKind, wind: "strong" })!.particles!;
    const h = lookOf({ kind: kind as WeatherKind, heavy: true, wind: "strong" })!.particles!;
    assert.deepEqual([l.perArea, l.cap, h.perArea, h.cap], [light, lightCap, heavy, heavyCap], kind);
  }
  assert.equal(lookOf({ kind: "fog" })!.particles, null);
});

test("fog is two sheets, patchy then heavy, and heavy kinds add their veils", () => {
  assert.deepEqual(lookOf({ kind: "fog" })!.sheets.map((s) => s.alpha), [0.18, 0.12]);
  assert.deepEqual(lookOf({ kind: "fog", heavy: true })!.sheets.map((s) => s.alpha), [0.35, 0.25]);
  assert.deepEqual(lookOf({ kind: "rain", heavy: true })!.veil, { color: "#1b2a3a", alpha: 0.12 });
  assert.equal(lookOf({ kind: "rain" })!.veil, null);
  assert.equal(lookOf({ kind: "snow", heavy: true })!.veil?.alpha, 0.1);
  assert.equal(lookOf({ kind: "ash", heavy: true })!.veil?.color, "#3a3330");
  assert.equal(lookOf({ kind: "sand", wind: "moderate" })!.veil?.alpha, 0.08);
  const storm = lookOf({ kind: "sand", heavy: true, wind: "strong" })!;
  assert.equal(storm.veil?.alpha, 0.3);
  assert.equal(storm.sheets.length, 1, "a sandstorm's fast sheet");
  assert.equal(lookOf({ kind: "rain", heavy: true })!.particles!.splashEvery, 200);
  assert.equal(lookOf({ kind: "rain" })!.particles!.splashEvery, 0);
});

test("nothing passes 35% and no screen holds more than 900 marks", () => {
  for (const w of every()) {
    const look = lookOf(w);
    if (!look) continue;
    assert.ok((look.veil?.alpha ?? 0) <= 0.35, look.key);
    for (const s of look.sheets) assert.ok(s.alpha <= 0.35, look.key);
    assert.ok((look.particles?.cap ?? 0) <= 900, look.key);
  }
});

test("the wind drifts falling marks at the table's speeds, strong at twice, and a strong wind's leaves take their own speeds", () => {
  assert.equal(lookOf({ kind: "rain" })!.particles!.drift, 0);
  assert.equal(lookOf({ kind: "rain", wind: "moderate" })!.particles!.drift, 1);
  assert.equal(lookOf({ kind: "rain", wind: "strong" })!.particles!.drift, 2);
  const leaves = lookOf({ kind: "leaves", wind: "strong" })!.particles!;
  assert.deepEqual([leaves.speed, leaves.drift], [[150, 250], 1]);
  assert.deepEqual(lookOf({ kind: "leaves", wind: "moderate" })!.particles!.speed, [40, 120]);
  assert.equal(lookOf({ kind: "sand", wind: "strong" })!.particles!.falls, false);
});

test("the key names kind, strength and wind, and the direction reads 135 when absent or calm", () => {
  assert.equal(lookOf({ kind: "rain", heavy: true, wind: "strong" })!.key, "rain heavy strong");
  assert.equal(lookOf({ kind: "snow" })!.key, "snow light calm");
  assert.equal(lookOf({ kind: "rain", wind: "moderate" })!.toward, DEFAULT_TOWARD);
  assert.equal(lookOf({ kind: "rain", wind: "moderate", toward: 270 })!.toward, 270);
  assert.equal(lookOf({ kind: "rain", toward: 270 })!.toward, DEFAULT_TOWARD, "no wind, no direction");
  assert.equal(lookOf({ kind: "rain", wind: "moderate", toward: -45 })!.toward, 315);
  assert.equal(lookOf({ kind: "clear", heavy: true, wind: "strong" })!.key, "clear light strong", "clear is never heavy");
});
