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

export const DICE_SETS: readonly DiceSet[] = [{ id: "ivory", name: "Ivory", body: "#f1efe9", ink: "#16161a", faint: "#a29e93", edge: "#c9c4b6", finish: "matte" }];

export const DEFAULT_DICE_SET = "ivory";

/** A set by its id, Ivory for one this version does not know. */
export function diceSet(id: string): DiceSet {
  return DICE_SETS.find((s) => s.id === id) ?? DICE_SETS[0]!;
}
