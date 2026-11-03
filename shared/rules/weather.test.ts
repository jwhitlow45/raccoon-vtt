import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { D20Test } from "../dice/bonus.ts";
import { RULES_TEXT } from "../srd/rules-text.ts";
import type { SceneWeather } from "../weather.ts";
import { WEATHER_RULES, WEATHER_RULE_KEYS, WEATHER_RULE_NAMES, weatherHasRules, weatherPreset, weatherReminders, weatherRules } from "./weather.ts";

/** Weather's roll rules (docs/design/design-v1-weather.md 2, lane WX-A). */

/** The SRD's apostrophes and quotation marks are curly, the rules' quotes straight. */
function plain(text: string): string {
  return text.replaceAll("’", "'");
}

const PERCEPTION: D20Test = { kind: "check", ability: "wis", skill: "perception" };
const INSIGHT: D20Test = { kind: "check", ability: "wis", skill: "insight" };
const BOW: D20Test = { kind: "attack", range: "ranged", weapon: true };
const EITHER: D20Test = { kind: "attack", range: "either", weapon: true };
const RAY: D20Test = { kind: "attack", range: "ranged" };
const PC_SWORD: D20Test = { kind: "attack", weapon: true };
const SCIMITAR: D20Test = { kind: "attack", range: "melee", weapon: true };
const SPELL_RAY: D20Test = { kind: "attack", range: "ranged", spell: true };
const BARE: D20Test = { kind: "attack" };

const HEAVY_RAIN: SceneWeather = { kind: "rain", heavy: true };
const STRONG: SceneWeather = { kind: "clear", wind: "strong" };
const SANDSTORM: SceneWeather = { kind: "sand", heavy: true, wind: "strong" };

const dis = (w: SceneWeather, test: D20Test) => weatherPreset(w, test).sources.map((s) => `${s.kind}:${s.from}`);
const notes = (w: SceneWeather, test: D20Test) => weatherPreset(w, test).notes.map((n) => n.key);

describe("weather's roll rules", () => {
  test("every rule rests on words its SRD 5.2.1 entry says", () => {
    for (const rule of WEATHER_RULES) {
      const entry = RULES_TEXT.environment[rule.source];
      for (const quote of rule.quotes) assert.ok(plain(entry.text).includes(quote), `${rule.key}: "${quote}"`);
    }
    // Each weapon list names the weapons section 2 names, in the Weapons table's order.
    assert.deepEqual(RULES_TEXT.environment["ranged-weapons"].text.split("\n"), ["Dart", "Light Crossbow", "Shortbow", "Sling", "Blowgun", "Hand Crossbow", "Heavy Crossbow", "Longbow", "Musket", "Pistol"].map((n) => `- ${n}`));
    assert.deepEqual(RULES_TEXT.environment["thrown-weapons"].text.split("\n"), ["Dagger", "Handaxe", "Javelin", "Light Hammer", "Spear", "Trident"].map((n) => `- ${n}`));
    for (const entry of Object.values(RULES_TEXT.environment)) assert.ok(!entry.text.includes("\u2014"), `${entry.title} has no em dash`);
    for (const key of WEATHER_RULE_KEYS) assert.ok(WEATHER_RULE_NAMES[key], key);
  });

  test("heavy rain, heavy snow and a sandstorm preset Perception checks, and nothing else", () => {
    for (const [w, key] of [[HEAVY_RAIN, "heavy-rain"], [{ kind: "snow", heavy: true }, "heavy-snow"], [SANDSTORM, "sandstorm"]] as const) {
      assert.deepEqual(dis(w, PERCEPTION), [`dis:${key}`]);
      assert.deepEqual(dis(w, INSIGHT), []);
      assert.deepEqual(dis(w, { kind: "save", ability: "wis" }), []);
      assert.deepEqual(dis(w, { kind: "initiative" }), []);
      assert.deepEqual(notes(w, PERCEPTION), []);
    }
  });

  test("strong wind presets only an attack known to be with a ranged weapon, reminds where it may be, and leaves the rest", () => {
    for (const w of [STRONG, { kind: "rain", heavy: true, wind: "strong" }, SANDSTORM, { kind: "leaves", wind: "strong" }] as SceneWeather[]) {
      assert.deepEqual(dis(w, BOW), ["dis:strong-wind"], JSON.stringify(w));
      assert.deepEqual(notes(w, BOW), []);
      const reminded: D20Test[] = [EITHER, RAY, PC_SWORD];
      for (const t of reminded) {
        assert.deepEqual(dis(w, t), [], JSON.stringify(t));
        assert.deepEqual(notes(w, t), ["strong-wind"], JSON.stringify(t));
      }
      const nothing: D20Test[] = [SCIMITAR, SPELL_RAY, BARE, { kind: "attack", range: "ranged", weapon: true, spell: true }];
      for (const t of nothing) {
        assert.deepEqual(weatherPreset(w, t), { sources: [], notes: [] }, JSON.stringify(t));
      }
    }
    assert.deepEqual(dis({ kind: "rain", wind: "moderate" }, BOW), [], "a moderate wind has no rule");
    assert.deepEqual(dis(SANDSTORM, PERCEPTION), ["dis:sandstorm"], "a sandstorm's own Perception rule beside the wind's");
  });

  test("fog only reminds: patchy fog on Perception checks, heavy fog on them and on every attack", () => {
    const patchy: SceneWeather = { kind: "fog" };
    const heavy: SceneWeather = { kind: "fog", heavy: true, wind: "moderate" };
    assert.deepEqual(weatherPreset(patchy, PERCEPTION), { sources: [], notes: [{ key: "patchy-fog", text: "Patchy fog: Lightly Obscured. Disadvantage on Perception checks that rely on sight." }] });
    assert.deepEqual(notes(patchy, BOW), []);
    assert.deepEqual(weatherPreset(heavy, PERCEPTION), { sources: [], notes: [{ key: "heavy-fog", text: "Heavy fog: Heavily Obscured. A creature trying to see something in it has the Blinded condition." }] });
    for (const t of [BOW, SCIMITAR, SPELL_RAY, BARE]) assert.deepEqual(notes(heavy, t), ["heavy-fog"], JSON.stringify(t));
    assert.deepEqual(notes(heavy, { kind: "save", ability: "dex" }), []);
  });

  test("a light kind, a moderate wind, no weather and the switch off give nothing", () => {
    const looks: (SceneWeather | undefined | null)[] = [
      undefined,
      null,
      { kind: "rain" },
      { kind: "snow", wind: "moderate" },
      { kind: "leaves", heavy: true },
      { kind: "ash", heavy: true, wind: "moderate" },
      { kind: "sand", wind: "moderate" },
      { kind: "clear", wind: "moderate" },
      { kind: "rain", heavy: true, wind: "strong", rules: false },
      { kind: "fog", heavy: true, rules: false },
      { kind: "sand", heavy: true, wind: "strong", rules: false },
    ];
    const tests: D20Test[] = [PERCEPTION, BOW, EITHER, RAY];
    for (const w of looks) for (const t of tests) assert.deepEqual(weatherPreset(w, t), { sources: [], notes: [] }, JSON.stringify([w, t]));
    assert.deepEqual(weatherReminders({ kind: "rain", heavy: true, rules: false }, [PERCEPTION]), []);
  });

  test("a request's reminders list each rule once, presets and notes alike, for any test it offers", () => {
    assert.deepEqual(weatherReminders(HEAVY_RAIN, [INSIGHT, PERCEPTION]), [{ key: "heavy-rain", text: "Heavy rain: Disadvantage on all Wisdom (Perception) checks." }]);
    assert.deepEqual(weatherReminders(HEAVY_RAIN, [INSIGHT]), []);
    assert.deepEqual(weatherReminders(STRONG, [BOW, RAY]), [{ key: "strong-wind", text: "Strong wind: Disadvantage on ranged attack rolls with weapons." }]);
  });

  test("the fold's rules line, its switch and its tone", () => {
    assert.deepEqual(weatherRules(HEAVY_RAIN), {
      tone: "help",
      text: "Everything here is Lightly Obscured, and creatures have Disadvantage on all Wisdom (Perception) checks. Heavy rain puts out open flames. Perception checks here roll with Disadvantage.",
    });
    assert.deepEqual(weatherRules(STRONG), {
      tone: "help",
      text: "Disadvantage on ranged attack rolls with weapons. Strong wind puts out open flames, and a flying creature must land at the end of its turn or fall. Attacks with a ranged weapon here roll with Disadvantage, and other ranged attacks remind.",
    });
    assert.deepEqual(weatherRules({ kind: "fog", heavy: true }), {
      tone: "note",
      text: "Heavily Obscured: a creature trying to see something in it has the Blinded condition. The map still shows what light and walls allow, so hide what the party could not see.",
    });
    assert.equal(
      weatherRules({ ...HEAVY_RAIN, wind: "strong", rules: false }).text,
      "Everything here is Lightly Obscured, and creatures have Disadvantage on all Wisdom (Perception) checks. Heavy rain puts out open flames. Disadvantage on ranged attack rolls with weapons. Strong wind puts out open flames, and a flying creature must land at the end of its turn or fall. Rolls here ignore it.",
    );
    for (const w of [undefined, { kind: "rain" }, { kind: "clear", wind: "moderate" }, { kind: "ash", heavy: true }] as (SceneWeather | undefined)[]) {
      assert.deepEqual(weatherRules(w), { tone: "help", text: "A look only. The rules stay as they are." }, JSON.stringify(w));
      assert.equal(weatherHasRules(w), false);
    }
    for (const w of [HEAVY_RAIN, STRONG, SANDSTORM, { kind: "fog" }, { kind: "fog", heavy: true }, { kind: "snow", heavy: true, rules: false }] as SceneWeather[]) assert.equal(weatherHasRules(w), true, JSON.stringify(w));
    for (const text of [weatherRules(SANDSTORM).text, weatherRules({ kind: "fog" }).text, weatherRules({ kind: "snow", heavy: true }).text]) {
      assert.ok(!text.includes("\u2014") && !text.includes(";"), text);
    }
  });
});
