import { SHEET_BODY_MIN, SHEET_HEADER } from "../components/sheetCap.ts";
import { TAP_SLOP_PX } from "../lib/gestures.ts";
import { theme } from "../lib/theme.ts";

/*
 * Two panels in the side panel (docs/design-v1-split-panel.md 3.2, 3.4 and
 * 8): the panes' sizes, the bar's steps, and what this device remembers.
 * Every size is in the side panel's own px, which the interface size zooms,
 * so the rules hold at every interface size. Pure but for storage, which is
 * passed in for tests.
 */

/**
 * A pane's least height: a subpage's header (SheetHeader's 56 px and its
 * 1 px border) above the very short sheet's least body. It holds whether or
 * not a header shows, so a subpage opening never moves the bar.
 */
export const PANE_MIN = SHEET_HEADER + theme.line.border + SHEET_BODY_MIN;

/** The bar between the panes: a 44 px row with a 1 px border above and below. */
export const BAR_PX = theme.touch + 2 * theme.line.border;

/** The room two panes and the bar take: 336 own px. */
export const SPLIT_ROOM = 2 * PANE_MIN + BAR_PX;

/**
 * The pane Initiative keeps its round header stuck in (features/encounter/logic.ts
 * roundHeaderForm): its 68 px full header and two standard rows, as
 * measured with today's header and rows (the design's appendix A). Only
 * the default share gives it this.
 */
export const INITIATIVE_STUCK = 193;

/** The grip's arrow keys move the bar this far, or `KEY_STEP_BIG` with Shift, as the token window's grip moves it. */
export const KEY_STEP = 8;
export const KEY_STEP_BIG = 64;

/** A press on the bar moves it only once the pointer passes the slop a tap on the map has. */
export const DRAG_SLOP = TAP_SLOP_PX;

/** Whether the room under the tab row holds two panes and the bar. */
export function roomForTwo(room: number): boolean {
  return room >= SPLIT_ROOM;
}

/** The two panes' heights and the bar's limits, as the top pane's height. */
export type PaneSizes = { top: number; below: number; min: number; max: number };

/**
 * The panes in a room (3.2). The bar's place is the top pane's share of the
 * room less the bar, in thousandths. A stored share, from a drag or a key
 * step, always wins, clamped where it is drawn so each pane keeps its
 * least height, and stays stored as it was. With none stored the split is
 * even, except that a pane holding Initiative takes at least
 * INITIATIVE_STUCK, as far as the other pane keeps its least height.
 */
export function splitPanes(input: { room: number; share: number | null; initiative: "top" | "below" | null }): PaneSizes {
  const space = Math.max(0, input.room - BAR_PX);
  const min = PANE_MIN;
  const max = Math.max(min, space - PANE_MIN);
  const clamp = (top: number) => Math.min(max, Math.max(min, top));
  let top: number;
  if (input.share !== null) top = clamp(Math.round((input.share * space) / 1000));
  else {
    top = Math.floor(space / 2);
    if (input.initiative === "top") top = Math.max(top, Math.min(INITIATIVE_STUCK, max));
    else if (input.initiative === "below") top = Math.min(top, Math.max(min, space - INITIATIVE_STUCK));
    top = clamp(top);
  }
  return { top, below: space - top, min, max };
}

/** The share that draws the top pane at `top` px, kept from 1 to 999 thousandths. */
export function shareOf(top: number, room: number): number {
  const space = room - BAR_PX;
  if (space <= 0) return 500;
  return Math.min(999, Math.max(1, Math.round((top * 1000) / space)));
}

/** The grip's keys (3.4): Up and Down move the bar 8 px, or 64 with Shift. Anything else is not the grip's. */
export function gripStep(key: string, shift: boolean): number | null {
  const size = shift ? KEY_STEP_BIG : KEY_STEP;
  if (key === "ArrowUp") return -size;
  if (key === "ArrowDown") return size;
  return null;
}

/** The top pane's height as a drag that began at `start` has moved it `dy` own px, or null while it stays within the slop. */
export function dragTop(sizes: Pick<PaneSizes, "min" | "max">, start: number, dy: number, moved: boolean): number | null {
  if (!moved && Math.abs(dy) <= DRAG_SLOP) return null;
  return Math.min(sizes.max, Math.max(sizes.min, start + dy));
}

/** The separator's value and its limits: the top pane's percent of the room less the bar. */
export function separatorValue(sizes: PaneSizes): { now: number; min: number; max: number } {
  const space = sizes.top + sizes.below;
  const percent = (px: number) => (space > 0 ? Math.round((px * 100) / space) : 50);
  return { now: percent(sizes.top), min: percent(sizes.min), max: percent(sizes.max) };
}

/** The bits of the DOM swapFocus reads, so it is tested without a page. */
export type FocusNode = { isConnected?: boolean };
export type FocusRoot = { contains(other: FocusNode | null): boolean };

/**
 * What a swap puts focus back on (4.3), if anything: the element focused
 * as the swap was asked for, only when it was inside the room's moved
 * panes or bar and no longer holds focus, since React moves those
 * elements with `insertBefore`, which drops their focus. Focus that was on
 * the page or outside the room, or that the move left alone, stays where
 * it is. So a press in Safari, which focuses no button, leaves focus on
 * the page, and an old record such as the Log's composer never raises an
 * iPad's keyboard.
 */
export function swapFocus<T extends FocusNode>(before: T | null, now: FocusNode | null, room: FocusRoot, page: FocusNode | null): T | null {
  if (before === null || before === page || before.isConnected === false) return null;
  if (!room.contains(before)) return null;
  return now === before ? null : before;
}

// ------------------------------------------------------------ what this device remembers

export const SPLIT_KEY = "rvtt.sidePanelSplit";

/** One role's entry: the bar's share, and the split's two panels, or null with no split. */
export type SplitEntry = { share: number | null; pair: { top: string; below: string } | null };

export const NO_SPLIT: SplitEntry = Object.freeze({ share: null, pair: null });

type Role = "dm" | "player";

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAll(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    return objectOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A role's entry in the stored key (8). `share` is an integer from 1 to
 * 999, else none. `top` and `below`, both present, two different panels
 * the role has from 900 px up (`has`), are the split. Anything else in an
 * entry reads as no split with that share, and a bad or missing key reads
 * as no split and no share.
 */
export function parseSplit(raw: string | null, role: Role, has: (id: string) => boolean): SplitEntry {
  const entry = objectOf(parseAll(raw)?.[role]);
  if (!entry) return NO_SPLIT;
  const share = typeof entry.share === "number" && Number.isInteger(entry.share) && entry.share >= 1 && entry.share <= 999 ? entry.share : null;
  const { top, below } = entry;
  const pair = typeof top === "string" && typeof below === "string" && top !== below && has(top) && has(below) ? { top, below } : null;
  return { share, pair };
}

/** The role's stored entry. Storage that throws (a private window, blocked site data) reads as none. */
export function readSplit(role: Role, has: (id: string) => boolean, storage?: Pick<Storage, "getItem">): SplitEntry {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return parseSplit(from?.getItem(SPLIT_KEY) ?? null, role, has);
  } catch {
    return NO_SPLIT;
  }
}

/** Whether two entries say the same, so nothing needs writing. */
export function sameSplit(a: SplitEntry, b: SplitEntry): boolean {
  return a.share === b.share && (a.pair === null || b.pair === null ? a.pair === b.pair : a.pair.top === b.pair.top && a.pair.below === b.pair.below);
}

/**
 * Stores the role's entry, keeping the other role's as it was. A DM's
 * "view as a player" reads the player's entry and never writes, as it
 * treats `rvtt.sidePanel` and the token window's spot.
 */
export function writeSplit(role: Role, entry: SplitEntry, options: { preview: boolean; storage?: Pick<Storage, "getItem" | "setItem"> }): void {
  if (options.preview) return;
  try {
    const to = options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!to) return;
    const all = parseAll(to.getItem(SPLIT_KEY)) ?? {};
    const mine: Record<string, unknown> = {};
    if (entry.share !== null) mine.share = entry.share;
    if (entry.pair) {
      mine.top = entry.pair.top;
      mine.below = entry.pair.below;
    }
    to.setItem(SPLIT_KEY, JSON.stringify({ ...all, [role]: mine }));
  } catch {
    // The split then lasts as long as the page, which is all a blocked storage allows.
  }
}
