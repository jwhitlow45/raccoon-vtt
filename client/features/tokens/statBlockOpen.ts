import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import { BESIDE_MIN, EDGE, barDockSlot } from "../../canvas/barDock.ts";
import type { Size } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { dockSlot, foldsUnderSheet } from "../../pages/fold.ts";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { PanelHow } from "../../state/types.ts";
import { useRoomView } from "../../state/view.ts";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { overrideAfterSelect, statBlockOpenedSlot } from "./panelFolds.ts";

/**
 * A request to show a token's stat block (docs/design-v1-token-panel.md
 * 3.4): the token panel's stat block section, once it shows that token,
 * unfolds, scrolls itself to the top of the panel, takes focus when
 * `focus` asks and clears the request. `seq` tells one press from the
 * next, so pressing "Stat block" again while the block shows scrolls and
 * focuses it again. Per Room page, so a press in "view as a player" never
 * reaches the DM's own panel.
 */
export type StatBlockRequest = { tokenId: string | null; focus: boolean; seq: number };

export const statBlockRequest = scopeSlot(() => createStore<StatBlockRequest>(() => ({ tokenId: null, focus: false, seq: 0 })));

export function requestStatBlock(scope: RoomScope, tokenId: string, focus = true): void {
  const store = scope.get(statBlockRequest);
  store.setState({ tokenId, focus, seq: store.getState().seq + 1 });
}

/**
 * Whether the token bar steps aside when the stat block opens: only where
 * it cannot stand beside the panel. That is where it folds under the sheet
 * (a portrait layout under 900 px, or the very short sideways sheet of
 * docs/design-v1-layout-hierarchy.md 4.2, `veryShort`), or where the free
 * width a side sheet leaves is under the bar's narrowest, 230 px. From 900
 * px up, and on a phone held sideways with room beside its sheet, the bar
 * stays, so the DM applies damage while reading the block.
 */
export function statBlockHidesBar(input: { width: number; height: number; safeLeft: number; veryShort?: boolean }): boolean {
  const { width, height } = input;
  if (foldsUnderSheet({ width, height, sheetOpen: true, full: input.veryShort })) return true;
  if (width >= theme.layout.wideMinWidth) return false;
  const sheet = Math.min(theme.layout.landscapeSheetWidth, width * 0.6);
  return width - sheet - input.safeLeft - 2 * EDGE < BESIDE_MIN;
}

/**
 * The one way to show a token's stat block, in its panel: the bar's "Stat
 * block" and a tracker row's. It selects the token, asks the section for
 * the block with focus, opens the token panel (the side panel's Token tab
 * from 900 px up, the Token sheet below) and hides the bar only where it
 * cannot stand beside the panel. Elsewhere it leaves the bar as it was:
 * open from the bar, and as a tracker row found it.
 *
 * `from` is the panel the press was in (features/panels.ts usePanelHere),
 * a tracker row's Initiative, so with two panels Token opens in the other
 * pane and Initiative stays (docs/design-v1-split-panel.md 5.1). `layout`
 * is the window in the chrome's px, read when left out.
 */
export function openStatBlock(scope: RoomScope, ui: Pick<RoomUi, "select" | "showActions" | "openPanel">, tokenId: string, options: { from?: string | null; layout?: Size } = {}): void {
  ui.select(tokenId, { opens: true });
  requestStatBlock(scope, tokenId);
  // Open whatever the folds say, without writing them (panelFolds.ts).
  scope.get(statBlockOpenedSlot).setState({ tokenId });
  const how: PanelHow | undefined = options.from ? { from: options.from } : undefined;
  ui.openPanel("token", how);
  const { width, height } = options.layout ?? layoutSize(window, uiScale());
  const safeLeft = scope.get(barDockSlot).getState().chrome?.safe.left ?? 0;
  // Room knows whether the Token sheet would open over the whole screen, from the bars, the band and the safe areas (components/sheetCap.ts sheetMode).
  const veryShort = scope.get(dockSlot).getState().sheetFullMode;
  if (statBlockHidesBar({ width, height, safeLeft, veryShort })) ui.showActions(false);
}

/**
 * Room's part: a new selection drops a stat block override and a pending
 * request that name another token, so neither opens a block later.
 */
export function useClearStatBlockOnSelect(): void {
  const opened = useScoped(statBlockOpenedSlot);
  const request = useScoped(statBlockRequest);
  const selectedId = useRoomView((s) => s.local.selectedId);
  useEffect(() => {
    const next = overrideAfterSelect(opened.getState(), selectedId);
    if (next !== opened.getState()) opened.setState(next);
    const pending = request.getState().tokenId;
    if (pending !== null && pending !== selectedId) request.setState({ tokenId: null });
  }, [opened, request, selectedId]);
}
