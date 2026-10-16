import { barMode, compactHang, freeArea, placeBar, spanRoomAtWorst } from "./barDock.ts";

/*
 * The single-token bar's buttons and its short layout
 * (docs/design-v1-token-panel.md 3.3), as plain functions for node --test.
 */

export type BarButtonId =
  | "undoMove"
  | "countLeg"
  | "door"
  | "conditions"
  | "requestRoll"
  | "hidden"
  | "light"
  | "selectSeveral"
  | "locked"
  | "duplicate"
  | "delete"
  | "dismiss"
  | "moveBar"
  | "resetBar";

/** Who the viewer is and what applies to this token now. */
export type BarButtonInput = {
  dm: boolean;
  /** An owner of the token, directly or through its character, who is not the DM. */
  owner: boolean;
  /** This device just moved the token, so Undo move answers a mis-drop. */
  undoMove: boolean;
  /** The acting creature moved this turn, so its last move may stop counting. */
  movedThisTurn: boolean;
  /** A door in reach of a player's own token. */
  door: boolean;
  /** The viewer may change the token's light, on a vision scene or while it is lit. */
  light: boolean;
  /** A creature a player plays, so the DM may request a roll of it. */
  played: boolean;
  /** The token is a companion (docs/design-v1-combat-flow.md 3.6), whose owners dismiss it. */
  companion: boolean;
  /** The bar docks, so it may be moved, and the spot it sits at is not its default. */
  docked: boolean;
  moved: boolean;
};

/**
 * The bar's two wrapping rows, ranked by use (3.1). The play row holds
 * what play needs, the transient answers to the move just made first. The
 * less-often row keeps the destructive and setup buttons apart from them,
 * so a quick tap meant for Conditions or Hidden never lands on Delete.
 * Each button shows only where it always has. Details is in neither: it
 * sits in the read-more row with the summary it expands.
 */
export function barButtons(input: BarButtonInput): { play: BarButtonId[]; less: BarButtonId[] } {
  const { dm, owner } = input;
  const play: BarButtonId[] = [];
  if (input.undoMove) play.push("undoMove");
  if ((dm || owner) && input.movedThisTurn) play.push("countLeg");
  if (!dm && owner && input.door) play.push("door");
  if (dm || owner) play.push("conditions");
  if (dm && input.played) play.push("requestRoll");
  if (dm) play.push("hidden");
  if ((dm || owner) && input.light) play.push("light");
  play.push("selectSeveral");
  const less: BarButtonId[] = [];
  if (dm) less.push("locked", "duplicate", "delete");
  // The DM keeps Delete and gets no second button.
  else if (owner && input.companion) less.push("dismiss");
  if (input.docked) {
    less.push("moveBar");
    if (input.moved) less.push("resetBar");
  }
  return { play, less };
}

/** A token that belongs to a character as its companion (docs/design-v1-combat-flow.md 3.6), whose owners who are not the DM dismiss it. */
export function isCompanion(token: object): boolean {
  return "companion" in token && token.companion !== undefined && token.companion !== null;
}

/** Below this capacity a bar is short (3.3). */
export const SHORT_BAR_PX = 300;

/**
 * Below this capacity a spanning bar is short: the room its full layout
 * takes to show Apply with no scroll. That is the frame's 61 px above its
 * content, the vitals on two lines as a narrow phone wraps them (21 px
 * each, 4 apart) with the 8 px gap after them, and the HP entry's mode row
 * and field row, 44 px each and 4 apart: 207 px, rounded up.
 */
export const SPAN_SHORT_BAR_PX = 210;

/** What decides where a bar hangs: placeBar's input without the bar's own content. */
export type BarRoom = Omit<Parameters<typeof placeBar>[0], "height">;

/**
 * The most a bar may draw where it stands: the `maxHeight` that placeBar
 * and shareLane give a bar of unbounded content at the same spot, or the
 * overlay's height when compact. It never reads the bar's own content,
 * which shareLane uses to place a moved bar hung by its bottom, so opening
 * "More stats", or the short layout itself, never changes it. It counts
 * what the lane gives the bar, so tall alert cards over a docked bar count.
 *
 * A bar that spans an upright phone hangs above or below its token, so its
 * room changes with where the tapped token stands. Its capacity is the
 * least room any token's bar gets on that screen instead (barDock.ts
 * spanRoomAtWorst), the screen's alone, so a phone keeps one layout, and
 * Apply one place in view, whichever token is tapped.
 */
export function barCapacity(room: BarRoom): number | null {
  const free = freeArea(room.viewport, room.chrome, room.foot);
  if (barMode(room.layout, free.height) === "span") return spanRoomAtWorst(free);
  const placed = placeBar({ ...room, height: Number.POSITIVE_INFINITY });
  if (!placed) return null;
  if (placed.mode === "compact") return compactHang(room.layout, room.viewport, room.chrome).room;
  return placed.hang.room;
}

/**
 * A short bar (3.3): a phone held sideways at any interface size, a large
 * phone held sideways in the wide layout, every screen too short to dock or
 * span, a docked bar under tall alert cards while they stand there, and a
 * spanning bar wherever a token in the middle of the screen would leave
 * its full layout's Apply out of view, as on an upright phone at 130%. It
 * keeps AC, HP and the HP entry at the top, and "More stats" holds the rest.
 */
export function barShort(room: BarRoom): boolean {
  const capacity = barCapacity(room);
  if (capacity === null) return false;
  const spans = barMode(room.layout, freeArea(room.viewport, room.chrome, room.foot).height) === "span";
  return capacity < (spans ? SPAN_SHORT_BAR_PX : SHORT_BAR_PX);
}
