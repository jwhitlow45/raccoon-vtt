import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";

/** The height of a phone's turn band under the top bar (design 14.4, InitiativeStrip.tsx). */
export const TURN_BAND_PX = 48;

/**
 * Below this layout height a phone in landscape keeps the turn strip in
 * its top bar when the bar has room for it: a band of its own would take
 * 48 of about 390 px while the bar's row stood mostly empty
 * (docs/design-v1-visual.md F22).
 */
export const SHORT_LANDSCAPE_MAX = 500;

/** Where the turn strip goes: in the top bar's row, or a band of its own under it. */
export type TurnPlacement = "bar" | "band";

/**
 * Where the turn strip goes (docs/design-v1-visual.md 3.2), in the
 * chrome's own pixels (features/device/layout.ts layoutSize), so the
 * interface size moves it as it moves everything else.
 *
 * - From 900 px wide the strip sits in the top bar, as it always has.
 * - A short landscape phone (wider than tall, under 500 px tall) puts it
 *   in the bar too, unless the bar's row overflowed at this width before.
 *   `overflowedAt` is that record (overflowRecord): the width that
 *   overflowed plus the overflow. The strip stays in the band until the
 *   layout is wider than that, so it never flips back and forth between a
 *   bar that overflows and a band.
 * - Anything else, a portrait phone above all, takes the band.
 *
 * No fixed threshold decides it, since what the bar holds varies: a long
 * room name gives way, but a player's own turn adds "Your turn" and End
 * turn, and the DM's bar has Undo and Redo.
 */
export function turnPlacement(input: { width: number; height: number; overflowedAt: number | null }): TurnPlacement {
  if (input.width >= theme.layout.wideMinWidth) return "bar";
  const shortLandscape = input.width > input.height && input.height < SHORT_LANDSCAPE_MAX;
  if (!shortLandscape) return "band";
  return input.overflowedAt === null || input.width > input.overflowedAt ? "bar" : "band";
}

/**
 * The record kept once the bar's row overflowed by `overflow` px at layout
 * width `width`: the width at which the same content would fit. A record
 * never shrinks, so a bar that overflowed at a wider width than before
 * keeps the larger need.
 */
export function overflowRecord(before: number | null, width: number, overflow: number): number {
  const need = width + overflow;
  return before === null ? need : Math.max(before, need);
}

/**
 * The record per Room page (state/scope.ts): "view as a player" draws a
 * second top bar with other contents, which must not move the DM's strip.
 */
const turnSlot = scopeSlot(() => createStore<{ overflowedAt: number | null }>(() => ({ overflowedAt: null })));

/** Where this Room's turn strip goes now. */
export function useTurnPlacement(): TurnPlacement {
  const { width, height } = useLayoutSize();
  const overflowedAt = useStore(useScoped(turnSlot), (s) => s.overflowedAt);
  return turnPlacement({ width, height, overflowedAt });
}

/** Records that the top bar's row overflowed by `overflow` px at layout width `width` (pages/Room.tsx TopBar measures it). */
export function useRecordOverflow(): (width: number, overflow: number) => void {
  const store = useScoped(turnSlot);
  return useCallback(
    (width: number, overflow: number) => {
      const before = store.getState().overflowedAt;
      const next = overflowRecord(before, width, overflow);
      if (next !== before) store.setState({ overflowedAt: next });
    },
    [store],
  );
}

/**
 * How far down from the safe area the bars over the top of the map reach:
 * the top bar, and the turn band under it during a fight when the strip
 * takes the band (turnPlacement). Anything placed over the map keeps clear
 * of it: sheets, notices, the token bar and the DM's roll desk. The layout
 * follows the window, not the map, which a docked side panel narrows, in
 * the chrome's own pixels (features/device/layout.ts), as the bars it
 * measures are.
 */
export function useTopBars(): number {
  const placement = useTurnPlacement();
  const fight = useRoomView((s) => !!s.view?.encounter);
  return theme.layout.topBar + (placement === "band" && fight ? TURN_BAND_PX : 0);
}
