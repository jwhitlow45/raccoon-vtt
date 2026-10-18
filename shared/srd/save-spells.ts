import data from "./save-spells.json" with { type: "json" };

/**
 * What a pass takes for each SRD 5.2.1 spell (CC-BY-4.0, see NOTICE.md)
 * that deals damage on a save, area spell or single target, generated into
 * save-spells.json by scripts/srd-import.ts from each spell's text: half
 * where it says "half as much damage" or "half the initial damage", else
 * none (W7B-R2-3). A character's spell of the same name with no "On a pass"
 * set takes this (`unknownOnPass` in shared/rules/pcStats.ts), so an unset
 * Disintegrate takes none and an unset Fireball half.
 *
 * Left out, each with its reason in the script's SAVE_SKIP: spells whose
 * text names a save and damage but whose damage does not hang on a save,
 * such as Heat Metal and Searing Smite, and Storm of Vengeance, whose
 * rounds differ. A summoned creature's own stat-block saves, such as Summon
 * Dragon's breath and Giant Insect's, are left out by the script's
 * lowercase SAVE_RE instead, since their stat blocks write "Saving Throw".
 */
export type SaveSpell = {
  srdId: string;
  name: string;
  /** 0 for a cantrip. */
  level: number;
  onPass: "half" | "none";
};

export const SAVE_SPELLS = data as readonly SaveSpell[];
