import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { weatherProblem, type SceneWeather } from "../shared/weather.ts";
import { WARMUP_MS, WINDOW_MS } from "../client/features/weather/mode.ts";
import { gateFailures, gestureOverages, HEAVIEST, p95, stepDownSettled, type Row } from "./bench-weather.ts";

/*
 * The weather bench's gates (docs/design/design-v1-weather.md 6.1): rest
 * busy time at most 60 ms a second over no weather for every kind, no ticks
 * at rest for Still and Off, and, with a GPU, a pan's and a drag's 95th
 * percentile frame at most 2 ms over none.
 */

function rows(view: Row["view"], over: { rest?: number; pan?: number; drag?: number; stillTicks?: number }): Row[] {
  return [
    { row: "rest, none", view, value: 10, unit: "ms/s" },
    { row: "rest, rain", view, value: 10 + (over.rest ?? 0), unit: "ms/s" },
    { row: "rest, fog", view, value: 20, unit: "ms/s" },
    { row: "pan, none", view, value: 17, unit: "ms p95" },
    { row: "pan, rain", view, value: 17 + (over.pan ?? 0), unit: "ms p95" },
    { row: "drag, none", view, value: 17, unit: "ms p95" },
    { row: "drag, rain", view, value: 17 + (over.drag ?? 0), unit: "ms p95" },
    { row: "ticks, rain still", view, value: over.stillTicks ?? 0, unit: "ticks" },
  ];
}

describe("the weather bench's gates", () => {
  test("a run within budget passes in both views", () => {
    assert.deepEqual(gateFailures([...rows("topDown", { rest: 60, pan: 2, drag: 2 }), ...rows("isometric", {})]), []);
  });

  test("each budget fails on its own, by view", () => {
    assert.deepEqual(gateFailures(rows("isometric", { rest: 61 })), ["isometric rest, rain: 61.0 ms/s over none"]);
    assert.deepEqual(gateFailures(rows("topDown", { pan: 2.5 })), ["topDown pan: p95 2.5 ms over none"]);
    assert.deepEqual(gateFailures(rows("topDown", { drag: 3 })), ["topDown drag: p95 3.0 ms over none"]);
    assert.deepEqual(gateFailures(rows("topDown", { stillTicks: 1 })), ["topDown ticks, rain still: 1 ticks at rest"]);
  });

  test("the 95th percentile, and every kind at its heaviest weather the schema allows", () => {
    assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 96);
    assert.equal(p95([]), 0);
    assert.deepEqual(
      HEAVIEST.map((k) => k.name),
      ["rain", "snow", "fog", "leaves", "ash", "sand", "wind"],
    );
    for (const k of HEAVIEST) assert.equal(weatherProblem(k.weather as SceneWeather), null, k.name);
  });

  test("with a GPU the weather keeps all its particles after pans, and without one it may not", () => {
    const panned = (level: number): Row[] => [{ row: "level after pans, rain", view: "topDown", value: level, unit: "level" }];
    assert.deepEqual(gateFailures(panned(0)), []);
    assert.deepEqual(gateFailures(panned(1)), ["topDown level after pans, rain: half"]);
    assert.deepEqual(gateFailures(panned(2), { software: true }), []);
  });

  test("without a GPU a pan's and a drag's frames are information, and what the step-down leaves at rest still gates", () => {
    // A software Isometric pan's 95th percentile, 16.7 ms with no weather and 33.4 ms with it, as one run read them (WXB-R2-5).
    const flipped = rows("isometric", { pan: 16.7, drag: 3 });
    assert.deepEqual(gateFailures(flipped, { software: true }), []);
    assert.deepEqual(gestureOverages(flipped), ["isometric pan: p95 16.7 ms over none", "isometric drag: p95 3.0 ms over none"], "said, not gated");
    assert.deepEqual(gateFailures(flipped), ["isometric pan: p95 16.7 ms over none", "isometric drag: p95 3.0 ms over none"], "with a GPU they gate");
    assert.deepEqual(gateFailures(rows("topDown", { rest: 61, pan: 16.7 }), { software: true }), ["topDown rest, rain: 61.0 ms/s over none"]);
    assert.deepEqual(gateFailures(rows("topDown", { stillTicks: 2, pan: 16.7 }), { software: true }), ["topDown ticks, rain still: 2 ticks at rest"]);
  });
});

describe("when the bench reads a kind's rest", () => {
  const two = WARMUP_MS + 2 * WINDOW_MS + 500;
  test("two windows after the warm-up with no step, or after the warm-up that follows a halving, or once still", () => {
    assert.equal(stepDownSettled([], 0), false);
    assert.equal(stepDownSettled([{ at: 0, level: 0 }, { at: 8000, level: 0 }], 8000), false);
    assert.equal(stepDownSettled([{ at: 0, level: 0 }, { at: two, level: 0 }], two), true);
    // A halving at 5 s restarts the warm-up, so the rest waits two windows past it.
    const halved = [{ at: 0, level: 0 }, { at: 5000, level: 1 }, { at: two + 1000, level: 1 }];
    assert.equal(stepDownSettled(halved, two + 1000), false);
    assert.equal(stepDownSettled([...halved, { at: 5000 + two, level: 1 }], 5000 + two), true);
    assert.equal(stepDownSettled([{ at: 0, level: 0 }, { at: 10_000, level: 2 }], 10_000), true);
  });
});
