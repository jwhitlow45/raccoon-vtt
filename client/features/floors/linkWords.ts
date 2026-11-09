import type { FloorLink } from "#shared/model.ts";
import { LINK_WORDS, climbLabel } from "#shared/rules/floorLinks.ts";

/*
 * Every word stairs and ladders show on a device (docs/design/design-v1-floors.md
 * phase 2, 6.3, 7, 10 and 11), in one place so the bar, the board, the
 * builder and the floor page name them alike. The server's refusals are
 * shared/rules/floorLinks.ts LINK_WORDS, which a refusal toast shows as
 * it comes.
 */

type Kind = FloorLink["kind"];
type Dir = "up" | "down";

/** "stairs" or "ladder", the word for the kind inside a sentence. */
function noun(kind: Kind): string {
  return kind === "stairs" ? "stairs" : "ladder";
}

/** The kind's chip and pane choice: "Stairs", "Ladder". */
export const KIND_NAMES = { stairs: "Stairs", ladder: "Ladder" } as const satisfies Record<Kind, string>;

// The bar and the strip (6.2, 6.3).

/** The button's words: "Go up", "Go down". */
export function climbWords(dir: Dir): string {
  return dir === "up" ? "Go up" : "Go down";
}

/** The button's name: "Go up the stairs to Upper floor", without "to …" where the viewer does not hold that floor. */
export function climbName(dir: Dir, kind: Kind, floor: string | null): string {
  const way = `${climbWords(dir)} the ${noun(kind)}`;
  return floor === null ? way : `${way} to ${floor}`;
}

/** The button's tooltip, with the key where the device has a keyboard: "Go up the stairs (})". */
export function climbTip(dir: Dir, kind: Kind, key: string | null): string {
  const way = `${climbWords(dir)} the ${noun(kind)}`;
  return key === null ? way : `${way} (${key})`;
}

/** The dim line under an off button (6.1), the server's words for the same refusal. */
export function climbOffReason(why: "locked" | "squeeze" | "tooBig", kind: Kind): string {
  if (why === "locked") return LINK_WORDS.locked;
  return why === "squeeze" ? LINK_WORDS.tooBigSqueeze(kind) : LINK_WORDS.tooBig(kind);
}

/** What `}` or `{` says where the selected creature is on no stairs (6.2). */
export function notOnStairs(name: string): string {
  return `${name} isn't on stairs or a ladder.`;
}

/** The undo step's label after "Undo ": "moving Thorn up the stairs", the server's own (6.3). */
export { climbLabel };

// The board (10, 11).

/**
 * An end's name pill: "Up to Upper floor" where the viewer holds that
 * floor, else "Stairs up" or "Ladder down", which names no floor.
 */
export function linkName(dir: Dir, kind: Kind, floor: string | null): string {
  if (floor !== null) return `${dir === "up" ? "Up" : "Down"} to ${floor}`;
  return `${KIND_NAMES[kind]} ${dir}`;
}

/** The DM's pill where players have not reached the far floor: "Up to Attic · Not reached yet". */
export function linkNameNotReached(dir: Dir, floor: string): string {
  return `${linkName(dir, "stairs", floor)} · ${NOT_REACHED}`;
}

/** The DM's mark of a far floor players have not reached, as the Floors menu marks it (scenes/floorWords.ts FLOOR_MARKS). */
export const NOT_REACHED = "Not reached yet";

// The builder's Between floors mode (7).

/** The mode's name and its short word, the same (D-261109-021). */
export const LINK_MODE = "Between floors";

/** The mode's option bar: the kind's group and the far floor's. */
export const KIND_GROUP = "Kind";
export const TO_GROUP = "To";

/** A To choice: "Up to Upper floor", "Down to Cellar". */
export function toChoice(dir: Dir, floor: string): string {
  return linkName(dir, "stairs", floor);
}

/** The mode's hint, under 45 characters so it fits at 390: "Drag over squares to place stairs." */
export function linkHint(kind: Kind, hexes: boolean): string {
  return `Drag over ${hexes ? "hexes" : "squares"} to place ${kind === "stairs" ? "stairs" : "a ladder"}.`;
}

// An end's pane (7.2).

/** The pane's title and heading: "Stairs up to Upper floor", "Ladder down to Cellar". */
export function paneTitle(dir: Dir, kind: Kind, floor: string): string {
  return `${KIND_NAMES[kind]} ${dir} to ${floor}`;
}

export const LOCKED_SWITCH = "Locked";

/** The Locked switch's help (D-261109-103). */
export function lockedHelp(kind: Kind): string {
  return `Go up and Go down are off while ${kind === "stairs" ? "they're" : "it's"} locked. A party member who climbs opens the floor to players.`;
}

/** The pane's line where players have not reached the far floor: what they read on the board instead. */
export function notReachedLine(floor: string, dir: Dir, kind: Kind): string {
  return `Players haven't reached ${floor}, so they see "${linkName(dir, kind, null)}" here.`;
}

/** "Go to Upper floor": shows that floor with the other end selected. */
export function goToFloor(floor: string): string {
  return `Go to ${floor}`;
}

/** "Remove stairs", then on a second tap "Remove both ends". */
export function removeWords(kind: Kind): string {
  return `Remove ${kind === "stairs" ? "stairs" : "ladder"}`;
}
export const REMOVE_BOTH = "Remove both ends";

// The builder's undo steps (7.2): the server's labels after "Undo ", "placing stairs to Upper floor".
export { LINK_LABELS } from "#shared/rules/floorLinks.ts";
