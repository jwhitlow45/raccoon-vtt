import { useCallback } from "react";
import type { Token } from "#shared/model.ts";
import { handFocusOn } from "../../lib/handFocus.ts";
import { footprint } from "../../lib/scene.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { duplicateToken, occupiedBoxes, spreadPositions } from "./factory.ts";

/** Where focus goes once the copy took the pressed button away: the first of `to` inside the closest `scope` to the button, as Revive's hand-off reads it. */
export type DuplicateFocus = { scope: string; to: readonly string[] };

/**
 * Duplicate, the token bar's and the DM's Token settings' (docs/design-v1-token-sections.md
 * 3.4): a copy of the token on the nearest free spot beside it, selected
 * for this viewer with `opens`, so an upright phone's strip clears it once
 * (docs/design-v1-bar-compact.md 3.6). The selection replaces the bar's
 * frame with the copy's, and remounts the Token panel for it, so the
 * button pressed leaves the page either way. Focus then moves on to
 * `focus` (D-261024-42), the one rule for both.
 */
export function useDuplicate(token: Token, focus: DuplicateFocus): () => void {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  return useCallback(() => {
    const view = store.getState().view;
    const scene = view?.scenes[token.sceneId];
    if (!view || !scene) return;
    const fp = footprint(token);
    const occupied = occupiedBoxes(Object.values(view.tokens), token.sceneId);
    const [at] = spreadPositions({ center: { x: token.x + fp.w / 2, y: token.y + fp.h / 2 }, footprint: fp, count: 1, bounds: scene.bounds, occupied });
    const id = actions.newId();
    const copy = duplicateToken(token, { id, at: at ?? { x: token.x + fp.w, y: token.y }, chunks: view.buildChunks ?? {}, blocks: view.companionBlocks ?? {} });
    // The scope is read while the pressed button still stands in it.
    const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scope = pressed?.closest<HTMLElement>(focus.scope) ?? null;
    if (actions.dispatch({ t: "token.create", token: copy }) === null) return;
    ui.select(id, { opens: true });
    handFocusOn(scope, focus.to);
  }, [store, actions, ui, token, focus]);
}
