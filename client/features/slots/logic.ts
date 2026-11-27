import type { Character, ClassLevel, HitDieSize, Spent } from "#shared/model.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { CLASS_IDS, CLASS_NAMES, presetById, type ClassId } from "#shared/rules/classResources.ts";
import { dieKey, diceOf, levelOf, MAX_CLASSES, MAX_LEVEL, slotsOf, THIRD_CLASSES, THIRD_FROM, type Pact } from "#shared/rules/spellSlots.ts";

/**
 * The words, rows and drafts of a character's spell slots, Pact Magic slots
 * and Hit Point Dice (docs/design/design-v1-slots.md 3), as plain functions
 * for node --test. Every count is derived from the classes
 * (shared/rules/spellSlots.ts) less what `spent` holds, so the rows read
 * what the server would.
 */

// ------------------------------------------------------------ spell slots

/** One slot level the character has: its most and what is left. */
export type SlotLevel = { level: number; max: number; left: number };

/** The slot levels a character has, lowest first, and its Pact Magic row or null. */
export function slotLevels(character: Pick<Character, "classes" | "spent"> | undefined): { levels: SlotLevel[]; pact: (Pact & { left: number }) | null } {
  const { slots, pact } = slotsOf(character?.classes);
  const spent = character?.spent;
  const levels = slots.flatMap((max, i) => (max > 0 ? [{ level: i + 1, max, left: Math.max(0, max - (spent?.slots?.[i] ?? 0)) }] : []));
  return { levels, pact: pact ? { ...pact, left: Math.max(0, pact.slots - (spent?.pact ?? 0)) } : null };
}

/** "Level 3 spell slots", a full row's name. */
export function slotName(level: number): string {
  return `Level ${level} spell slots`;
}

/** "Pact Magic, level 3", the Pact row's name. */
export function pactName(pact: Pick<Pact, "level">): string {
  return `Pact Magic, level ${pact.level}`;
}

export const SLOT_BACK = "Back on a Long Rest";
export const PACT_BACK = "Back on a Short or Long Rest";
export const FOLDED_NAME = "Spell slots";

/** The folded row's muted line: "Left by level: 4, 3, 3, 3, 2, 1, 1, 1, 1". */
export function leftByLevel(levels: readonly SlotLevel[]): string {
  return `Left by level: ${levels.map((l) => l.left).join(", ")}`;
}

export function slotUseLabel(s: SlotLevel): string {
  return `Use a level ${s.level} spell slot, ${s.left} of ${s.max} left`;
}
export function slotBackLabel(level: number): string {
  return `Restore a level ${level} spell slot`;
}
export function slotEmptyText(level: number): string {
  return `No level ${level} spell slots left.`;
}
export function slotFullText(level: number): string {
  return `Every level ${level} spell slot is there.`;
}
/** A folded row's level button, its words and its name: "Level 3, 2 left" and "Use a level 3 spell slot, 2 left". */
export function foldedUse(s: SlotLevel): { text: string; label: string } {
  return { text: `Level ${s.level}, ${s.left} left`, label: `Use a level ${s.level} spell slot, ${s.left} left` };
}
/** The drawer's Restore a slot… button: "Level 3, 1 spent". */
export function foldedBack(s: SlotLevel): { text: string; label: string } {
  return { text: `Level ${s.level}, ${s.max - s.left} spent`, label: `Restore a level ${s.level} spell slot, ${s.max - s.left} spent` };
}

export function pactUseLabel(pact: Pact & { left: number }): string {
  return `Use a Pact Magic slot, ${pact.left} of ${pact.slots} left`;
}
export const PACT_BACK_LABEL = "Restore a Pact Magic slot";
export const PACT_EMPTY = "No Pact Magic slots left.";
export const PACT_FULL = "Every Pact Magic slot is there.";

/** "Bree's spell slots", the rows' list. */
export function slotsListLabel(name: string): string {
  return `${name}'s spell slots`;
}

export function slotOp(characterId: string, level: number, back: boolean): ClientOp {
  return { t: "actor.use", target: { characterId }, use: { kind: "slot", level }, ...(back ? { back: true as const } : {}) };
}
export function pactOp(characterId: string, back: boolean): ClientOp {
  return { t: "actor.use", target: { characterId }, use: { kind: "pact" }, ...(back ? { back: true as const } : {}) };
}

/**
 * How many rows a character's slots count toward a turn card's uses
 * (D-261127-266, 360): the slot group as 1 and Pact Magic as 1, so a Wizard
 * 3 with nothing else still gets a card.
 */
export function slotCount(classes: readonly ClassLevel[] | undefined): number {
  if (!classes || classes.length === 0) return 0;
  const { slots, pact } = slotsOf(classes);
  return (slots.some((n) => n > 0) ? 1 : 0) + (pact ? 1 : 0);
}

// ------------------------------------------------------------ the slot offer

/** One pool a sent cast ask may spend, with its button's words and whether it is off. */
export type OfferPool = { kind: "slot" | "pact"; level: number; text: string; off: string | null; op: ClientOp };

/**
 * The pools that can cast a spell sent at `level` (D-261127-363, 400, 408):
 * ordinary slots at exactly that level, and Pact Magic only where the Pact
 * level equals it, since a Pact slot always casts at its level and the ask
 * was scaled to the level sent. Each is off with its "left" reason. Empty
 * is no offer.
 */
export function offerPools(character: Pick<Character, "id" | "classes" | "spent"> | undefined, level: number): OfferPool[] {
  if (!character) return [];
  const { levels, pact } = slotLevels(character);
  const out: OfferPool[] = [];
  const at = levels.find((l) => l.level === level);
  if (at) out.push({ kind: "slot", level, text: `Use a level ${level} spell slot`, off: at.left === 0 ? slotEmptyText(level) : null, op: slotOp(character.id, level, false) });
  if (pact && pact.level === level) out.push({ kind: "pact", level, text: `Use a Pact Magic slot (cast at level ${pact.level})`, off: pact.left === 0 ? PACT_EMPTY : null, op: pactOp(character.id, false) });
  return out;
}

/** "Cast at level 3.", the offer's line. */
export function offerLine(level: number): string {
  return `Cast at level ${level}.`;
}

/**
 * Where a spell's casting level starts (D-261127-401): at the Pact level
 * where Pact Magic is the only pool that covers it, judged by the slot
 * maxima the classes give, not the slots left. Null where it starts at the
 * spell's own level.
 */
export function pactStart(classes: readonly ClassLevel[] | undefined, spellLevel: number | undefined): number | null {
  if (spellLevel === undefined || spellLevel < 1 || !classes) return null;
  const { slots, pact } = slotsOf(classes);
  if (!pact || pact.level < spellLevel) return null;
  return slots.some((max, i) => max > 0 && i + 1 >= spellLevel) ? null : pact.level;
}

// ------------------------------------------------------------ Hit Point Dice

/** One die size a character has: its most and what is left. */
export type DieRow = { die: HitDieSize; max: number; left: number };

/** The die sizes a character has, largest first. */
export function dieRows(character: Pick<Character, "classes" | "spent"> | undefined): DieRow[] {
  const dice = diceOf(character?.classes);
  const spent = character?.spent?.dice;
  return ([12, 10, 8, 6] as const).flatMap((die) => {
    const max = dice[dieKey(die)] ?? 0;
    return max > 0 ? [{ die, max, left: Math.max(0, max - (spent?.[dieKey(die)] ?? 0)) }] : [];
  });
}

/** The count line under the rest choice: "Hit Point Dice: 3 of 5 d10, 1 of 1 d8". Null without classes. */
export function hitDiceLine(rows: readonly DieRow[]): string | null {
  return rows.length > 0 ? `Hit Point Dice: ${rows.map((r) => `${r.left} of ${r.max} d${r.die}`).join(", ")}` : null;
}

export function dieName(die: HitDieSize): string {
  return `d${die} Hit Point Dice`;
}

function signed(n: number): string {
  return n < 0 ? `- ${-n}` : `+ ${n}`;
}

/** "Roll d10 + 2", the row's button. */
export function rollText(die: HitDieSize, con: number): string {
  return `Roll d${die} ${signed(con)}`;
}
/** "Roll a d10 Hit Point Die plus 2, 3 of 5 left", its name. */
export function rollLabel(row: DieRow, con: number): string {
  return `Roll a d${row.die} Hit Point Die ${con < 0 ? "minus" : "plus"} ${Math.abs(con)}, ${row.left} of ${row.max} left`;
}
export function dieBackLabel(die: HitDieSize): string {
  return `Restore a d${die} Hit Point Die`;
}
export function dieEmptyText(die: HitDieSize): string {
  return `No d${die} Hit Point Dice left.`;
}
export function dieFullText(die: HitDieSize): string {
  return `Every d${die} Hit Point Die is there.`;
}
export function hpFullText(name: string): string {
  return `${name}'s HP is full.`;
}
/** The typed field's name: "HP from one d10, your roll plus Constitution". */
export function typedLabel(die: HitDieSize): string {
  return `HP from one d${die}, your roll plus Constitution`;
}

/** Why a die cannot be spent now, or null: full HP first, as a die there would go to waste. */
export function spendOff(row: DieRow, hp: { cur: number; max: number } | undefined, name: string): string | null {
  if (hp && hp.cur >= hp.max) return hpFullText(name);
  if (row.left === 0) return dieEmptyText(row.die);
  return null;
}

/**
 * A landed roll's words: "Rolled 7 + 2: 9 HP back.", and at the floor
 * "Rolled 1 - 2: 1 HP back, at least 1." (SRD 5.2.1 "Short Rest"). `face`
 * is the die's face, `con` the modifier the server added.
 */
export function rolledText(face: number, con: number): string {
  const total = face + con;
  return total < 1 ? `Rolled ${face} ${signed(con)}: 1 HP back, at least 1.` : `Rolled ${face} ${signed(con)}: ${total} HP back.`;
}

/** A typed roll: a whole number from 1 to 100,000, else the range. */
export function typedOutcome(text: string): { ok: true; heal: number } | { ok: false; error: string } {
  const t = text.trim();
  const n = /^\d{1,6}$/.test(t) ? Number(t) : null;
  if (n === null || n < 1 || n > 100_000) return { ok: false, error: "Type the HP from 1 to 100000." };
  return { ok: true, heal: n };
}

export function hitDieOp(characterId: string, die: HitDieSize, opts: { heal?: number; back?: boolean }): ClientOp {
  return { t: "actor.use", target: { characterId }, use: { kind: "hitDie", die, ...(opts.heal !== undefined ? { heal: opts.heal } : {}) }, ...(opts.back ? { back: true as const } : {}) };
}

export function hitDieRollOp(tag: string, characterId: string, die: HitDieSize, con: number | undefined): Extract<ClientOp, { t: "actor.hitDieRoll" }> {
  return { t: "actor.hitDieRoll", tag, target: { characterId } as ActorTarget, die, ...(con !== undefined ? { con } : {}) };
}

/** Where a die's Roll and typed Spend read Constitution: the numbers', a field this device keeps, or none yet (D-261127-263, 091, 365). */
export type ConSource = { kind: "numbers"; con: number } | { kind: "field" } | { kind: "loading" } | { kind: "failed" };

/**
 * The Constitution modifier a die adds, as the Dice panel rolls with it: the
 * numbers' where they give one (a block, a shape's mixed in). The field
 * stands only with no block and no shape, and a shaped character never
 * gets it: while its numbers load, Roll is busy, and if they fail, off.
 */
export function conSource(input: { shaped: boolean; hasBlock: boolean; numbersCon: number | undefined; loading: boolean; failed: boolean }): ConSource {
  if (input.numbersCon !== undefined) return { kind: "numbers", con: input.numbersCon };
  if (input.loading) return { kind: "loading" };
  if (input.failed) return { kind: "failed" };
  if (!input.shaped && !input.hasBlock) return { kind: "field" };
  return { kind: "failed" };
}

/** A typed Constitution modifier, -5 to 10, a plus sign allowed. */
export function conOf(text: string | null | undefined): number | null {
  const t = (text ?? "").trim().replace(/^\+/, "").replace(/[−–]/g, "-");
  if (!/^-?\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= -5 && n <= 10 ? n : null;
}

/** What a nonempty Constitution field that is not a modifier says, and why Roll is off (SLOTS-ASTRA-01). */
export const CON_RANGE = "Type a Constitution modifier from -5 to 10.";

/**
 * The Constitution field's value for a roll: an empty field is +0, a
 * modifier from -5 to 10 is itself, and anything else holds Roll with the
 * range, so a typo never rolls as +0 and spends a die.
 */
export function conChoice(text: string): { ok: true; con: number } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, con: 0 };
  const con = conOf(text);
  return con === null ? { ok: false, error: CON_RANGE } : { ok: true, con };
}

/**
 * The one pending guard of a Short Rest card's die rows (SLOTS-ASTRA-02):
 * a Roll, a typed Spend and a Restore on any row each wait for their
 * answer before another may go, so two dice are never spent before the
 * first result is known. `run` calls `send` only while nothing waits, and
 * hands it `done`, to call once the answer lands. A `send` that sent
 * nothing returns false and frees the guard at once.
 */
export function dieGuard(onChange: (held: boolean) => void) {
  let held = false;
  return {
    held: () => held,
    run(send: (done: () => void) => boolean): boolean {
      if (held) return false;
      held = true;
      onChange(true);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        held = false;
        onChange(false);
      };
      if (!send(done)) done();
      return true;
    },
  };
}
export type DieGuard = ReturnType<typeof dieGuard>;

// ------------------------------------------------------------ classes

/** "Wizard 5", "Other class 3 (d8)", "Fighter 3 (its subclass casts spells)". */
export function classText(entry: ClassLevel, long = false): string {
  if (entry.id === "other") return `Other class ${entry.level} (d${entry.die})`;
  return `${CLASS_NAMES[entry.id]} ${entry.level}${long && entry.third ? " (its subclass casts spells)" : ""}`;
}

/** Uses' Classes line: "Classes: Wizard 5, Cleric 1". */
export function classesLine(classes: readonly ClassLevel[]): string {
  return `Classes: ${classes.map((c) => classText(c)).join(", ")}`;
}

export const NO_CLASSES = "Add your classes to count spell slots and Hit Point Dice.";

/** The line at Uses' head when the level differs from the classes' sum: "Your classes add up to level 5, and your level is 6." */
export function levelMismatch(character: Pick<Character, "classes" | "level">): string | null {
  const classes = character.classes;
  if (!classes || classes.length === 0) return null;
  const sum = levelOf(classes);
  return character.level !== undefined && character.level !== sum ? `Your classes add up to level ${sum}, and your level is ${character.level}.` : null;
}

/** One class row in the sheet. `third` is kept while the level is below 3, and sent only from 3. */
export type ClassRow = { key: string; id: ClassId | "other"; level: number; third: boolean; die: HitDieSize };

/** What the sheet starts from (D-261127-087): the classes, else each preset's class at the highest class level read, else none. */
export function startRows(character: Pick<Character, "classes" | "resources">, newKey: () => string): ClassRow[] {
  if (character.classes && character.classes.length > 0) {
    return character.classes.map((c) => (c.id === "other" ? { key: newKey(), id: "other", level: c.level, third: false, die: c.die } : { key: newKey(), id: c.id, level: c.level, third: c.third === true, die: 8 }));
  }
  const read = new Map<ClassId, number>();
  for (const r of character.resources ?? []) {
    const preset = presetById(r.preset);
    if (!preset || r.level === undefined) continue;
    read.set(preset.classId, Math.max(read.get(preset.classId) ?? 0, r.level));
  }
  return CLASS_IDS.filter((id) => read.has(id)).map((id) => ({ key: newKey(), id, level: read.get(id)!, third: false, die: 8 }));
}

/** The classes a row may pick: the SRD classes no other row picked, then Other class. */
export function classChoices(rows: readonly ClassRow[], row: ClassRow): (ClassId | "other")[] {
  const taken = new Set(rows.filter((r) => r !== row && r.id !== "other").map((r) => r.id));
  return [...CLASS_IDS.filter((id) => id === row.id || !taken.has(id)), "other"];
}

/** A new row: the first SRD class no row picked, else Other class, at level 1. */
export function newRow(rows: readonly ClassRow[], key: string): ClassRow | null {
  if (rows.length >= MAX_CLASSES) return null;
  const taken = new Set(rows.map((r) => r.id));
  const id = CLASS_IDS.find((c) => !taken.has(c)) ?? "other";
  return { key, id, level: 1, third: false, die: 8 };
}

/** The rows as the classes they save, `third` only on a Fighter or Rogue from level 3. */
export function rowsClasses(rows: readonly ClassRow[]): ClassLevel[] {
  return rows.map((r): ClassLevel => (r.id === "other" ? { id: "other", level: r.level, die: r.die } : { id: r.id, level: r.level, ...(r.third && THIRD_CLASSES.has(r.id) && r.level >= THIRD_FROM ? { third: true as const } : {}) }));
}

function countsList(values: readonly number[]): string {
  return values.join(", ");
}

/** "5 d10 and 1 d8". */
function diceWords(classes: readonly ClassLevel[]): string {
  const parts = Object.entries(diceOf(classes)).map(([key, n]) => `${n} ${key}`);
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The sheet's preview under the rows: what the classes give ("Spell slots:
 * 4, 3, 2. Pact Magic: 2 at level 3. Hit Point Dice: 5 d10 and 1 d8.",
 * each part only when there is one), the level, and the line when Save
 * would set a level that differs. Past 20 Save is off.
 */
export function preview(rows: readonly ClassRow[], level: number | undefined): { gives: string | null; total: string | null; sets: string | null; over: string | null } {
  const classes = rowsClasses(rows);
  const sum = levelOf(classes);
  if (sum > MAX_LEVEL) return { gives: null, total: null, sets: null, over: `The classes add up to ${sum}. A character's level is at most ${MAX_LEVEL}.` };
  if (classes.length === 0) return { gives: null, total: null, sets: null, over: null };
  const { slots, pact } = slotsOf(classes);
  const parts: string[] = [];
  const counts = slots.filter((n) => n > 0);
  if (counts.length > 0) parts.push(`Spell slots: ${countsList(counts)}.`);
  if (pact) parts.push(`Pact Magic: ${pact.slots} at level ${pact.level}.`);
  parts.push(`Hit Point Dice: ${diceWords(classes)}.`);
  return { gives: parts.join(" "), total: `Level ${sum} in all.`, sets: level !== sum ? `Saving sets the character's level to ${sum}.` : null, over: null };
}

/** The line a Save that lowers the level shows (D-261127-267): "Saving lowers Bree's level from 8 to 3, and with it the Proficiency Bonus." */
export function lowering(name: string, level: number | undefined, rows: readonly ClassRow[]): { line: string; button: string } | null {
  const classes = rowsClasses(rows);
  const sum = levelOf(classes);
  if (classes.length === 0 || level === undefined || sum >= level || sum > MAX_LEVEL) return null;
  return { line: `Saving lowers ${name}'s level from ${level} to ${sum}, and with it the Proficiency Bonus.`, button: `Lower to level ${sum} and save` };
}

/**
 * The sheet's Save (D-261127-086, 265): the classes with their sum as the
 * level in one update, or with no rows the classes removed and the level
 * kept. Null past 20.
 */
export function savePatch(rows: readonly ClassRow[], level: number | undefined): Extract<ClientOp, { t: "character.update" }>["patch"] | null {
  const classes = rowsClasses(rows);
  const sum = levelOf(classes);
  if (sum > MAX_LEVEL) return null;
  if (classes.length === 0) return { classes: [] };
  return { classes, ...(level !== sum ? { level: sum } : {}) };
}

// ------------------------------------------------------------ class resources and rests

/**
 * Where Add a class resource's class picker starts once there are classes
 * (D-261127-087): the first SRD class in the list and its level. Null
 * without one.
 */
export function pickStart(classes: readonly ClassLevel[] | undefined): { classId: ClassId; level: number } | null {
  const first = (classes ?? []).find((c): c is Extract<ClassLevel, { id: ClassId }> => c.id !== "other");
  return first ? { classId: first.id, level: first.level } : null;
}

/** Spent counts in rest words: how many slots, Pact slots and dice a character has spent. */
export function spentCounts(spent: Spent | undefined): { slots: number; pact: number; dice: number } {
  return {
    slots: (spent?.slots ?? []).reduce((a, b) => a + b, 0),
    pact: spent?.pact ?? 0,
    dice: Object.values(spent?.dice ?? {}).reduce((a, b) => a + (b ?? 0), 0),
  };
}
