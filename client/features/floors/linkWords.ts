import type { FloorLink } from "#shared/model.ts";
import { LINK_WORDS, climbLabel } from "#shared/rules/floorLinks.ts";

/*
 * Every word stairs, ladders and openings show on a device
 * (docs/design/design-v1-floors.md phase 2, 6.3, 7, 10 and 11, and phase 4,
 * 3, 5 and 8.1), in one place so the bar, the board, the builder and the
 * floor page name them alike. The server's refusals are
 * shared/rules/floorLinks.ts LINK_WORDS, which a refusal toast shows as
 * it comes.
 */

type Kind = FloorLink["kind"];
type Dir = "up" | "down";

/** The word for the kind inside a sentence. */
const NOUNS = { stairs: "stairs", ladder: "ladder", opening: "opening" } as const satisfies Record<Kind, string>;

function noun(kind: Kind): string {
  return NOUNS[kind];
}

/** The kind's chip and pane choice: "Stairs", "Ladder", "Opening" (phase 4, 3). */
export const KIND_NAMES = { stairs: "Stairs", ladder: "Ladder", opening: "Opening" } as const satisfies Record<Kind, string>;

// The bar and the strip (6.2, 6.3, and phase 4, 5).

/** The button's words: "Go up", "Go down", and through an opening "Fly up", "Fly down". */
export function climbWords(dir: Dir, kind: Kind = "stairs"): string {
  if (kind === "opening") return dir === "up" ? "Fly up" : "Fly down";
  return dir === "up" ? "Go up" : "Go down";
}

/**
 * The button's name: "Go up the stairs to Upper floor", without "to …"
 * where the viewer does not hold that floor. Through an opening it names
 * the floor alone, "Fly down to Ground floor", and without it "Fly down
 * through the opening".
 */
export function climbName(dir: Dir, kind: Kind, floor: string | null): string {
  if (kind === "opening") return `${climbWords(dir, kind)} ${floor === null ? "through the opening" : `to ${floor}`}`;
  const way = `${climbWords(dir)} the ${noun(kind)}`;
  return floor === null ? way : `${way} to ${floor}`;
}

/**
 * The button's tooltip, with the key where the device has a keyboard: "Go
 * up the stairs (})". An opening's names the floor as its name does, "Fly
 * down to Ground floor ({)".
 */
export function climbTip(dir: Dir, kind: Kind, key: string | null, floor: string | null = null): string {
  const way = kind === "opening" ? climbName(dir, kind, floor) : `${climbWords(dir)} the ${noun(kind)}`;
  return key === null ? way : `${way} (${key})`;
}

/** What `}` or `{` says for a creature on the ground under or over an opening, the server's words for a hand-made flight (phase 4, 5). */
export const FLY_ONLY = "Only a creature in the air goes through an opening.";

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

/** The DM's mark on hidden stairs or a hidden ladder (phase 4, 8.1), before "Not reached yet" where both apply. */
export const HIDDEN_MARK = "Hidden";

/** The DM's pill's marks after the name, joined as the pill joins a value: "Hidden · Not reached yet", or null with none. */
export function linkMarksLine(marks: { hidden: boolean; notReached: boolean }): string | null {
  const out = [marks.hidden ? HIDDEN_MARK : null, marks.notReached ? NOT_REACHED : null].filter((m): m is string => m !== null);
  return out.length > 0 ? out.join(" · ") : null;
}

/**
 * The chip inside an opening's upper end (phase 4, 7.4): how far a
 * creature would fall there, "10 ft down", shown only where the device
 * holds the floor below and its end.
 */
export function dropChip(ft: number): string {
  return `${ft} ft down`;
}

/** The notice an opening's window waits under while the floor below loads (phase 4, 12): "Loading Ground floor…". */
export function windowLoading(floor: string): string {
  return `Loading ${floor}…`;
}

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
  const what = kind === "stairs" ? "stairs" : kind === "ladder" ? "a ladder" : "an opening";
  return `Drag over ${hexes ? "hexes" : "squares"} to place ${what}.`;
}

// An end's pane (7.2).

/** The pane's title and heading: "Stairs up to Upper floor", "Ladder down to Cellar", "Opening down to Ground floor". */
export function paneTitle(dir: Dir, kind: Kind, floor: string): string {
  return `${KIND_NAMES[kind]} ${dir} to ${floor}`;
}

/** The pane's name for a screen reader: "Edit stairs", "Edit ladder", "Edit opening". */
export function paneName(kind: Kind): string {
  return `Edit ${noun(kind)}`;
}

/**
 * The kinds the pane's Kind offers an end of stairs or a ladder: the
 * server turns neither into an opening, nor an opening into either (phase
 * 4, 3), so an opening's pane has no Kind at all.
 */
export const PANE_KINDS = ["stairs", "ladder"] as const satisfies readonly Kind[];

export const LOCKED_SWITCH = "Locked";

/** The Locked switch's help (D-261109-103). */
export function lockedHelp(kind: Kind): string {
  return `Go up and Go down are off while ${kind === "stairs" ? "they're" : "it's"} locked. A party member who climbs opens the floor to players.`;
}

/** The Hidden switch on stairs and ladders (phase 4, 8.1). */
export const HIDDEN_SWITCH = "Hidden from players";

/** Its help. */
export function hiddenHelp(kind: Kind): string {
  return `Players see nothing of ${kind === "stairs" ? "these stairs" : "this ladder"} until you turn this off.`;
}

/** The pane's line where players have not reached the far floor: what they read on the board instead. */
export function notReachedLine(floor: string, dir: Dir, kind: Kind): string {
  return `Players haven't reached ${floor}, so they see "${linkName(dir, kind, null)}" here.`;
}

/** "Go to Upper floor": shows that floor with the other end selected. */
export function goToFloor(floor: string): string {
  return `Go to ${floor}`;
}

/** "Remove stairs", "Remove ladder" or "Remove opening", then on a second tap "Remove both ends". */
export function removeWords(kind: Kind): string {
  return `Remove ${noun(kind)}`;
}
export const REMOVE_BOTH = "Remove both ends";

// The builder's undo steps (7.2): the server's labels after "Undo ", "placing stairs to Upper floor".
export { LINK_LABELS } from "#shared/rules/floorLinks.ts";

// The walking ruler over stairs (phase 3, 4.1 and 4.2).

/** The ruler's stairs button: "Up the stairs", "Down the ladder". */
export function rulerStairsWords(dir: Dir, kind: Kind): string {
  return `${dir === "up" ? "Up" : "Down"} the ${noun(kind)}`;
}

/** Its name, which names the floor: "Measure on up the stairs to Upper floor". */
export function rulerStairsName(dir: Dir, kind: Kind, floor: string): string {
  return `Measure on ${dir} the ${noun(kind)} to ${floor}`;
}

/** A carried ruler's line under its total, given the feet already written: "25 ft before this floor" (D-261110-083). */
export function beforeFloorLine(feet: string): string {
  return `${feet} before this floor`;
}

/** Keep or a double tap on a ruler carried over stairs. */
export const CARRIED_NO_KEEP = "A ruler over stairs can't be kept.";

/** Measure's Straight while a ruler is carried over stairs. */
export const CARRIED_WALKS = "A ruler over stairs walks.";

/** A ruler carried over stairs ends where a co-DM removes those stairs or this device loses them. */
export const CARRIED_STAIRS_GONE = "The stairs this ruler took are gone.";

/** The DM's Shared while a ruler carried private is on another floor. */
export const SHARE_BEFORE_STAIRS = "Share it before it takes the stairs.";

/** A stop that would make a carried ruler's frame too big to send (the server's 4 KB cap on a preview). */
export const CARRIED_TOO_LONG = "A ruler over stairs can't take more stops. Clear it to measure again.";
