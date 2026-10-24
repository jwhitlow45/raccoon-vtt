import { compactHang, freeArea, heldOrOpenMode, placeBar, restOrder, spanRoomAtWorst, type BarMode, type Box } from "./barDock.ts";
import type { HpMode } from "../features/tokens/hpInput.ts";

/*
 * The single-token bar's buttons and its short layout
 * (docs/design-v1-token-panel.md 3.3), as plain functions for node --test.
 */

export type BarButtonId =
  | "undoMove"
  | "countLeg"
  | "door"
  | "conditions"
  | "hidden"
  | "light"
  | "attach"
  | "detach"
  | "multiSelect"
  | "roll"
  | "uses"
  | "locked"
  | "duplicate"
  | "delete"
  | "dismiss";

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
  /** The token is a companion (docs/design-v1-combat-flow.md 3.6), whose owners dismiss it. */
  companion: boolean;
  /**
   * On a carried token, Get off, Put down or Let go for whoever may undo the
   * link, then Attach for whoever may attach the token to anything
   * (docs/design-v1-attach.md 4.1 and 4.3), in that order. Empty for neither.
   */
  attach: readonly ("detach" | "attach")[];
  /**
   * The creature's combat uses (docs/design-v1-combat-controls.md 6): "yes"
   * for an actor with legendary counts, spent uses or class resources, or a
   * block that lists a use, "loading" while its block loads, whose place is
   * held, and "no" for none. Left out, none.
   */
  uses?: "yes" | "loading" | "no";
};

/**
 * The bar's wrapping rows, ranked by use (3.1), each its own row in the
 * bar. The passing line holds the answers to the move just made or a door
 * just reached, which come and go with it, so it leads only while one of
 * them shows. The steady line starts with Conditions, Hidden and
 * Multi-select, which the default width keeps on one line
 * (docs/design-v1-token-window.md 3.2), so nothing that comes and goes
 * moves them: Roll, Uses for a creature with combat uses, Light and
 * Attach (after Get off on a carried token) follow, on the same line where
 * room is left.
 * Roll opens the Dice panel's options, whose Ask switch asks the player of
 * a creature a player plays, so the single bar has no Request a roll
 * (docs/design-v1-roll-options.md 4.5). The less-often row keeps the
 * destructive and setup buttons apart, so a quick tap meant for Conditions
 * or Hidden never lands on Delete. Each button shows only where it always
 * has. Details is in none: it sits in the read-more row with the summary
 * it expands.
 */
export function barButtons(input: BarButtonInput): { passing: BarButtonId[]; play: BarButtonId[]; less: BarButtonId[] } {
  const { dm, owner } = input;
  const passing: BarButtonId[] = [];
  if (input.undoMove) passing.push("undoMove");
  if ((dm || owner) && input.movedThisTurn) passing.push("countLeg");
  if (!dm && owner && input.door) passing.push("door");
  const play: BarButtonId[] = [];
  if (dm || owner) play.push("conditions");
  if (dm) play.push("hidden");
  play.push("multiSelect");
  // After Multi-select: any earlier, Roll would push Multi-select to a second line at the default width.
  if (dm || owner) play.push("roll");
  // After Roll, held while the block loads, so Light and Attach do not jump when it shows (docs/design-v1-combat-controls.md 6).
  if ((dm || owner) && input.uses !== undefined && input.uses !== "no") play.push("uses");
  if ((dm || owner) && input.light) play.push("light");
  play.push(...input.attach);
  const less: BarButtonId[] = [];
  if (dm) less.push("locked", "duplicate", "delete");
  // The DM keeps Delete and gets no second button.
  else if (owner && input.companion) less.push("dismiss");
  return { passing, play, less };
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
 * On an upright phone the bar rests as a strip and expands up from it
 * (docs/design-v1-bar-compact.md 5.1), so its capacity is the expanded
 * bar's room on that screen (barDock.ts spanRoomAtWorst), the screen's
 * alone: a phone keeps one layout, and Apply one place in view, whichever
 * token is tapped. That room leaves the full layout's Apply out of view
 * only on the smallest phones at a larger interface size, such as
 * 320 x 568 at 130%. The mode is the one the frame draws in (roomMode),
 * so a held strip keeps its layout as its free area shrinks, and the
 * first render with a roll card standing at the foot gets the strip's.
 */
export function barCapacity(room: BarRoom): number | null {
  const free = freeArea(room.viewport, room.chrome, room.foot);
  if (roomMode(room, free) === "span") return spanRoomAtWorst(free);
  const placed = placeBar({ ...room, height: Number.POSITIVE_INFINITY });
  if (!placed) return null;
  if (placed.mode === "compact") return compactHang(room.layout, room.viewport, room.chrome, room.width).room;
  return placed.hang.room;
}

/**
 * A short bar (3.3): a phone held sideways at any interface size, a large
 * phone held sideways in the wide layout, every screen too short to dock or
 * span, a docked bar under tall alert cards while they stand there, and an
 * upright phone's bar where the expanded bar's room would leave its full
 * layout's Apply out of view, which now holds only on the smallest phones
 * at a larger interface size (docs/design-v1-bar-compact.md 9.1). It keeps
 * AC, HP and the HP entry at the top, and "More stats" holds the rest.
 */
export function barShort(room: BarRoom): boolean {
  const capacity = barCapacity(room);
  if (capacity === null) return false;
  const spans = roomMode(room, freeArea(room.viewport, room.chrome, room.foot)) === "span";
  return capacity < (spans ? SPAN_SHORT_BAR_PX : SHORT_BAR_PX);
}

/**
 * The mode the bar draws in, by the rule placeBar uses (barDock.ts
 * heldOrOpenMode): the strip held since it showed, or else the opening
 * rule, which counts a roll card standing at the foot as map
 * (docs/design-v1-bar-compact.md 2).
 */
function roomMode(room: BarRoom, free: Box): BarMode {
  return heldOrOpenMode({ layout: room.layout, free, foot: room.foot, cardAt: room.cardAt ?? null, heldMode: room.heldMode ?? null });
}

// ------------------------------------------------------------ an upright phone's resting strip

/** The passing actions, newest first, which take Roll's place in the strip while one applies (docs/design-v1-bar-compact.md 3.3). */
const PASSING: readonly string[] = ["undoMove", "countLeg", "door"];

/*
 * The order the quick row fills by, apart from the order it shows in
 * (barDock.ts restOrder), so a passing action that comes and goes can
 * never put Conditions out (3.3, D-261024-12). "place" is Roll's place:
 * the first passing action where it fits whole there, and else Roll.
 */
const REST_FIT: readonly string[] = ["mode", "crit", "conditions", "place", "useRoll", "multiSelect", "uses", "hidden", "details"];

/**
 * Which of the quick row's candidates show, in the order they show
 * (3.3). `widths` holds each candidate's drawn width, so the font, the
 * interface size and the browser's least font size count. "mode", the
 * HP entry's lead, is given without its field, which counts `fieldMin`
 * and takes what the others leave. Each other candidate shows where it
 * fits whole in the `room` left after those before it in the fitting
 * order, `gap` apart. One that does not fit is skipped, and a narrower
 * one after it may still fit. The lead always shows: it is the strip's
 * reason to be, and its field gives up room before it goes. A candidate
 * whose width is 0 draws nothing and is left out.
 */
export function restFit(widths: Readonly<Record<string, number>>, room: number, gap: number, fieldMin: number): string[] {
  // A candidate drawn 0 px wide draws nothing, such as a door button with no door in reach, and must not take Roll's place.
  const ids = Object.keys(widths).filter((id) => id === "mode" || (widths[id] ?? 0) > 0);
  const shown: string[] = [];
  let used = 0;
  const fits = (width: number) => used + (shown.length > 0 ? gap : 0) + width <= room + FIT_SLACK;
  const take = (id: string, width: number) => {
    used += (shown.length > 0 ? gap : 0) + width;
    shown.push(id);
  };
  const width = (id: string) => widths[id] ?? 0;
  const unknown = ids.filter((id) => !REST_FIT.includes(id) && !PASSING.includes(id) && id !== "roll");
  for (const slot of [...REST_FIT, ...unknown]) {
    if (slot === "mode") {
      if (ids.includes("mode")) take("mode", width("mode") + fieldMin);
      continue;
    }
    if (slot === "place") {
      const passing = PASSING.find((id) => ids.includes(id));
      if (passing !== undefined && fits(width(passing))) take(passing, width(passing));
      else if (ids.includes("roll") && fits(width("roll"))) take("roll", width("roll"));
      continue;
    }
    if (ids.includes(slot) && fits(width(slot))) take(slot, width(slot));
  }
  return restOrder(shown);
}

/** Drawn widths are fractions of a pixel, so a sum may land a hair over the room it fills exactly. */
const FIT_SLACK = 0.01;

/** The play row's buttons the strip offers (3.3). Light, Attach, Get off, Locked, Duplicate and Delete are rarer, one tap away behind Expand (3.4). */
const REST_PLAY: readonly BarButtonId[] = ["conditions", "roll", "multiSelect", "uses", "hidden"];

/**
 * The quick row's candidates on one token's strip, by who the viewer is
 * and what applies (3.3), in the order they show. "mode" is the HP
 * entry's lead, for a viewer who may change the token's HP (`lead`), and
 * the entry offers its own Crit and "Use 9" beside it. The passing
 * actions vie for Roll's place (restFit). Details shows only with no
 * lead, since the lead's viewer reaches it behind Expand.
 */
export function restButtons(input: BarButtonInput & { lead: boolean }): string[] {
  const rows = barButtons(input);
  const ids: string[] = [...rows.passing, ...rows.play.filter((id) => REST_PLAY.includes(id))];
  if (input.lead) ids.push("mode");
  else ids.push("details");
  return restOrder(ids);
}

/**
 * The group's strip (9.4): its HP entry as the lead, then Conditions,
 * Roll (the DM), Multi-select and Hidden (the DM). Undo move after a
 * group's drag takes Roll's place as it does on one token's strip
 * (D-261024-12). Request a roll, Locked, Start a fight, More and Delete
 * stay behind Expand.
 */
export function groupRestButtons(input: { dm: boolean; lead: boolean; conditions: boolean; undoMove: boolean }): string[] {
  const ids: string[] = [];
  if (input.lead) ids.push("mode");
  if (input.conditions) ids.push("conditions");
  if (input.undoMove) ids.push("undoMove");
  if (input.dm) ids.push("roll");
  ids.push("multiSelect");
  if (input.dm) ids.push("hidden");
  return restOrder(ids);
}

/**
 * The strip's mode toggle (3.3, D-261024-10): Damage and Heal switch, and
 * Set or Temp, chosen in the expanded bar or by typed math, go back to
 * Damage.
 */
export function nextRestMode(mode: HpMode): HpMode {
  return mode === "damage" ? "heal" : "damage";
}
