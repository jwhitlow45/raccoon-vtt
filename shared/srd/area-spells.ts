import type { AreaShape, AreaTrigger } from "../model.ts";
import data from "./area-spells.json" with { type: "json" };

/**
 * Spell presets for area templates: the SRD 5.2.1 spells (CC-BY-4.0, see
 * NOTICE.md) whose effect covers an area, generated into area-spells.json by
 * scripts/srd-import.ts from a hand-reviewed table. Searching "fireball"
 * gives a 20-foot-radius sphere.
 *
 * Sizes are in feet and mean what AreaTemplate.size means: the radius of a
 * sphere or cylinder, the length of a cone or line, the side of a cube, or
 * the distance of an emanation.
 */
export type AreaSpell = {
  srdId: string;
  name: string;
  /** 0 for a cantrip. */
  level: number;
  shape: AreaShape;
  size: number;
  /** Lines only. */
  width?: number;
  /** Cylinders only. */
  height?: number;
  /**
   * An emanation that moves with the caster, such as Spirit Guardians. An
   * emanation without it stays where it was cast (Tiny Hut), or surrounds a
   * target rather than the caster (Ice Knife), as its note says.
   */
  attached: boolean;
  /** The spell's range is Self, so the area starts at the caster. */
  fromCaster: boolean;
  /** As printed, such as "150 feet" or "Self". */
  range: string;
  concentration: boolean;
  /**
   * When the spell hits a creature again after it is cast, as its text
   * says: entering the area ("enters the Emanation"), or starting or ending
   * a turn there. A new area from the preset reminds the table then
   * (AreaTemplate.triggers).
   */
  triggers?: AreaTrigger[];
  /**
   * The text limits it to once a turn per creature, whichever trigger it is
   * ("makes this save only once per turn"). A new area from the preset then
   * reminds about each creature once a turn (AreaTemplate.oncePerTurn).
   */
  oncePerTurn?: true;
  /**
   * What an emanation that does not come from the caster surrounds, as the
   * spell names it, such as Conjure Animals' "pack". Without it, it is "the
   * target", as for Ice Knife.
   */
  target?: string;
  /**
   * False when that target is not one of the creatures the spell hits, so
   * the area leaves it out: Conjure Animals' pack forces saves on creatures
   * near it, not on itself. Ice Knife's target is caught.
   */
  catchesTarget?: false;
  /** How the preset differs from a plain template, such as "Four Spheres". */
  note?: string;
};

export const AREA_SPELLS = data as readonly AreaSpell[];
