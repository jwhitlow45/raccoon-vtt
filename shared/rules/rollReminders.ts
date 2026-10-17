import type { AbilityKey, ConditionKey, Effect, RollTest, StatusKey } from "../model.ts";
import { INCAPACITATING_KEYS } from "./hp.ts";

/**
 * What a creature's conditions and statuses say about a requested roll
 * (docs/design-v1-dm-tools.md 3.3), from their SRD 5.2.1 text in
 * shared/srd/rules-text.json. The player's roll card shows each one that
 * bears on what was asked. They remind and decide nothing: the app rolls no
 * dice, and the player applies Advantage or a penalty to the dice they roll.
 *
 * `quote` is the SRD's own words each reminder rests on, and the test
 * checks that every quote is in its rule's text, so a reminder never says
 * more than the rule. An effect the DM hid is not in the player's data, so
 * it never shows here.
 */
export type RollReminder = { key: ConditionKey | StatusKey; text: string };

type Rule = {
  key: ConditionKey | StatusKey;
  /** Where the rule's text lives in rules-text.json. */
  source: "conditions" | "statuses";
  /** The SRD's words this reminder rests on, each found in the rule's text. */
  quotes: readonly string[];
  /** Whether it bears on one choice of the test. */
  applies(kind: RollTest["kind"], ability: AbilityKey): boolean;
  text(effect: Pick<Effect, "level">): string;
};

const STR_OR_DEX_SAVE = (kind: RollTest["kind"], ability: AbilityKey) => kind === "save" && (ability === "str" || ability === "dex");
const DEX_SAVE = (kind: RollTest["kind"], ability: AbilityKey) => kind === "save" && ability === "dex";
const CHECK = (kind: RollTest["kind"]) => kind === "check";
const SAVE = (kind: RollTest["kind"]) => kind === "save";
const ANY = () => true;

function autoFail(key: "paralyzed" | "petrified" | "stunned" | "unconscious", name: string): Rule {
  return {
    key,
    source: "conditions",
    quotes: ["You automatically fail Strength and Dexterity saving throws."],
    applies: STR_OR_DEX_SAVE,
    text: () => `${name}: automatically fail Strength and Dexterity saving throws.`,
  };
}

/** In the order the card lists them: what fails or hinders a roll first, then what helps. */
export const ROLL_REMINDER_RULES: readonly Rule[] = [
  autoFail("paralyzed", "Paralyzed"),
  autoFail("petrified", "Petrified"),
  autoFail("stunned", "Stunned"),
  autoFail("unconscious", "Unconscious"),
  {
    key: "restrained",
    source: "conditions",
    quotes: ["You have Disadvantage on Dexterity saving throws."],
    applies: DEX_SAVE,
    text: () => "Restrained: Disadvantage on Dexterity saving throws.",
  },
  {
    key: "blinded",
    source: "conditions",
    quotes: ["automatically fail any ability check that requires sight"],
    applies: CHECK,
    text: () => "Blinded: automatically fail any ability check that requires sight.",
  },
  {
    key: "deafened",
    source: "conditions",
    quotes: ["automatically fail any ability check that requires hearing"],
    applies: CHECK,
    text: () => "Deafened: automatically fail any ability check that requires hearing.",
  },
  {
    key: "poisoned",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls and ability checks."],
    applies: CHECK,
    text: () => "Poisoned: Disadvantage on ability checks.",
  },
  {
    key: "frightened",
    source: "conditions",
    quotes: ["You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight."],
    applies: CHECK,
    text: () => "Frightened: Disadvantage on ability checks while the source of fear is within line of sight.",
  },
  {
    // A D20 Test is any check or save, so Exhaustion bears on every request.
    key: "exhaustion",
    source: "conditions",
    quotes: ["When you make a D20 Test, the roll is reduced by 2 times your Exhaustion level."],
    applies: ANY,
    text: (effect) => {
      const level = effect.level ?? 1;
      return `Exhaustion ${level}: the roll is reduced by ${2 * level}.`;
    },
  },
  {
    key: "hexed",
    source: "statuses",
    // The effect does not store which ability the hex chose, so the reminder stays general.
    quotes: ["The target has Disadvantage on ability checks made with the chosen ability."],
    applies: CHECK,
    text: () => "Hexed: Disadvantage on ability checks made with the ability the hex chose.",
  },
  {
    key: "baned",
    source: "statuses",
    quotes: ["the target must subtract 1d4 from the attack roll or save"],
    applies: SAVE,
    text: () => "Baned: subtract 1d4 from the save.",
  },
  {
    key: "dodging",
    source: "statuses",
    quotes: ["you make Dexterity saving throws with Advantage", "You lose these benefits if you have the Incapacitated condition or if your Speed is 0."],
    applies: DEX_SAVE,
    text: () => "Dodging: Advantage on Dexterity saving throws, lost if you have the Incapacitated condition or if your Speed is 0.",
  },
  {
    key: "hasted",
    source: "statuses",
    quotes: ["it has Advantage on Dexterity saving throws"],
    applies: DEX_SAVE,
    text: () => "Hasted: Advantage on Dexterity saving throws.",
  },
  {
    key: "raging",
    source: "statuses",
    quotes: ["You have Advantage on Strength checks and Strength saving throws.", "it ends early if you don Heavy armor or have the Incapacitated condition"],
    applies: (_kind, ability) => ability === "str",
    text: () => "Raging: Advantage on Strength checks and Strength saving throws, ended early by Heavy armor or the Incapacitated condition.",
  },
  {
    key: "blessed",
    source: "statuses",
    quotes: ["the target adds 1d4 to the attack roll or save"],
    applies: SAVE,
    text: () => "Blessed: add 1d4 to the save.",
  },
  {
    key: "heroic-inspiration",
    source: "statuses",
    quotes: ["you can expend it to reroll any die immediately after rolling it"],
    applies: ANY,
    text: () => "Heroic Inspiration: you can spend it to reroll any die immediately after rolling it.",
  },
];

/**
 * The reminders a creature's effects give for a requested test. With
 * `choice`, only that one of the test's choices counts, as on a card where
 * the player picked which one they rolled. Otherwise any choice the request
 * offers does. Each rule shows once, even for an effect held twice.
 */
export function rollReminders(effects: readonly Pick<Effect, "key" | "level">[], test: RollTest, choice?: number): RollReminder[] {
  const choices = choice === undefined ? test.choices : test.choices.slice(choice, choice + 1);
  const out: RollReminder[] = [];
  for (const rule of ROLL_REMINDER_RULES) {
    const effect = effects.find((e) => e.key === rule.key);
    if (!effect || !choices.some((c) => rule.applies(test.kind, c.ability))) continue;
    out.push({ key: rule.key, text: rule.text(effect) });
  }
  return out;
}

/**
 * Whether a creature has the Incapacitated condition or one that includes
 * it (docs/design-v1-roll-options.md 3.2). Every rule that ends with
 * Incapacitated asks this one predicate, in presets and defenses alike:
 * Rage's advantage and resistance, Evasion, and Dodging.
 */
export function incapacitated(effects: readonly Pick<Effect, "key">[]): boolean {
  return effects.some((e) => INCAPACITATING_KEYS.has(e.key));
}

/** The conditions whose rule fails a Strength or Dexterity save outright, in the order the card lists them. */
const SAVE_FAILERS: readonly ConditionKey[] = ["paralyzed", "petrified", "stunned", "unconscious"];

/**
 * The condition that fails a save whatever its total (docs/design-v1-dice.md
 * 4.2): Paralyzed, Petrified, Stunned or Unconscious on a Strength or
 * Dexterity save, by the rules above, among the creature's effects its
 * players may see. The server stores it on a rolled save as `fails`, so a
 * line never reveals a condition the DM hid, and replay never reads these
 * rules. Docs/design-v1-roll-options.md's presets take this over with every
 * other source.
 */
export function failingCondition(effects: readonly Pick<Effect, "key" | "hiddenFromPlayers">[], test: { kind: string; ability?: AbilityKey }): ConditionKey | undefined {
  if (test.kind !== "save" || (test.ability !== "str" && test.ability !== "dex")) return undefined;
  return SAVE_FAILERS.find((key) => effects.some((e) => e.key === key && e.hiddenFromPlayers !== true));
}
