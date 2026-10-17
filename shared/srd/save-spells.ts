/**
 * What a pass takes for the SRD 5.2.1 spells (CC-BY-4.0, see NOTICE.md) that
 * force a save for damage and have no area preset (area-spells.ts holds
 * those), read by hand against each spell's text (W7B-R2-3). A character's
 * spell of the same name with no "On a pass" set takes this
 * (`unknownOnPass` in shared/rules/pcStats.ts), so an unset Disintegrate
 * takes none.
 *
 * Left out: spells whose damage does not hang on the save they force when
 * cast (Heat Metal, Searing Smite, Ensnaring Strike, Geas), the caster's
 * own save (Contact Other Plane), a summoned creature's attacks (Summon
 * Dragon, Giant Insect), and Storm of Vengeance, whose parts differ.
 */
export const SAVE_SPELLS: readonly { name: string; onPass: "half" | "none" }[] = [
  { name: "Befuddlement", onPass: "half" },
  { name: "Blade Barrier", onPass: "half" },
  { name: "Blight", onPass: "half" },
  { name: "Chain Lightning", onPass: "half" },
  { name: "Conjure Elemental", onPass: "none" },
  { name: "Contagion", onPass: "none" },
  { name: "Control Water", onPass: "half" },
  { name: "Disintegrate", onPass: "none" },
  { name: "Dissonant Whispers", onPass: "half" },
  { name: "Dream", onPass: "none" },
  { name: "Faithful Hound", onPass: "none" },
  { name: "Finger of Death", onPass: "half" },
  { name: "Flaming Sphere", onPass: "half" },
  { name: "Guardian of Faith", onPass: "half" },
  { name: "Harm", onPass: "half" },
  { name: "Hellish Rebuke", onPass: "half" },
  { name: "Inflict Wounds", onPass: "half" },
  { name: "Mind Spike", onPass: "half" },
  { name: "Phantasmal Killer", onPass: "half" },
  { name: "Prismatic Wall", onPass: "half" },
  { name: "Sacred Flame", onPass: "none" },
  { name: "Tsunami", onPass: "half" },
  { name: "Vicious Mockery", onPass: "none" },
  { name: "Wall of Fire", onPass: "half" },
  { name: "Wall of Ice", onPass: "half" },
  { name: "Wall of Thorns", onPass: "half" },
  { name: "Wind Wall", onPass: "half" },
];
