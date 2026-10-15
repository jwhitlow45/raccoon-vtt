import { useEffect, useRef, useState } from "react";
import { sceneGate } from "../../lib/scene.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import type { HpTarget } from "./groupHp.ts";
import type { HpMode } from "./hpInput.ts";

/** What was typed into an HP entry and not applied: the mode, the number or math, and the critical hit box. */
export type HpDraft = { mode: HpMode; text: string; crit: boolean };

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

/** One draft per set of creatures: the token bar and the token's panel share it, as they show the same entry. */
export function hpDraftKey(targets: readonly Pick<HpTarget, "holder">[]): string {
  return targets
    .map((t) => t.holder)
    .sort()
    .join("|");
}

/** Whether this viewer is behind a blackout now, by the rule the room's gate follows (lib/scene.ts sceneGate). */
export function behindBlackout(s: Pick<RoomView, "view" | "sceneId" | "you">): boolean {
  return sceneGate({ view: s.view, sceneId: s.sceneId, role: s.you?.role ?? "player" }).kind === "blackout";
}

/** The draft an entry for `key` starts from, the one it left behind the pause screen, which it takes off the shelf once mounted. */
export function useKeptHpDraft(key: string): HpDraft | undefined {
  const drafts = useScoped(hpDraftSlot);
  const [kept] = useState(() => drafts.get(key));
  useEffect(() => {
    drafts.delete(key);
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
      if (behindBlackout(store.getState())) drafts.set(key, latest.current);
    },
    [store, drafts, key],
  );
}

/** Room's part: a new selection drops every draft left, whose entry never came back for it. */
export function useDropHpDraftsOnSelect(): void {
  const drafts = useScoped(hpDraftSlot);
  const selected = useRoomView((s) => s.local.selectedIds);
  useEffect(() => {
    drafts.clear();
  }, [drafts, selected]);
}
