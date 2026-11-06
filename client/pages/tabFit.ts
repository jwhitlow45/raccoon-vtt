/**
 * Which of the side panel's tabs stand in its one row
 * (docs/design/design-v1-panel-tabs.md 3.2). The row holds a prefix of the
 * registry's order, as many as fit, and More at its end holds the rest.
 * A device may leave panels out of the row (This device's Tab row), which
 * More then always holds. Nothing counts use and nothing moves a tab: the
 * result depends only on the widths measured on this device, the room the
 * row has and the DM's own ticks.
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

/** The gap before a group's first tab, between tabs in the row (docs/design/design-v1-layout-hierarchy.md M3). */
export const GROUP_GAP = 8;

export type TabWidths = {
  /**
   * Each panel: its tab's width at rest, its title as More draws it (with
   * the caret), and its group. The panels this device lets stand in the row
   * come first, then the rest, each part in the registry's order.
   */
  tabs: readonly { rest: number; more: number; group: string }[];
  /** More at rest: "More" and its caret. */
  moreRest: number;
  /** The tab list's width. */
  room: number;
  /**
   * How many of `tabs`, from the first, may stand in the row: This device's
   * Tab row (designs/qol audit Q10), every panel when left out. The rest are
   * always in More, so More stays while any is left out.
   */
  kept?: number;
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
 * measures again as it shows. All tabs when they fit with their gaps and
 * none is left out, and no More. Otherwise the largest prefix of the kept
 * panels that leaves room for More's reserve after one gap, or More alone.
 * More's room is what the row leaves it, never less than its reserve. A
 * wider room never fits fewer tabs, since every prefix that fits a room
 * fits a wider one.
 */
export function fitTabs(w: TabWidths): TabFit | null {
  if (!(w.room > 0)) return null;
  const n = w.tabs.length;
  const kept = Math.max(0, Math.min(w.kept ?? n, n));
  if (kept === n && rowWidth(w.tabs, n) <= w.room) return { count: n, moreRoom: 0 };
  // Every panel kept and too wide for the row: all of them and More cannot fit either, so the count starts one lower.
  for (let count = kept === n ? n - 1 : kept; count > 0; count--) {
    const used = rowWidth(w.tabs, count) + TAB_GAP;
    const reserve = moreReserve(w, count);
    if (used + reserve <= w.room) return { count, moreRoom: w.room - used };
  }
  return { count: 0, moreRoom: Math.max(w.room, moreReserve(w, 0)) };
}

/**
 * The panels in the order the fit reads them (TabWidths `tabs`): those this
 * device lets stand in the row first, then those it leaves out, each part
 * in the registry's order, and how many are kept. A panel id the list no
 * longer has is ignored, so a panel added later starts in the row.
 */
export function keptOrder<T extends { id: string }>(panels: readonly T[], left: ReadonlySet<string>): { ordered: T[]; kept: number } {
  const kept = panels.filter((p) => !left.has(p.id));
  return { ordered: [...kept, ...panels.filter((p) => left.has(p.id))], kept: kept.length };
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

/** How the row draws its tabs (docs/design/design-v1-icons-2.md 3.1): each panel's icon before its name, or its icon alone. */
export type TabLook = "named" | "icon";

/** A tab that draws its icon alone: the 44 px touch target, at least as narrow as any named tab. */
export const ICON_TAB = 44;

/**
 * Icon and name where the row then holds as many tabs as the names alone
 * would, else the icons alone, so an icon never costs the row a tab. The
 * icons alone never hold fewer than the names, since no tab is narrower
 * than its 44 px target. Null while either fit is (a hidden side panel).
 */
export function tabLook(words: TabWidths, named: TabWidths): TabLook | null {
  const plain = fitTabs(words);
  const withIcons = fitTabs(named);
  if (plain === null || withIcons === null) return null;
  return withIcons.count >= plain.count ? "named" : "icon";
}

/** The widths the fit reads for a look: the named tabs as measured, or each tab at ICON_TAB. More keeps its icon and name in both. */
export function widthsFor(look: TabLook, named: TabWidths): TabWidths {
  return look === "named" ? named : { ...named, tabs: named.tabs.map((t) => ({ ...t, rest: ICON_TAB })) };
}

/**
 * Whether the row shows the open panel's name: a named tab in the row, or
 * More's uncut name for a panel it holds.
 */
export function rowNamesOpen(look: TabLook, held: boolean, moreCut: boolean): boolean {
  return held ? !moreCut : look === "named";
}

/**
 * Whether the side panel names the open panel above it
 * (docs/design/design-v1-panel-tabs.md 3.8, as docs/design/design-v1-icons-2.md 3.1
 * amends it): where the row does not, on a touch pointer only, so a tap
 * never needs a long press to learn which panel is open. A computer shows
 * the name on hover and focus (first pass 3.2) and keeps the panel's height.
 */
export function headerNamesOpen(look: TabLook, held: boolean, moreCut: boolean, coarse: boolean): boolean {
  return coarse && !rowNamesOpen(look, held, moreCut);
}
