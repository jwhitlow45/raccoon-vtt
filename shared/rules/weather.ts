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

/** The fold's rules line (4.1): Help, or a Note for heavy fog's warning. */
export type WeatherRulesLine = { tone: "help" | "note"; text: string };

const RULES_OFF = "Rolls here ignore it.";
const LOOK_ONLY = "A look only. The rules stay as they are.";

/**
 * The fold's rules line for a weather, from its rules in section 2's words.
 * Each part says what the SRD says and then what rolls here do, and with
 * "Weather rules on rolls" off the rolls' part gives way to "Rolls here
 * ignore it.", since nothing then presets or reminds.
 */
export function weatherRules(w: SceneWeather | null | undefined): WeatherRulesLine {
  if (!w || !weatherHasRules(w)) return { tone: "help", text: LOOK_ONLY };
  const on = w.rules !== false;
  const parts: string[] = [];
  if (w.kind === "rain" && w.heavy === true) {
    parts.push("Everything here is Lightly Obscured, and creatures have Disadvantage on all Wisdom (Perception) checks. Heavy rain puts out open flames.");
    if (on) parts.push("Perception checks here roll with Disadvantage.");
  } else if (w.kind === "snow" && w.heavy === true) {
    parts.push("Everything here is Lightly Obscured, and creatures have Disadvantage on all Wisdom (Perception) checks.");
    if (on) parts.push("Perception checks here roll with Disadvantage.");
  } else if (w.kind === "sand" && w.heavy === true) {
    parts.push("A sandstorm puts Disadvantage on Wisdom (Perception) checks.");
    if (on) parts.push("Perception checks here roll with Disadvantage.");
  } else if (w.kind === "fog" && w.heavy === true) {
    parts.push("Heavily Obscured: a creature trying to see something in it has the Blinded condition. The map still shows what light and walls allow, so hide what the party could not see.");
  } else if (w.kind === "fog") {
    parts.push("Lightly Obscured: Disadvantage on Wisdom (Perception) checks that rely on sight.");
    if (on) parts.push("Perception checks here remind.");
  }
  if (w.wind === "strong") {
    parts.push("Disadvantage on ranged attack rolls with weapons. Strong wind puts out open flames, and a flying creature must land at the end of its turn or fall.");
    if (on) parts.push("Attacks with a ranged weapon here roll with Disadvantage, and other ranged attacks remind.");
  }
  if (!on) parts.push(RULES_OFF);
  return { tone: w.kind === "fog" && w.heavy === true ? "note" : "help", text: parts.join(" ") };
}
