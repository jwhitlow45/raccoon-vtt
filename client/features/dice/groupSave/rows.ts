import { bonusFor, type D20Test } from "#shared/dice/bonus.ts";
import type { AbilityKey, ConditionKey, DiceRoll, RollTarget, SkillKey, Token } from "#shared/model.ts";
import { playersToken } from "#shared/project.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { resultOf } from "#shared/rules/rolls.ts";
import { displayName } from "../../../lib/scene.ts";
import { askTarget } from "../../rolls/logic.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import { presetFor } from "../presets.ts";

/**
 * A group save's rows (docs/design-v1-roll-options.md 5.2 and 5.3): one per
 * creature, each holder once, with its way of rolling, and its result by
 * one precedence, read from what the page holds.
 */

export type GroupTest = { kind: "save"; ability: AbilityKey } | { kind: "check"; ability: AbilityKey; skill?: SkillKey } | { kind: "none" };

/** How a row rolls, in the order a row takes the first that fits. */
export type Way = "fails" | "ask" | "server" | "type";

export type Mark = "fail" | "pass" | "skip";

/** What a row knows before its roll. */
export type RowBase = {
  holder: string;
  /** The creature its roll and outcome name: its token, or its character for a token of one. */
  target: ActorTarget;
  tokenId: string;
  /** The creature a request names: its character for a party character's token, else its token (rolls/logic.ts askTarget). */
  askRef?: ActorTarget;
  name: string;
  /**
   * Its ways in setup, the first the default: a creature a player plays
   * offers Ask, else Server where its bonus is known, else Type. One with no
   * stat block offers Server after Type, with a bonus the DM types (rowBonus).
   */
  ways: Way[];
  bonus: number | null;
  fails?: ConditionKey;
  /** Why it cannot be asked: another scene. */
  why?: string;
  /** An object or the dead: listed last, set to Skip. */
  skip: boolean;
};

export const MAX_GROUP = 100;
export const TOO_MANY = "At most 100 creatures in one group save.";

export function d20Of(test: GroupTest, spell: boolean): D20Test | null {
  if (test.kind === "none") return null;
  if (test.kind === "save") return spell ? { kind: "save", ability: test.ability, spell: true } : { kind: "save", ability: test.ability };
  return test.skill ? { kind: "check", ability: test.ability, skill: test.skill } : { kind: "check", ability: test.ability };
}

/**
 * The rows for these tokens, as hpTargets holds them (client/features/tokens/groupHp.ts):
 * a token of a character stands for its character, so two tokens of one
 * character are one row. The living first by name, then objects and the
 * dead, Skip from the start.
 */
export function groupRows(dice: DiceView, tokenIds: readonly string[], test: GroupTest, spell: boolean): RowBase[] {
  const state = dice.view;
  const seen = new Set<string>();
  const out: RowBase[] = [];
  const d20 = d20Of(test, spell);
  for (const id of tokenIds) {
    const token: Token | undefined = state.tokens[id];
    if (!token) continue;
    const holder = "ref" in token.actor ? `character:${token.actor.ref}` : `token:${token.id}`;
    if (seen.has(holder)) continue;
    seen.add(holder);
    const actor = "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
    const target: ActorTarget = { tokenId: token.id };
    const rolls = creatureRolls(dice, target);
    const bonus = d20 && rolls?.numbers ? bonusFor(rolls.numbers, d20) : null;
    const preset = d20 ? presetFor(dice, target, d20, { rolls }) : null;
    const played = playersToken(state, token) && token.kind !== "object";
    const ask = played ? askTarget(state, token) : null;
    const ways: Way[] = [];
    if (preset?.fails) ways.push("fails");
    if (ask && !ask.blocked) ways.push("ask");
    if (bonus !== null) ways.push("server");
    ways.push("type");
    if (bonus === null && d20 && token.kind !== "object") ways.push("server");
    out.push({
      holder,
      target,
      tokenId: token.id,
      ...(ask && !ask.blocked ? { askRef: ask.ref } : {}),
      name: displayName(token),
      ways,
      bonus,
      ...(preset?.fails ? { fails: preset.fails } : {}),
      ...(ask?.blocked && ask.why ? { why: ask.why } : {}),
      skip: token.kind === "object" || actor?.life === "dead",
    });
  }
  const last = (r: RowBase) => Number(r.skip);
  return out.sort((a, b) => last(a) - last(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A row's bonus for its server roll: its creature's, else the one the DM typed for a creature with no stat block, else none. */
export function rowBonus(row: Pick<RowBase, "bonus">, state: Pick<RowState, "typedBonus">): number | null {
  return row.bonus ?? state.typedBonus ?? null;
}

/** What a row holds once rolled, copied as it lands so a request closed elsewhere leaves it as it was. */
export type RowState = {
  way: Way;
  mark?: Mark;
  typed?: number;
  /** The server's roll of it. */
  rolled?: DiceRoll;
  /** The request's answer for it, copied whole as it arrived. */
  answer?: RollTarget;
  /** The request it was asked in and that request's DC. */
  asked?: { rollId: string; dc?: number };
  /** Its batch, and how that batch's receipt settled for it. */
  batch?: { tag: string; part: number };
  status?: "notRolled" | "unknown" | "notAsked";
  /** The words of a refusal: "Not asked: 20 requests are open", "Not rolled: you are going too fast". */
  says?: string;
  /** The DM's typed amount, which wins over the outcome's. */
  amount?: number;
  /** The bonus the DM typed for a row with no stat block, which its server roll takes (rowBonus). */
  typedBonus?: number;
  legendary?: boolean;
  evasion?: boolean;
  qualifiedOn?: string[];
  /** The DM's override of the condition rule: on whatever it says, off whatever it says. */
  conditions?: "on" | "off";
  /** The creature left the view after the roll. */
  gone?: boolean;
};

/**
 * A row's result (5.3): the DM's mark on this page, then for an asked row
 * doc 4's `resultOf` over the answer against the page's DC (the live card's
 * mark, the condition's fail on a rolled answer, a fail without rolling,
 * then the total), then for any other row its automatic fail, then its
 * total against the page's DC, else none. Read from the answer's stored
 * provenance, never inferred from its numbers. With No save every row
 * fails unless marked.
 */
export function rowResult(row: Pick<RowBase, "fails">, state: RowState, test: GroupTest, dc: number | null): Mark | null {
  if (state.mark) return state.mark;
  if (test.kind === "none") return "fail";
  if (state.answer) return resultOf(state.answer, dc ?? undefined) ?? null;
  if (state.asked) return null;
  if (state.way === "fails" && row.fails) return "fail";
  if (state.rolled?.fails) return "fail";
  const total = state.rolled?.total ?? state.typed;
  if (total === undefined || dc === null) return null;
  return total >= dc ? "pass" : "fail";
}

/** A row's total as the page shows it: the server's roll, the request's newest answer, or the typed one. */
export function rowTotal(state: RowState): number | undefined {
  return state.answer?.total ?? state.rolled?.total ?? state.typed;
}

/** The setup's count of its rows: "1 creature", "3 creatures". */
export function creatureCount(n: number): string {
  return `${n} ${n === 1 ? "creature" : "creatures"}`;
}

/** The header's count: "4 pass, 2 fail, 1 waiting". */
export function countWords(results: readonly (Mark | null)[]): string {
  const pass = results.filter((r) => r === "pass").length;
  const fail = results.filter((r) => r === "fail").length;
  const waiting = results.filter((r) => r === null).length;
  return [`${pass} pass`, `${fail} fail`, ...(waiting > 0 ? [`${waiting} waiting`] : [])].join(", ");
}
