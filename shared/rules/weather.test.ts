import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { D20Test } from "../dice/bonus.ts";
import { RULES_TEXT } from "../srd/rules-text.ts";
import { WEATHER_KINDS, weatherProblem, type SceneWeather } from "../weather.ts";
import { isWeatherRuleKey, WEATHER_RULES, WEATHER_RULE_KEYS, WEATHER_RULE_NAMES, weatherHasRules, weatherPreset, weatherReminders, weatherRuleLines } from "./weather.ts";

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

  test("a look-only weather has no lines and says so, and every weather with a rule has the switch", () => {
    for (const w of [undefined, null, { kind: "rain" }, { kind: "clear", wind: "moderate" }, { kind: "ash", heavy: true }, { kind: "leaves", wind: "moderate" }] as (SceneWeather | undefined | null)[]) {
      assert.deepEqual(weatherRuleLines(w), { lines: [], rolls: "A look only. The rules stay as they are." }, JSON.stringify(w));
      assert.equal(weatherHasRules(w), false);
    }
    for (const w of [HEAVY_RAIN, STRONG, SANDSTORM, { kind: "fog" }, { kind: "fog", heavy: true }, { kind: "snow", heavy: true, rules: false }] as SceneWeather[]) assert.equal(weatherHasRules(w), true, JSON.stringify(w));
  });
});

/** Light and weather's rules: one sentence for what rolls do, then a line per weather part (docs/design/design-v1-polish-pass.md 3.2). */
describe("the weather rules' sentence and lines", () => {
  /** Every weather the picker can make, each with the switch on and off: 34 weathers, 68 cases. */
  function everyWeather(): SceneWeather[] {
    const out: SceneWeather[] = [];
    for (const kind of WEATHER_KINDS) {
      for (const heavy of [false, true]) {
        for (const wind of [undefined, "moderate", "strong"] as const) {
          for (const rules of [true, false]) {
            const w: SceneWeather = { kind, ...(heavy ? { heavy: true } : {}), ...(wind ? { wind } : {}), ...(rules ? {} : { rules: false }) };
            if (weatherProblem(w) === null) out.push(w);
          }
        }
      }
    }
    return out;
  }

  /** The four kinds of roll a weather can tell apart, each with the words the sentence names it by. */
  const ROLLS = [
    { test: PERCEPTION, words: "Perception checks" },
    { test: BOW, words: "ranged weapon attacks" },
    { test: EITHER, words: "other ranged attacks" },
    { test: SCIMITAR, words: "melee attacks" },
  ] as const;

  /**
   * The sentence `weatherPreset` asks for: the tests it presets, then the
   * ones it reminds. Reminding every attack, ranged weapon or not, reads as
   * "attacks". Worked out from the presets alone, never from the table.
   */
  function sentenceOf(w: SceneWeather): string {
    const preset: string[] = [];
    let remind: string[] = [];
    for (const { test: t, words } of ROLLS) {
      const got = weatherPreset(w, t);
      if (got.sources.length > 0) preset.push(words);
      else if (got.notes.length > 0) remind.push(words);
    }
    if (["ranged weapon attacks", "other ranged attacks", "melee attacks"].every((a) => remind.includes(a))) remind = [...remind.filter((a) => !a.endsWith("attacks")), "attacks"];
    const cap = (xs: string[]) => {
      const s = xs.join(" and ");
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
    const parts: string[] = [];
    if (preset.length > 0) parts.push(`${cap(preset)} here roll with Disadvantage.`);
    if (remind.length > 0) parts.push(`${cap(remind)} here get a reminder.`);
    return parts.length > 0 ? parts.join(" ") : "Rolls here ignore these rules.";
  }

  test("every valid weather, strength, wind and switch: the sentence names exactly what weatherPreset presets, then what it reminds", () => {
    const cases = everyWeather();
    assert.equal(cases.length, 68);
    const seen = new Set<string>();
    for (const w of cases) {
      const { rolls, lines } = weatherRuleLines(w);
      if (!weatherHasRules(w)) {
        assert.equal(rolls, "A look only. The rules stay as they are.", JSON.stringify(w));
        assert.deepEqual(lines, [], JSON.stringify(w));
        continue;
      }
      assert.equal(rolls, sentenceOf(w), JSON.stringify(w));
      seen.add(rolls);
      // Every rule that gives any roll here a preset or a reminder has its line, and no line names a rule the weather lacks.
      const on: SceneWeather = { ...w };
      delete on.rules;
      const given = new Set<string>();
      for (const { test: t } of ROLLS) {
        const got = weatherPreset(on, t);
        for (const s of got.sources) if (isWeatherRuleKey(s.from)) given.add(WEATHER_RULE_NAMES[s.from]);
        for (const n of got.notes) given.add(WEATHER_RULE_NAMES[n.key]);
      }
      assert.deepEqual(lines.map((l) => l.name).sort(), [...given].sort(), JSON.stringify(w));
      // The switch changes the sentence alone: the SRD still says what it says.
      assert.deepEqual(lines, weatherRuleLines(on).lines, JSON.stringify(w));
    }
    assert.deepEqual([...seen].sort(), [
      "Perception checks and attacks here get a reminder.",
      "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.",
      "Perception checks here get a reminder.",
      "Perception checks here roll with Disadvantage.",
      "Ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.",
      "Rolls here ignore these rules.",
    ]);
  });

  test("fog with a strong wind is no case: weatherProblem refuses it", () => {
    for (const heavy of [false, true]) {
      const w: SceneWeather = { kind: "fog", wind: "strong", ...(heavy ? { heavy: true } : {}) };
      assert.equal(weatherProblem(w), "Strong wind disperses fog.");
      assert.ok(!everyWeather().some((c) => c.kind === "fog" && c.wind === "strong"));
    }
  });

  test("the sentences the design names, rules on and off", () => {
    assert.equal(weatherRuleLines({ kind: "fog", heavy: true }).rolls, "Perception checks and attacks here get a reminder.");
    assert.equal(weatherRuleLines({ ...HEAVY_RAIN, wind: "strong" }).rolls, "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.");
    assert.equal(weatherRuleLines(SANDSTORM).rolls, "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.");
    assert.equal(weatherRuleLines({ kind: "leaves", wind: "strong" }).rolls, "Ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.");
    assert.equal(weatherRuleLines({ kind: "snow", heavy: true, wind: "moderate" }).rolls, "Perception checks here roll with Disadvantage.");
    assert.equal(weatherRuleLines({ kind: "fog", wind: "moderate" }).rolls, "Perception checks here get a reminder.");
    for (const w of [HEAVY_RAIN, { kind: "fog", heavy: true }, SANDSTORM] as SceneWeather[]) assert.equal(weatherRuleLines({ ...w, rules: false }).rolls, "Rolls here ignore these rules.");
  });

  test("the lines: one per part, the kind's then the wind's, each named, heavy fog's a note with its advice apart", () => {
    assert.deepEqual(
      weatherRuleLines({ ...HEAVY_RAIN, wind: "strong" }).lines.map((l) => `${l.name}: ${l.text}`),
      [
        "Heavy rain: Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks. Puts out open flames.",
        "Strong wind: Disadvantage on ranged attack rolls with weapons. Puts out open flames, and a flying creature must land at the end of its turn or fall.",
      ],
    );
    assert.deepEqual(weatherRuleLines(SANDSTORM).lines.map((l) => l.name), ["Sandstorm", "Strong wind"]);
    const [fog, ...rest] = weatherRuleLines({ kind: "fog", heavy: true }).lines;
    assert.deepEqual(rest, []);
    assert.deepEqual(
      { name: fog?.name, text: fog?.text, advice: fog?.advice, tone: fog?.tone },
      {
        name: "Heavy fog",
        text: "Heavily Obscured, so a creature trying to see something in it has the Blinded condition.",
        advice: "The map still shows what light and walls allow, so hide what the party could not see.",
        tone: "note",
      },
    );
    for (const w of everyWeather()) for (const line of weatherRuleLines(w).lines) if (line.name !== "Heavy fog") assert.equal(line.tone, "help", line.name);
    assert.deepEqual(
      weatherRuleLines({ kind: "fog" }).lines.map((l) => `${l.name}: ${l.text}`),
      ["Patchy fog: Lightly Obscured, so Wisdom (Perception) checks that rely on sight have Disadvantage."],
    );
  });

  test("every line says only what its quotes say: each quote is in its SRD entry, each rule term of the line in a quote, and the advice stays out", () => {
    const TERMS = ["Lightly Obscured", "Heavily Obscured", "Disadvantage", "Perception", "rely on sight", "Blinded", "ranged attack rolls with weapons", "flames", "flying"];
    const lines = new Map(everyWeather().flatMap((w) => weatherRuleLines(w).lines.map((l) => [l.name, l] as const)));
    assert.deepEqual([...lines.keys()].sort(), Object.values(WEATHER_RULE_NAMES).sort(), "every rule has a line somewhere");
    for (const line of lines.values()) {
      const entry = plain(RULES_TEXT.environment[line.source].text);
      for (const quote of line.quotes) assert.ok(entry.includes(quote), `${line.name}: "${quote}"`);
      for (const term of TERMS) if (line.text.includes(term)) assert.ok(line.quotes.some((q) => q.includes(term)), `${line.name}: "${term}" in a quote`);
      for (const words of [line.text, line.advice ?? ""]) assert.ok(!words.includes("\u2014") && !words.includes(";"), words);
      // Shown after its name and a colon, so a colon of its own would read as a second label.
      assert.ok(!line.text.includes(":"), line.text);
    }
  });
});
