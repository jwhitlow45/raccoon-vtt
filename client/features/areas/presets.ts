import { AREA_SPELLS, type AreaSpell } from "#shared/srd/area-spells.ts";
import { canPitch, DEFAULT_CYLINDER_HEIGHT_FT, DEFAULT_LINE_WIDTH_FT, defaultIncludeOrigin } from "#shared/rules/aoe.ts";
import { usesFrom, type AreaDraft } from "./placement.ts";

/**
 * Spell presets for the area tool: search the SRD 5.2.1 area spells and turn
 * one into a draft with the right shape, size and placement.
 *
 * How each kind of preset is placed:
 * - Cones and lines start on a token's edge: the caster's, or for Dragon's
 *   Breath the creature that exhales it.
 * - A cube with range Self (Thunderwave) starts on the caster's edge. Any
 *   other cube is a square on the ground placed by its center (Entangle,
 *   Black Tentacles, Fire Storm's cubes).
 * - Spheres and cylinders go where the person taps, with the caster
 *   recorded so the distance from it reads against the spell's range.
 * - An emanation that moves with its caster (Spirit Guardians, Conjure
 *   Minor Elementals) attaches to the caster. One that is "immobile once
 *   cast" (Tiny Hut) surrounds the caster where it stands. Ice Knife's
 *   surrounds the target, which it also catches.
 */

/** Curly and straight apostrophes match, case and punctuation do not matter. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Name prefix first, then a word that starts with the query, then anywhere in the name. Ties by name. */
export function searchAreaSpells(query: string, limit = 8, spells: readonly AreaSpell[] = AREA_SPELLS): AreaSpell[] {
  const q = normalize(query);
  if (!q) return [];
  const ranked: { spell: AreaSpell; rank: number }[] = [];
  for (const spell of spells) {
    const name = normalize(spell.name);
    const rank = name.startsWith(q) ? 0 : name.split(" ").some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ spell, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.spell.name.localeCompare(b.spell.name));
  return ranked.slice(0, limit).map((r) => r.spell);
}

/** "150 feet" is 150 and "1 mile" is 5,280. Self and Touch have no range to show. */
export function rangeFeet(range: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(feet|foot|ft|miles?)$/i.exec(range.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return /mile/i.test(m[2]!) ? n * 5280 : n;
}

/** Ice Knife's kind: an emanation that does not come from the caster surrounds a target and catches it. */
function surroundsTarget(spell: AreaSpell): boolean {
  return spell.shape === "emanation" && !spell.fromCaster;
}

/**
 * A draft for a spell. It keeps the draft's id, color, aim and any point
 * already tapped, and casts from `casterId` when the spell starts from a
 * token and one is known. Without one, the tool asks for a tap.
 */
export function presetDraft(spell: AreaSpell, prev: AreaDraft, casterId: string | undefined): AreaDraft {
  const target = surroundsTarget(spell);
  const fromToken = usesFrom(spell.shape) && !target && !(spell.shape === "cube" && !spell.fromCaster);
  const draft: AreaDraft = {
    id: prev.id,
    shape: spell.shape,
    size: spell.size,
    width: spell.width ?? DEFAULT_LINE_WIDTH_FT,
    height: spell.height ?? DEFAULT_CYLINDER_HEIGHT_FT,
    anchor: "bottom",
    yaw: prev.yaw,
    pitch: canPitch(spell.shape) ? prev.pitch : 0,
    faceU: 0,
    point: fromToken || target ? null : prev.point,
    attached: spell.shape === "emanation" && (spell.attached || target),
    // Ice Knife's target is caught. Conjure Animals' pack is not (AreaSpell.catchesTarget).
    includeOrigin: target ? spell.catchesTarget !== false : defaultIncludeOrigin(spell.shape),
    targetsOther: target,
    color: prev.color,
    spell: spell.name,
    visibility: prev.visibility,
    triggers: spell.triggers ? [...spell.triggers] : [],
    oncePerTurn: spell.oncePerTurn === true,
  };
  if (fromToken && casterId) draft.fromId = casterId;
  if (casterId) draft.casterId = casterId;
  if (target && spell.target) draft.targetName = spell.target;
  if (spell.note) draft.note = spell.note;
  const range = rangeFeet(spell.range);
  if (range !== undefined) draft.rangeFt = range;
  return draft;
}

/** What the tool says while a draft has nowhere to be yet. */
export function placementHint(d: AreaDraft): string {
  if (d.targetsOther) return `Tap the ${d.targetName ?? "target"}.`;
  if (d.shape === "sphere" || d.shape === "cylinder") return "Tap where it goes.";
  if (d.shape === "cube" && !d.fromId) return "Tap a token to cast from it, or tap the middle of the square.";
  if (d.shape === "emanation") return "Tap the token it surrounds, or a point on the map.";
  return "Tap the caster, or a point on the map.";
}
