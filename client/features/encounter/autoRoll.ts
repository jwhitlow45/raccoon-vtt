import { advantageFields, d20Formula, type AdvantageSource } from "#shared/dice/formula.ts";
import { rolledTerms } from "#shared/dice/roll.ts";
import type { DiceResult, DiceRoll, InitEntry, OrderReveal, RoomState, TokenId } from "#shared/model.ts";
import { MAX_ENTRIES_PER_OP, type ClientOp } from "#shared/protocol.ts";
import { rowGroup } from "#shared/rules/initiative.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { rollsOf } from "../dice/logic.ts";
import { rollModeSources, type RollModeOverride } from "../dice/rollMode.ts";
import { withExtra } from "../dice/options.ts";
import type { PanelRoll } from "../dice/useDicePanel.ts";
import type { ReceiptState } from "../dice/useReceipt.ts";
import { MAX_VALUE, MIN_VALUE, entryActor } from "./logic.ts";

/**
 * Auto initiative: the DM rolls monster initiative in one press (features
 * section 10, design 9.4, docs/design-v1-roll-options.md 7).
 *
 * The dice roll on the server, as one secret `dice.roll` from the DM, so
 * they land in the DM's log and Recent rolls like any other roll. Once
 * their lines land, the totals go with the same `encounter.setValues` a
 * typed value uses, so players see each visible monster's total as if the
 * DM typed it, never the dice or modifiers.
 *
 * It follows D&D Beyond's map combat tracker, which many DMs already know:
 * identical monsters are grouped and share one roll, one added mid-fight
 * takes its group's value, each other monster rolls its own, and a group
 * can be ungrouped. "One each" and "All at once" are quick variants on top
 * of that.
 *
 * Everything here is plain data in and out, so the tests can play the
 * server's part.
 */

/** A total the op schema accepts. Only an absurd modifier could reach the bounds. */
export function clampValue(n: number): number {
  return Math.min(MAX_VALUE, Math.max(MIN_VALUE, n));
}

// ---------------------------------------------------------------- what each row rolls with

/**
 * Whether a creature's +0 initiative bonus is only the default of a token
 * made by hand (factory.ts blankActor), so the DM can tell it from a real
 * +0. Every token made from a stat block, SRD or the room's own, carries
 * the block's challenge rating, and a hand-made one never does.
 */
export function noBonusSet(actor: { initBonus?: number; cr?: string } | undefined): boolean {
  return actor !== undefined && (actor.initBonus ?? 0) === 0 && actor.cr === undefined;
}

/** A monster row the DM can roll for, with what its roll needs. */
export type RollRow = {
  entryId: string;
  /** The row's token, which its roll names as its creature. */
  tokenId: TokenId;
  /** The DM's name for it, numbered ("Goblin 2"). */
  name: string;
  /** Identical monsters share it (the SRD id or the base name, as `rowGroup` reads it). Absent once ungrouped. */
  groupKey?: string;
  /**
   * The actor's initiative bonus: the printed "Initiative +X" of a 2024
   * stat block, the Dexterity modifier of a 2014 paste, or whatever the DM
   * entered on a hand-made token.
   */
  modifier: number;
  /**
   * The preset's advantage sources (presetFor): the DM's mark on the row in
   * place of the tracker's hint, and Poisoned. Unresolved, so the roll
   * combines them once (docs/design-v1-dice.md 3.3).
   */
  sources: AdvantageSource[];
  /** The preset's extra terms, such as Exhaustion's "-2". */
  extra: string[];
  value: number | null;
};

/** A row left out of the roll: a creature on another scene, whatever it is, or a dead monster. */
export type Skipped = { entryId: string; reason: "elsewhere" | "dead" };

/**
 * The rows auto initiative may touch, in the tracker's order: monsters and
 * NPCs the DM runs. Player characters never roll here, and neither does a
 * creature a player owns (a familiar, a sidekick), since its player rolls
 * for it. Label-only rows have no creature to take a modifier from.
 * Defeated monsters keep their value.
 *
 * A DM's view holds one scene's tokens, so a row whose token is on another
 * scene says nothing here about its kind, its owner or its modifier. Every
 * such row is reported as a creature elsewhere, a player character
 * included, rather than guessed at. Its group key cannot tell: Ungroup
 * clears it from monsters, and a player's familiar has one.
 *
 * `presetOf` is the initiative preset every d20 path reads
 * (client/features/dice/presets.ts presetFor), passed in so this file stays
 * free of the stat block readers the always-mounted strip would otherwise
 * load through autoState.ts.
 */
export function rollRows(
  view: Pick<RoomState, "tokens" | "characters">,
  entries: readonly InitEntry[],
  name: (entry: InitEntry) => string,
  presetOf: (creature: { tokenId: TokenId }) => Pick<RollPreset, "sources" | "extra">,
): { rows: RollRow[]; skipped: Skipped[] } {
  const rows: RollRow[] = [];
  const skipped: Skipped[] = [];
  for (const entry of entries) {
    if (entry.tokenId === undefined) continue;
    const token = view.tokens[entry.tokenId];
    if (!token) {
      skipped.push({ entryId: entry.id, reason: "elsewhere" });
      continue;
    }
    if (token.kind === "pc" || !("inline" in token.actor) || (token.ownerIds ?? []).length > 0) continue;
    const actor = entryActor(view, entry);
    if (actor?.life === "dead") {
      skipped.push({ entryId: entry.id, reason: "dead" });
      continue;
    }
    const preset = presetOf({ tokenId: entry.tokenId });
    const group = rowGroup(entry);
    rows.push({
      entryId: entry.id,
      tokenId: entry.tokenId,
      name: name(entry),
      ...(group !== undefined ? { groupKey: group } : {}),
      // Every actor has an initiative bonus. Only a player's projection may leave it out, and players never get here.
      modifier: actor?.initBonus ?? 0,
      sources: [...preset.sources],
      extra: [...preset.extra],
      value: entry.value,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------- grouping

/**
 * How the monsters share rolls:
 * - `creature`: identical monsters (one group key) share one roll, and
 *   every other monster rolls its own, as in D&D Beyond's tracker.
 * - `each`: every monster rolls its own.
 * - `all`: one roll for every monster, so they all act together.
 */
export type RollMode = "creature" | "each" | "all";
export const ROLL_MODES: readonly RollMode[] = ["creature", "each", "all"];
export const DEFAULT_ROLL_MODE: RollMode = "creature";

/** One shared roll: the rows that take its total, and what the d20 is rolled with. */
export type RollGroup = {
  rows: RollRow[];
  modifier: number;
  /** The sources the shared d20 rolls with, unresolved. */
  sources: AdvantageSource[];
  extra: string[];
  /** `all` only: the rows' advantage came out differently, so the shared d20 was rolled straight. */
  mixedAdvantage: boolean;
  /** `all` only: the rows' modifiers differed, and the group took the most common one. */
  mixedModifier: boolean;
  /** `all` only: the rows' extra terms differed, and the group took the most common ones. */
  mixedExtra: boolean;
};

/**
 * The modifier a mixed crowd adds: the one most of them have, and of
 * those tied, the higher. A crowd acting together moves at its typical
 * member's pace, and the higher one breaks a tie the way the default tie
 * rule ranks a higher bonus first.
 */
export function commonModifier(modifiers: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const m of modifiers) counts.set(m, (counts.get(m) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [m, count] of counts) {
    if (count > bestCount || (count === bestCount && m > best)) {
      best = m;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The extra terms a mixed crowd adds, for the same reason: the ones most of
 * them have. Terms can be dice, which have no "higher", so a tie goes to
 * the first in the tracker's order.
 */
function commonExtra(extras: readonly (readonly string[])[]): string[] {
  const counts = new Map<string, { extra: readonly string[]; count: number }>();
  for (const extra of extras) {
    const key = extra.join("");
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { extra, count: 1 });
  }
  let best: { extra: readonly string[]; count: number } | undefined;
  for (const candidate of counts.values()) if (!best || candidate.count > best.count) best = candidate;
  return [...(best?.extra ?? [])];
}

/**
 * The sources as the roll will resolve them. Two rows whose sources differ
 * but resolve alike roll the same d20, and the line records the same mode
 * and the same `cancelled` for both.
 */
function advantageKey(sources: readonly AdvantageSource[]): string {
  const fields = advantageFields(sources);
  return fields.mode ?? (fields.cancelled ? "cancelled" : "none");
}

/**
 * What By creature shares a roll by: one group key, modifier, resolved
 * advantage and extra. Absent for a row that stands alone.
 */
function shareKey(row: RollRow): string | undefined {
  return row.groupKey === undefined ? undefined : JSON.stringify([row.groupKey, row.modifier, advantageKey(row.sources), row.extra]);
}

/**
 * Splits the rows into shared rolls, in the tracker's order of each
 * group's first row. Within `creature`, monsters of one kind share a roll
 * only when they also share a modifier, an advantage and an extra, so every
 * total is exactly its own d20 plus its own numbers: an invisible goblin
 * among goblins rolls on its own with advantage, as the rules give it, and
 * an exhausted one with its penalty.
 */
export function planRolls(rows: readonly RollRow[], mode: RollMode): RollGroup[] {
  if (rows.length === 0) return [];
  if (mode === "all") {
    const advantages = new Set(rows.map((r) => advantageKey(r.sources)));
    const modifiers = new Set(rows.map((r) => r.modifier));
    const extras = new Set(rows.map((r) => r.extra.join("")));
    return [
      {
        rows: [...rows],
        modifier: commonModifier(rows.map((r) => r.modifier)),
        sources: advantages.size === 1 ? [...rows[0]!.sources] : [],
        extra: commonExtra(rows.map((r) => r.extra)),
        mixedAdvantage: advantages.size > 1,
        mixedModifier: modifiers.size > 1,
        mixedExtra: extras.size > 1,
      },
    ];
  }
  const groups = new Map<string, RollGroup>();
  const out: RollGroup[] = [];
  for (const row of rows) {
    const share = mode === "creature" ? shareKey(row) : undefined;
    const key = share !== undefined ? `group:${share}` : `entry:${row.entryId}`;
    let group = groups.get(key);
    if (!group) {
      group = { rows: [], modifier: row.modifier, sources: [...row.sources], extra: [...row.extra], mixedAdvantage: false, mixedModifier: false, mixedExtra: false };
      groups.set(key, group);
      out.push(group);
    }
    group.rows.push(row);
  }
  return out;
}

/** The rows a roll touches: by default only monsters still waiting for a value, or every one when re-rolling. */
export function rowsToRoll(rows: readonly RollRow[], reroll: boolean): RollRow[] {
  return reroll ? [...rows] : rows.filter((r) => r.value === null);
}

/** Monsters that took their group's value instead of rolling, and that value. */
export type JoinedGroup = { rows: RollRow[]; total: number };

/**
 * By creature, a monster still waiting for a value whose identical group
 * already has one takes that value instead of rolling alone, as D&D
 * Beyond adds a monster to its group mid-fight. Identical means what By
 * creature would share a roll with. A group whose members hold different
 * values was split by the DM, so it has no one value to give and the
 * monster rolls. `kept` are the monsters that keep their values this time.
 */
export function joinGroups(rows: readonly RollRow[], kept: readonly RollRow[]): { joined: JoinedGroup[]; rest: RollRow[] } {
  // A group's one value, or null once its members disagree.
  const valueOf = new Map<string, number | null>();
  for (const row of kept) {
    const key = shareKey(row);
    if (key === undefined || row.value === null) continue;
    const seen = valueOf.get(key);
    valueOf.set(key, seen === undefined || seen === row.value ? row.value : null);
  }
  const joined = new Map<string, JoinedGroup>();
  const rest: RollRow[] = [];
  for (const row of rows) {
    const key = shareKey(row);
    const value = key === undefined ? undefined : valueOf.get(key);
    if (key === undefined || value === undefined || value === null) {
      rest.push(row);
      continue;
    }
    let group = joined.get(key);
    if (!group) {
      group = { rows: [], total: value };
      joined.set(key, group);
    }
    group.rows.push(row);
  }
  return { joined: [...joined.values()], rest };
}

/**
 * What one press rolls: the shared rolls by the mode, and, by creature, the
 * waiting monsters that join their group's value instead (joinGroups).
 * `kept` are the monsters that keep their values this time. Joins use the
 * original presets, then the invocation changes only rows drawing new dice.
 */
export function planPress(rows: readonly RollRow[], mode: RollMode, kept: readonly RollRow[] = [], override?: RollModeOverride): { groups: RollGroup[]; joined: JoinedGroup[] } {
  const { joined, rest } = mode === "creature" ? joinGroups(rows, kept) : { joined: [], rest: [...rows] };
  return { groups: planRolls(rest.map((row) => ({ ...row, sources: rollModeSources(row.sources, [], override) })), mode), joined };
}

// ---------------------------------------------------------------- rolling on the server

/**
 * One panel roll per shared roll, in the groups' order, for
 * `useDicePanel().roll(rolls, { to: "dm" })`. Each names its first row's
 * token, so the DM's log reads whose roll it was, and goes behind the
 * screen, so a hidden group leaves players no trace of its creature. Each
 * is marked as initiative, so a creature whose place in the order players
 * may not know yet leaves them no bare line either
 * (docs/design-v1-combat-flow.md 11.3).
 */
export function initiativeRolls(groups: readonly RollGroup[]): PanelRoll[] {
  return groups.map((group) => {
    const n = group.rows.length;
    const roll: PanelRoll = { formula: withExtra(d20Formula(group.modifier), group.extra), label: n === 1 ? "Initiative" : `Initiative, shared by ${n}`, sources: [...group.sources], initiative: true };
    const first = group.rows[0];
    if (first) roll.creature = { tokenId: first.tokenId };
    return roll;
  });
}

export type RolledGroup = RollGroup & { roll: DiceRoll; total: number };

export type RowValue = { entryId: string; value: number };

/**
 * Each group's total from its landed roll, in the order initiativeRolls
 * sent them, and every row in it given that total, clamped. Null when the
 * rolls do not answer the groups one to one, such as a line that lost a
 * batch or names another creature, so a mismatch never sets a value.
 */
export function valuesFrom(groups: readonly RollGroup[], results: readonly DiceRoll[]): { rolled: RolledGroup[]; values: RowValue[] } | null {
  if (results.length !== groups.length) return null;
  const rolled: RolledGroup[] = [];
  const values: RowValue[] = [];
  for (const [i, group] of groups.entries()) {
    const roll = results[i]!;
    if (roll.tokenId !== undefined && roll.tokenId !== group.rows[0]?.tokenId) return null;
    const total = clampValue(roll.total);
    rolled.push({ ...group, roll, total });
    for (const row of group.rows) values.push({ entryId: row.entryId, value: total });
  }
  return { rolled, values };
}

/**
 * The `encounter.setValues` ops for a press's totals, sent as one undo
 * step, in batches the op schema accepts. The reducer places each value in
 * turn by the existing tie rule (design 9.4), and rows that tie on
 * everything it compares, such as a group of goblins, keep the tracker's
 * order.
 *
 * A row is set only while it still holds the value it had at the tap
 * (`rows`), since the dice land a moment later and a value typed or rolled
 * meanwhile is newer: those rows are `changed`. A row that left the fight is
 * left out. A total equal to the row's value is left out too, so a re-roll
 * that lands on the same number does not disturb a tie the DM already
 * settled.
 */
export function rollOps(
  values: readonly RowValue[],
  rows: readonly Pick<RollRow, "entryId" | "value">[],
  entries: readonly Pick<InitEntry, "id" | "value">[],
): { ops: ClientOp[]; changed: string[] } {
  const before = new Map(rows.map((r) => [r.entryId, r.value]));
  const now = new Map(entries.map((e) => [e.id, e.value]));
  const set: RowValue[] = [];
  const changed: string[] = [];
  for (const v of values) {
    if (!now.has(v.entryId)) continue;
    const current = now.get(v.entryId);
    if (current === v.value) continue;
    if (current !== before.get(v.entryId)) changed.push(v.entryId);
    else set.push(v);
  }
  const ops: ClientOp[] = [];
  for (let i = 0; i < set.length; i += MAX_ENTRIES_PER_OP) ops.push({ t: "encounter.setValues", values: set.slice(i, i + MAX_ENTRIES_PER_OP) });
  return { ops, changed };
}

/** One press of a roll button as the DM's device keeps it, from the tap until its totals are set or it settles without them. */
export type RollPress = {
  mode: RollMode;
  /** The server roll's tag. Null when nothing needed a die (every monster joined its group's value) or nothing went. */
  tag: string | null;
  groups: RollGroup[];
  joined: JoinedGroup[];
  /** The shared rolls with their dice and totals, once they landed. Null until then, and for good when nothing was set. */
  rolled: RolledGroup[] | null;
  /** Why nothing was set, in the card's words. */
  error: string | null;
  /** Rows left as they were: their value changed after the tap. */
  changed: string[];
  /** Settled: its totals were sent, or it ended without them. It never acts again. */
  done: boolean;
};

/**
 * What the results card says players see of the totals. Where the room keeps
 * monsters' places secret, a total reaches them only once its row joins their
 * order (docs/design-v1-combat-flow.md 11.2), so the card must not tell the
 * DM that every visible monster's total already went out.
 */
export function totalsHelp(reveal: OrderReveal): string {
  return reveal === "all"
    ? "Players see each visible monster's total, as if you typed it, never the dice or modifiers."
    : "Players see a monster's total once it joins their order, never the dice or modifiers.";
}

/** An answer that never came back, which the receipt could not settle. Nothing is sent again on its own (docs/design-v1-dice.md 8.7). */
export const MAY_HAVE_HAPPENED = "This may have happened. Check the log.";
/** Lines that do not answer the press's rolls one to one (valuesFrom). */
export const NOT_READ = "The dice landed, but their lines could not be read here. Nothing was set. Check the log.";

/** The words of a refused roll: nothing was set, and the server's reason. */
export function notSet(reason: string): string {
  return reason ? `Nothing was set. ${reason}` : "Nothing was set.";
}

/**
 * Settles a press against its tag's receipt (useReceipt.ts), as the DM's
 * device does each time the receipt moves: null while the dice are on
 * their way or once the press is done, else the press as it ends and the
 * ops to send. Only committed lines for every batch set values. A refused
 * batch, an unknown answer or lines that cannot be read set nothing, and
 * the card says why.
 */
export function settleRoll(
  press: RollPress,
  receipt: ReceiptState | null,
  entries: readonly Pick<InitEntry, "id" | "value">[],
): { press: RollPress; ops: ClientOp[] } | null {
  if (press.done) return null;
  const stop = (error: string) => ({ press: { ...press, error, done: true }, ops: [] });
  const joined = press.joined.flatMap((g) => g.rows.map((r) => ({ entryId: r.entryId, value: g.total })));
  let rolled: RolledGroup[] = [];
  let values: RowValue[] = joined;
  if (press.tag !== null) {
    if (!receipt || receipt.state === "sending" || receipt.state === "checking") return null;
    if (receipt.state === "unknown") return stop(MAY_HAVE_HAPPENED);
    if (receipt.state === "refused") return stop(notSet(receipt.text || receipt.message));
    if (receipt.refused) return stop(notSet(receipt.refused.text || receipt.refused.message));
    const landed = valuesFrom(press.groups, rollsOf(receipt.lines));
    if (!landed) return stop(NOT_READ);
    rolled = landed.rolled;
    values = [...landed.values, ...joined];
  }
  const rows = [...press.groups, ...press.joined].flatMap((g) => g.rows);
  const { ops, changed } = rollOps(values, rows, entries);
  return { press: { ...press, rolled, changed, done: true }, ops };
}

/**
 * Whether the DM's card for a roll still describes the fight. The card
 * belongs to its fight: it holds while at least one of its rows is still
 * in the encounter with the total the roll gave it. Ending the fight,
 * starting another, or an undo that takes the roll back leaves none, and
 * then the card goes for good. Until the totals are set, and when they
 * never will be, it holds while any of its rows is still in the encounter:
 * `waiting` is true while the dice or the ops they set are unanswered, and
 * a DM's view that holds only one scene cannot predict them (design 7.4).
 */
export function rollStillShown(press: Pick<RollPress, "groups" | "joined" | "rolled">, encounter: { entries: readonly Pick<InitEntry, "id" | "value">[] } | null, waiting: boolean): boolean {
  if (!encounter) return false;
  const values = new Map(encounter.entries.map((e) => [e.id, e.value]));
  if (waiting || press.rolled === null) return [...press.groups, ...press.joined].some((g) => g.rows.some((r) => values.has(r.entryId)));
  return [...press.rolled, ...press.joined].some((g) => g.rows.some((r) => values.has(r.entryId) && values.get(r.entryId) === g.total));
}

// ---------------------------------------------------------------- what the DM reads

const signed = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/**
 * One line per shared roll for the DM's result card, from the faces the
 * server drew, such as "d20 (12) +2 = 14", "d20 (12) +2 −2 = 12" with
 * Exhaustion, or "2d20 with Advantage (5, 17) keeps 17, +1 = 18". The minus
 * sign is typographic, as a stat block prints it. A result whose text no
 * longer parses reads as its formula and total.
 */
export function describeRoll(roll: Pick<DiceResult, "formula" | "faces" | "total">): string {
  const terms = rolledTerms(roll);
  if (!terms) return `${roll.formula} = ${roll.total}`;
  let head: string | null = null;
  let kept = false;
  const tail: string[] = [];
  for (const t of terms) {
    if (!("kept" in t)) {
      tail.push(signed(t.term.sign * t.term.value));
      continue;
    }
    if (head === null && t.term.sides === 20 && t.term.sign === 1) {
      if (t.term.keep) {
        const how = t.term.keep.high ? "with Advantage" : "with Disadvantage";
        const keeps = t.faces.filter((_, i) => t.kept[i]);
        head = `${t.term.count}d20 ${how} (${t.faces.join(", ")}) keeps ${keeps.join(", ")}`;
        kept = true;
      } else head = `${t.term.count === 1 ? "" : t.term.count}d20 (${t.faces.join(", ")})`;
      continue;
    }
    tail.push(`${t.term.sign < 0 ? "−" : "+"}${t.term.count}d${t.term.sides} (${t.faces.join(", ")})`);
  }
  const parts = [head === null ? null : `${head}${kept && tail.length > 0 ? "," : ""}`, ...tail].filter((p): p is string => p !== null);
  return `${parts.join(" ")} = ${roll.total}`;
}

// ---------------------------------------------------------------- the DM's choices on this device

/** The mode last used in a room, remembered on this device per room. */
export function prefsKey(roomId: string): string {
  return `rvtt.autoInitiative.${roomId}`;
}

export type RollPrefs = { mode: RollMode };

/** Reads stored prefs, falling back to the default on anything unexpected. */
export function decodePrefs(raw: string | null): RollPrefs {
  if (raw === null) return { mode: DEFAULT_ROLL_MODE };
  try {
    const parsed: unknown = JSON.parse(raw);
    const mode = (parsed as { mode?: unknown } | null)?.mode;
    if (typeof mode === "string" && (ROLL_MODES as readonly string[]).includes(mode)) return { mode: mode as RollMode };
  } catch {
    // A damaged entry reads as the default.
  }
  return { mode: DEFAULT_ROLL_MODE };
}

export function encodePrefs(prefs: RollPrefs): string {
  return JSON.stringify({ mode: prefs.mode });
}
