import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { Handout } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";
import { decodeDismissed, encodeDismissed, keepShowing, showingKey } from "./handouts.ts";

/**
 * The handouts this device closed, shared by the popup and the Library
 * panel, which can open one again. Kept in localStorage per room and
 * member, so a reload, or an installed app opened again, does not pop up
 * every handout still showing (features section 16).
 */
export type ClosedHandouts = {
  /** The storage key loaded, or null before the room knows who this is. */
  storageKey: string | null;
  closed: ReadonlySet<string>;
  /** A handout opened again from the Library, shown before newer ones. */
  preferId: string | null;
};

export const closedSlot = scopeSlot(() =>
  createStore<ClosedHandouts>(() => ({ storageKey: null, closed: new Set<string>(), preferId: null })),
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
  const closed = new Set(store.getState().closed);
  closed.delete(showingKey(handout));
  save(store, closed, handout.id);
}
