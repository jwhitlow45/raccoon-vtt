import { useCallback, type RefCallback } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Fade, Playlist, PlaylistId, Repeat, SoundId } from "#shared/sound.ts";
import { scopeSlot, useScoped, type RoomScope } from "../../../state/scope.ts";
import type { RoomUi } from "../../../state/store.ts";
import { panelScrollSlot, SOUND_PANEL } from "../../panels.ts";

/*
 * The Sound panel's state that outlives the panel
 * (docs/design/design-v1-sound-layout.md 4.1 and 4.5): which view shows
 * and Library's search, a request to show Now playing from elsewhere, and
 * the playlist maker's pop-up with its draft. Each lives in Room's scope
 * rather than in the panel, since a turn across 900 px remounts the panel
 * in the other tree, and the view, the search and the draft must stay. None
 * of it is stored: a DM in play opens Sound for the player.
 */

/** The Sound panel's two views (4.1): the player and what plays with it, or the playlists and tracks. */
export type SoundView = "now" | "library";

/** The view and Library's search, read by both trees (4.1, 4.4). */
export type SoundViewState = { readonly view: SoundView; readonly query: string };

/** Where Sound starts at each opening: Now playing, with no search. */
export const SOUND_VIEW_START: SoundViewState = Object.freeze({ view: "now", query: "" });

export const soundViewSlot = scopeSlot(() => createStore<SoundViewState>(() => SOUND_VIEW_START));

/** The view and the search, for whatever draws in the Sound panel. */
export function useSoundView(): SoundViewState {
  return useStore(useScoped(soundViewSlot));
}

/**
 * Sound went from open to closed, a hidden sheet or side panel counting
 * as open (4.1): the next opening starts on Now playing with no search,
 * and its remembered scroll goes now, not at the opening, since the
 * panel's scroll keeper puts an offset back in its first layout effect,
 * before anything after the mount could drop it. So a close after
 * scrolling to the foot of a long Library opens on the player.
 */
export function endSoundView(scope: RoomScope): void {
  scope.get(soundViewSlot).setState(SOUND_VIEW_START);
  scope.get(panelScrollSlot).delete(SOUND_PANEL);
}

/**
 * A request from outside the panel to show Now playing at its top (4.1),
 * the chip's Open Sound: the panel leaves a subpage through its own Back,
 * then puts its scroller at the top as the viewer taking it. `seq` tells
 * one press from the next, so a second press acts again.
 */
export type SoundAsk = { readonly seq: number };

export const soundAskSlot = scopeSlot(() => createStore<SoundAsk>(() => ({ seq: 0 })));

/** The elements the Sound panel draws in, one per tree it is mounted in (useSoundRoot). */
export const soundRootsSlot = scopeSlot(() => new Set<Pick<HTMLElement, "contains">>());

/** A ref for the Sound panel's own root, so openSoundNow can find a field being typed in there and blur it first. */
export function useSoundRoot(): RefCallback<HTMLElement> {
  const roots = useScoped(soundRootsSlot);
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      roots.add(el);
      return () => {
        roots.delete(el);
      };
    },
    [roots],
  );
}

/**
 * Open Sound (5.3): opens the Sound panel, or leaves it where it is
 * already open, on Now playing, and asks it to show its top.
 *
 * First it blurs a field focused inside the panel, such as a track's name
 * on its page, which saves on blur: the request then leaves that subpage,
 * and the field would unmount unsaved. The press cannot be trusted to
 * blur it: it is in a popover or a dialog outside the panel, and Safari
 * focuses no button on a click.
 */
export function openSoundNow(scope: RoomScope, ui: Pick<RoomUi, "openPanel">): void {
  blurInside(scope.get(soundRootsSlot));
  scope.get(soundViewSlot).setState({ view: "now" });
  const ask = scope.get(soundAskSlot);
  ask.setState({ seq: ask.getState().seq + 1 });
  ui.openPanel(SOUND_PANEL);
}

function blurInside(roots: ReadonlySet<Pick<HTMLElement, "contains">>): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement as (Node & { blur?(): void }) | null;
  if (!active) return;
  for (const root of roots) {
    if (root.contains(active)) {
      active.blur?.();
      return;
    }
  }
}

/** The narrow maker's tabs (music-player 5): its tracks in order and its settings, or the search to add tracks. */
export type MakerTab = "tracks" | "add";

/** What a playlist's draft edits, in the shape `playlist.create` and `playlist.update` send. */
export type MakerFields = { name: string; sounds: SoundId[]; shuffle: boolean; repeat: Repeat; fade: Fade };

/**
 * The maker's draft, saved once (music-player 5). `base` is the playlist
 * as the draft began, its `rev` too, so Save sends only the fields the
 * draft changed and the maker can tell another DM's change of tracks.
 * Null for a new playlist, whose `playlistId` is chosen as the draft
 * begins, so a Create sent twice makes one playlist.
 */
export type MakerDraft = MakerFields & {
  playlistId: PlaylistId;
  base: (MakerFields & { rev: number }) | null;
  tab: MakerTab;
};

/** A saved playlist's fields, as a draft edits them. */
function fieldsOf(playlist: Playlist): MakerFields {
  return { name: playlist.name, sounds: [...playlist.sounds], shuffle: playlist.shuffle === true, repeat: playlist.repeat, fade: playlist.fade };
}

/**
 * A draft of a saved playlist, as it stands now. Here beside the slot,
 * not in the maker, so Library opens the maker without loading the
 * maker's code first (MakerHost.tsx).
 */
export function draftOf(playlist: Playlist): MakerDraft {
  const fields = fieldsOf(playlist);
  return { ...fields, playlistId: playlist.id, base: { ...fields, sounds: [...playlist.sounds], rev: playlist.rev }, tab: "tracks" };
}

/** A new playlist's draft, its id chosen now so a Create sent twice makes one, with a first track when it starts from one (New playlist with this track). */
export function newDraft(playlistId: string, seed?: SoundId): MakerDraft {
  return { name: "", sounds: seed ? [seed] : [], shuffle: false, repeat: "all", fade: 5, playlistId, base: null, tab: "tracks" };
}

/**
 * The playlist maker's pop-up (4.5): its draft while it is open, else
 * null, and the mark of the control that opened it (MAKER_OPENER), so
 * focus goes back there on close though a turn across 900 px remounted
 * that control.
 */
export type MakerState = { readonly draft: MakerDraft | null; readonly opener: string | null };

export const MAKER_CLOSED: MakerState = Object.freeze({ draft: null, opener: null });

export const makerSlot = scopeSlot(() => createStore<MakerState>(() => MAKER_CLOSED));

/** The attribute a control that opens the maker carries, its value the mark openMaker is given. */
export const MAKER_OPENER = "data-maker-opener";

/** Opens the maker on `draft`, from the control marked `opener`. */
export function openMaker(store: StoreApi<MakerState>, draft: MakerDraft, opener: string | null): void {
  store.setState({ draft, opener });
}

/** The draft changed. An answer that comes after the maker closed changes nothing. */
export function setMakerDraft(store: StoreApi<MakerState>, draft: MakerDraft): void {
  if (store.getState().draft !== null) store.setState({ draft });
}

/** Closed, its draft let go: a close with changes has asked first (4.5). */
export function closeMaker(store: StoreApi<MakerState>): void {
  store.setState(MAKER_CLOSED);
}

/** Where focus goes back as the maker closes: the control marked `opener`, found afresh at that moment, or null. */
export function makerOpener(opener: string | null): { readonly current: HTMLElement | null } {
  return {
    get current(): HTMLElement | null {
      if (opener === null || typeof document === "undefined") return null;
      return [...document.querySelectorAll<HTMLElement>(`[${MAKER_OPENER}]`)].find((el) => el.getAttribute(MAKER_OPENER) === opener) ?? null;
    },
  };
}
