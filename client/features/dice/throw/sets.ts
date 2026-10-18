/**
 * The dice sets (docs/design-v1-roll-animation.md 9.1): a body color, an
 * ink for the result, a faint ink for the other faces, an edge color and
 * a finish, drawn in code into the dice's textures. No image or texture
 * file of any kind. A set is chosen on the device and kept there, never in
 * the room, and others' toasts keep the flat d20 icon in the app's colors.
 *
 * Each set's numbers were read back from rendered pixels on the tray's
 * scrim: its result at least 6.7:1, its faint numbers between 2.1 and
 * 2.4:1, and its edge at least 5.7:1 on the scrim (sets.test.ts holds the
 * unlit rule).
 */

export type Finish = "matte" | "glossy" | "translucent" | "metal";

export type DiceSet = { id: string; name: string; body: string; ink: string; faint: string; edge: string; finish: Finish };

export const DICE_SETS: readonly DiceSet[] = [
  { id: "ivory", name: "Ivory", body: "#f1efe9", ink: "#16161a", faint: "#a29e93", edge: "#c9c4b6", finish: "matte" },
  { id: "obsidian", name: "Obsidian", body: "#2a2a33", ink: "#f4f1ea", faint: "#6f6d7a", edge: "#9a97a6", finish: "glossy" },
  { id: "ruby", name: "Ruby", body: "#94102a", ink: "#ffffff", faint: "#d0697a", edge: "#f08a98", finish: "translucent" },
  { id: "sapphire", name: "Sapphire", body: "#173f9e", ink: "#ffffff", faint: "#6f8fd8", edge: "#8fb0ff", finish: "translucent" },
  { id: "emerald", name: "Emerald", body: "#0a5236", ink: "#ffffff", faint: "#4e9677", edge: "#5fc59a", finish: "glossy" },
  { id: "amethyst", name: "Amethyst", body: "#5b2a9e", ink: "#ffffff", faint: "#9d7ccf", edge: "#b99cf0", finish: "translucent" },
  { id: "gold", name: "Gold", body: "#d9b448", ink: "#24180a", faint: "#86681a", edge: "#f6dc86", finish: "metal" },
  { id: "steel", name: "Steel", body: "#c3c8d1", ink: "#15171c", faint: "#737884", edge: "#eef1f6", finish: "metal" },
];

export const DEFAULT_DICE_SET = "ivory";

/** A set by its id, Ivory for one this version does not know. */
export function diceSet(id: string): DiceSet {
  return DICE_SETS.find((s) => s.id === id) ?? DICE_SETS[0]!;
}

/** The stored choice as a set's id: Ivory when unset or unknown. */
export function parseDiceSet(raw: string | null): string {
  return diceSet(raw ?? DEFAULT_DICE_SET).id;
}
