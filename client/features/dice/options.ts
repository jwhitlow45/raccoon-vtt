import type { D20Test, DamagePart, NamedRoll } from "#shared/dice/bonus.ts";
import { d20Formula, doubleDice, formatFormula, parseFormula } from "#shared/dice/formula.ts";
import { keptD20 } from "#shared/dice/roll.ts";
import { LIMITS } from "#shared/limits.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import type { CharacterId, DiceRoll, InitEntry, LogEntry, RollRequest, RollTarget, RoomState, TokenId } from "#shared/model.ts";
import { findEntryFor } from "#shared/rules/durations.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { effectName } from "#shared/logText.ts";
import type { PanelRoll } from "./useDicePanel.ts";

/**
 * The rules of the Dice panel's roll options (docs/design-v1-roll-options.md
 * 4), free of React so node --test covers them: each option's label and
 * roll, where a save or check tap goes, initiative written only to an
 * unchanged row, a damage tap's one line, and how a result reads on its
 * row.
 */

/** A label cut to fit a roll's 60 characters (doc 1 3.3), whole words kept where they fit. */
export function cutLabel(text: string): string {
  if (text.length <= LIMITS.diceLabelChars) return text;
  const cut = text.slice(0, LIMITS.diceLabelChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A d20 test as a roll's label names it: "Dexterity save", "Stealth check", "Initiative", "Death save" (4.2). */
export function testLabel(test: D20Test): string {
  switch (test.kind) {
    case "save":
      return test.cause === "concentration" ? "Concentration save" : `${ABILITY_NAMES[test.ability]} save`;
    case "check":
      return test.skill ? `${SKILLS[test.skill].name} check` : `${ABILITY_NAMES[test.ability]} check`;
    case "initiative":
      return "Initiative";
    case "deathSave":
      return "Death save";
    case "attack":
      return "Attack";
  }
}

/** "+2", "-1", "+0". */
export function signedText(n: number): string {
  return n < 0 ? `${n}` : `+${n}`;
}

const SOURCE_NAMES: Record<string, string> = { "magic-resistance": "Magic Resistance", tracker: "the tracker" };

/** A preset source's key as a button names it: "Restrained", "Magic Resistance". */
export function sourceName(from: string): string {
  return SOURCE_NAMES[from] ?? effectName(from);
}

/**
 * A preset in a few words, the button's second line (4.2, Appendix D):
 * "Fails: Stunned", "Dis: Restrained", "+1d4: Blessed", "Adv: Hasted. Dis:
 * Restrained", empty for none. Each extra names the effect it comes from.
 */
export function presetLine(preset: RollPreset): string {
  const extraNames = (preset.extraFrom ?? []).map(sourceName);
  if (preset.fails) return `Fails: ${effectName(preset.fails)}`;
  const parts: string[] = [];
  const adv = preset.sources.filter((s) => s.kind === "adv").map((s) => sourceName(s.from));
  const dis = preset.sources.filter((s) => s.kind === "dis").map((s) => sourceName(s.from));
  if (adv.length > 0) parts.push(`Adv: ${adv.join(", ")}`);
  if (dis.length > 0) parts.push(`Dis: ${dis.join(", ")}`);
  preset.extra.forEach((term, i) => parts.push(extraNames[i] ? `${term}: ${extraNames[i]}` : term));
  return parts.join(". ");
}

/** A formula with the preset's extra terms after it, "1d20+2" with "-2" and "+1d4" as "1d20+2-2+1d4", canonical. */
export function withExtra(formula: string, extra: readonly string[]): string {
  if (extra.length === 0) return formula;
  const joined = [formula, ...extra.map((t) => (/^[+-]/.test(t) ? t : `+${t}`))].join("");
  const parsed = parseFormula(joined);
  return parsed.ok ? formatFormula(parsed.formula) : formula;
}

/** A d20 roll for one creature: its bonus, the preset's extra and sources, and its label. */
export function d20Roll(creature: ActorTarget, bonus: number, preset: RollPreset, label: string, critOn?: 18 | 19): PanelRoll {
  const roll: PanelRoll = { formula: withExtra(d20Formula(bonus), preset.extra), label: cutLabel(label), creature, sources: [...preset.sources] };
  if (critOn !== undefined) roll.critOn = critOn;
  return roll;
}

/** A roll as a save of its test's ability, so the server records the condition that fails it (W7B-P-21). Any other test leaves it as it is. */
export function asSave(roll: PanelRoll, test: D20Test): PanelRoll {
  return test.kind === "save" ? { ...roll, save: test.ability } : roll;
}

// ------------------------------------------------------------ routing

/** Where a save or check tap goes (4.2, 4.3). */
export type Route =
  /** An open request asks this creature this test and it has not answered: the tap answers it. */
  | { kind: "answer"; request: RollRequest; target: RollTarget; choice: number }
  /** A creature a player plays, for the DM with Ask on: the request sheet opens with this test. */
  | { kind: "ask" }
  | { kind: "roll" };

/** The creature a request target or a tap names, as one id: a token of a character is its character. */
export function creatureKey(state: Pick<RoomState, "tokens">, creature: { tokenId?: TokenId; characterId?: CharacterId }): string {
  if (creature.characterId !== undefined) return `c:${creature.characterId}`;
  const token = creature.tokenId !== undefined ? state.tokens[creature.tokenId] : undefined;
  if (token && "ref" in token.actor) return `c:${token.actor.ref}`;
  return `t:${creature.tokenId ?? ""}`;
}

function sameTest(choice: RollRequest["test"]["choices"][number], kind: RollRequest["test"]["kind"], test: D20Test): boolean {
  if (test.kind === "save") return kind === "save" && choice.ability === test.ability;
  if (test.kind === "check") return kind === "check" && choice.ability === test.ability && (choice.skill ?? null) === (test.skill ?? null);
  return false;
}

/**
 * A save or check tap's route. An open request that asks this creature
 * this test, while it has not answered, takes the roll as its answer, for
 * the player and for the DM, whatever the Ask switch says, so no second
 * request goes. Otherwise the DM's tap on a creature a player plays asks
 * that player while Ask is on, and anything else rolls.
 */
export function routeOf(input: { state: Pick<RoomState, "tokens" | "rolls">; creature: ActorTarget; test: D20Test; dm: boolean; played: boolean; ask: boolean }): Route {
  const { state, test } = input;
  if (test.kind === "save" || test.kind === "check") {
    const me = creatureKey(state, input.creature);
    const requests = Object.values(state.rolls).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const request of requests) {
      const target = request.targets.find((t) => creatureKey(state, t) === me);
      if (!target || target.total !== undefined || target.result !== undefined) continue;
      const choice = request.test.choices.findIndex((c) => sameTest(c, request.test.kind, test));
      if (choice >= 0) return { kind: "answer", request, target, choice };
    }
    if (input.dm && input.played && input.ask) return { kind: "ask" };
  }
  return { kind: "roll" };
}

/** The request target a `roll.dice` names: the target as the request holds it. */
export function targetRef(target: RollTarget): ActorTarget {
  return target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! };
}

// ------------------------------------------------------------ initiative

/**
 * The creature's own row in the fight: its token's, or its character's.
 * A companion acting on its character's turn has none of its own.
 */
export function initiativeRow(state: RoomState, creature: ActorTarget): InitEntry | undefined {
  const entry = findEntryFor(state, creature);
  if (!entry) return undefined;
  if ("tokenId" in creature && entry.tokenId !== creature.tokenId) {
    const token = state.tokens[creature.tokenId];
    const ref = token && "ref" in token.actor ? token.actor.ref : undefined;
    if (ref === undefined || entry.characterId !== ref) return undefined;
  }
  return entry;
}

/** A monster's initiative score where the room uses scores (shared/rules/initiative.ts scoredValue), else null. */
export function scoreOf(state: RoomState, creature: ActorTarget): number | null {
  if (!state.meta.settings.monsterInitScore || !("tokenId" in creature)) return null;
  const token = state.tokens[creature.tokenId];
  if (!token || token.kind === "pc" || !("inline" in token.actor)) return null;
  return token.actor.inline.initScore ?? null;
}

const clampInit = (n: number) => Math.max(-50, Math.min(100, n));

/**
 * Initiative's value written once its roll lands (4.3), as a typed value
 * goes: `encounter.setValue` for a player's own row and `encounter.setValues`
 * for the DM. Only while the row still holds the value it had at the tap,
 * so a value typed meanwhile is never overwritten. Null when it changed.
 */
export function initiativeOp(state: RoomState, entryId: string, before: number | null, value: number, dm: boolean): ClientOp | null {
  const row = state.encounter?.entries.find((e) => e.id === entryId);
  if (!row || row.value !== before) return null;
  const v = clampInit(value);
  return dm ? { t: "encounter.setValues", values: [{ entryId, value: v }] } : { t: "encounter.setValue", entryId, value: v };
}

// ------------------------------------------------------------ named rolls

/** A rider or an optional part as its toggle reads: "+3d6 Sneak Attack", "+1d4 if the attack roll had Advantage". */
export function partToggleText(part: DamagePart): string {
  return `+${part.formula}${part.name ? ` ${part.name}` : ""}`;
}

/** Whether a part's name is a rider's own ("Sneak Attack"), not a block's condition ("if the attack roll had Advantage"). */
function riderName(part: DamagePart): string | null {
  return part.name && !/^(if|when|while)\b/i.test(part.name) ? part.name : null;
}

/**
 * One Damage tap (4.2, 4.3): the parts and every toggled rider in one line,
 * one roll per damage type, so a damage is never split across lines.
 * A critical hit doubles every part's dice, riders included. Labels name
 * the roll, never the creature: "Rend damage, fire", with a rider "Rapier
 * damage and Sneak Attack, piercing", and "Rend critical damage, fire".
 */
export function damageRolls(named: NamedRoll, opts: { on: ReadonlySet<number>; critical: boolean; creature?: ActorTarget }): PanelRoll[] {
  const parts = named.damage.filter((p, i) => !p.optional || opts.on.has(i));
  const riders = parts.flatMap((p) => (p.optional ? [riderName(p)] : [])).filter((n): n is string => n !== null);
  // "critical" in the label tells an HP entry the line was a critical hit, for a creature at 0 HP.
  const head = `${named.name} ${opts.critical ? "critical damage" : "damage"}${riders.length > 0 ? ` and ${riders.join(" and ")}` : ""}`;
  const byType = new Map<string, string[]>();
  for (const part of parts) {
    const parsed = parseFormula(part.formula);
    if (!parsed.ok) continue;
    const text = formatFormula(opts.critical ? doubleDice(parsed.formula) : parsed.formula);
    const key = part.type ?? "";
    byType.set(key, [...(byType.get(key) ?? []), text]);
  }
  const out: PanelRoll[] = [];
  for (const [type, formulas] of byType) {
    const parsed = parseFormula(formulas.join("+"));
    if (!parsed.ok) continue;
    const roll: PanelRoll = { formula: formatFormula(parsed.formula), label: cutLabel(type ? `${head}, ${type}` : head) };
    if (opts.creature) roll.creature = opts.creature;
    out.push(roll);
  }
  return out;
}

/** A plain roll by a named roll's name: healing, a plain die, a recharge. */
export function namedRoll(formula: string, label: string, creature?: ActorTarget): PanelRoll {
  const roll: PanelRoll = { formula, label: cutLabel(label) };
  if (creature) roll.creature = creature;
  return roll;
}

// ------------------------------------------------------------ results

/** What a row says under it once its line lands (4.2, 4.3). */
export function resultWords(rolls: readonly DiceRoll[], kind: "d20" | "attack" | "damage" | "recharge" | "plain", opts: { recharge?: number } = {}): string {
  const first = rolls[0];
  if (!first) return "";
  if (kind === "damage") {
    const total = rolls.reduce((n, r) => n + r.total, 0);
    return rolls.length > 1 ? `${total}: ${rolls.map((r) => `${r.total} ${(r.label ?? "").split(", ").at(-1)}`).join(", ")}` : `${total}`;
  }
  if (kind === "recharge") {
    const need = opts.recharge ?? 6;
    return first.total >= need ? `Recharged (${first.total})` : `Not yet (${first.total})`;
  }
  if (kind === "plain") return `${first.total}`;
  const face = keptD20(first)?.face;
  const parts = [`${first.total}`];
  if (first.fails) parts.push(`fails (${effectName(first.fails)})`);
  if (kind === "attack" && face !== undefined && face >= (first.critOn ?? 20)) parts.push(face === 20 ? "Natural 20. Critical damage next." : `Natural ${face}. Critical damage next.`);
  else if (kind === "attack" && face === 1) parts.push("Natural 1: a miss");
  else if (face === 20) parts.push("Natural 20");
  else if (face === 1) parts.push("Natural 1");
  if (first.cancelled) parts.push("normal: advantage and disadvantage cancelled");
  return parts.join(", ");
}

/** Whether an attack's result makes its next Damage tap a critical hit. */
export function critical(roll: DiceRoll | undefined): boolean {
  const face = roll ? keptD20(roll)?.face : undefined;
  return face !== undefined && face >= (roll?.critOn ?? 20);
}

// ------------------------------------------------------------ recharge

/**
 * Actions marked Used on this device, per token, in session storage
 * (6.4): a tap on a recharge action's Damage or Group save marks it, its
 * row's Used toggles it, and a recharge that succeeds clears it.
 */
function usedKey(roomId: string): string {
  return `rvtt.rechargeUsed.${roomId}`;
}

export function readUsed(roomId: string): Record<string, string[]> {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(usedKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}

export function withUsed(used: Record<string, string[]>, holder: string, key: string, on: boolean): Record<string, string[]> {
  const list = used[holder] ?? [];
  const next = on ? [...new Set([...list, key])] : list.filter((k) => k !== key);
  const out = { ...used };
  if (next.length > 0) out[holder] = next;
  else delete out[holder];
  return out;
}

export function writeUsed(roomId: string, used: Record<string, string[]>): void {
  try {
    sessionStorage.setItem(usedKey(roomId), JSON.stringify(used));
  } catch {
    // Storage blocked or full: Used lasts until the page closes.
  }
}

/**
 * Starts what spends a recharge action and marks it Used only once that
 * went (6.4, ASTRA-15): a group save the DM kept open in its place, or an
 * outcome that sent nothing, spends nothing. True when it started.
 */
export function spendOnStart(start: () => boolean, spend: (() => void) | null): boolean {
  const started = start();
  if (started) spend?.();
  return started;
}

// ------------------------------------------------------------ HP chips

/** A damage or healing line's total offered in an HP entry (4.3): "Use 9 (Bree's Longsword damage)". */
export type HpChip = { lineId: string; amount: number; text: string; critical: boolean };

const DAMAGE_LABEL = /\bdamage\b/i;
const HEAL_LABEL = /\bhealing\b/i;

/** The words of a line's first label without its damage type: "Rapier damage and Sneak Attack". */
function chipWhat(roll: DiceRoll): string {
  return (roll.label ?? "").replace(/, [a-z]+$/, "");
}

/**
 * The newest damage line or healing line in the viewer's log, this
 * viewer's own and the newest of anyone else's, as chips for an HP entry
 * in that mode. A chip sums every roll of its line. A plain roll is never
 * one, since only damage and healing labels count. A line this device has
 * applied goes, and no older line of its side takes its place.
 */
export function hpChips(log: readonly LogEntry[], me: string, kind: "damage" | "heal", opts: { applied: ReadonlySet<string>; nameOf(memberId: string): string }): HpChip[] {
  const test = kind === "damage" ? DAMAGE_LABEL : HEAL_LABEL;
  // Null once the newest line of its side is applied: that side then shows nothing, never an older line.
  let mine: HpChip | null | undefined;
  let theirs: HpChip | null | undefined;
  for (let i = log.length - 1; i >= 0 && (mine === undefined || theirs === undefined); i--) {
    const entry = log[i]!;
    const data = entry.data;
    if (entry.kind !== "event" || data?.type !== "dice" || data.rolls.length === 0) continue;
    if (!data.rolls.every((r) => r.label !== undefined && test.test(r.label))) continue;
    const own = data.by === me;
    if ((own ? mine : theirs) !== undefined) continue;
    let chip: HpChip | null = null;
    if (!opts.applied.has(entry.id)) {
      const amount = data.rolls.reduce((n, r) => n + r.total, 0);
      const what = chipWhat(data.rolls[0]!);
      const text = own ? `Use ${amount} (${what})` : `Use ${amount} (${opts.nameOf(data.by)}'s ${what})`;
      chip = { lineId: entry.id, amount, text, critical: data.rolls.some((r) => /\bcritical\b/i.test(r.label ?? "")) };
    }
    if (own) mine = chip;
    else theirs = chip;
  }
  return [mine, theirs].filter((c): c is HpChip => c !== undefined && c !== null);
}
