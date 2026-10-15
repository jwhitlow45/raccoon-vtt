import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import { sheetRoom, SHEET_MIN_HEIGHT, type SheetSpace } from "../components/sheetCap.ts";
import { useLayoutSize } from "../features/device/layout.ts";
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
 * rule for when to fold.
 */

/**
 * Whether what floats over the map folds: a phone in portrait (under
 * 900 layout px and no wider than tall, the roll desk's rule,
 * features/rolls/logic.ts deskLayout) with a panel sheet or the list of
 * panels open. In landscape the sheet docks on the right and leaves the
 * map beside it, so nothing folds there.
 */
export function foldsUnderSheet(input: { width: number; height: number; sheetOpen: boolean }): boolean {
  return input.sheetOpen && input.width < theme.layout.wideMinWidth && input.width <= input.height;
}

/** foldsUnderSheet for this Room now, in the chrome's own pixels (features/device/layout.ts). */
export function useUnderSheet(): boolean {
  const { width, height } = useLayoutSize();
  const open = useRoomView((s) => sheetOpen(s.local));
  return foldsUnderSheet({ width, height, sheetOpen: open });
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

/** The rolls' line, as features/rolls publishes it (components/sheetFocus.ts AlertsSummaryEntry). */
export type RollsLine = { text: string; name: string; waiting: boolean; requests: number };

export type SummaryKind = "rolls" | ColumnAlert["kind"];

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
 * "see it" for one. Null while nothing waits.
 *
 * `hides` is what stands over the alerts: the sheet that folded them, or
 * the docked token bar that leaves the column only this summary row
 * (docs/design-v1-bar-dock.md 1.3), whose tap hides the bar. Each advice
 * then says that: "Hide the bar to answer.", "Hide the bar to see them.",
 * "Hide the bar to see it.".
 */
export function alertsSummary(rolls: RollsLine | null, alerts: readonly ColumnAlert[], hides: "sheet" | "bar" = "sheet"): AlertsSummary | null {
  const items: Item[] = [];
  if (rolls?.waiting) items.push({ kind: "rolls", id: "rolls", text: rolls.text, phrase: rolls.name });
  for (const a of alerts) {
    if (a.kind === "concentration") items.push({ kind: a.kind, id: a.id, text: "Concentration check", phrase: `${a.who} checks concentration` });
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
  const more = items.length > 1 ? `+${items.length - 1}` : "";
  const several = items.length > 1 || (rolls !== null && rolls.requests > 1);
  const way = hides === "bar" ? "Hide the bar" : "Close the sheet";
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
};

const NO_ALERTS: readonly ColumnAlert[] = [];

/** Per Room page (state/scope.ts): "view as a player" draws a second room with a bar and a column of its own. */
export const dockSlot = scopeSlot(() => createStore<DockState>(() => ({ bar: null, alerts: NO_ALERTS, column: null })));

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
