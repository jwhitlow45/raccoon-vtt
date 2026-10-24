import { LIMITS } from "#shared/limits.ts";
import type { ClassResource, PcStats } from "#shared/model.ts";
import { clientOpSchema, combatUseSchemas } from "#shared/protocol.ts";
import { abilityMod } from "#shared/statBlock.ts";
import {
  asInputs,
  CLASS_NAMES,
  classPresets,
  fromPreset,
  presetById,
  presetCount,
  presetReset,
  updateClass,
  type ClassId,
  type ClassPreset,
  type CountAbility,
  type LevelUp,
  type ResourceInput,
} from "#shared/rules/classResources.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";

/**
 * The words and the drafts of a character's class resources
 * (docs/design-v1-combat-controls.md 7): what each row reads, what a rest
 * gives back, and the Add, Update and Edit sheets' checks, as plain
 * functions for node --test. Every sheet sends one character.update with
 * the whole list, each item without `used`, which the reducer keeps by id.
 */

export type Reset = ClassResource["reset"];

/** A row's count: what is left of the most, "2 of 3". */
export function countText(r: Pick<ClassResource, "max" | "used">): string {
  return `${left(r)} of ${r.max}`;
}

export function left(r: Pick<ClassResource, "max" | "used">): number {
  return Math.max(0, r.max - r.used);
}

/** Use's name, which says the count with it (9): "Use Rage, 2 of 3 left". */
export function useLabel(r: Pick<ClassResource, "name" | "max" | "used">): string {
  return `Use ${r.name}, ${countText(r)} left`;
}

/** Why Use is off. */
export function emptyText(r: Pick<ClassResource, "name" | "pool">): string {
  return r.pool ? `No ${r.name} is left.` : `${r.name} has no uses left.`;
}

/** Give back's name, and why it is off. */
export function backLabel(r: Pick<ClassResource, "name" | "pool">): string {
  return r.pool ? `Give back ${r.name}` : `Give one back: ${r.name}`;
}

export function fullText(r: Pick<ClassResource, "name">): string {
  return `${r.name} is full.`;
}

/**
 * Why a tap was refused, as a sentence of its own for the status line under
 * the rows: the server's reason, "Rage has no uses left.", without the
 * toast's "Not saved.", which reads oddly beside a Use.
 */
export function reasonText(refusal: { message: string; text: string } | undefined): string {
  const detail = refusal?.message.trim().replace(/\.$/, "") ?? "";
  if (!detail) return refusal?.text ?? "That could not be done.";
  return `${detail[0]!.toUpperCase()}${detail.slice(1)}.`;
}

/** The rest that brings a resource back, as its row's detail and the sheets' choice read it. */
export const RESET_WORDS: Record<Reset, string> = {
  long: "Back on a Long Rest",
  short: "Back on a Short or Long Rest",
  shortOne: "One back on a Short Rest, all on a Long Rest",
};

export const RESET_OPTIONS: { value: Reset; label: string }[] = [
  { value: "long", label: "A Long Rest" },
  { value: "short", label: "A Short or Long Rest" },
  { value: "shortOne", label: "One on a Short Rest, all on a Long Rest" },
];

/** A list in prose: "Rage", "Rage and Focus Points", "Rage, Wild Shape and Focus Points". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * What a rest also gives back of what is spent (7.2), as the rules of
 * shared/rules/rest.ts give it: "A Short Rest also gives back one Rage and
 * all Focus Points." Null when it gives back none, so a creature with
 * nothing spent reads nothing new.
 */
export function restBackText(resources: readonly ClassResource[] | undefined, kind: "short" | "long"): string | null {
  const spent = (resources ?? []).filter((r) => r.used > 0);
  if (kind === "long") return spent.length > 0 ? `A Long Rest also gives back ${joinWords(spent.map((r) => r.name))}.` : null;
  const words = spent.flatMap((r) => (r.reset === "shortOne" ? [`one ${r.name}`] : r.reset === "short" ? [r.max > 1 ? `all ${r.name}` : r.name] : []));
  return words.length > 0 ? `A Short Rest also gives back ${joinWords(words)}.` : null;
}

/**
 * An amount typed for a pool: a whole number from 1 to `most`, the most
 * left to spend or the most spent to give back. Anything else says the
 * range.
 */
export function amountOutcome(text: string, most: number, verb: "Spend" | "Give back"): { ok: true; amount: number } | { ok: false; error: string } {
  const n = wholeNumber(text);
  if (n === null || n < 1 || n > most) return { ok: false, error: most === 1 ? `${verb} 1.` : `${verb} 1 to ${most}.` };
  return { ok: true, amount: n };
}

/** Digits alone, as a numeric keypad types them: no sign, point or exponent. */
function wholeNumber(text: string): number | null {
  const t = text.trim();
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

/** The modifiers a character's stat block gives for counts from a modifier. None without a block. */
export function blockModifiers(stats: Pick<PcStats, "abilities"> | undefined): Partial<Record<CountAbility, number>> {
  if (!stats) return {};
  return { wis: abilityMod(stats.abilities.wis), cha: abilityMod(stats.abilities.cha) };
}

export type Outcome = { ok: true; resources: ResourceInput[] } | { ok: false; error: string };

const FULL = `A character holds at most ${LIMITS.resourcesPerCharacter} class resources.`;

/**
 * A list a sheet built, checked against the server's own schema for
 * character.update, so the sheet names what is wrong rather than sending
 * an op the server refuses: "Lay on Hands: a count is at most 99, a pool's
 * 200." A list stored before a rule tightened can hold such a resource.
 */
function checked(resources: ResourceInput[]): Outcome {
  const parsed = clientOpSchema.safeParse({ t: "character.update", characterId: "check", patch: { resources } });
  if (parsed.success) return { ok: true, resources };
  const issue = parsed.error.issues[0];
  const at = issue?.path[2];
  const name = typeof at === "number" ? resources[at]?.name : undefined;
  const detail = (issue?.message ?? "the server would refuse it").replace(/\.$/, "");
  return { ok: false, error: `${name ? `${name}: ` : ""}${detail}.` };
}

/**
 * Picking from a class (7.1): the class, its level, the presets ticked,
 * and the modifiers typed where the stat block gives none.
 */
export type PickDraft = {
  classId: ClassId | null;
  classLevel: number;
  ticks: readonly string[];
  modifiers: Partial<Record<CountAbility, number | null>>;
};

/** One preset in the pick: on the character already or not, its count at the draft's level, and the ability it still needs. */
export type PickRow = {
  preset: ClassPreset;
  /** The resource of this preset the character has. */
  have: ClassResource | undefined;
  count: number | null;
  /** The modifier its count is read from, from the block or as typed. Null for a count from a table or a level. */
  modifier: number | null;
  reset: Reset;
  ticked: boolean;
  /** Its count needs this modifier, which the stat block does not give. */
  asks?: CountAbility;
};

/**
 * Where a new pick starts: the class of the character's first preset,
 * at the class level it was read at, or no class at the character's
 * level, 1 without one.
 */
export function startPick(resources: readonly ClassResource[] | undefined, characterLevel: number | undefined): PickDraft {
  const first = (resources ?? []).map((r) => presetById(r.preset)).find((p) => p !== undefined);
  const draft: PickDraft = { classId: null, classLevel: characterLevel ?? 1, ticks: [], modifiers: {} };
  return first ? pickClass(draft, first.classId, resources, characterLevel) : draft;
}

/** A class chosen: its level as its presets were read at, else the character's, and its own presets that start by then ticked. */
export function pickClass(draft: PickDraft, classId: ClassId, resources: readonly ClassResource[] | undefined, characterLevel: number | undefined): PickDraft {
  const read = (resources ?? []).flatMap((r) => (presetById(r.preset)?.classId === classId && r.level !== undefined ? [r.level] : []));
  const classLevel = read.length > 0 ? Math.max(...read) : (characterLevel ?? draft.classLevel);
  return { ...draft, classId, classLevel, ticks: defaultTicks(classId, classLevel, resources) };
}

/**
 * The ticks a level starts with: the class's own presets that start by
 * then and are not on the character. A subclass's are left to the player,
 * since the app does not know the subclass.
 */
export function defaultTicks(classId: ClassId, classLevel: number, resources: readonly ClassResource[] | undefined, from = 0): string[] {
  const have = new Set((resources ?? []).map((r) => r.preset));
  return classPresets(classId)
    .filter((p) => p.unlock <= classLevel && p.unlock > from && !p.subclass && !have.has(p.id))
    .map((p) => p.id);
}

/** A new class level keeps the player's ticks that still start by then and ticks the class's own presets the level adds. */
export function pickLevel(draft: PickDraft, classLevel: number, resources: readonly ClassResource[] | undefined): PickDraft {
  if (!draft.classId) return { ...draft, classLevel };
  const kept = draft.ticks.filter((id) => (presetById(id)?.unlock ?? 99) <= classLevel);
  const added = defaultTicks(draft.classId, classLevel, resources, draft.classLevel).filter((id) => !kept.includes(id));
  return { ...draft, classLevel, ticks: [...kept, ...added] };
}

export function tick(draft: PickDraft, presetId: string, on: boolean): PickDraft {
  const ticks = draft.ticks.filter((id) => id !== presetId);
  return { ...draft, ticks: on ? [...ticks, presetId] : ticks };
}

function modifierFor(preset: ClassPreset, draft: PickDraft, block: Partial<Record<CountAbility, number>>): { modifier: number | null; asks?: CountAbility } {
  if (preset.count.by !== "modifier") return { modifier: null };
  const ability = preset.count.ability;
  const known = block[ability];
  if (known !== undefined) return { modifier: known };
  return { modifier: draft.modifiers[ability] ?? null, asks: ability };
}

/** The pick's rows: each of the class's presets that starts by the draft's level, in Appendix A's order. */
export function pickRows(draft: PickDraft, resources: readonly ClassResource[] | undefined, block: Partial<Record<CountAbility, number>>): PickRow[] {
  if (!draft.classId) return [];
  return classPresets(draft.classId)
    .filter((p) => p.unlock <= draft.classLevel)
    .map((preset) => {
      const { modifier, asks } = modifierFor(preset, draft, block);
      return {
        preset,
        have: (resources ?? []).find((r) => r.preset === preset.id),
        count: presetCount(preset, draft.classLevel, modifier),
        modifier,
        reset: presetReset(preset, draft.classLevel),
        ticked: draft.ticks.includes(preset.id),
        ...(asks ? { asks } : {}),
      };
    });
}

/** A count in words: "3 uses", "1 use", "a pool of 20". */
export function countWords(count: number, pool: boolean): string {
  if (pool) return `A pool of ${count}`;
  return count === 1 ? "1 use" : `${count} uses`;
}

/**
 * What a pick's row says under its name: its subclass, what it counts at
 * the draft's level and the rest that brings it back. In an update, a
 * resource the character has says how its count changes, or that it
 * stays, typed by hand or with no modifier to read again.
 */
export function pickHelp(row: PickRow, mode: "add" | "update"): string {
  const sub = row.preset.subclass ? `${row.preset.subclass}. ` : "";
  if (row.have && mode === "add") return `${sub}Already added.`;
  if (row.have) {
    const now = row.have.max;
    if (row.have.edited) return `${sub}Stays at ${now}, typed by hand.`;
    if (row.count === null || row.count === now) return `${sub}Stays at ${now}.`;
    return `${sub}Goes from ${now} to ${row.count}.`;
  }
  const { count: by } = row.preset;
  const from = by.by === "modifier" ? ABILITY_NAMES[by.ability] : null;
  const count =
    row.count === null ? `Your ${from} modifier, at least 1` : `${countWords(row.count, row.preset.pool === true)}${from && !row.asks ? `, from the stat block's ${from}` : ""}`;
  return `${sub}${count}. ${RESET_WORDS[row.reset]}.`;
}

/** The first class level that has a preset of the class, for a level with none yet. */
export function firstLevel(classId: ClassId): number {
  return Math.min(...classPresets(classId).map((p) => p.unlock));
}

function newFromTicks(rows: readonly PickRow[], input: { classLevel: number; characterLevel: number | undefined; newId(): string }): ResourceInput[] | string {
  const out: ResourceInput[] = [];
  for (const row of rows) {
    if (!row.ticked || row.have) continue;
    if (row.count === null) return `Fill in the ${ABILITY_NAMES[row.asks ?? "cha"]} modifier for ${row.preset.name}.`;
    const r = fromPreset(row.preset, { id: input.newId(), classLevel: input.classLevel, characterLevel: input.characterLevel, modifier: row.modifier });
    if (r) out.push(r);
  }
  return out;
}

/** Add from a class: the list with each ticked preset the character does not have at the end. */
export function addOutcome(
  draft: PickDraft,
  input: { resources: readonly ClassResource[] | undefined; block: Partial<Record<CountAbility, number>>; characterLevel: number | undefined; newId(): string },
): Outcome {
  if (!draft.classId) return { ok: false, error: "Choose a class first." };
  const fresh = newFromTicks(pickRows(draft, input.resources, input.block), { ...input, classLevel: draft.classLevel });
  if (typeof fresh === "string") return { ok: false, error: fresh };
  if (fresh.length === 0) return { ok: false, error: "Tick a resource to add." };
  const resources = [...asInputs(input.resources), ...fresh];
  if (resources.length > LIMITS.resourcesPerCharacter) return { ok: false, error: `${FULL} Untick ${resources.length - LIMITS.resourcesPerCharacter} or remove one first.` };
  return checked(resources);
}

/**
 * Update a class after the character's level rose (7.1): its presets read
 * at the new class level, and the ticked ones it does not have added. The
 * modifiers come from the stat block, else as typed, and a modifier count
 * with neither keeps its count.
 */
export function updateOutcome(
  draft: PickDraft,
  input: { resources: readonly ClassResource[] | undefined; block: Partial<Record<CountAbility, number>>; characterLevel: number; newId(): string },
): Outcome {
  if (!draft.classId) return { ok: false, error: "Choose a class first." };
  const fresh = newFromTicks(pickRows(draft, input.resources, input.block), { ...input, classLevel: draft.classLevel });
  if (typeof fresh === "string") return { ok: false, error: fresh };
  const typed = Object.fromEntries(Object.entries(draft.modifiers).filter(([, v]) => typeof v === "number")) as Partial<Record<CountAbility, number>>;
  const resources = updateClass(input.resources, { classId: draft.classId, classLevel: draft.classLevel, characterLevel: input.characterLevel, modifiers: { ...typed, ...input.block }, add: fresh });
  if (resources.length > LIMITS.resourcesPerCharacter) return { ok: false, error: `${FULL} Untick ${resources.length - LIMITS.resourcesPerCharacter} or remove one first.` };
  return checked(resources);
}

/** Where an update starts: its class at the level guessed from the rise, and the class's own presets that level adds ticked. */
export function startUpdate(resources: readonly ClassResource[] | undefined, up: LevelUp): PickDraft {
  return { classId: up.classId, classLevel: up.guess, ticks: defaultTicks(up.classId, up.guess, resources, up.classLevel), modifiers: {} };
}

/** "Update Barbarian resources?" and its sheet's title. */
export function updateTitle(classId: ClassId): string {
  return `Update ${CLASS_NAMES[classId]} resources`;
}

/** A resource of the player's own, or one being edited: its name, count, rest, and whether it spends an amount (7.1). */
export type OwnDraft = { name: string; count: string; reset: Reset; pool: boolean };

export const EMPTY_OWN: OwnDraft = { name: "", count: "", reset: "long", pool: false };

export function editDraft(r: ClassResource): OwnDraft {
  return { name: r.name, count: String(r.max), reset: r.reset, pool: r.pool === true };
}

/** A draft's name and count as the schema takes them, or what is wrong with them. */
function ownFields(draft: OwnDraft): { name: string; max: number } | string {
  const name = draft.name.trim();
  if (name === "") return "Give it a name.";
  if (name.length > LIMITS.resourceNameChars) return `A name is at most ${LIMITS.resourceNameChars} characters.`;
  if (!combatUseSchemas.resourceName.safeParse(name).success) return "A name holds letters, numbers and punctuation only.";
  const most = draft.pool ? LIMITS.resourcePoolMax : LIMITS.resourceMax;
  const n = wholeNumber(draft.count);
  if (n === null || n < 1 || n > most) return draft.pool ? `An amount is 1 to ${most}.` : `A count is 1 to ${most}.`;
  return { name, max: n };
}

/** Add one of the player's own: at the end of the list, with no preset. */
export function ownOutcome(draft: OwnDraft, input: { resources: readonly ClassResource[] | undefined; newId(): string }): Outcome {
  const fields = ownFields(draft);
  if (typeof fields === "string") return { ok: false, error: fields };
  const list = asInputs(input.resources);
  if (list.length >= LIMITS.resourcesPerCharacter) return { ok: false, error: `${FULL} Remove one first.` };
  return checked([...list, { id: input.newId(), name: fields.name, max: fields.max, reset: draft.reset, ...(draft.pool ? { pool: true as const } : {}) }]);
}

/**
 * Save an edit in place. A new count marks it `edited`, so an update for a
 * level never changes it, and so does a pool other than its preset's: an
 * update would otherwise give Lay on Hands, kept as a count, 100 uses where
 * a count holds at most 99. A name or a rest alone does not.
 */
export function editOutcome(draft: OwnDraft, input: { resources: readonly ClassResource[] | undefined; id: string }): Outcome {
  const fields = ownFields(draft);
  if (typeof fields === "string") return { ok: false, error: fields };
  const list = asInputs(input.resources);
  if (!list.some((r) => r.id === input.id)) return { ok: false, error: "It was removed meanwhile." };
  return checked(
    list.map((r) => {
      if (r.id !== input.id) return r;
      const { pool: _pool, ...rest } = r;
      const preset = presetById(r.preset);
      const typed = r.edited || fields.max !== r.max || (preset !== undefined && draft.pool !== (preset.pool === true));
      return { ...rest, name: fields.name, max: fields.max, reset: draft.reset, ...(draft.pool ? { pool: true as const } : {}), ...(typed ? { edited: true as const } : {}) };
    }),
  );
}

/** Remove one. The list left, empty when it was the last, which removes them all. */
export function removeOutcome(resources: readonly ClassResource[] | undefined, id: string): Outcome {
  return checked(asInputs(resources).filter((r) => r.id !== id));
}
