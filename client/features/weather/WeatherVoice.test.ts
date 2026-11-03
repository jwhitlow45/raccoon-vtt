import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../../state/scope.ts";
import { sayNext, seenOf, weatherSaid, weatherSeenSlot } from "./WeatherVoice.ts";

/** What the polite status says of the weather (docs/design/design-v1-weather.md 4.2). */
describe("weatherSaid", () => {
  const rain = seenOf("s1", { kind: "rain", heavy: true, wind: "strong" });
  const clear = seenOf("s1", undefined);

  test("arriving on a scene with weather names it", () => {
    assert.equal(weatherSaid(null, rain), "Weather here: Heavy rain, Strong wind.");
    assert.equal(weatherSaid(clear, seenOf("s2", { kind: "rain", heavy: true, wind: "strong" })), "Weather here: Heavy rain, Strong wind.");
    assert.equal(weatherSaid(rain, seenOf("s2", { kind: "rain", heavy: true, wind: "strong" })), "Weather here: Heavy rain, Strong wind.", "another scene, the same weather: still an arrival");
  });

  test("a change of the weather names the new one", () => {
    assert.equal(weatherSaid(clear, rain), "Weather here: Heavy rain, Strong wind.");
    assert.equal(weatherSaid(rain, seenOf("s1", { kind: "snow" })), "Weather here: Light snow.");
    assert.equal(weatherSaid(clear, seenOf("s1", { kind: "clear", wind: "moderate" })), "Weather here: Moderate wind.");
  });

  test("clearing says it is clear now, on the same scene or by arriving on a clear one", () => {
    assert.equal(weatherSaid(rain, clear), "The weather here is clear now.");
    assert.equal(weatherSaid(rain, seenOf("s2", undefined)), "The weather here is clear now.");
  });

  test("a clear scene, a direction turned and a rules switch say nothing", () => {
    assert.equal(weatherSaid(null, clear), null);
    assert.equal(weatherSaid(clear, seenOf("s2", undefined)), null);
    assert.equal(weatherSaid(rain, seenOf("s1", { kind: "rain", heavy: true, wind: "strong", toward: 270 })), null);
    assert.equal(weatherSaid(rain, seenOf("s1", { kind: "rain", heavy: true, wind: "strong", rules: false })), null);
  });
});

describe("what the status remembers, one per Room page", () => {
  test("a View button that mounts again in the same page says nothing again, and another page says it for itself", () => {
    const rain = seenOf("s1", { kind: "rain", heavy: true, wind: "strong" });
    const page = new RoomScope();
    assert.equal(sayNext(page.get(weatherSeenSlot), rain), "Weather here: Heavy rain, Strong wind.");
    // The button mounts again: its effect runs again with the same scene and weather.
    assert.equal(sayNext(page.get(weatherSeenSlot), rain), null);
    assert.equal(sayNext(page.get(weatherSeenSlot), seenOf("s1", undefined)), "The weather here is clear now.");
    const preview = new RoomScope();
    assert.equal(sayNext(preview.get(weatherSeenSlot), rain), "Weather here: Heavy rain, Strong wind.", "View as a player has a page of its own");
  });
});
