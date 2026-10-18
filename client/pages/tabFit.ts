/**
 * Which of the side panel's tabs stand in its one row
 * (docs/design-v1-panel-tabs.md 3.2). The row holds a prefix of the
 * registry's order, as many as fit, and More at its end holds the rest.
 * Nothing counts use and nothing moves a tab: the result depends only on
 * the widths measured on this device and the room the row has.
 *
 * Widths are measured, not set per role: the tab font is Inter, but the
 * system font draws until Inter loads, and a browser's minimum font size
 * can widen every tab. All widths are in the side panel's own px, which
 * the interface size zooms as a whole, so it cancels out.
 */

/**
 * The most room the fit keeps for More: "More" with a name of about seven
 * letters. Below it More is fitted at its widest name, so a font that
 * leaves room never cuts one. Past it a long name is cut with an
 * ellipsis, and the side panel names the panel in full above it (3.8),
 * so that Log keeps its place in the row with a wide font such as DejaVu
 * Sans. Set so that Token, Initiative, Log and More fit a 295 px row in
 * Inter, and in the fonts that draw until it loads: macOS's system font,
 * Segoe UI and DejaVu Sans.
 */
export const MORE_CAP = 92;

/** The gap between two tabs, and before More. */
export const TAB_GAP = 2;

/** The gap before a group's first tab, between tabs in the row (docs/design-v1-layout-hierarchy.md M3). */
export const GROUP_GAP = 8;

export type TabWidths = {
  /** Each panel in the registry's order: its tab's width at rest, its title as More draws it (with the caret), and its group. */
  tabs: readonly { rest: number; more: number; group: string }[];
  /** More at rest: "More" and its caret. */
  moreRest: number;
  /** The tab list's width. */
  room: number;
};

/** `count` tabs stand in the row. With fewer than all, More follows with `moreRoom`. */
export type TabFit = { count: number; moreRoom: number };

/** The first `count` tabs with the gaps between them. */
export function rowWidth(tabs: TabWidths["tabs"], count: number): number {
  let width = 0;
  for (let i = 0; i < count; i++) {
    const tab = tabs[i]!;
    if (i > 0) width += tabs[i - 1]!.group === tab.group ? TAB_GAP : GROUP_GAP;
    width += tab.rest;
  }
  return width;
}

/** The room More keeps beside `count` tabs: its widest label among "More" and the panels it then holds, no wider than the cap. */
export function moreReserve(w: TabWidths, count: number): number {
  let widest = w.moreRest;
  for (let i = count; i < w.tabs.length; i++) widest = Math.max(widest, w.tabs[i]!.more);
  return Math.min(MORE_CAP, widest);
}

/**
 * The fit, or null where the row has no room: a hidden side panel, which
 * measures again as it shows. All tabs when they fit with their gaps, and
 * no More. Otherwise the largest prefix that leaves room for More's
 * reserve after one gap, or More alone. More's room is what the row leaves
 * it, never less than its reserve. A wider room never fits fewer tabs,
 * since every prefix that fits a room fits a wider one.
 */
export function fitTabs(w: TabWidths): TabFit | null {
  if (!(w.room > 0)) return null;
  const n = w.tabs.length;
  if (rowWidth(w.tabs, n) <= w.room) return { count: n, moreRoom: 0 };
  for (let count = n - 1; count > 0; count--) {
    const used = rowWidth(w.tabs, count) + TAB_GAP;
    const reserve = moreReserve(w, count);
    if (used + reserve <= w.room) return { count, moreRoom: w.room - used };
  }
  return { count: 0, moreRoom: Math.max(w.room, moreReserve(w, 0)) };
}

/**
 * Whether More cuts the name of the panel at `index`: exactly when the
 * panel is in More and its title, as More draws it, is wider than More's
 * room. Worked out from the fit, never read from the drawn span, so the
 * header that names the panel in full (3.8) never flickers.
 */
export function nameCut(fit: TabFit, w: TabWidths, index: number): boolean {
  const tab = w.tabs[index];
  return tab !== undefined && index >= fit.count && tab.more > fit.moreRoom;
}
