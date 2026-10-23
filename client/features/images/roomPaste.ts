import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";

/**
 * Pasting with nothing open that takes it (docs/design-v1-paste.md 4): on
 * a computer, the DM's Ctrl+V over the map offers the picture as a new
 * scene, the selected token's picture, a stamp or a handout.
 *
 * The offer uploads nothing itself. Each choice hands the file to its
 * entry through a one-item slot in the room's scope and opens the entry,
 * which then runs the handler its file control runs, with every rule, busy
 * state and error its own.
 */

/** The entries the offer hands a picture to. The token's picture is the offer's own, through the image picker. */
export type HandoffTo = "scene" | "handout" | "stamp";

export type Handoff = { to: HandoffTo; file: File };

/** What an entry reports so its row waits while it is busy. */
export type BusyEntry = "scene" | "handout";

export type RoomPasteState = { handoff: Handoff | null; busy: Record<BusyEntry, boolean> };

export const roomPasteSlot = scopeSlot(() => createStore<RoomPasteState>(() => ({ handoff: null, busy: { scene: false, handout: false } })));

/**
 * An entry takes a picture handed to it, once it is `ready`. Whether one
 * is waiting comes back, so a closed form can open for it. The take waits
 * a turn after the render, so React's development double mount, which
 * runs every cleanup once before the second mount, never takes it twice
 * nor has a cleanup stop what the take started.
 */
export function useHandoff(to: HandoffTo, ready: boolean, take: (file: File) => void): boolean {
  const store = useScoped(roomPasteSlot);
  const handoff = useStore(store, (s) => (s.handoff?.to === to ? s.handoff : null));
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    if (!handoff || !ready) return;
    const timer = setTimeout(() => {
      if (store.getState().handoff !== handoff) return;
      store.setState({ handoff: null });
      latest.current(handoff.file);
    }, 0);
    return () => clearTimeout(timer);
  }, [handoff, ready, store]);
  return handoff !== null;
}

/** An entry's busy state, for its row in the offer (1.3: a busy entry's row is disabled). */
export function useEntryBusy(entry: BusyEntry, busy: boolean): void {
  const store = useScoped(roomPasteSlot);
  useEffect(() => {
    store.setState({ busy: { ...store.getState().busy, [entry]: busy } });
    return () => store.setState({ busy: { ...store.getState().busy, [entry]: false } });
  }, [store, entry, busy]);
}

export type RoomPasteRowId = "scene" | "token" | "stamp" | "handout";

export type RoomPasteRow = { id: RoomPasteRowId; label: string; help: string; disabled: boolean };

export type RoomPasteInput = {
  role: "dm" | "player";
  sceneCount: number;
  /** The one selected token's name, or null when none or several are selected. */
  token: string | null;
  /** A scene is open, which a stamp is placed on. */
  onScene: boolean;
  /** The Build tool is in Stamp mode. */
  stampMode: boolean;
  busy: Record<BusyEntry, boolean>;
};

/**
 * The offer's rows, the likeliest first: Stamp with Stamp mode on, the
 * token's picture with one token selected, else New scene. The DM's
 * alone: a player's one kind of image is a token's, a tap away in the
 * picker, where paste works.
 */
export function roomPasteRows(input: RoomPasteInput): RoomPasteRow[] {
  if (input.role !== "dm") return [];
  const full = input.sceneCount >= LIMITS.scenesPerRoom;
  const rows: RoomPasteRow[] = [
    {
      id: "scene",
      label: "New scene",
      help: full
        ? `A room holds at most ${LIMITS.scenesPerRoom} scenes. Delete one to add another.`
        : input.busy.scene
          ? "Wait for New scene's upload to finish."
          : "Make a scene with it as the map.",
      disabled: full || input.busy.scene,
    },
  ];
  if (input.token !== null) rows.push({ id: "token", label: `Picture for ${input.token}`, help: "Then crop it to fit the token.", disabled: false });
  if (input.onScene) rows.push({ id: "stamp", label: "Stamp", help: "Then tap the map to place it.", disabled: false });
  rows.push({
    id: "handout",
    label: "Handout",
    help: input.busy.handout ? "Wait for the handout's upload to finish." : "Then choose who sees it.",
    disabled: input.busy.handout,
  });
  const first: RoomPasteRowId = input.stampMode && input.onScene ? "stamp" : input.token !== null ? "token" : "scene";
  return [...rows.filter((r) => r.id === first), ...rows.filter((r) => r.id !== first)];
}
