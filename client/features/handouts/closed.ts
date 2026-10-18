import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { Handout } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";
import { decodeDismissed, encodeDismissed, keepShowing, seenOnLoad, showingKey } from "./handouts.ts";

/**
 * The handouts this device closed, shared by the popup and the Library
 * panel, which can open one again. Kept in localStorage per room and
 * member, so a reload, or an installed app opened again, does not pop up
 * a handout the player closed (features section 16).
 */
export type ClosedHandouts = {
  /** The storage key loaded, or null before the room knows who this is. */
  storageKey: string | null;
  closed: ReadonlySet<string>;
  /** A handout opened again from the Library, shown before newer ones. */
  preferId: string | null;
  /**
   * The handouts already showing when this page first had the room's view,
   * which do not pop up (handouts.ts seenOnLoad), or null until then. Kept
   * for this page load only.
   */
  seen: ReadonlySet<string> | null;
};

export const closedSlot = scopeSlot(() =>
  createStore<ClosedHandouts>(() => ({ storageKey: null, closed: new Set<string>(), preferId: null, seen: null })),
);

export function closedStorageKey(roomId: string, memberId: string): string {
  return `rvtt.handoutsClosed.${roomId}.${memberId}`;
}

export function loadClosed(store: StoreApi<ClosedHandouts>, storageKey: string): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    // Storage blocked: closing still works for this page load.
  }
  store.setState({ storageKey, closed: decodeDismissed(raw), preferId: null });
}

function save(store: StoreApi<ClosedHandouts>, closed: ReadonlySet<string>, preferId: string | null): void {
  const { storageKey } = store.getState();
  store.setState({ closed, preferId });
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, encodeDismissed(closed));
  } catch {
    // As above.
  }
}

export function closeHandout(store: StoreApi<ClosedHandouts>, key: string, handouts: Record<string, Handout | undefined>): void {
  save(store, keepShowing(new Set(store.getState().closed).add(key), handouts), null);
}

/** Pops a handout up again, in front of newer ones. */
export function openHandout(store: StoreApi<ClosedHandouts>, handout: Handout): void {
  const key = showingKey(handout);
  const { seen } = store.getState();
  // One that was showing when the page opened pops up too, once asked for.
  if (seen?.has(key)) store.setState({ seen: new Set([...seen].filter((k) => k !== key)) });
  const closed = new Set(store.getState().closed);
  closed.delete(key);
  save(store, closed, handout.id);
}

/**
 * Where this tab keeps the showing open in its popup: in sessionStorage,
 * which a reload of the same tab keeps and a new tab starts without.
 */
export function openStorageKey(roomId: string, memberId: string): string {
  return `rvtt.handoutOpen.${roomId}.${memberId}`;
}

/**
 * Counts every handout showing now as seen, once, when the page first has
 * the room's view, except the one this tab had open before it reloaded.
 * `openKey` is null where nothing is kept, as in "view as a player".
 */
export function markSeen(store: StoreApi<ClosedHandouts>, handouts: Record<string, Handout | undefined>, openKey: string | null): void {
  if (store.getState().seen) return;
  let open: string | null = null;
  try {
    open = openKey ? sessionStorage.getItem(openKey) : null;
  } catch {
    // Storage blocked: a reload pops up nothing that was showing.
  }
  store.setState({ seen: seenOnLoad(handouts, open) });
}

/** Keeps the showing open in this tab's popup, or forgets it once none is. */
export function rememberOpen(openKey: string | null, key: string | null): void {
  if (!openKey) return;
  try {
    if (key) sessionStorage.setItem(openKey, key);
    else sessionStorage.removeItem(openKey);
  } catch {
    // As above.
  }
}
