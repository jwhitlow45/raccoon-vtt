import { askedCritical } from "#shared/dice/crit.ts";
import { applyMode, formatFormula, formulaRange, parseFormula, parseRollText, type AdvantageMode } from "#shared/dice/formula.ts";
import type { DiceResult, DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import type { DiceRollInput } from "#shared/protocol.ts";

/**
 * What the Dice panel reads from the log (docs/design-v1-dice.md 8.3 and
 * 8.6), kept free of React so it is tested under plain Node: the rows of
 * Recent rolls, a tag's lines, the field's reading and this device's
 * history of formulas.
 */

export type DiceLine = Extract<LogEvent, { type: "dice" }>;
export type AnswerLine = Extract<LogEvent, { type: "roll" }>;

export type RecentRow =
  /** Lines of one roller and one batch, as one row for every viewer. */
  | { kind: "dice"; key: string; by: string; to: "all" | "dm"; rolls: DiceRoll[]; dc?: number; ac?: number; at: string; ids: string[] }
  /** Someone else's secret rolls in a row, by one member, read as "rolled in secret 3 times". */
  | { kind: "bare"; key: string; by: string; count: number; at: string; ids: string[] }
  /** A request's answer the server rolled. */
  | { kind: "answer"; key: string; line: AnswerLine; at: string; ids: string[] };

function diceOf(entry: LogEntry): DiceLine | null {
  return entry.kind === "event" && entry.data?.type === "dice" ? entry.data : null;
}

/**
 * Every dice line and every rolled answer in the viewer's log, newest
 * first. Lines with one roller and one batch become one row whatever lies
 * between them, so a group rolled in batches reads as one roll. One
 * member's bare lines next to each other become one row.
 */
export function recentRolls(log: readonly LogEntry[]): RecentRow[] {
  const rows: RecentRow[] = [];
  const byBatch = new Map<string, Extract<RecentRow, { kind: "dice" }>>();
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    const data = entry.data;
    if (entry.kind !== "event" || !data) continue;
    if (data.type === "roll") {
      if (data.dice) rows.push({ kind: "answer", key: entry.id, line: data, at: entry.at, ids: [entry.id] });
      continue;
    }
    if (data.type !== "dice") continue;
    if (data.rolls.length === 0) {
      const last = rows.at(-1);
      if (last?.kind === "bare" && last.by === data.by) {
        last.count++;
        last.ids.push(entry.id);
      } else rows.push({ kind: "bare", key: entry.id, by: data.by, count: 1, at: entry.at, ids: [entry.id] });
      continue;
    }
    const group = data.batch === undefined ? undefined : byBatch.get(`${data.by}|${data.batch}`);
    if (group) {
      // Read newest first, so an older batch's rolls go in front.
      group.rolls.unshift(...data.rolls);
      group.ids.push(entry.id);
      continue;
    }
    const row: Extract<RecentRow, { kind: "dice" }> = { kind: "dice", key: entry.id, by: data.by, to: data.to, rolls: [...data.rolls], at: entry.at, ids: [entry.id] };
    if (data.dc !== undefined) row.dc = data.dc;
    if (data.ac !== undefined) row.ac = data.ac;
    if (data.batch !== undefined) byBatch.set(`${data.by}|${data.batch}`, row);
    rows.push(row);
  }
  return rows;
}

/** One member's consecutive bare lines as one row, the rule recentRolls applies, for a list built another way. */
export function collapseBare(rows: readonly RecentRow[]): RecentRow[] {
  const out: RecentRow[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (row.kind === "bare" && last?.kind === "bare" && last.by === row.by) {
      out[out.length - 1] = { ...last, count: last.count + row.count, ids: [...last.ids, ...row.ids] };
    } else out.push(row);
  }
  return out;
}

/**
 * Every line of one tag in the viewer's log, oldest first: a group's
 * batches, or a request's answer. Only the roller's own dice lines carry
 * the tag, so this finds only what this member rolled (doc 3 reads a
 * group's results with it). With `part`, only that batch's own line: a
 * line of the tag says nothing of another part's outcome.
 */
export function findRolls(log: readonly LogEntry[], tag: string, part?: number): LogEntry[] {
  return log.filter((e) => {
    const data = e.data;
    if (e.kind !== "event" || (data?.type !== "dice" && data?.type !== "roll") || data.tag !== tag) return false;
    return part === undefined || (data.type === "dice" ? (data.part ?? 0) : 0) === part;
  });
}

/** Every roll the lines of a tag hold, in order. */
export function rollsOf(lines: readonly LogEntry[]): DiceRoll[] {
  return lines.flatMap((e) => (e.data?.type === "dice" ? e.data.rolls : e.data?.type === "roll" && e.data.dice ? [e.data.dice] : []));
}

/**
 * The reading under the field (8.2): "2d6+3, fire: 5 to 15", with the typed
 * mode, or the refusal's words. Null for an empty field.
 */
export function readingOf(text: string): { ok: true; text: string } | { ok: false; error: string } | null {
  if (text.trim() === "") return null;
  const parsed = parseRollText(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const adv = parsed.sources.some((s) => s.kind === "adv");
  const dis = parsed.sources.some((s) => s.kind === "dis");
  const mode: AdvantageMode | undefined = adv && !dis ? "adv" : dis && !adv ? "dis" : undefined;
  let formula = parsed.formula;
  if (mode) {
    const applied = applyMode(formula, mode);
    if (!applied.ok) return { ok: false, error: applied.error };
    formula = applied.formula;
  }
  const { min, max } = formulaRange(formula);
  const label = parsed.label !== undefined ? `, ${parsed.label}` : "";
  return { ok: true, text: `${formatFormula(formula, mode)}${label}: ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}` };
}

/**
 * A result's formula as it was asked, its mode's d20 written back as one:
 * "1d20+5" for "2d20kh1+5" with advantage, so Again sends the same roll
 * with the mode beside it. Null when its text no longer parses.
 */
export function askedFormula(result: Pick<DiceResult, "formula" | "mode">): string | null {
  const parsed = parseFormula(result.formula);
  if (!parsed.ok) return null;
  if (!result.mode) return formatFormula(parsed.formula);
  const text = formatFormula(parsed.formula, result.mode);
  return text.replace(/ with (advantage|disadvantage)$/, "");
}

/**
 * A roll as Again asks for it: its formula as asked, and a critical hit's
 * damage marked critical again, so the server rolls it by the room's rule
 * then (the critical hit rules addendum of docs/design-v1-dice.md).
 */
export function askedRoll(result: Pick<DiceResult, "formula" | "mode" | "crit">): { formula: string; critical?: true } | null {
  const critical = askedCritical(result);
  if (critical) return { formula: formatFormula(critical), critical: true };
  const formula = askedFormula(result);
  return formula === null ? null : { formula };
}

/**
 * A roll as Again sends it: its formula as asked, with the mode beside it,
 * its label, creature and range. A critical hit's damage goes as asked and
 * marked critical again, so it rolls by the room's rule then. A creature's
 * initiative goes marked as initiative again, so the server keeps it from
 * players while the order setting keeps the creature's place from them then
 * (docs/design-v1-combat-flow.md 11.3). A line from before the mark was kept
 * says so by its `hidden`, which only an initiative roll carries. A
 * creature's save goes as that save again, so the server records the
 * condition that fails it then, as the first roll did.
 */
export function againInput(roll: DiceRoll): DiceRollInput | null {
  const asked = askedRoll(roll);
  if (asked === null) return null;
  const input: DiceRollInput = { ...asked };
  if (roll.mode) input.mode = roll.mode;
  if (roll.cancelled) input.cancelled = true;
  if (roll.label !== undefined) input.label = roll.label;
  if (roll.tokenId !== undefined) input.creature = { tokenId: roll.tokenId };
  else if (roll.characterId !== undefined) input.creature = { characterId: roll.characterId };
  if (roll.critOn !== undefined) input.critOn = roll.critOn;
  if ((roll.initiative || roll.hidden) && input.creature) input.initiative = true;
  if (roll.save !== undefined && input.creature) input.save = roll.save;
  return input;
}

// ------------------------------------------------------------ history

/** Texts this device rolled from the field, per room, newest first (8.6). */
export const HISTORY_SIZE = 20;

function historyKey(roomId: string): string {
  return `rvtt.diceHistory.${roomId}`;
}

export function readHistory(roomId: string): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(historyKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string").slice(0, HISTORY_SIZE) : [];
  } catch {
    return [];
  }
}

/** The history with a text rolled now: first, once, and at most 20 kept. */
export function withHistory(history: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [...history];
  return [trimmed, ...history.filter((t) => t !== trimmed)].slice(0, HISTORY_SIZE);
}

export function writeHistory(roomId: string, history: readonly string[]): void {
  try {
    localStorage.setItem(historyKey(roomId), JSON.stringify(history.slice(0, HISTORY_SIZE)));
  } catch {
    // Storage blocked or full: the history lasts until the page closes.
  }
}

/**
 * Up and Down in the field (8.6): Up goes back through the history, newest
 * first, Down forward again, and past the newest back to what was being
 * typed. `at` is -1 while the field holds the typed draft.
 */
export function stepHistory(history: readonly string[], at: number, key: "up" | "down"): number {
  if (key === "up") return Math.min(history.length - 1, at + 1);
  return Math.max(-1, at - 1);
}
