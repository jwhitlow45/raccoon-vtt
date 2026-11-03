import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { weatherProblem, type SceneWeather } from "../shared/weather.ts";
import { gateFailures, HEAVIEST, p95, type Row } from "./bench-weather.ts";

/*
 * The weather bench's gates (docs/design/design-v1-weather.md 6.1): rest
 * busy time at most 60 ms a second over no weather for every kind, a pan's
 * and a drag's 95th percentile frame at most 2 ms over none, and no ticks
 * at rest for Still and Off.
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
});
