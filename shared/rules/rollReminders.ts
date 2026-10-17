import type { D20Test } from "../dice/bonus.ts";
import type { AdvantageSource } from "../dice/formula.ts";
import type { AbilityKey, ConditionKey, Effect, RollTest, StatusKey } from "../model.ts";
import { INCAPACITATING_KEYS } from "./hp.ts";

/**
 * What a creature's conditions and statuses do to a d20 roll
 * (docs/design-v1-dm-tools.md 3.3, docs/design-v1-roll-options.md 3.2 and
 * Appendix C), from their SRD 5.2.1 text in shared/srd/rules-text.json. One
 * table for every d20 roll the app makes: saves (concentration and save-ends
 * saves among them), death saves, checks, initiative and attacks.
 *
 * A rule presets the roll (an advantage or disadvantage source, an extra die
 * or number, an automatic fail) only where it holds without a judgment the
 * app cannot make. The rules that need sight, hearing, a source of fear or
 * the hex's ability remind only. The exceptions a rule's own words state,
 * such as Dodge lost at Speed 0, are part of the rule, so a preset never
 * applies where the rule says it does not.
 *
 * `quotes` are the SRD's own words each rule rests on, and the test checks
 * that every quote is in its rule's text, so a rule never says more than
 * the SRD. An effect the DM hid is not in the player's data, so it never
 * shows there.
 */
export type RollReminder = { key: ConditionKey | StatusKey; text: string };

/** What a creature's effects give one roll: sources for the cancel rule (docs/design-v1-dice.md 3.3), never a resolved mode. */
export type RollPreset = {
  /** `from` is the effect's key, "magic-resistance", or "tracker" for the DM's mark on an initiative row. */
  sources: AdvantageSource[];
  /** Terms to add, in the table's order: "+1d4", "-4". */
  extra: string[];
  /** The effect each extra comes from, in the same order, so a button can say "+1d4: Blessed". Absent with no extra. */
  extraFrom?: string[];
  /** The condition that fails this save whatever its total. */
  fails?: ConditionKey;
  notes: RollReminder[];
};

type Key = ConditionKey | StatusKey;
type Does = { kind: "adv" | "dis" } | { kind: "fails" } | { kind: "extra"; term(effect: Pick<Effect, "level">): string } | { kind: "note" };

type Rule = {
  key: Key;
  /** The effects that bring it, where more than its own key does: every condition that includes Incapacitated. */
  keys?: readonly Key[];
  /** Where the rule's text lives in rules-text.json. */
  source: "conditions" | "statuses";
  /** The SRD's words this rule rests on, each found in the rule's text. */
  quotes: readonly string[];
  /** Whether it bears on this roll. */
  applies(test: D20Test): boolean;
  does: Does;
  /** A preset that is also a note, such as Invisible's advantage, which a target that sees it denies. */
  noted?: true;
  /** The exception the rule's words state: it holds only while this does. */
  holds?(effects: readonly Pick<Effect, "key">[]): boolean;
  /** Initiative's tracker hint (shared/rules/initiative.ts advantageHint), which the row's DM mark replaces. */
  hint?: true;
  text(effect: Pick<Effect, "key" | "level">, test: D20Test): string;
};

const abilityIs = (test: D20Test, ...abilities: AbilityKey[]) => (test.kind === "save" || test.kind === "check") && abilities.includes(test.ability);
const STR_OR_DEX_SAVE = (test: D20Test) => test.kind === "save" && abilityIs(test, "str", "dex");
const DEX_SAVE = (test: D20Test) => test.kind === "save" && abilityIs(test, "dex");
const CHECK = (test: D20Test) => test.kind === "check";
/** A save of any kind, a death save among them, which has no ability. */
const SAVE = (test: D20Test) => test.kind === "save" || test.kind === "deathSave";
const ATTACK = (test: D20Test) => test.kind === "attack";
const INITIATIVE = (test: D20Test) => test.kind === "initiative";
const ANY = () => true;
const has = (effects: readonly Pick<Effect, "key">[], key: Key) => effects.some((e) => e.key === key);
const ADV = { kind: "adv" } as const;
const DIS = { kind: "dis" } as const;
const NOTE = { kind: "note" } as const;

function autoFail(key: "paralyzed" | "petrified" | "stunned" | "unconscious", name: string): Rule {
  return {
    key,
    source: "conditions",
    quotes: ["You automatically fail Strength and Dexterity saving throws."],
    applies: STR_OR_DEX_SAVE,
    does: { kind: "fails" },
    text: () => `${name}: automatically fail Strength and Dexterity saving throws.`,
  };
}

function conditionName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
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
    does: DIS,
    text: () => "Restrained: Disadvantage on Dexterity saving throws.",
  },
  {
    key: "restrained",
    source: "conditions",
    quotes: ["your attack rolls have Disadvantage"],
    applies: ATTACK,
    does: DIS,
    text: () => "Restrained: Disadvantage on attack rolls.",
  },
  {
    key: "blinded",
    source: "conditions",
    quotes: ["automatically fail any ability check that requires sight"],
    applies: CHECK,
    does: NOTE,
    text: () => "Blinded: automatically fail any ability check that requires sight.",
  },
  {
    key: "blinded",
    source: "conditions",
    quotes: ["your attack rolls have Disadvantage"],
    applies: ATTACK,
    does: DIS,
    text: () => "Blinded: Disadvantage on attack rolls.",
  },
  {
    key: "deafened",
    source: "conditions",
    quotes: ["automatically fail any ability check that requires hearing"],
    applies: CHECK,
    does: NOTE,
    text: () => "Deafened: automatically fail any ability check that requires hearing.",
  },
  {
    key: "poisoned",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls and ability checks."],
    applies: CHECK,
    does: DIS,
    text: () => "Poisoned: Disadvantage on ability checks.",
  },
  {
    key: "poisoned",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls and ability checks."],
    applies: ATTACK,
    does: DIS,
    text: () => "Poisoned: Disadvantage on attack rolls.",
  },
  {
    // Initiative is a Dexterity check in 2024.
    key: "poisoned",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls and ability checks."],
    applies: INITIATIVE,
    does: DIS,
    text: () => "Poisoned: Disadvantage on Initiative, a Dexterity check.",
  },
  {
    key: "prone",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls."],
    applies: ATTACK,
    does: DIS,
    text: () => "Prone: Disadvantage on attack rolls.",
  },
  {
    key: "frightened",
    source: "conditions",
    quotes: ["You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight."],
    applies: CHECK,
    does: NOTE,
    text: () => "Frightened: Disadvantage on ability checks while the source of fear is within line of sight.",
  },
  {
    key: "frightened",
    source: "conditions",
    quotes: ["You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight."],
    applies: ATTACK,
    does: NOTE,
    text: () => "Frightened: Disadvantage on attack rolls while the source of fear is within line of sight.",
  },
  {
    key: "grappled",
    source: "conditions",
    quotes: ["You have Disadvantage on attack rolls against any target other than the grappler."],
    applies: ATTACK,
    does: NOTE,
    text: () => "Grappled: Disadvantage on attack rolls against any target other than the grappler.",
  },
  {
    key: "surprised",
    source: "statuses",
    quotes: ["which causes it to have Disadvantage on its Initiative roll"],
    applies: INITIATIVE,
    does: DIS,
    hint: true,
    text: () => "Surprised: Disadvantage on Initiative.",
  },
  {
    key: "incapacitated",
    keys: [...INCAPACITATING_KEYS] as Key[],
    source: "conditions",
    quotes: ["If you're Incapacitated when you roll Initiative, you have Disadvantage on the roll."],
    applies: INITIATIVE,
    does: DIS,
    hint: true,
    text: (effect) => (effect.key === "incapacitated" ? "Incapacitated: Disadvantage on Initiative." : `${conditionName(effect.key)}: Disadvantage on Initiative, as Incapacitated.`),
  },
  {
    // A D20 Test is any check, save or attack roll, so Exhaustion bears on every d20 roll.
    key: "exhaustion",
    source: "conditions",
    quotes: ["When you make a D20 Test, the roll is reduced by 2 times your Exhaustion level."],
    applies: ANY,
    does: { kind: "extra", term: (effect) => `-${2 * (effect.level ?? 1)}` },
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
    does: NOTE,
    text: () => "Hexed: Disadvantage on ability checks made with the ability the hex chose.",
  },
  {
    key: "baned",
    source: "statuses",
    quotes: ["the target must subtract 1d4 from the attack roll or save"],
    applies: (test) => SAVE(test) || ATTACK(test),
    does: { kind: "extra", term: () => "-1d4" },
    text: (_effect, test) => (ATTACK(test) ? "Baned: subtract 1d4 from the attack roll." : "Baned: subtract 1d4 from the save."),
  },
  {
    key: "dodging",
    source: "statuses",
    quotes: ["you make Dexterity saving throws with Advantage", "You lose these benefits if you have the Incapacitated condition or if your Speed is 0."],
    applies: DEX_SAVE,
    does: ADV,
    // Grappled and Restrained each set Speed 0.
    holds: (effects) => !incapacitated(effects) && !has(effects, "grappled") && !has(effects, "restrained"),
    text: () => "Dodging: Advantage on Dexterity saving throws, lost if you have the Incapacitated condition or if your Speed is 0.",
  },
  {
    key: "hasted",
    source: "statuses",
    quotes: ["it has Advantage on Dexterity saving throws"],
    applies: DEX_SAVE,
    does: ADV,
    text: () => "Hasted: Advantage on Dexterity saving throws.",
  },
  {
    key: "raging",
    source: "statuses",
    quotes: ["You have Advantage on Strength checks and Strength saving throws.", "it ends early if you don Heavy armor or have the Incapacitated condition"],
    applies: (test) => abilityIs(test, "str"),
    does: ADV,
    holds: (effects) => !incapacitated(effects),
    text: () => "Raging: Advantage on Strength checks and Strength saving throws, ended early by Heavy armor or the Incapacitated condition.",
  },
  {
    key: "invisible",
    source: "conditions",
    quotes: ["your attack rolls have Advantage", "If a creature can somehow see you, you don't gain this benefit against that creature."],
    applies: ATTACK,
    does: ADV,
    noted: true,
    text: () => "Invisible: Advantage on attack rolls, but not against a creature that can see you.",
  },
  {
    key: "invisible",
    source: "conditions",
    quotes: ["If you're Invisible when you roll Initiative, you have Advantage on the roll."],
    applies: INITIATIVE,
    does: ADV,
    hint: true,
    text: () => "Invisible: Advantage on Initiative.",
  },
  {
    key: "blessed",
    source: "statuses",
    quotes: ["the target adds 1d4 to the attack roll or save"],
    applies: (test) => SAVE(test) || ATTACK(test),
    does: { kind: "extra", term: () => "+1d4" },
    text: (_effect, test) => (ATTACK(test) ? "Blessed: add 1d4 to the attack roll." : "Blessed: add 1d4 to the save."),
  },
  {
    key: "heroic-inspiration",
    source: "statuses",
    quotes: ["you can expend it to reroll any die immediately after rolling it"],
    applies: ANY,
    does: NOTE,
    text: () => "Heroic Inspiration: you can spend it to reroll any die immediately after rolling it.",
  },
];

/** The effect that brings a rule, the first of them, or none, so a rule counts once for an effect held twice. */
function present<E extends Pick<Effect, "key">>(rule: Rule, effects: readonly E[]): E | undefined {
  const keys = rule.keys ?? [rule.key];
  return effects.find((e) => (keys as readonly string[]).includes(e.key));
}

/** A request's choice as the d20 roll it asks for. */
function choiceTest(kind: RollTest["kind"], choice: RollTest["choices"][number]): D20Test {
  if (kind === "save") return { kind: "save", ability: choice.ability };
  return choice.skill ? { kind: "check", ability: choice.ability, skill: choice.skill } : { kind: "check", ability: choice.ability };
}

/**
 * The reminders a creature's effects give for a requested test. With
 * `choice`, only that one of the test's choices counts, as on a card where
 * the player picked which one they rolled. Otherwise any choice the request
 * offers does. Each rule shows once, even for an effect held twice, and a
 * rule its own exception ends shows none.
 */
export function rollReminders(effects: readonly Pick<Effect, "key" | "level">[], test: RollTest, choice?: number): RollReminder[] {
  const choices = choice === undefined ? test.choices : test.choices.slice(choice, choice + 1);
  const out: RollReminder[] = [];
  for (const rule of ROLL_REMINDER_RULES) {
    const effect = present(rule, effects);
    if (!effect || (rule.holds && !rule.holds(effects))) continue;
    const asked = choices.map((c) => choiceTest(test.kind, c)).find((t) => rule.applies(t));
    if (!asked || out.some((r) => r.key === rule.key)) continue;
    out.push({ key: rule.key, text: rule.text(effect, asked) });
  }
  return out;
}

/**
 * Every source, extra and automatic fail a creature's effects give one d20
 * roll (docs/design-v1-roll-options.md 3.2), unresolved, so the roll
 * combines them with every other source once (docs/design-v1-dice.md 3.3).
 * A save against a spell is the test's own `spell`, which a creature with
 * Magic Resistance makes with advantage. On initiative, `mark` is the DM's
 * reminder on the creature's row, which replaces the tracker's hint
 * (Invisible, Surprised, Incapacitated) and keeps Poisoned and Exhaustion.
 */
export function reminderPreset(effects: readonly Pick<Effect, "key" | "level">[], test: D20Test, ctx: { magicResistance?: boolean; mark?: "adv" | "dis" } = {}): RollPreset {
  const out: RollPreset = { sources: [], extra: [], notes: [] };
  const marked = test.kind === "initiative" && ctx.mark !== undefined;
  if (marked) out.sources.push({ kind: ctx.mark!, from: "tracker" });
  for (const rule of ROLL_REMINDER_RULES) {
    const effect = present(rule, effects);
    if (!effect || !rule.applies(test) || (rule.holds && !rule.holds(effects)) || (marked && rule.hint)) continue;
    const does = rule.does;
    if (does.kind === "adv" || does.kind === "dis") out.sources.push({ kind: does.kind, from: effect.key });
    else if (does.kind === "fails") out.fails ??= effect.key as ConditionKey;
    else if (does.kind === "extra") {
      out.extra.push(does.term(effect));
      (out.extraFrom ??= []).push(effect.key);
    }
    if (does.kind === "note" || rule.noted) out.notes.push({ key: rule.key, text: rule.text(effect, test) });
  }
  if (ctx.magicResistance && test.kind === "save" && test.spell) out.sources.push({ kind: "adv", from: "magic-resistance" });
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

/**
 * The condition that fails a save whatever its total (docs/design-v1-dice.md
 * 4.2): Paralyzed, Petrified, Stunned or Unconscious on a Strength or
 * Dexterity save, by the table above, among the creature's effects its
 * players may see. The server stores it on a rolled save as `fails`, so a
 * line never reveals a condition the DM hid, and replay never reads these
 * rules.
 */
export function failingCondition(effects: readonly Pick<Effect, "key" | "level" | "hiddenFromPlayers">[], test: D20Test): ConditionKey | undefined {
  return reminderPreset(
    effects.filter((e) => e.hiddenFromPlayers !== true),
    test,
  ).fails;
}
