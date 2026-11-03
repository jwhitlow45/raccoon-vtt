import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { WEATHER_KINDS, weatherProblem, type SceneWeather } from "#shared/weather.ts";
import { buildWeather, CLEAR_PICKER, COMPASS, pickerOf, windHelp, windOffered, type Picker, type WindLevel } from "./buildWeather.ts";

/** The picker rules of docs/design/design-v1-weather.md 4.1, each as the DM would meet it. */

const from = (w: SceneWeather | undefined) => pickerOf(w);

describe("buildWeather", () => {
  test("Clear from a heavy kind drops heavy and keeps the wind", () => {
    const built = buildWeather(from({ kind: "rain", heavy: true, wind: "moderate" }), { kind: "clear" });
    assert.deepEqual(built.weather, { kind: "clear", wind: "moderate" });
  });

  test("Clear with Calm sends null", () => {
    assert.equal(buildWeather(from({ kind: "rain", heavy: true }), { kind: "clear" }).weather, null);
    assert.equal(buildWeather(from({ kind: "clear", wind: "strong" }), { wind: "calm" }).weather, null);
  });

  test("a kind picked from Clear keeps the wind and its direction, light", () => {
    const built = buildWeather(from({ kind: "clear", wind: "strong", toward: 45 }), { kind: "rain" });
    assert.deepEqual(built.weather, { kind: "rain", wind: "strong", toward: 45 });
    assert.equal(built.forced, null);
  });

  test("Fog picked while the wind is Strong drops it to Moderate and says why, from Clear's wind too", () => {
    for (const before of [from({ kind: "rain", wind: "strong" }), from({ kind: "clear", wind: "strong" })]) {
      const built = buildWeather(before, { kind: "fog" });
      assert.deepEqual(built.weather, { kind: "fog", wind: "moderate" });
      assert.equal(built.forced, "The wind is moderate now: strong wind disperses fog.");
    }
  });

  test("a sandstorm picked while the wind is Calm or Moderate raises it to Strong", () => {
    for (const wind of [undefined, "moderate" as const]) {
      const built = buildWeather(from({ kind: "sand", ...(wind ? { wind } : {}) }), { heavy: true });
      assert.deepEqual(built.weather, { kind: "sand", heavy: true, wind: "strong" });
      assert.equal(built.forced, "The wind is strong now: a sandstorm is a strong wind.");
    }
  });

  test("leaving Sand keeps Strong, except for Fog", () => {
    const storm = from({ kind: "sand", heavy: true, wind: "strong" });
    assert.deepEqual(buildWeather(storm, { kind: "rain" }).weather, { kind: "rain", wind: "strong" });
    assert.deepEqual(buildWeather(storm, { kind: "fog" }).weather, { kind: "fog", wind: "moderate" });
  });

  test("Calm drops the direction and a wind picked again starts toward the bottom right", () => {
    const blowing = from({ kind: "snow", wind: "moderate", toward: 270 });
    const calm = buildWeather(blowing, { wind: "calm" });
    assert.deepEqual(calm.weather, { kind: "snow" });
    assert.deepEqual(buildWeather(pickerOf(calm.weather ?? undefined), { wind: "strong" }).weather, { kind: "snow", wind: "strong" });
  });

  test("a direction is kept across wind strengths and kinds", () => {
    const west = from({ kind: "snow", wind: "moderate", toward: 270 });
    assert.deepEqual(buildWeather(west, { wind: "strong" }).weather, { kind: "snow", wind: "strong", toward: 270 });
    assert.deepEqual(buildWeather(west, { kind: "ash" }).weather, { kind: "ash", wind: "moderate", toward: 270 });
    assert.deepEqual(buildWeather(west, { toward: 135 }).weather, { kind: "snow", wind: "moderate" });
  });

  test("Weather rules on rolls off stays off across kind changes until it is turned on or Clear with Calm is picked", () => {
    const off = from({ kind: "rain", heavy: true, rules: false });
    assert.deepEqual(buildWeather(off, { kind: "snow", heavy: true }).weather, { kind: "snow", rules: false });
    assert.deepEqual(buildWeather(off, { rules: true }).weather, { kind: "rain", heavy: true });
    const clear = buildWeather(off, { kind: "clear" });
    assert.equal(clear.weather, null);
    assert.equal(pickerOf(clear.weather ?? undefined).rules, true);
  });

  test("the picker's refusals change nothing: Strong in fog, Calm or Moderate in a sandstorm", () => {
    const fog = buildWeather(from({ kind: "fog", wind: "moderate" }), { wind: "strong" });
    assert.equal(fog.refused, true);
    assert.deepEqual(fog.weather, { kind: "fog", wind: "moderate" });
    const storm = from({ kind: "sand", heavy: true, wind: "strong" });
    for (const wind of ["calm", "moderate"] as const) {
      const built = buildWeather(storm, { wind });
      assert.equal(built.refused, true);
      assert.deepEqual(built.weather, { kind: "sand", heavy: true, wind: "strong" });
    }
  });

  test("a new kind starts light", () => {
    assert.deepEqual(buildWeather(from({ kind: "rain", heavy: true }), { kind: "snow" }).weather, { kind: "snow" });
  });

  test("whatever is picked from wherever, the result is a weather the op schema takes, or null", () => {
    const kinds = fc.constantFrom(...WEATHER_KINDS);
    const winds = fc.constantFrom<WindLevel>("calm", "moderate", "strong");
    const toward = fc.constantFrom(...COMPASS.map((c) => c.toward));
    const picker = fc.record({ kind: kinds, heavy: fc.boolean(), wind: winds, toward, rules: fc.boolean() });
    const change = fc.oneof(
      kinds.map((kind) => ({ kind })),
      fc.boolean().map((heavy) => ({ heavy })),
      winds.map((wind) => ({ wind })),
      toward.map((t) => ({ toward: t })),
      fc.boolean().map((rules) => ({ rules })),
    );
    fc.assert(
      fc.property(picker, fc.array(change, { minLength: 1, maxLength: 8 }), (start, changes) => {
        // Begin from a state the picker can hold, as the store would.
        let now: Picker = start;
        const first = buildWeather(CLEAR_PICKER, { kind: start.kind, wind: start.wind, toward: start.toward });
        now = pickerOf(first.weather ?? undefined);
        for (const c of changes) {
          const built = buildWeather(now, c);
          if (built.weather !== null) assert.equal(weatherProblem(built.weather), null, JSON.stringify([now, c, built]));
          now = pickerOf(built.weather ?? undefined);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("the picker's words", () => {
  test("winds the kind cannot hold are not offered, and the help says why", () => {
    assert.equal(windOffered({ kind: "fog", heavy: false }, "strong"), false);
    assert.equal(windOffered({ kind: "fog", heavy: false }, "moderate"), true);
    assert.equal(windOffered({ kind: "sand", heavy: true }, "calm"), false);
    assert.equal(windOffered({ kind: "sand", heavy: true }, "moderate"), false);
    assert.equal(windOffered({ kind: "sand", heavy: false }, "calm"), true);
    assert.equal(windHelp(from({ kind: "fog" }), null), "Strong wind disperses fog.");
    assert.equal(windHelp(from({ kind: "sand", heavy: true, wind: "strong" }), null), "A sandstorm is a strong wind.");
    assert.equal(windHelp(from({ kind: "rain" }), null), null);
    assert.equal(windHelp(from({ kind: "fog" }), "forced"), "forced");
  });

  test("the compass names eight directions once each, clockwise from the top", () => {
    assert.deepEqual(COMPASS.map((c) => c.toward), [0, 45, 90, 135, 180, 225, 270, 315]);
    assert.equal(new Set(COMPASS.map((c) => c.name)).size, 8);
    assert.equal(new Set(COMPASS.map((c) => `${c.row},${c.col}`)).size, 8);
    assert.equal(COMPASS[0]!.name, "Toward the top");
    assert.equal(COMPASS[7]!.name, "Toward the top left");
  });
});
