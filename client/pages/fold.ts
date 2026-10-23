import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { barDockSlot, freeArea, paneLaneBox, WINDOW_FOLD_BELOW, type Chrome, type Lane, type PaneLane, type PaneLaneBox } from "../canvas/barDock.ts";
import { sheetRoom, SHEET_MIN_HEIGHT, type SheetSpace } from "../components/sheetCap.ts";
import { PANE_MIN_HEIGHT, sheetPaneRoom, type PanePlacement } from "../features/builder/labelEdit.ts";
import { useLayoutSize } from "../features/device/layout.ts";
import type { Insets, Size } from "../lib/camera.ts";
import { revealAndFocus } from "../lib/reveal.ts";
import { theme } from "../lib/theme.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";
import { sheetOpen } from "../state/types.ts";
import { useRoomView } from "../state/view.ts";

/*
 * What floats over a phone's map folds under a sheet
 * (docs/design-v1-visual.md 3.2.1). On a phone in portrait a panel sheet
 * covers the bottom of the map, and the token action bar and the fight
 * alerts column would sit under it or over its header. So while a sheet
 * is open they fold, with their state kept, and one row docks on the
 * sheet's top edge in their place: the token's name with a Show button
 * and its Close, then one alerts summary. Room draws the dock, the token
 * bar and the column publish here what it needs, and each reads the same
 * rule for when to fold. A map pane's bottom sheet folds the column too,
 * and the alerts summary alone docks on its top edge (useFoldUnderPane).
 */

/**
 * Whether what floats over the map folds: a phone in portrait (under
 * 900 layout px and no wider than tall, the roll desk's rule,
 * features/rolls/logic.ts deskLayout) with a panel sheet or the list of
 * panels open. In landscape the sheet docks on the right and leaves the
 * map beside it, so nothing folds there, unless the screen is so short
 * that the sheet opens over all of it (`full`, the very short mode of
 * docs/design-v1-layout-hierarchy.md 4.2, or an upright sheet swiped up to
 * fill the screen, docs/design-v1-sheet-swipe.md 4.7), as the upright sheet folds, or
 * the room the sheet leaves beside it (`sideRoom`, sideSheetRoom) is too
 * narrow for a docked window's header in its one row, as on a phone 480 px
 * wide (docs/design-v1-token-window.md 7.1).
 */
export function foldsUnderSheet(input: { width: number; height: number; sheetOpen: boolean; full?: boolean; sideRoom?: number }): boolean {
  if (!input.sheetOpen) return false;
  if (input.sideRoom !== undefined && input.sideRoom < WINDOW_FOLD_BELOW) return true;
  return input.width < theme.layout.wideMinWidth && (input.width <= input.height || input.full === true);
}

/**
 * The width a sideways sheet leaves the map's free area, where a docked
 * window stands beside it, or undefined with no such sheet. Under 900 px
 * there is no side panel, so the map is the layout's whole width.
 */
export function sideSheetRoom(layout: Size, chrome: Chrome | null): number | undefined {
  return chrome && chrome.sheet > 0 ? freeArea(layout, chrome).width : undefined;
}

/** sideSheetRoom for this Room now, from the chrome Room measured. */
export function useSideSheetRoom(): number | undefined {
  const layout = useLayoutSize();
  const chrome = useStore(useScoped(barDockSlot), (s) => s.chrome);
  return sideSheetRoom(layout, chrome);
}

/**
 * foldsUnderSheet for this Room now, in the chrome's own pixels
 * (features/device/layout.ts), or a map pane's bottom sheet showing
 * (useFoldUnderPane). The token bar keeps to the panel sheets' rule alone.
 * Under a pane the alerts' summary row docks on the pane's top edge
 * (pages/RoomDock.tsx usePaneDock), and the alerts come back as it closes.
 */
export function useUnderSheet(): boolean {
  const { width, height } = useLayoutSize();
  const open = useRoomView((s) => sheetOpen(s.local));
  const dock = useScoped(dockSlot);
  const full = useStore(dock, (s) => s.sheetFull);
  const pane = useStore(dock, (s) => s.paneSheets > 0);
  const sideRoom = useSideSheetRoom();
  return pane || foldsUnderSheet({ width, height, sheetOpen: open, full, sideRoom });
}

/**
 * Whether the alerts' summary row has room on a map pane's bottom sheet
 * (pages/RoomDock.tsx usePaneDock): the row and the pane at its least
 * height (features/builder/labelEdit.ts PANE_MIN_HEIGHT) both between the
 * bars (`insets`), in the panes' layout px. Where they do not, as on a
 * short screen held sideways or at a large interface size, the row would
 * reach under the top bars, so the pane keeps none, and the alerts come
 * back as it closes.
 */
export function paneDockFits(input: { viewport: Size; insets: Insets }, dockHeight = DOCK_PX): boolean {
  return sheetPaneRoom(input) - dockHeight >= PANE_MIN_HEIGHT;
}

/**
 * Folds the alerts column while a map pane (a label's, pin's, light's or
 * trap's, features/builder/labelEdit.ts panePlacement) shows as a bottom
 * sheet, `on`: the sheet spans the map's width and may rise to the top
 * bars, where the column's cards would cover its header and Close. In any
 * orientation, since the pane is a bottom sheet only under 600 px wide.
 * The panes call it through usePaneDock (pages/RoomDock.tsx), which docks
 * the alerts' summary row on the pane's top edge.
 */
export function useFoldUnderPane(on: boolean): void {
  const store = useScoped(dockSlot);
  useLayoutEffect(() => {
    if (!on) return;
    store.setState((s) => ({ paneSheets: s.paneSheets + 1 }));
    return () => store.setState((s) => ({ paneSheets: s.paneSheets - 1 }));
  }, [store, on]);
}

/**
 * The alerts lane a map pane drawn as a card keeps out of
 * (canvas/barDock.ts paneLaneBox), for this Room now: from what the
 * column publishes, as the token window reads it, with `viewport` the
 * map as the pane sees it. The pane and its host's loading frame both
 * read it, so the frame stands where the pane will.
 */
export function useAlertsLane(viewport: Size): PaneLaneBox | null {
  const dock = useScoped(barDockSlot);
  const chrome = useStore(dock, (s) => s.chrome);
  const column = useStore(dock, (s) => s.column);
  const folded = useUnderSheet();
  const lane = paneLaneBox({ viewport, chrome, column, folded });
  const left = lane?.left ?? null;
  const top = lane?.top ?? null;
  return useMemo(() => (left === null || top === null ? null : { left, top }), [left, top]);
}

/**
 * Publishes where a map pane drawn as a card stands against the alerts
 * column (features/builder/labelEdit.ts panePlacement `lane`) while it is
 * mounted and shown, or nothing for null. For "summary" the column shows
 * its summary row in place of its cards, and the row's tap closes the
 * pane through `close`, the pane's own close, which may be a new function
 * on every render. The pane's place clears as it closes or unmounts.
 */
export function usePublishPaneLane(lane: PaneLane | null, close: () => void): void {
  const store = useScoped(dockSlot);
  const latest = useRef(close);
  latest.current = close;
  useLayoutEffect(() => {
    if (lane === null) return;
    const mine = { lane, close: () => latest.current() };
    store.setState({ paneLane: mine });
    return () => {
      if (store.getState().paneLane === mine) store.setState({ paneLane: null });
    };
  }, [store, lane]);
}

/**
 * usePublishPaneLane for a pane host's loading or failure frame, placed as
 * the pane will be (`place`), with the host's own close. The loaded pane's
 * place takes over from it as the frame unmounts, since each clears only
 * its own.
 */
export function useFrameLane(place: PanePlacement, close: () => void): void {
  usePublishPaneLane(place.kind === "card" ? (place.lane ?? null) : null, close);
}

/**
 * Whose summary row the alerts column shows in place of its cards for
 * what shares its lane: a map pane's drawn as a card ("pane", whose tap
 * closes the pane), the docked token window's ("bar", whose tap hides
 * it), or none. The column draws one row, so where both want it the
 * pane's words win: the pane is what stands over the cards, and once it
 * closes the column's ask hides the window too (features/encounter
 * InitiativeStrip.tsx FightAlerts `showAsk`).
 */
export function summaryFor(input: { paneLane: PaneLane | null; barLane: Lane | null }): "pane" | "bar" | null {
  if (input.paneLane === "summary") return "pane";
  if (input.barLane === "summary") return "bar";
  return null;
}

/** The dock's row height, and the gap kept above it under the top bars. */
export const DOCK_PX = 48;
export const DOCK_GAP = theme.space(2);

/**
 * Whether the dock and the sheet under it both fit between the top bars
 * and the toolbar: the dock, its gap above and the sheet's 120 px minimum.
 * Safe areas can take that room (at 320 x 480 at 130%, 44 px at the top and
 * 34 at the bottom leave 131 px, short of 176). Then the dock is not drawn
 * and its buttons move into the sheet's header (3.2.1).
 */
export function dockFits(space: Omit<SheetSpace, "reserveTop">, dockHeight = DOCK_PX): boolean {
  return sheetRoom({ ...space, reserveTop: dockHeight + DOCK_GAP }) >= SHEET_MIN_HEIGHT;
}

/**
 * One alert in the fight alerts column (features/encounter/InitiativeStrip.tsx),
 * as the dock names it while the column is folded. `says` is what Room's
 * status region announces when it arrives folded.
 */
export type ColumnAlert =
  | { id: string; kind: "concentration"; who: string; says: string }
  | { id: string; kind: "timeUp"; says: string }
  | { id: string; kind: "notice"; text: string; says: string };

/** The rolls' line, as features/rolls publishes it (components/sheetFocus.ts AlertsSummaryEntry). `unnamed`: how many of its requests its words leave out. */
export type RollsLine = { text: string; name: string; waiting: boolean; requests: number; unnamed?: number };

export type SummaryKind = "rolls" | ColumnAlert["kind"];

/** What a summary's tap asks the alerts column to show (DockState.showAsk). */
export type ShowAsk = { kind: "rolls" } | { kind: "alert"; first: { kind: SummaryKind; id: string } };

/** What stands over the alerts, which a summary's advice names (alertsSummary). */
export type SummaryHides = "sheet" | "bar" | "room" | "pane";

export type AlertsSummary = {
  /** The most pressing alert's words: the summary's visible text, which may shrink. */
  text: string;
  /** "+2" when two more wait, outside the text that shrinks, or "". */
  more: string;
  /** The button's name, which starts with what it shows and lists the rest. */
  name: string;
  /** The alert the visible text names, which a tap shows. */
  first: { kind: SummaryKind; id: string };
};

type Item = { kind: SummaryKind; id: string; text: string; phrase: string };

/** "Bless ended on Thorn." as a phrase in a list: no closing stop. */
function phrase(text: string): string {
  return text.replace(/[.!]+$/, "");
}

/**
 * The dock's one alerts summary (3.2.1): the most pressing alert in its
 * visible text, with "+2" when two more wait, in this order: a roll that
 * waits for this viewer ("Roll asked"), concentration checks, the time-up,
 * the other open rolls ("Rolls 1/3"), then the notices, newest first. An
 * order by urgency, since the column mixes log entries, roll requests and
 * a timer that share no clock. Its name starts with that text and lists
 * the rest, then says what a tap does: "Concentration check +2: Thorn
 * checks concentration, time is up, rolls 1 of 3 answered. Close the
 * sheet to see them." It says "see them" whenever the summary stands for
 * more than one thing, the rolls' line of several requests included, and
 * "see it" for one. Null while nothing waits. A rolls' line whose words
 * name only what leads it, as the DM desk's "Dart plate went off" over
 * two asks for saves, adds what they leave out (`unnamed`) to the count:
 * "Dart plate went off +2".
 *
 * `hides` is what stands over the alerts: the sheet that folded them, or
 * the docked token window that leaves the column only this summary row
 * (docs/design-v1-bar-dock.md 1.3), whose tap hides the window. Each advice
 * then says that, in the word the frame names itself by: "Hide the window
 * to answer.", "Hide the window to see them.", "Hide the window to see
 * it.". `room` is a screen whose tool's options leave
 * the column under one whole card, where the row's tap brings up what it
 * stands for over them: "Tap to answer.", "Tap to see them.", "Tap to see
 * it.". `pane` is a map pane, as a bottom sheet (useFoldUnderPane) or as a
 * card the lane leaves no room beside (usePublishPaneLane), whose row's
 * tap closes the pane: "Close the pane to answer.", "Close the pane to see
 * them.", "Close the pane to see it.".
 */
export function alertsSummary(rolls: RollsLine | null, alerts: readonly ColumnAlert[], hides: SummaryHides = "sheet"): AlertsSummary | null {
  const items: Item[] = [];
  if (rolls?.waiting) items.push({ kind: "rolls", id: "rolls", text: rolls.text, phrase: rolls.name });
  for (const a of alerts) {
    if (a.kind === "concentration") items.push({ kind: a.kind, id: a.id, text: "Concentration save", phrase: `${a.who} makes a Concentration save` });
  }
  for (const a of alerts) {
    if (a.kind === "timeUp") items.push({ kind: a.kind, id: a.id, text: "Time is up", phrase: "time is up" });
  }
  if (rolls && !rolls.waiting) items.push({ kind: "rolls", id: "rolls", text: rolls.text, phrase: rolls.name });
  for (const a of [...alerts].reverse()) {
    if (a.kind === "notice") items.push({ kind: a.kind, id: a.id, text: phrase(a.text), phrase: phrase(a.text) });
  }
  const [first] = items;
  if (!first) return null;
  // The rolls' line may stand for things its words leave out, such as asks for saves under a trap that went off: they wait too, so they count.
  const others = items.length - 1 + (rolls ? Math.max(0, rolls.unnamed ?? 0) : 0);
  const more = others > 0 ? `+${others}` : "";
  const several = items.length > 1 || (rolls !== null && rolls.requests > 1);
  const way = hides === "bar" ? "Hide the window" : hides === "room" ? "Tap" : hides === "pane" ? "Close the pane" : "Close the sheet";
  const advice = first.kind === "rolls" && rolls?.waiting ? `${way} to answer.` : several ? `${way} to see them.` : `${way} to see it.`;
  const head = more ? `${first.text} ${more}` : first.text;
  return { text: first.text, more, name: `${head}: ${items.map((i) => i.phrase).join(", ")}. ${advice}`, first: { kind: first.kind, id: first.id } };
}

/**
 * The token bar as the dock shows it while folded: its name ("Thorn
 * actions", "3 selected tokens"), the visible words of its Show button
 * ("Thorn", "3 selected") and that button's name ("Show Thorn actions"),
 * its close's name, its frame to focus, and what its close does.
 */
export type DockBar = {
  label: string;
  text: string;
  show: string;
  closeLabel: string;
  frame: RefObject<HTMLElement | null>;
  close(): void;
};

type DockState = {
  bar: DockBar | null;
  alerts: readonly ColumnAlert[];
  /** The fight alerts column, to find the alert a tap on the summary shows. */
  column: HTMLElement | null;
  /** A sheet shows over the whole screen, in the very short mode or filled by a swipe up (Room sets it): what floats over the map folds as under an upright sheet. */
  sheetFull: boolean;
  /**
   * A sheet opened now would take the very short mode, whether one shows or
   * not (Room sets it), so the stat block's button knows the bar will fold
   * once the panel it opens covers the screen (features/tokens/statBlockOpen.ts).
   */
  sheetFullMode: boolean;
  /** How many map panes show as a bottom sheet now (useFoldUnderPane), which fold the alerts column as a panel sheet does. */
  paneSheets: number;
  /** Where a map pane drawn as a card stands against the column, and its close (usePublishPaneLane). */
  paneLane: { lane: PaneLane; close(): void } | null;
  /**
   * What a summary on a map pane's edge asked to show as its tap closed the
   * pane (RoomDock.tsx PaneDockRow): a roll waiting for this viewer, or the
   * alert it named. The alerts column meets it once it unfolds, as its own
   * row's tap would (features/encounter/InitiativeStrip.tsx FightAlerts).
   */
  showAsk: ShowAsk | null;
  /**
   * The foot of a map pane's header while the pane stands as a bottom sheet
   * (RoomDock.tsx usePaneHead), in the chrome's own px from the page's top,
   * so a toast that shows meanwhile starts under it (canvas/barDock.ts
   * paneToastTop). Null with no such pane, or before it is measured.
   */
  paneHead: number | null;
};

const NO_ALERTS: readonly ColumnAlert[] = [];

/** Per Room page (state/scope.ts): "view as a player" draws a second room with a bar and a column of its own. */
export const dockSlot = scopeSlot(() => createStore<DockState>(() => ({ bar: null, alerts: NO_ALERTS, column: null, sheetFull: false, sheetFullMode: false, paneSheets: 0, paneLane: null, showAsk: null, paneHead: null })));

/**
 * Publishes the token bar for the dock while it is mounted, or nothing for
 * null. `close` may be a new function on every render: the dock always
 * calls the latest one.
 */
export function usePublishBar(bar: DockBar | null): void {
  const store = useScoped(dockSlot);
  const close = useRef(bar?.close);
  close.current = bar?.close;
  const label = bar?.label ?? null;
  const text = bar?.text ?? "";
  const show = bar?.show ?? "";
  const closeLabel = bar?.closeLabel ?? "";
  const frame = bar?.frame ?? null;
  useLayoutEffect(() => {
    if (label === null || frame === null) return;
    store.setState({ bar: { label, text, show, closeLabel, frame, close: () => close.current?.() } });
    return () => {
      if (store.getState().bar?.frame === frame) store.setState({ bar: null });
    };
  }, [store, label, text, show, closeLabel, frame]);
}

/** Publishes the column's alerts for the dock, and its element through the returned ref. */
export function usePublishAlerts(alerts: readonly ColumnAlert[]): (el: HTMLElement | null) => void {
  const store = useScoped(dockSlot);
  useLayoutEffect(() => {
    store.setState({ alerts });
  }, [store, alerts]);
  useLayoutEffect(() => () => store.setState({ alerts: NO_ALERTS }), [store]);
  return useCallback((el: HTMLElement | null) => store.setState({ column: el }), [store]);
}

/** Whether an element is drawn: on the page and not folded under a `hidden` ancestor. */
export function drawn(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
}

/**
 * Focuses the alert a tap on the summary shows, once the column has
 * unfolded: the one its text names (`data-alert` marks each kind in the
 * column), else the column's first drawn alert. The column scrolls as a
 * whole and keeps its place while folded, so the alert is brought into
 * its view first. Returns whether focus landed on an alert that shows.
 */
export function focusAlert(column: HTMLElement | null, first: { kind: SummaryKind; id: string } | null): boolean {
  if (!column) return false;
  const pick = (): HTMLElement | null => {
    if (first) {
      const marked = [...column.querySelectorAll<HTMLElement>(`[data-alert="${first.kind}"]`)].filter((el) => el.dataset.alertId === undefined || el.dataset.alertId === first.id);
      const match = marked.find(drawn) ?? marked[0];
      if (match) return focusTarget(match);
    }
    for (const child of column.querySelectorAll<HTMLElement>("[data-alert]")) {
      const target = focusTarget(child);
      if (target && drawn(target)) return target;
    }
    return null;
  };
  return revealAndFocus(pick());
}

/** The element itself when it takes focus, else its first control. A wrapper with `display: contents` has no box of its own. */
function focusTarget(el: HTMLElement): HTMLElement | null {
  if (el.tabIndex >= 0 || el.hasAttribute("tabindex") || el instanceof HTMLButtonElement) return el;
  return el.querySelector<HTMLElement>("button:not([disabled]), [tabindex], input, select, textarea, a[href]");
}
