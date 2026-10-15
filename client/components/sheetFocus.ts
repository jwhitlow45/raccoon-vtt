import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { revealAndFocus } from "../lib/reveal.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";

/**
 * Two small registries where the room's folding parts meet without
 * importing one another (docs/design-v1-visual.md 2.3 and 3.2.1). On a
 * phone in portrait an open sheet folds the token bar and the fight
 * alerts into a dock on its edge (Room, part 3's), and folds the player's
 * roll card (features/rolls, part 5's). Room needs to know where focus
 * goes once the sheet closes, and the dock needs the rolls' line of its
 * summary. Each side registers or reads here, so each builds alone, and
 * both registries do nothing until someone reads them.
 *
 * They belong to one Room page (state/scope.ts), not to the page load:
 * "view as a player" mounts a second Room over the DM's, and a shared
 * registry let the preview's dock show the DM's rolls, open the DM's
 * card, announce the DM's line, and hand focus to the DM's token bar.
 */

/** Return-focus ranks, lowest first: a roll card the sheet was hiding outranks the token bar (3.2.1). */
export const RETURN_RANK = { rollCard: 1, tokenBar: 2 } as const;

type ReturnEntry = { ref: RefObject<HTMLElement | null>; rank: number; order: number };

type SummaryRecord = { id: number; entry: AlertsSummaryEntry };

/** One Room's registries: what may take focus when a sheet closes, and the rolls' line of the dock's summary. */
export class SheetFocusRegistry {
  readonly returnEntries = new Set<ReturnEntry>();
  registered = 0;
  readonly summaries: SummaryRecord[] = [];
  readonly summaryListeners = new Set<() => void>();
  published = 0;
  latest: AlertsSummaryEntry | null = null;
  /** The dock's alerts summary button, wherever the dock draws it, which Room publishes. */
  dockSummary: RefObject<HTMLElement | null> | null = null;
}

/** This Room's registries (state/scope.ts). */
export const sheetFocusSlot = scopeSlot(() => new SheetFocusRegistry());

/** Registers an element that may take focus when a sheet closes. Returns the function that removes it. */
export function registerSheetReturnFocus(registry: SheetFocusRegistry, ref: RefObject<HTMLElement | null>, rank: number): () => void {
  const entry: ReturnEntry = { ref, rank, order: registry.registered++ };
  registry.returnEntries.add(entry);
  return () => {
    registry.returnEntries.delete(entry);
  };
}

/**
 * Offers `ref`'s element to take focus when a sheet closes, at `rank`
 * (RETURN_RANK), while `active` holds and the component is mounted. A
 * part registers only what has something to show: the roll card while it
 * is mounted, never a request put off with Later, which has no card.
 */
export function useSheetReturnFocus(ref: RefObject<HTMLElement | null>, rank: number, active = true): void {
  const registry = useScoped(sheetFocusSlot);
  useLayoutEffect(() => {
    if (!active) return;
    return registerSheetReturnFocus(registry, ref, rank);
  }, [registry, ref, rank, active]);
}

/**
 * Whether an element can take focus now: on the page and drawn, so not
 * folded under a `hidden` ancestor, where focus() would do nothing.
 */
function focusable(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && el.getClientRects().length > 0 && el.closest("[hidden]") === null;
}

/** The element that should take focus now: the lowest rank whose element is on the page and drawn, and on a tie the one registered last. */
export function sheetReturnTarget(registry: SheetFocusRegistry): HTMLElement | null {
  let best: { el: HTMLElement; rank: number; order: number } | null = null;
  for (const entry of registry.returnEntries) {
    const el = entry.ref.current;
    if (!focusable(el)) continue;
    if (!best || entry.rank < best.rank || (entry.rank === best.rank && entry.order > best.order)) best = { el, rank: entry.rank, order: entry.order };
  }
  return best?.el ?? null;
}

/**
 * Room's one decision once a sheet has closed by its close button,
 * Escape or Back (3.2.1): focus the registered target, if any. Ask after
 * the folded parts have unfolded (an effect after the render that closed
 * the sheet), since a folded element cannot take focus. False, when no
 * target was found or focus did not land on it, leaves Room to place focus
 * where it went before.
 */
export function returnFocusAfterSheet(registry: SheetFocusRegistry): boolean {
  // A roll card in the alerts column, which scrolls as a whole, may have scrolled out of sight.
  return revealAndFocus(sheetReturnTarget(registry));
}

/**
 * The rolls' line in the dock's alerts summary (3.2.1 and 3.3.1), which
 * features/rolls publishes and the dock reads.
 */
export type AlertsSummaryEntry = {
  /** The visible words: "Roll asked" while a request waits for this viewer's answer, "Rolls 1/3" otherwise. */
  text: string;
  /**
   * What waits, in words, for the summary button's name, without the
   * closing advice the dock adds: "the DM asks for a Wisdom check",
   * "rolls 1 of 3 answered".
   */
  name: string;
  /** A request waits for this viewer's answer, which puts "Roll asked" first in the summary's order. */
  waiting: boolean;
  /** How many requests the line stands for, so the dock's closing advice says "see them" for several. */
  requests: number;
  /**
   * Shows what waits: the card of the request to answer, focused (3.3.1).
   * The dock closes the sheets first, then calls it, and the token bar
   * comes back as it was. The alerts column's summary row asks with
   * `barAway`, which puts the token bar away first, as a chip's tap does.
   */
  open(options?: { barAway?: boolean }): void;
};

function changed(registry: SheetFocusRegistry): void {
  registry.latest = registry.summaries.at(-1)?.entry ?? null;
  for (const listener of registry.summaryListeners) listener();
}

/** Publishes an entry. Returns the function that withdraws it. */
export function publishAlertsSummary(registry: SheetFocusRegistry, entry: AlertsSummaryEntry): () => void {
  const id = registry.published++;
  registry.summaries.push({ id, entry });
  changed(registry);
  return () => {
    const at = registry.summaries.findIndex((r) => r.id === id);
    if (at === -1) return;
    registry.summaries.splice(at, 1);
    changed(registry);
  };
}

/** The entry published last and not yet withdrawn, or null. */
export function alertsSummaryEntry(registry: SheetFocusRegistry): AlertsSummaryEntry | null {
  return registry.latest;
}

function subscribeAlertsSummary(registry: SheetFocusRegistry, listener: () => void): () => void {
  registry.summaryListeners.add(listener);
  return () => {
    registry.summaryListeners.delete(listener);
  };
}

/**
 * Publishes the rolls' part of the alerts summary while mounted, or
 * nothing for null. `open` may be a new function on every render: the
 * reader always calls the latest one. A change of the words, of `waiting`
 * or of the count publishes again.
 */
export function useAlertsSummary(entry: AlertsSummaryEntry | null): void {
  const registry = useScoped(sheetFocusSlot);
  const open = useRef(entry?.open);
  open.current = entry?.open;
  const text = entry?.text ?? null;
  const name = entry?.name ?? null;
  const waiting = entry?.waiting ?? false;
  const requests = entry?.requests ?? 0;
  useLayoutEffect(() => {
    if (text === null || name === null) return;
    return publishAlertsSummary(registry, { text, name, waiting, requests, open: (options) => open.current?.(options) });
  }, [registry, text, name, waiting, requests]);
}

/**
 * Publishes the dock's alerts summary button while mounted (Room), so a
 * part that folds into it, such as the roll card with focus inside it,
 * can hand focus to it (3.3.1) without importing the dock.
 */
export function useDockSummaryButton(ref: RefObject<HTMLElement | null>): void {
  const registry = useScoped(sheetFocusSlot);
  useLayoutEffect(() => {
    registry.dockSummary = ref;
    return () => {
      if (registry.dockSummary === ref) registry.dockSummary = null;
    };
  }, [registry, ref]);
}

/** The dock's alerts summary button, when it is on the page and drawn. */
export function dockSummaryButton(registry: SheetFocusRegistry): HTMLElement | null {
  const el = registry.dockSummary?.current ?? null;
  return focusable(el) ? el : null;
}

/** What the rolls publish for the dock's summary, or null when nothing waits. */
export function useAlertsSummaryEntry(): AlertsSummaryEntry | null {
  const registry = useScoped(sheetFocusSlot);
  const subscribe = useCallback((listener: () => void) => subscribeAlertsSummary(registry, listener), [registry]);
  const read = useCallback(() => alertsSummaryEntry(registry), [registry]);
  return useSyncExternalStore(subscribe, read, () => null);
}
