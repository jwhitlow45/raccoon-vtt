import type { Character } from "#shared/model.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import { MAX_KNOWN_FORMS, type ActorPatch } from "#shared/protocol.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { shapePatch, shapeTempHp } from "./shape.ts";
import { byCrThenName, DRUID_LEVELS, knownFormCount, shapeLimitMiss, type ShapeLimit } from "./shapeLevel.ts";

/*
 * A Druid's known forms (docs/design-v1-known-forms.md 5), as plain
 * functions for node --test: the list a tap sends, the count's words, the
 * marks against a Druid level, and the Druid level this device remembers.
 * The rule is shown, never enforced, so nothing here refuses a form but the
 * protocol's cap.
 */

/** The list with the form taken out, or added at the end, in the order chosen. At MAX_KNOWN_FORMS another is not added. */
export function toggleKnownForm(list: readonly string[] | undefined, srdId: string): string[] {
  const now = list ?? [];
  if (now.includes(srdId)) return now.filter((id) => id !== srdId);
  return now.length >= MAX_KNOWN_FORMS ? [...now] : [...now, srdId];
}

/** The count in a sentence, `short` for the label row, and `over` for the warning tone. */
export type KnownFormCount = { text: string; short: string; over: boolean };

/** The count read against the Beast Shapes table for the Druid level picked, the first case that holds (5.4). */
export function knownFormCountWords(count: number, level: number | null): KnownFormCount {
  const forms = `${count} known ${count === 1 ? "form" : "forms"}`;
  if (level !== null) {
    const most = knownFormCount(level);
    const short = `${count} of ${most} at Druid level ${level}`;
    if (count > most) return { text: `${forms}, ${count - most} more than a level ${level} Druid knows.`, short, over: true };
    return { text: `${count} of ${most} known forms at Druid level ${level}.`, short, over: false };
  }
  if (count >= MAX_KNOWN_FORMS) return { text: `${forms}, the most there are.`, short: `${count} of ${MAX_KNOWN_FORMS}`, over: false };
  return { text: `${forms}.`, short: String(count), over: false };
}

/** The forms the SRD list has, highest CR first, and the ids it lacks, in the order chosen. */
export function knownFormsIn<M extends StatBlockMonster & { srdId: string }>(ids: readonly string[] | undefined, list: readonly M[]): { forms: M[]; missing: string[] } {
  const byId = new Map(list.map((m) => [m.srdId, m]));
  const forms: M[] = [];
  const missing: string[] = [];
  for (const id of ids ?? []) {
    const m = byId.get(id);
    if (m) forms.push(m);
    else missing.push(id);
  }
  return { forms: forms.sort(byCrThenName), missing };
}

/** What an id the SRD list lacks says, such as after a later rename or from a crafted op. */
export function missingFormText(id: string): string {
  return `${id}: not in this app's SRD list`;
}

/** A mark on a known form a Druid of the picked level may not take: the tag's words, short enough for its 88 px, and the reason its row's name adds. */
export type FormMark = { tag: string; reason: string };

const CR_WORD = new Map([
  [0.25, "1/4"],
  [0.5, "1/2"],
  [1, "1"],
]);

export function formMark(limit: ShapeLimit | null, m: StatBlockMonster): FormMark | null {
  if (!limit) return null;
  const miss = shapeLimitMiss(limit, m);
  if (miss === "fly") return { tag: "Fly Speed", reason: "has a Fly Speed" };
  if (miss !== "cr") return null;
  // No level the select offers is below 2, so this is the rule's own answer rather than one anyone sees.
  if (limit.maxCr === null) return { tag: "No Wild Shape", reason: "no Wild Shape before level 2" };
  const cr = CR_WORD.get(limit.maxCr) ?? String(limit.maxCr);
  return { tag: `Over CR ${cr}`, reason: `over CR ${cr}` };
}

/** A known form's accessible name in Take a shape: what one tap does, and its mark's reason. */
export function formLabel(name: string, mark: FormMark | null): string {
  return `Wild Shape as ${name}${mark ? `, ${mark.reason}` : ""}`;
}

/** The form a druid in Wild Shape is in: its row is pressed and a tap does nothing, as a second tap would refill the Temporary HP (5.3). */
export function isCurrentForm(character: Pick<Character, "actor">, srdId: string): boolean {
  return pcShape(character) === "wild" && character.actor.srdId === srdId;
}

/**
 * The one patch a known form's tap sends: Wild Shape, with the Temporary HP
 * the step's checkbox gives by default, which shapePatch adds only where
 * they are more than the character holds (5.1). `druidLevel` is the one this
 * device remembers (rememberedDruidLevel).
 */
export function knownFormPatch(creature: Pick<SrdMonster, "srdId" | "ac" | "speeds" | "hp">, character: Pick<Character, "level" | "actor">, druidLevel: number | null | undefined): ActorPatch {
  // Any picked (null) names no Druid level, so the character's level stands in, as when none was picked.
  return shapePatch(creature, "wild", character, shapeTempHp("wild", character, creature, druidLevel ?? undefined));
}

// ------------------------------------------------------------ the Druid level on this device

/**
 * The Druid level picked in Take a shape, per character, on this device
 * (5.5), as the dice history is kept: an object by character id under
 * `rvtt.druidLevel.<room>`, where null is Any. Any is kept too, so a
 * player who turns into other creatures with Polymorph is not taken back
 * to the character's level each time. Every read and write is in try and
 * catch, so a device with storage blocked starts at the character's level
 * each time.
 */
function druidLevelKey(roomId: string): string {
  return `rvtt.druidLevel.${roomId}`;
}

function readDruidLevels(roomId: string): Record<string, number | null> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(druidLevelKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number | null> = {};
    for (const [id, level] of Object.entries(parsed)) if (level === null || (typeof level === "number" && DRUID_LEVELS.includes(level))) out[id] = level;
    return out;
  } catch {
    return {};
  }
}

/** The Druid level this device remembers for the character: a level, null for Any, or undefined when none was picked here. */
export function rememberedDruidLevel(roomId: string, characterId: string): number | null | undefined {
  return readDruidLevels(roomId)[characterId];
}

/** Remembers the level picked for the character, or Any (null). */
export function rememberDruidLevel(roomId: string, characterId: string, level: number | null): void {
  try {
    const all = readDruidLevels(roomId);
    all[characterId] = level;
    localStorage.setItem(druidLevelKey(roomId), JSON.stringify(all));
  } catch {
    // Storage blocked or full: the level lasts while Take a shape is open.
  }
}

/**
 * Where the Druid level select starts (5.5): the level or Any remembered,
 * else the character's level once it has known forms and is level 2 or
 * more, else Any. The select offers no level 1, since Wild Shape starts at 2.
 */
export function startDruidLevel(remembered: number | null | undefined, character: Pick<Character, "level" | "knownForms">): number | null {
  if (remembered !== undefined) return remembered;
  const level = character.level;
  return (character.knownForms?.length ?? 0) > 0 && level !== undefined && level >= 2 ? level : null;
}
