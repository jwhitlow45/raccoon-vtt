/**
 * The SRD 5.2.1 damage types, one list for every reader: the monster
 * filters, the stat block readers and the dice's damage parts
 * (docs/design-v1-dice.md 6.2), so a part's type and a defense's words
 * always name the same thing.
 */
export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
