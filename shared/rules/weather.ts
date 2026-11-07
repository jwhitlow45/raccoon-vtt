import type { D20Test } from "../dice/bonus.ts";
import type { AdvantageSource } from "../dice/formula.ts";
import type { EnvironmentKey } from "../srd/rules-text.ts";
import type { SceneWeather } from "../weather.ts";

/**
 * What a scene's weather does to a d20 roll (docs/design/design-v1-weather.md
 * 2), from the SRD 5.2.1 text in shared/srd/rules-text.json's `environment`.
 * As with the conditions' reminders (rollReminders.ts), a rule presets a roll
 * only where it holds without a judgment the app cannot make:
 *
 * - Gameplay Toolbox, Environmental Effects, Heavy Precipitation: "creatures
 *   in the area have Disadvantage on all Wisdom (Perception) checks", so
 *   heavy rain and heavy snow preset Perception checks.
 * - Strong Wind: "Strong wind imposes Disadvantage on ranged attack rolls with
 *   weapons", so only an attack known to be with a ranged weapon takes it
 *   (2.1). "A strong wind in a desert can create a sandstorm that imposes
 *   Disadvantage on Wisdom (Perception) checks."
 * - Playing the Game, Vision and Light, Obscured Areas: patchy fog's checks
 *   "that rely on sight" and heavy fog's Blinded "when trying to see
 *   something there" need a judgment, so fog only reminds.
 *
 * `quotes` are the SRD's words each rule rests on, and the test checks that
 * every one is in its entry's text, so a rule never says more than the SRD.
 */

/** The weather a rule comes from, the `from` of its advantage source and the key of its reminder. */
export const WEATHER_RULE_KEYS = ["heavy-rain", "heavy-snow", "sandstorm", "strong-wind", "patchy-fog", "heavy-fog"] as const;
export type WeatherRuleKey = (typeof WEATHER_RULE_KEYS)[number];

/** How a roll's source names each, as a condition's does: Disadvantage from "Heavy rain". */
export const WEATHER_RULE_NAMES: Record<WeatherRuleKey, string> = {
  "heavy-rain": "Heavy rain",
  "heavy-snow": "Heavy snow",
  sandstorm: "Sandstorm",
  "strong-wind": "Strong wind",
  "patchy-fog": "Patchy fog",
  "heavy-fog": "Heavy fog",
};

export function isWeatherRuleKey(key: string): key is WeatherRuleKey {
  return (WEATHER_RULE_KEYS as readonly string[]).includes(key);
}

type WeatherRule = {
  key: WeatherRuleKey;
  /** Where the rule's text lives in rules-text.json's `environment`. */
  source: EnvironmentKey;
  quotes: readonly string[];
  /** Whether the scene's weather brings it. */
  brings(w: SceneWeather): boolean;
  /** Whether it bears on this roll. */
  applies(test: D20Test): boolean;
  does: "dis" | "note";
  text: string;
};

const PERCEPTION = (test: D20Test) => test.kind === "check" && test.skill === "perception";
const ATTACK = (test: D20Test) => test.kind === "attack";

/** An attack with a positive ranged weapon signal: never a spell, never "either" (2.1). */
function rangedWeapon(test: D20Test): boolean {
  return test.kind === "attack" && test.range === "ranged" && test.weapon === true && test.spell !== true;
}

/**
 * An attack that may be ranged and with a weapon but is not known to be both:
 * "Melee or Ranged", a ranged attack not known to be a weapon (Force Bolt,
 * Necrotic Ray, an Ape's Rock) and a weapon with no range. A melee attack, a
 * spell attack and the bare d20, which says nothing, take nothing.
 */
function maybeRangedWeapon(test: D20Test): boolean {
  if (test.kind !== "attack" || test.spell === true || test.range === "melee" || rangedWeapon(test)) return false;
  return test.range !== undefined || test.weapon === true;
}

const strongWind = (w: SceneWeather) => w.wind === "strong";

export const WEATHER_RULES: readonly WeatherRule[] = [
  {
    key: "heavy-rain",
    source: "heavy-precipitation",
    quotes: ["Everything within an area of heavy rain or heavy snowfall is Lightly Obscured", "creatures in the area have Disadvantage on all Wisdom (Perception) checks"],
    brings: (w) => w.kind === "rain" && w.heavy === true,
    applies: PERCEPTION,
    does: "dis",
    text: "Heavy rain: Disadvantage on all Wisdom (Perception) checks.",
  },
  {
    key: "heavy-snow",
    source: "heavy-precipitation",
    quotes: ["Everything within an area of heavy rain or heavy snowfall is Lightly Obscured", "creatures in the area have Disadvantage on all Wisdom (Perception) checks"],
    brings: (w) => w.kind === "snow" && w.heavy === true,
    applies: PERCEPTION,
    does: "dis",
    text: "Heavy snow: Disadvantage on all Wisdom (Perception) checks.",
  },
  {
    key: "sandstorm",
    source: "strong-wind",
    quotes: ["A strong wind in a desert can create a sandstorm that imposes Disadvantage on Wisdom (Perception) checks."],
    brings: (w) => w.kind === "sand" && w.heavy === true,
    applies: PERCEPTION,
    does: "dis",
    text: "Sandstorm: Disadvantage on Wisdom (Perception) checks.",
  },
  {
    key: "strong-wind",
    source: "strong-wind",
    quotes: ["Strong wind imposes Disadvantage on ranged attack rolls with weapons."],
    brings: strongWind,
    applies: rangedWeapon,
    does: "dis",
    text: "Strong wind: Disadvantage on ranged attack rolls with weapons.",
  },
  {
    key: "strong-wind",
    source: "strong-wind",
    quotes: ["Strong wind imposes Disadvantage on ranged attack rolls with weapons."],
    brings: strongWind,
    applies: maybeRangedWeapon,
    does: "note",
    text: "Strong wind: Disadvantage on ranged attack rolls with weapons.",
  },
  {
    key: "patchy-fog",
    source: "obscured-areas",
    quotes: ["In a Lightly Obscured area, such as an area with Dim Light, patchy fog, or moderate foliage, you have Disadvantage on Wisdom (Perception) checks that rely on sight."],
    brings: (w) => w.kind === "fog" && w.heavy !== true,
    applies: PERCEPTION,
    does: "note",
    text: "Patchy fog: Lightly Obscured. Disadvantage on Perception checks that rely on sight.",
  },
  {
    key: "heavy-fog",
    source: "obscured-areas",
    quotes: ["A Heavily Obscured area, such as an area with Darkness, heavy fog, or dense foliage, is opaque.", "You have the Blinded condition", "when trying to see something there"],
    brings: (w) => w.kind === "fog" && w.heavy === true,
    applies: (test) => PERCEPTION(test) || ATTACK(test),
    does: "note",
    text: "Heavy fog: Heavily Obscured. A creature trying to see something in it has the Blinded condition.",
  },
];

export type WeatherReminder = { key: WeatherRuleKey; text: string };
export type WeatherPreset = { sources: AdvantageSource[]; notes: WeatherReminder[] };

/** The rules a weather brings, none with "Weather rules on rolls" off or no weather at all. */
function rulesOf(w: SceneWeather | null | undefined): readonly WeatherRule[] {
  if (!w || w.rules === false) return [];
  return WEATHER_RULES.filter((rule) => rule.brings(w));
}

/** What a scene's weather gives one d20 roll: Disadvantage sources and notes, never a resolved mode. */
export function weatherPreset(w: SceneWeather | null | undefined, test: D20Test): WeatherPreset {
  const out: WeatherPreset = { sources: [], notes: [] };
  for (const rule of rulesOf(w)) {
    if (!rule.applies(test)) continue;
    if (rule.does === "dis") out.sources.push({ kind: "dis", from: rule.key });
    else out.notes.push({ key: rule.key, text: rule.text });
  }
  return out;
}

/** Every reminder a weather gives any of these rolls, presets and notes alike, each once, as a request's card lists them. */
export function weatherReminders(w: SceneWeather | null | undefined, tests: readonly D20Test[]): WeatherReminder[] {
  const out: WeatherReminder[] = [];
  for (const rule of rulesOf(w)) {
    if (!tests.some((t) => rule.applies(t)) || out.some((r) => r.key === rule.key)) continue;
    out.push({ key: rule.key, text: rule.text });
  }
  return out;
}

/** Whether a weather has any rule, so the fold shows its "Weather rules on rolls" switch. It ignores the switch itself. */
export function weatherHasRules(w: SceneWeather | null | undefined): boolean {
  return w ? WEATHER_RULES.some((rule) => rule.brings(w)) : false;
}

/**
 * One weather part's rule as Light and weather lists it under its switch
 * (docs/design/design-v1-polish-pass.md 3.2): its name, then what the SRD
 * says in the SRD's words. Heavy fog's is a Note, the warning a setting's
 * cost wears, since the map cannot hide what the fog would.
 */
export type WeatherRuleLine = {
  name: string;
  text: string;
  /** The app's own advice, kept apart from `text` so the check of the SRD's words leaves it out. */
  advice?: string;
  tone: "help" | "note";
  /** Where `quotes` live in rules-text.json's `environment`. */
  source: EnvironmentKey;
  /** The SRD's words `text` rests on: the test checks each is in its entry and each rule term of `text` is in one of them. */
  quotes: readonly string[];
};

const LIGHTLY_OBSCURED = "Everything within an area of heavy rain or heavy snowfall is Lightly Obscured";
const ALL_PERCEPTION = "creatures in the area have Disadvantage on all Wisdom (Perception) checks";

const RULE_LINES: Record<WeatherRuleKey, Omit<WeatherRuleLine, "name">> = {
  "heavy-rain": {
    text: "Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks. Puts out open flames.",
    tone: "help",
    source: "heavy-precipitation",
    quotes: [LIGHTLY_OBSCURED, ALL_PERCEPTION, "Heavy rain also extinguishes open flames."],
  },
  "heavy-snow": {
    text: "Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks.",
    tone: "help",
    source: "heavy-precipitation",
    quotes: [LIGHTLY_OBSCURED, ALL_PERCEPTION],
  },
  sandstorm: {
    text: "Disadvantage on Wisdom (Perception) checks.",
    tone: "help",
    source: "strong-wind",
    quotes: ["A strong wind in a desert can create a sandstorm that imposes Disadvantage on Wisdom (Perception) checks."],
  },
  "strong-wind": {
    text: "Disadvantage on ranged attack rolls with weapons. Puts out open flames, and a flying creature must land at the end of its turn or fall.",
    tone: "help",
    source: "strong-wind",
    quotes: ["Strong wind imposes Disadvantage on ranged attack rolls with weapons.", "It also extinguishes open flames", "A flying creature in a strong wind must land at the end of its turn or fall."],
  },
  "patchy-fog": {
    text: "Lightly Obscured, so Wisdom (Perception) checks that rely on sight have Disadvantage.",
    tone: "help",
    source: "obscured-areas",
    quotes: ["In a Lightly Obscured area, such as an area with Dim Light, patchy fog, or moderate foliage, you have Disadvantage on Wisdom (Perception) checks that rely on sight."],
  },
  "heavy-fog": {
    text: "Heavily Obscured, so a creature trying to see something in it has the Blinded condition.",
    advice: "The map still shows what light and walls allow, so hide what the party could not see.",
    tone: "note",
    source: "obscured-areas",
    quotes: ["A Heavily Obscured area, such as an area with Darkness, heavy fog, or dense foliage, is opaque.", "You have the Blinded condition", "when trying to see something there"],
  },
};

/*
 * What rolls here do with "Weather rules on rolls" on: the tests the
 * weather presets, then the ones it reminds. Five sentences cover every
 * weather that has a rule, since fog cannot have a strong wind
 * (shared/weather.ts weatherProblem). A table reads plainer than words
 * built from the rules' predicates, and weather.test.ts checks each
 * against weatherPreset in every valid weather.
 */
const ROLLS = {
  perception: "Perception checks here roll with Disadvantage.",
  perceptionAndWind: "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.",
  wind: "Ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.",
  patchyFog: "Perception checks here get a reminder.",
  heavyFog: "Perception checks and attacks here get a reminder.",
} as const;

const RULES_OFF = "Rolls here ignore these rules.";
const LOOK_ONLY = "A look only. The rules stay as they are.";

/** The sentence for a weather that has a rule, with the switch on. */
function rollsOn(w: SceneWeather): string {
  if (w.kind === "fog") return w.heavy === true ? ROLLS.heavyFog : ROLLS.patchyFog;
  // Heavy rain, heavy snow and a sandstorm preset Perception checks. The rest that has a rule is a strong wind alone.
  const perception = w.heavy === true && (w.kind === "rain" || w.kind === "snow" || w.kind === "sand");
  if (w.wind === "strong") return perception ? ROLLS.perceptionAndWind : ROLLS.wind;
  return ROLLS.perception;
}

/**
 * Light and weather's rules for a weather: one line per part that brings a
 * rule, the kind's then the wind's, and `rolls`, the switch's help, saying
 * in one sentence what rolls here do. With the switch off the lines stay,
 * since the SRD still says them, and `rolls` says rolls ignore them. A
 * weather with no rule has no switch, no lines, and says it is a look only.
 */
export function weatherRuleLines(w: SceneWeather | null | undefined): { lines: WeatherRuleLine[]; rolls: string } {
  if (!w || !weatherHasRules(w)) return { lines: [], rolls: LOOK_ONLY };
  const brought = WEATHER_RULE_KEYS.filter((key) => WEATHER_RULES.some((rule) => rule.key === key && rule.brings(w)));
  const lines = brought.map((key) => ({ name: WEATHER_RULE_NAMES[key], ...RULE_LINES[key] }));
  return { lines, rolls: w.rules === false ? RULES_OFF : rollsOn(w) };
}
