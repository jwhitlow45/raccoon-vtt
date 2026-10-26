import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { PillProps } from "../features/measure/Pill.tsx";
import type { Box } from "../lib/boardText.ts";
import { NO_INSETS, screenToView, type Camera, type Insets, type Size } from "../lib/camera.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";

/**
 * The board in view, in view space (lib/view.ts), two ways: `clear`, the
 * part the bars over the map leave (`insets`, in screen px), which a readout
 * near the screen's edge slides back into (Pill.tsx), and `canvas`, the
 * whole canvas, which what is drawn culls by, since the map shows beside a
 * bar's narrower parts such as the options line
 * (features/builder/heights/HeightLayer.tsx). In Top-down view space is the
 * world's cells. In Isometric it is the turned and squashed picture, so a
 * box here holds what stands upright there, never a stretch of ground.
 */
export type BoardViews = { clear: Box; canvas: Box };

/** The part of the board in `insets` of the canvas, in view space. */
export function boardViewOf(cam: Camera, size: Size, insets: Insets): Box {
  const a = screenToView(cam, { x: insets.left, y: insets.top });
  const b = screenToView(cam, { x: size.width - insets.right, y: size.height - insets.bottom });
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

export function boardViewsOf(cam: Camera, size: Size, insets: Insets): BoardViews {
  return { clear: boardViewOf(cam, size, insets), canvas: boardViewOf(cam, size, NO_INSETS) };
}

/** Null until the canvas has a size. */
export const BoardViewContext = createContext<BoardViews | null>(null);

export function useBoardView(): BoardViews | null {
  return useContext(BoardViewContext);
}

/**
 * Pills other layers draw over the tokens' ground (an area's name, the move
 * marker), by the layer that owns them. Token labels keep off them
 * (useBoardText.ts), and those layers place their pills from token bodies
 * alone, never from where labels went, so the two never chase each other.
 *
 * A layer publishes its pill as it draws it, minus the zoom: where it
 * points and what it says. The canvas works out its box at each zoom
 * itself, so a pinch never sends a fresh pill through the store, and the
 * board lays out once a frame.
 */
export type PillSpec = Omit<PillProps, "scale" | "color">;

export const boardPillsSlot = scopeSlot(() => createStore<{ pills: Readonly<Record<string, readonly PillSpec[]>> }>(() => ({ pills: {} })));

const NONE: readonly PillSpec[] = [];

/** Publishes `pills` under `key` while the component is mounted. */
export function usePublishPills(key: string, pills: readonly PillSpec[]): void {
  const store = useScoped(boardPillsSlot);
  useLayoutEffect(() => {
    const current = store.getState().pills[key] ?? NONE;
    if (JSON.stringify(current) === JSON.stringify(pills)) return;
    store.setState((s) => ({ pills: { ...s.pills, [key]: pills } }));
  }, [store, key, pills]);
  useLayoutEffect(
    () => () => {
      const { [key]: _gone, ...rest } = store.getState().pills;
      store.setState({ pills: rest });
    },
    [store, key],
  );
}

/** Every published pill. */
export function useBoardPills(): readonly PillSpec[] {
  const pills = useStore(useScoped(boardPillsSlot), (s) => s.pills);
  return useMemo(() => Object.values(pills).flat(), [pills]);
}

/** The pills published under keys that do not start with `prefix`. */
export function pillsExcept(pills: Readonly<Record<string, readonly PillSpec[]>>, prefix: string): PillSpec[] {
  return Object.entries(pills).flatMap(([key, list]) => (key.startsWith(prefix) ? [] : list));
}

/**
 * Every pill but those under keys starting with `prefix`, kept the same
 * array while they do not change, so a layer that reads them and publishes
 * its own does not lay out again on every publish of its own.
 */
export function useBoardPillsExcept(prefix: string): readonly PillSpec[] {
  const pills = useStore(useScoped(boardPillsSlot), (s) => s.pills);
  const kept = useMemo(() => pillsExcept(pills, prefix), [pills, prefix]);
  const key = JSON.stringify(kept);
  // Keyed on what the pills say, not on the store's object, which changes whenever any layer publishes.
  return useMemo(() => kept, [key]);
}
