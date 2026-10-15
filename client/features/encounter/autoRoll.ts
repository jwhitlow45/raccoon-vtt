import type { InitEntry } from "#shared/model.ts";
import { randomIndex, type RandomSource } from "#shared/passphrase.ts";
import { MAX_ENTRIES_PER_OP, type ClientOp } from "#shared/protocol.ts";
import { MAX_VALUE, MIN_VALUE, entryActor, rollReminder, type TrackerView } from "./logic.ts";

/**
 * Auto initiative: the DM's device rolls monster initiative (features
 * section 10, design 9.4).
 *
 * The "no dice" rule has this one exception. The device rolls and sends the
 * totals with the same `encounter.setValues` a typed value uses, so the
 * shared reducer never sees a die and replay stays deterministic. Players
 * see each visible monster's total, as if the DM typed it, never the dice
 * or modifiers, which stay on the DM's device.
 *
 * It follows D&D Beyond's map combat tracker, which many DMs already know:
 * identical monsters are grouped and share one roll, one added mid-fight
 * takes its group's value, each other monster rolls its own, and a group
 * can be ungrouped. "One each" and "All at
 * once" are quick variants on top of that.
 *
 * Everything here is plain data in and out, with the random source passed
 * in, so the tests can fix the dice.
 */

/** A d20, uniform from 1 to 20, from the browser's cryptographic source unless a test passes its own. */
export function rollD20(random?: RandomSource): number {
  return randomIndex(20, random) + 1;
}

export type Advantage = "adv" | "dis" | "normal";

/** The dice behind one result: one d20, or two with the one kept. */
export type D20Roll = { dice: number[]; kept: number; advantage: Advantage };

/** Advantage rolls two d20s and keeps the higher, disadvantage the lower (2024 rules, D20 Tests). */
export function rollWith(advantage: Advantage, random?: RandomSource): D20Roll {
  if (advantage === "normal") {
    const die = rollD20(random);
    return { dice: [die], kept: die, advantage };
  }
  const a = rollD20(random);
  const b = rollD20(random);
  return { dice: [a, b], kept: advantage === "adv" ? Math.max(a, b) : Math.min(a, b), advantage };
}

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

/** A monster row the DM's device can roll for, with what its roll needs. */
export type RollRow = {
  entryId: string;
  /** The DM's name for it, numbered ("Goblin 2"). */
  name: string;
  /** Identical monsters share it (the SRD id or the base name). Absent once ungrouped. */
  groupKey?: string;
  /**
   * The actor's initiative bonus: the printed "Initiative +X" of a 2024
   * stat block, the Dexterity modifier of a 2014 paste, or whatever the DM
   * entered on a hand-made token.
   */
  modifier: number;
  /** The row's reminder: the DM's own mark, else what its conditions say. */
  advantage: Advantage;
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
 */
export function rollRows(view: TrackerView, entries: readonly InitEntry[], name: (entry: InitEntry) => string): { rows: RollRow[]; skipped: Skipped[] } {
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
    rows.push({
      entryId: entry.id,
      name: name(entry),
      ...(entry.groupKey !== undefined ? { groupKey: entry.groupKey } : {}),
      // Every actor has an initiative bonus. Only a player's projection may leave it out, and players never get here.
      modifier: actor?.initBonus ?? 0,
      advantage: rollReminder(entry, actor?.effects) ?? "normal",
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
  advantage: Advantage;
  /** `all` only: the rows' reminders disagreed, so the shared d20 was rolled straight. */
  mixedAdvantage: boolean;
  /** `all` only: the rows' modifiers differed, and the group took the most common one. */
  mixedModifier: boolean;
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

/** What By creature shares a roll by: one group key, modifier and reminder. Absent for a row that stands alone. */
function shareKey(row: RollRow): string | undefined {
  return row.groupKey === undefined ? undefined : `${row.groupKey}|${row.modifier}|${row.advantage}`;
}

/**
 * Splits the rows into shared rolls, in the tracker's order of each
 * group's first row. Within `creature`, monsters of one kind share a roll
 * only when they also share a modifier and a reminder, so every total is
 * exactly its own d20 plus its own modifier: an invisible goblin among
 * goblins rolls on its own with advantage, as the rules give it.
 */
export function planRolls(rows: readonly RollRow[], mode: RollMode): RollGroup[] {
  if (rows.length === 0) return [];
  if (mode === "all") {
    const advantages = new Set(rows.map((r) => r.advantage));
    const modifiers = new Set(rows.map((r) => r.modifier));
    const advantage = advantages.size === 1 ? rows[0]!.advantage : "normal";
    return [
      {
        rows: [...rows],
        modifier: commonModifier(rows.map((r) => r.modifier)),
        advantage,
        mixedAdvantage: advantages.size > 1,
        mixedModifier: modifiers.size > 1,
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
      group = { rows: [], modifier: row.modifier, advantage: row.advantage, mixedAdvantage: false, mixedModifier: false };
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

// ---------------------------------------------------------------- rolling

export type RolledGroup = RollGroup & { roll: D20Roll; total: number };

/** What one press of the button rolled, and who joined a group's value instead, kept on the DM's device to show. */
export type RollResult = { mode: RollMode; groups: RolledGroup[]; joined: JoinedGroup[] };

/**
 * Rolls each group once and gives every row in it the group's total, for
 * `encounter.setValues`. The reducer places each value in turn by the
 * existing tie rule (design 9.4), and rows that tie on everything it
 * compares, such as a group of goblins, keep the tracker's order.
 */
export function rollGroups(groups: readonly RollGroup[], random?: RandomSource): { result: RolledGroup[]; values: { entryId: string; value: number }[] } {
  const result: RolledGroup[] = [];
  const values: { entryId: string; value: number }[] = [];
  for (const group of groups) {
    const roll = rollWith(group.advantage, random);
    const total = clampValue(roll.kept + group.modifier);
    result.push({ ...group, roll, total });
    for (const row of group.rows) values.push({ entryId: row.entryId, value: total });
  }
  return { result, values };
}

/**
 * One press of a roll button: rolls the rows by the mode and builds the
 * `encounter.setValues` ops to send as one undo step, in batches the op
 * schema accepts. A total equal to the row's value is left out, so a
 * re-roll that lands on the same number does not disturb a tie the DM
 * already settled. By creature, `kept` (the monsters that keep their
 * values) lets a waiting monster join its group's value (joinGroups).
 */
export function rollOps(
  rows: readonly RollRow[],
  mode: RollMode,
  random?: RandomSource,
  kept: readonly RollRow[] = [],
): { ops: ClientOp[]; result: RollResult } {
  const { joined, rest } = mode === "creature" ? joinGroups(rows, kept) : { joined: [], rest: rows };
  const { result, values } = rollGroups(planRolls(rest, mode), random);
  for (const group of joined) for (const row of group.rows) values.push({ entryId: row.entryId, value: group.total });
  const current = new Map(rows.map((r) => [r.entryId, r.value]));
  const changed = values.filter((v) => current.get(v.entryId) !== v.value);
  const ops: ClientOp[] = [];
  for (let i = 0; i < changed.length; i += MAX_ENTRIES_PER_OP) {
    ops.push({ t: "encounter.setValues", values: changed.slice(i, i + MAX_ENTRIES_PER_OP) });
  }
  return { ops, result: { mode, groups: result, joined } };
}

/**
 * Whether the DM's card for a roll still describes the fight. The card
 * belongs to its fight: it holds while at least one of its rows is still
 * in the encounter with the total the roll gave it. Ending the fight,
 * starting another, or an undo that takes the roll back leaves none, and
 * then the card goes for good. `waiting` is true while the roll's ops are
 * unanswered: a DM's view that holds only one scene cannot predict them
 * (design 7.4) and shows the old values until the server answers.
 */
export function rollStillShown(result: RollResult, encounter: { entries: readonly Pick<InitEntry, "id" | "value">[] } | null, waiting: boolean): boolean {
  if (!encounter) return false;
  const values = new Map(encounter.entries.map((e) => [e.id, e.value]));
  return [...result.groups, ...result.joined].some((g) => g.rows.some((r) => values.has(r.entryId) && (waiting || values.get(r.entryId) === g.total)));
}

// ---------------------------------------------------------------- what the DM reads

const signed = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/**
 * One line per shared roll for the DM's result card, such as
 * "d20 (12) +2 = 14" or "2d20 with advantage (5, 17) keeps 17, +1 = 18".
 * The minus sign is typographic, as a stat block prints it.
 */
export function describeRoll(group: Pick<RolledGroup, "roll" | "modifier" | "total">): string {
  const { roll, modifier, total } = group;
  const tail = `${signed(modifier)} = ${total}`;
  if (roll.advantage === "normal") return `d20 (${roll.kept}) ${tail}`;
  const how = roll.advantage === "adv" ? "with advantage" : "with disadvantage";
  return `2d20 ${how} (${roll.dice.join(", ")}) keeps ${roll.kept}, ${tail}`;
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
