import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { sceneGate } from "../../lib/scene.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import type { HpTarget } from "./groupHp.ts";
import type { HpMode } from "./hpInput.ts";
import type { HpChip } from "../dice/options.ts";

/** What was typed into an HP entry and not applied: the mode, the number or math, and the critical hit box. */
export type HpDraft = { mode: HpMode; text: string; crit: boolean; chip?: HpChip };

/**
 * HP typed and not applied, kept through a DM's blackout (LPD-PLAYER-7).
 * Behind a blackout a player's room shows only the pause screen, so the
 * token bar and the entry in it unmount, and the number was gone when the
 * game resumed. An entry leaves its draft here as it unmounts behind the
 * pause screen, and takes it back when it mounts again after, which can be
 * a moment after the pause screen goes, once the map is drawn. A draft
 * nothing takes back goes with the next change of selection, so it never
 * turns up on a token picked later. An entry that unmounts for any other
 * reason leaves nothing, and starts empty next time, as it always has.
 *
 * Per Room page (state/scope.ts), which outlives the pause screen: Room
 * draws that screen in place of the room rather than leaving the page.
 */
export const hpDraftSlot = scopeSlot(() => new Map<string, HpDraft>());

/**
 * Where an HP entry stands: the token bar over the map, or a panel (the
 * Token and Characters panels and the tracker's group entry).
 */
export type HpPlace = "bar" | "panel";

/**
 * One draft per place and set of creatures. The token bar and the token's
 * panel can both be up for one creature, on a desktop with the Token tab
 * chosen or a phone with the Token sheet open over the folded bar, each
 * with its own typing. Sharing one draft let the panel's empty entry
 * overwrite what was typed into the bar behind the blackout, and the panel,
 * which mounts before the bar once the pause ends, took the draft first.
 */
export function hpDraftKey(place: HpPlace, targets: readonly Pick<HpTarget, "holder">[]): string {
  const holders = targets
    .map((t) => t.holder)
    .sort()
    .join("|");
  return `${place}:${holders}`;
}

/** What an entry leaves as it unmounts: its draft for `key`, only behind a blackout (useKeepHpDraft). */
export function leaveHpDraft(drafts: Map<string, HpDraft>, key: string, draft: HpDraft, paused: boolean): void {
  if (paused) drafts.set(key, draft);
}

/** The draft an entry for `key` starts from, if one was left, which it then takes off the shelf (useKeptHpDraft). */
export function takeHpDraft(drafts: Map<string, HpDraft>, key: string): HpDraft | undefined {
  const draft = drafts.get(key);
  drafts.delete(key);
  return draft;
}

/** Whether this viewer is behind a blackout now, by the rule the room's gate follows (lib/scene.ts sceneGate). */
export function behindBlackout(s: Pick<RoomView, "view" | "sceneId" | "you">): boolean {
  return sceneGate({ view: s.view, sceneId: s.sceneId, role: s.you?.role ?? "player" }).kind === "blackout";
}

/** The draft an entry for `key` starts from, the one it left behind the pause screen, which it takes off the shelf once mounted. */
export function useKeptHpDraft(key: string): HpDraft | undefined {
  const drafts = useScoped(hpDraftSlot);
  // Read in render and taken once mounted, since the development double render calls the initializer twice.
  const [kept] = useState(() => drafts.get(key));
  useEffect(() => {
    takeHpDraft(drafts, key);
  }, [drafts, key]);
  return kept;
}

/**
 * Leaves `draft` behind for `key` when the entry unmounts behind a
 * blackout. The blackout is already in the state by then: it is what made
 * Room draw the pause screen in the room's place.
 */
export function useKeepHpDraft(key: string, draft: HpDraft): void {
  const store = useRoomStore();
  const drafts = useScoped(hpDraftSlot);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () => () => {
      leaveHpDraft(drafts, key, latest.current, behindBlackout(store.getState()));
    },
    [store, drafts, key],
  );
}

/**
 * A player's Apply to chip asking a token's bar to fill its HP entry
 * (QOL audit Q2, D-261106-117): the roll's amount in Damage mode with its
 * parts, as the entry's Use fills it, so its preview shows and nothing is
 * sent until Apply, since a player has no Undo (D-261106-174). The chip
 * selects the token, which opens its bar, and the bar's entry for that
 * token alone takes the fill, now or as it mounts. `focus` puts the caret
 * in the field, on a computer: a phone keeps its keyboard down.
 */
export type HpFill = { tokenId: string; chip: HpChip; focus: boolean };

export const hpFillSlot = scopeSlot(() => createStore<{ fill: HpFill | null }>(() => ({ fill: null })));

/** A fill to ask for, which the next selection of any other token drops (useDropHpDraftsOnSelect). */
export function useAskHpFill(): (fill: HpFill) => void {
  const fills = useScoped(hpFillSlot);
  return useCallback((fill: HpFill) => fills.setState({ fill }), [fills]);
}

/** The fill waiting for this token's bar entry, and how the entry takes it off the shelf. Null `tokenId` waits for none. */
export function useHpFill(tokenId: string | null): { fill: HpFill | null; take(fill: HpFill): void } {
  const fills = useScoped(hpFillSlot);
  const fill = useStore(fills, (s) => (tokenId !== null && s.fill?.tokenId === tokenId ? s.fill : null));
  const take = useCallback((taken: HpFill) => fills.setState((s) => (s.fill === taken ? { fill: null } : s)), [fills]);
  return { fill, take };
}

/** Whether a fill still waits for the selection: only while that token alone is selected. */
export function fillWaits(fill: HpFill, selected: readonly string[]): boolean {
  return selected.length === 1 && selected[0] === fill.tokenId;
}

/** Room's part: a new selection drops every draft left, whose entry never came back for it, and a fill for a token no longer selected alone. */
export function useDropHpDraftsOnSelect(): void {
  const drafts = useScoped(hpDraftSlot);
  const fills = useScoped(hpFillSlot);
  const selected = useRoomView((s) => s.local.selectedIds);
  useEffect(() => {
    drafts.clear();
    fills.setState((s) => (s.fill && !fillWaits(s.fill, selected) ? { fill: null } : s));
  }, [drafts, fills, selected]);
}
