import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { PillProps } from "../features/measure/Pill.tsx";
import type { Box } from "../lib/boardText.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";

/**
 * The part of the scene in view, in cells, so a pill near the screen's edge
 * can slide back into it (Pill.tsx). Null until the canvas has a size.
 */
export const BoardViewContext = createContext<Box | null>(null);

export function useBoardView(): Box | null {
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
