import { createStore, type StoreApi } from "zustand/vanilla";
import type { Fade, PlaylistId, Repeat, SoundId } from "#shared/sound.ts";
import { scopeSlot } from "../../../state/scope.ts";

/*
 * The Music window's state (docs/design/design-v1-music-player.md 3.2 and
 * 5): whether it is open, its tab, its step and the playlist maker's
 * draft. It lives in Room's scope rather than in the window, since a
 * resize across 900 px remounts the panel that opens it, and the window
 * must stay open on the same step with the draft kept.
 */

/** The narrow window's tabs (4.1). The wide one shows both at once and keeps the tab for a later narrow layout. */
export type MusicTab = "now" | "library";

/** The narrow maker's tabs (5): its tracks in order and its settings, or the search to add tracks. */
export type MakerTab = "tracks" | "add";

/** What a playlist's draft edits, in the shape `playlist.create` and `playlist.update` send. */
export type MakerFields = { name: string; sounds: SoundId[]; shuffle: boolean; repeat: Repeat; fade: Fade };

/**
 * The maker's draft, saved once (5). `base` is the playlist as the draft
 * began, its `rev` too, so Save sends only the fields the draft changed
 * and the maker can tell another DM's change of tracks. Null for a new
 * playlist, whose `playlistId` is chosen as the draft begins, so a Create
 * sent twice makes one playlist.
 */
export type MakerDraft = MakerFields & {
  playlistId: PlaylistId;
  base: (MakerFields & { rev: number }) | null;
  tab: MakerTab;
};

/** The window's step: its home (Now playing, Up next and Library), the maker, or a track's page, the last two with back "Music". */
export type MusicStep = { t: "home" } | { t: "maker"; draft: MakerDraft } | { t: "track"; soundId: SoundId };

export type MusicWindowState = { open: boolean; tab: MusicTab; step: MusicStep };

export const MUSIC_WINDOW_CLOSED: MusicWindowState = { open: false, tab: "library", step: { t: "home" } };

/** The window's state for one Room page. */
export const musicWindowSlot = scopeSlot(() => createStore<MusicWindowState>(() => MUSIC_WINDOW_CLOSED));

/** Open music (3.2): on Now playing while a run exists, paused too, else on Library, at its home. */
export function openMusicWindow(store: StoreApi<MusicWindowState>, runExists: boolean): void {
  store.setState({ open: true, tab: runExists ? "now" : "library", step: { t: "home" } });
}

/** Closed, its step and draft let go: a close with changes has asked first (5). */
export function closeMusicWindow(store: StoreApi<MusicWindowState>): void {
  store.setState(MUSIC_WINDOW_CLOSED);
}
