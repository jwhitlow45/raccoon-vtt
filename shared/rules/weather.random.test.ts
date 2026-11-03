import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { D20Test } from "../dice/bonus.ts";
import { ABILITY_KEYS, SKILL_KEYS } from "../model.ts";
import { WEATHER_KINDS, weatherProblem, type SceneWeather } from "../weather.ts";
import { reminderPreset } from "./rollReminders.ts";
import { weatherPreset } from "./weather.ts";

/**
 * Every weather by every d20 test (docs/design/design-v1-weather.md 12): weather
 * adds only Disadvantage, only to Perception checks and to ranged attacks
 * with `weapon`, never to saves, death saves, Initiative, spell attacks or
 * "either", and a light kind adds nothing.
 */

const weather: fc.Arbitrary<SceneWeather> = fc
  .record(
    {
      kind: fc.constantFrom(...WEATHER_KINDS),
      heavy: fc.constant(true as const),
      wind: fc.constantFrom("moderate" as const, "strong" as const),
      toward: fc.constantFrom(0, 45, 90, 135, 180, 225, 270, 315),
      rules: fc.constant(false as const),
    },
    { requiredKeys: ["kind"] },
  )
  .filter((w) => weatherProblem(w) === null);

const ability = fc.constantFrom(...ABILITY_KEYS);
const test20: fc.Arbitrary<D20Test> = fc.oneof(
  fc.record({ kind: fc.constant("save" as const), ability, cause: fc.constantFrom("concentration" as const, "saveEnds" as const), spell: fc.constant(true as const) }, { requiredKeys: ["kind", "ability"] }),
  fc.constant({ kind: "deathSave" as const }),
  fc.record({ kind: fc.constant("check" as const), ability, skill: fc.constantFrom(...SKILL_KEYS) }, { requiredKeys: ["kind", "ability"] }),
  fc.constant({ kind: "initiative" as const }),
  fc.record(
    { kind: fc.constant("attack" as const), range: fc.constantFrom("melee" as const, "ranged" as const, "either" as const), spell: fc.constant(true as const), weapon: fc.constant(true as const) },
    { requiredKeys: ["kind"] },
  ),
);

const heavyRuled = (w: SceneWeather) => w.rules !== false;

describe("weather's rules over every weather and every d20 test", () => {
  test("only Disadvantage, only where the SRD needs no judgment", () => {
    fc.assert(
      fc.property(weather, test20, (w, t) => {
        const preset = weatherPreset(w, t);
        for (const source of preset.sources) assert.equal(source.kind, "dis");
        if (preset.sources.length === 0) return;
        assert.ok(heavyRuled(w), "the switch off gives nothing");
        if (t.kind === "check") {
          assert.equal(t.skill, "perception");
          assert.ok(w.heavy === true && (w.kind === "rain" || w.kind === "snow" || w.kind === "sand"), "only heavy precipitation and a sandstorm");
        } else {
          assert.equal(t.kind, "attack", "never a save, a death save or Initiative");
          if (t.kind !== "attack") return;
          assert.equal(t.range, "ranged");
          assert.equal(t.weapon, true);
          assert.notEqual(t.spell, true);
          assert.equal(w.wind, "strong");
        }
      }),
      { numRuns: 3_000 },
    );
  });

  test("a light kind with no strong wind, or the switch off, adds nothing at all", () => {
    fc.assert(
      fc.property(weather, test20, (w, t) => {
        if (w.rules !== false && (w.heavy === true || w.wind === "strong")) return;
        assert.deepEqual(weatherPreset(w, t), { sources: [], notes: [] });
      }),
      { numRuns: 2_000 },
    );
  });

  test("with conditions, weather only adds to what the effects give, after them", () => {
    fc.assert(
      fc.property(weather, test20, fc.subarray(["restrained", "poisoned", "blessed", "prone"] as const), (w, t, keys) => {
        const effects = keys.map((key) => ({ key }));
        const alone = reminderPreset(effects, t);
        const withWeather = reminderPreset(effects, t, { weather: w });
        assert.deepEqual(withWeather.sources.slice(0, alone.sources.length), alone.sources);
        assert.deepEqual(withWeather.notes.slice(0, alone.notes.length), alone.notes);
        assert.deepEqual(withWeather.extra, alone.extra);
        assert.equal(withWeather.fails, alone.fails);
        const added = weatherPreset(w, t);
        assert.deepEqual(withWeather.sources.slice(alone.sources.length), added.sources);
        assert.deepEqual(withWeather.notes.slice(alone.notes.length), added.notes);
      }),
      { numRuns: 1_000 },
    );
  });
});
