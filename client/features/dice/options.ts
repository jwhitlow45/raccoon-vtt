import { testOf, type D20Test, type DamagePart, type NamedRoll } from "#shared/dice/bonus.ts";
import { d20Formula, formatFormula, parseFormula } from "#shared/dice/formula.ts";
import { damageTypeName } from "#shared/rules/damage.ts";
import { keptD20 } from "#shared/dice/roll.ts";
import { LIMITS } from "#shared/limits.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import type { CharacterId, CritRule, DiceRoll, InitEntry, LogEntry, LogEvent, RollRequest, RollTarget, RoomState, TokenId } from "#shared/model.ts";
import { findEntryFor } from "#shared/rules/durations.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { ABILITY_ABBR, ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { critSums, effectName } from "#shared/logText.ts";
import type { PanelRoll } from "./useDicePanel.ts";
import { parseBonus, TYPE_BONUS } from "../rolls/card.ts";

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

/** A d20 test as a roll's label names it: "Dexterity save", "Stealth check", "Initiative", "Death Save" (4.2). */
export function testLabel(test: D20Test): string {
  switch (test.kind) {
    case "save":
      return test.cause === "concentration" ? "Concentration save" : `${ABILITY_NAMES[test.ability]} save`;
    case "check":
      return test.skill ? `${SKILLS[test.skill].name} check` : `${ABILITY_NAMES[test.ability]} check`;
    case "initiative":
      return "Initiative";
    case "deathSave":
      return "Death Save";
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

/**
 * A roll marked as its creature's initiative, so the server keeps it from
 * players while they may not know the creature's place in the order
 * (docs/design-v1-combat-flow.md 11.3). Any other test leaves it as it is.
 */
export function asInitiative(roll: PanelRoll, test: D20Test): PanelRoll {
  return test.kind === "initiative" ? { ...roll, initiative: true } : roll;
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
/** A creature a player may roll for, as the options' chips list it. */
export type Pickable = { key: string; creature: ActorTarget; name: string; tokenId?: string };

/**
 * A player's creatures (4.1): each character they own and each companion
 * of those characters on the scene, then every other token on the scene
 * they own, such as a summon, a beast token not made a companion, or the
 * DM's NPC lent to them, since the server lets a player roll for any
 * creature they own (doc 1 4.3). Objects are never offered.
 */
export function playerCreatures(view: Pick<RoomState, "characters" | "tokens">, me: string, sceneId: string | null, nameOf: (token: RoomState["tokens"][string]) => string): Pickable[] {
  const out: Pickable[] = [];
  const listed = new Set<string>();
  const mine = Object.values(view.characters).filter((c) => (c.ownerIds ?? []).includes(me));
  for (const character of mine.sort((a, b) => a.name.localeCompare(b.name))) {
    const token = Object.values(view.tokens).find((t) => t.sceneId === sceneId && "ref" in t.actor && t.actor.ref === character.id);
    out.push({ key: `c:${character.id}`, creature: { characterId: character.id }, name: character.name, ...(token ? { tokenId: token.id } : {}) });
    for (const companion of Object.values(view.tokens)) {
      if (companion.companion?.of !== character.id || companion.sceneId !== sceneId || companion.kind === "object") continue;
      listed.add(companion.id);
      out.push({ key: `t:${companion.id}`, creature: { tokenId: companion.id }, name: nameOf(companion), tokenId: companion.id });
    }
  }
  // A player's view of a token they do not own carries no owners (design 7.3), so a missing list is nobody's.
  // A token of a character they do not own, the DM's NPC lent to them, is theirs by the token alone (shared/project.ts ownsToken).
  const theirsByToken = (t: RoomState["tokens"][string]) => !("ref" in t.actor) || !(view.characters[t.actor.ref]?.ownerIds ?? []).includes(me);
  const owned = Object.values(view.tokens).filter((t) => t.sceneId === sceneId && t.kind !== "object" && (t.ownerIds ?? []).includes(me) && theirsByToken(t) && !listed.has(t.id));
  for (const token of owned.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }))) {
    // Keyed as creatureKey keys its selection, so the token's bar Roll picks it: a token of a character by that character.
    const key = "ref" in token.actor ? `c:${token.actor.ref}` : `t:${token.id}`;
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, creature: { tokenId: token.id }, name: nameOf(token), tokenId: token.id });
  }
  return out;
}

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

/**
 * The test a tap rolls by its route (docs/design-v1-roll-request.md 7.1):
 * an answer rolls the request's own test, which carries its `spell` and
 * `cause`, so a creature with Magic Resistance answers a spell request
 * with advantage from the Dice panel as from its card. Any other route
 * rolls the option's test.
 */
export function routedTest(route: Route, test: D20Test): D20Test {
  return route.kind === "answer" ? testOf(route.request, route.choice) : test;
}

// ------------------------------------------------------------ no numbers

/** What the bonus field of a creature with no numbers reads, by parseBonus: null while empty. */
export type TypedBonus = ReturnType<typeof parseBonus>;

/**
 * A d20 tap for a creature whose numbers this viewer does not hold: one
 * with no stat block, or a character whose numbers go only to the DM and
 * its own players (docs/design-v1-pc-stats.md 4.2). Its saves, checks and
 * skills are listed all the same. An ask needs no bonus, since its player
 * answers it. A roll here, an answer included, takes the bonus typed, and
 * waits for one, so no "+0" goes that no one gave.
 */
export function typedTap(route: Route["kind"], typed: TypedBonus): { bonus: number | null; waits: string | null } {
  if (route === "ask") return { bonus: null, waits: null };
  if (typed?.ok) return { bonus: typed.bonus, waits: null };
  return { bonus: null, waits: typed?.ok === false ? typed.error : TYPE_BONUS };
}

/** Such a creature's option as its button reads: "STR d20", then "STR d20+3" once a bonus is typed. */
export function typedText(name: string, typed: TypedBonus): string {
  return typed?.ok ? `${name} d20${signedText(typed.bonus)}` : `${name} d20`;
}

/** The note over such a creature's options: why no bonus shows, and what a tap does. */
export function noNumbersNote(input: { name: string; hidden: boolean; rollsHere: boolean }): string {
  const why = input.hidden ? `${input.name}'s numbers are for the DM and its own players.` : "No stat block, so no bonus is known.";
  return input.rollsHere ? `${why} Type the bonus of the roll you make, then tap it.` : `${why} A save or check tap asks its player.`;
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
 * A player's names the roll's tag, so the server takes it while the room
 * has typed totals off (shared/permissions.ts rolledInitiative).
 */
export function initiativeOp(state: RoomState, entryId: string, before: number | null, value: number, dm: boolean, roll?: string): ClientOp | null {
  const row = state.encounter?.entries.find((e) => e.id === entryId);
  if (!row || row.value !== before) return null;
  const v = clampInit(value);
  return dm ? { t: "encounter.setValues", values: [{ entryId, value: v }] } : { t: "encounter.setValue", entryId, value: v, ...(roll !== undefined ? { roll } : {}) };
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
 * A critical hit sends every part as asked, riders included, marked
 * `critical`: the server rolls it by the room's rule (the critical hit
 * rules addendum of docs/design-v1-dice.md), so this device never needs
 * to know it. Labels name the roll, never the creature: "Rend damage,
 * fire", with a rider "Rapier damage and Sneak Attack, piercing", and
 * "Rend critical damage, fire".
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
    const text = formatFormula(parsed.formula);
    const key = part.type ?? "";
    byType.set(key, [...(byType.get(key) ?? []), text]);
  }
  const out: PanelRoll[] = [];
  for (const [type, formulas] of byType) {
    const parsed = parseFormula(formulas.join("+"));
    if (!parsed.ok) continue;
    const roll: PanelRoll = { formula: formatFormula(parsed.formula), label: cutLabel(type ? `${head}, ${damageTypeName(type)}` : head) };
    if (opts.creature) roll.creature = opts.creature;
    if (opts.critical) roll.critical = true;
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
    return rolls.length > 1 ? `${total}: ${rolls.map((r) => `${r.total} ${(r.label ?? "").split(", ").at(-1)}${critSums([r])}`).join(", ")}` : `${total}${critSums(rolls)}`;
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
  if (first.cancelled) parts.push("normal: Advantage and Disadvantage cancelled");
  return parts.join(", ");
}

/** The Damage cell's second line while Critical is pressed: the room's rule, which the server rolls it by. */
export const CRIT_WORDS: Record<CritRule, string> = {
  rollTwice: "Critical: dice rolled twice",
  maxPlusRoll: "Critical: max plus a roll",
  doubleDice: "Critical: dice doubled",
  doubleTotal: "Critical: total doubled",
};

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

/**
 * A damage or healing roll's total offered in an HP entry (4.3): "Use 9
 * (Bree's Longsword damage)". A roll the splitter sent as several lines is
 * one chip: `lineIds` are all of them, `lineId` the newest.
 */
export type HpChip = { lineId: string; lineIds: string[]; amount: number; text: string; critical: boolean };

const DAMAGE_LABEL = /\bdamage\b/i;
const HEAL_LABEL = /\bhealing\b/i;

/** The words of a line's first label without its damage type: "Rapier damage and Sneak Attack". */
function chipWhat(roll: DiceRoll): string {
  return (roll.label ?? "").replace(/, [a-z]+$/i, "");
}

/**
 * The newest damage roll or healing roll in the viewer's log, this
 * viewer's own and the newest of anyone else's, as chips for an HP entry
 * in that mode. A chip sums every roll of its lines: a roll the splitter
 * sent as several lines (one `batch`), such as 21 hits' damage, is one
 * chip. A plain roll is never one, since only damage and healing labels
 * count. A roll this device has applied goes, and no older one of its side
 * takes its place.
 */
export function hpChips(log: readonly LogEntry[], me: string, kind: "damage" | "heal", opts: { applied: ReadonlySet<string>; nameOf(memberId: string): string }): HpChip[] {
  const test = kind === "damage" ? DAMAGE_LABEL : HEAL_LABEL;
  type Line = { entry: LogEntry; data: Extract<LogEvent, { type: "dice" }> };
  const counts = (entry: LogEntry): Line | null => {
    const data = entry.data;
    if (entry.kind !== "event" || data?.type !== "dice" || data.rolls.length === 0) return null;
    return data.rolls.every((r) => r.label !== undefined && test.test(r.label)) ? { entry, data } : null;
  };
  // Null once the newest roll of its side is applied: that side then shows nothing, never an older roll.
  let mine: HpChip | null | undefined;
  let theirs: HpChip | null | undefined;
  for (let i = log.length - 1; i >= 0 && (mine === undefined || theirs === undefined); i--) {
    const line = counts(log[i]!);
    if (!line) continue;
    const { entry, data } = line;
    const own = data.by === me;
    if ((own ? mine : theirs) !== undefined) continue;
    const batch = data.batch;
    const lines = batch === undefined ? [line] : log.flatMap((e) => {
      const l = counts(e);
      return l && l.data.batch === batch && l.data.by === data.by ? [l] : [];
    });
    const ids = lines.map((l) => l.entry.id);
    const rolls = lines.flatMap((l) => l.data.rolls);
    let chip: HpChip | null = null;
    if (!ids.some((id) => opts.applied.has(id))) {
      const amount = rolls.reduce((n, r) => n + r.total, 0);
      const what = chipWhat(data.rolls[0]!);
      const text = own ? `Use ${amount} (${what})` : `Use ${amount} (${opts.nameOf(data.by)}'s ${what})`;
      // A line rolled before the server marked a crit says so only in its label.
      chip = { lineId: entry.id, lineIds: ids, amount, text, critical: rolls.some((r) => r.crit !== undefined || /\bcritical\b/i.test(r.label ?? "")) };
    }
    if (own) mine = chip;
    else theirs = chip;
  }
  return [mine, theirs].filter((c): c is HpChip => c !== undefined && c !== null);
}

// ------------------------------------------------------------ the compact rows (docs/design-v1-dice-ui.md 4)

/**
 * A preset in a button's few characters, beside its bonus on one line:
 * "Dis", "Adv", "+1d4", "Fails". The effects' names go once in the
 * group's label (presetLine), so twelve cells never repeat "Blessed".
 */
export function presetTag(preset: RollPreset): string {
  if (preset.fails) return "Fails";
  const adv = preset.sources.some((s) => s.kind === "adv");
  const dis = preset.sources.some((s) => s.kind === "dis");
  const parts: string[] = [];
  if (adv) parts.push("Adv");
  if (dis) parts.push("Dis");
  parts.push(...preset.extra.map((t) => (/^[+-]/.test(t) ? t : `+${t}`)));
  return parts.join(" ");
}

/**
 * The tag parts every preset of a group carries ("+1d4" for a Blessed
 * creature's six saves), said once in the group's label and left off its
 * buttons (docs/design-v1-dice-ui.md 4.3). One preset without a part keeps
 * it on every button that has it.
 */
export function commonTags(presets: readonly RollPreset[]): string[] {
  const parts = presets.map((p) => presetTag(p).split(" ").filter(Boolean));
  return (parts[0] ?? []).filter((part) => parts.every((p) => p.includes(part)));
}

/** A group's label note: every effect that bears on its rolls, each said once ("Blessed: +1d4. Restrained: Dis"). */
export function groupNote(presets: readonly RollPreset[]): string {
  return [...new Set(presets.flatMap((p) => presetLine(p).split(". ")).filter(Boolean))].join(". ");
}

const SAVE_SHORT: Record<string, string> = ABILITY_ABBR;

/**
 * A named roll's line in its header, as a stat block reads: "+6 to hit,
 * 1d8+3 Slashing, +2d8 Divine Smite", "DC 14 DEX, 2d8 Radiant", "2d8+3
 * healing". A save stands where an attack's bonus stands (the project
 * owner, 2026-10-17). A rider's dice are said here, so its toggle needs
 * only its name and the controls share one line more often.
 */
export function rowSummary(named: Pick<NamedRoll, "attack" | "save" | "damage" | "heal" | "dice">): string {
  const parts: string[] = [];
  if (named.attack !== undefined) parts.push(`${named.attack < 0 ? named.attack : `+${named.attack}`} to hit`);
  const fixed = named.damage.filter((p) => !p.optional);
  // "Half on a pass" only where there is damage to halve: Hold Person has none.
  if (named.save) parts.push(`DC ${named.save.dc} ${SAVE_SHORT[named.save.ability] ?? named.save.ability}${named.save.onPass === "half" && fixed.length > 0 ? ", half on a pass" : ""}`);
  if (fixed.length > 0) parts.push(fixed.map((p) => (p.type ? `${p.formula} ${damageTypeName(p.type)}` : p.formula)).join(" + "));
  for (const rider of named.damage.filter((p) => p.optional)) parts.push(`+${rider.formula} ${shortRider(rider.name ?? "")}`.trim());
  if (named.heal) parts.push(`${named.heal.formula} healing`);
  if (named.dice) parts.push(named.dice);
  return parts.join(", ");
}

/**
 * A rider's toggle in a few words, its dice being in the row's header: its
 * own name ("Divine Smite"), a block's condition cut short ("With
 * Advantage"), or its dice where it has neither. The whole clause stays in
 * the toggle's name for a screen reader.
 */
export function riderText(part: DamagePart): string {
  const short = shortRider(part.name ?? "");
  if (short === "") return `+${part.formula}`;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/**
 * A rider toggle's name: the words it shows, so a voice user who says them
 * finds it (WCAG 2.5.3), then the dice it adds. A clause cut short on the
 * toggle is read whole: "When the target is in dim light or darkness: add
 * 1d6 to the next damage".
 */
export function riderToggleName(part: DamagePart): string {
  const shown = riderText(part);
  if (!part.name) return `${shown}: add it to the next damage`;
  const words = shown.endsWith("…") ? part.name.charAt(0).toUpperCase() + part.name.slice(1) : shown;
  return `${words}: add ${part.formula} to the next damage`;
}

/** A rider's name, or a block's clause cut short: "Divine Smite", "with Advantage". */
function shortRider(name: string): string {
  if (/^if the attack roll (had|has) advantage$/i.test(name)) return "with Advantage";
  return name.length > 22 ? `${name.slice(0, 21).trimEnd()}…` : name;
}
