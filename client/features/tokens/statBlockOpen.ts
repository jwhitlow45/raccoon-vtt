import { createStore } from "zustand/vanilla";
import { BESIDE_MIN, EDGE, barDockSlot } from "../../canvas/barDock.ts";
import type { Size } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { foldsUnderSheet } from "../../pages/fold.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";

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
  if (input.veryShort || foldsUnderSheet({ width, height, sheetOpen: true })) return true;
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
 */
export function openStatBlock(scope: RoomScope, ui: Pick<RoomUi, "select" | "showActions" | "openPanel">, tokenId: string, layout: Size = layoutSize(window, uiScale())): void {
  ui.select(tokenId);
  requestStatBlock(scope, tokenId);
  ui.openPanel("token");
  const { width, height } = layout;
  const safeLeft = scope.get(barDockSlot).getState().chrome?.safe.left ?? 0;
  if (statBlockHidesBar({ width, height, safeLeft })) ui.showActions(false);
}
