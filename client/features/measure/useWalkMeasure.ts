import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { WorkBudget } from "#shared/rules/walk.ts";
import { BOARD_WORK } from "../movement/boardWork.ts";
import { measureWalk, nextHeld, walkJob, type HeldWalk, type WalkInput, type WalkMeasure } from "./walkRuler.ts";

/**
 * A walking ruler's walk, worked through the board's route work
 * (routeWork.ts) as a drag's route is (docs/design-v1-movement.md 5.2), so
 * a stop with no way through on a large map never holds the page, and all
 * the rulers on the board share one budget a frame, each in turn. A render
 * reads what is known. The ruler being drawn, `live`, also works on what is
 * left of the frame's budget as it renders, as a drag works on the finger's
 * spot at once, so its walk follows the pointer. Any other ruler's work
 * waits its turn, so no ruler drawn first takes every frame. While the
 * walk is still searching it comes back `searching`, and renders again
 * when a turn finds more. `null` input measures nothing.
 */
export function useWalkMeasure(input: WalkInput | null, live = false): WalkMeasure | null {
  const [found, more] = useReducer((n: number) => n + 1, 0);
  const m = useMemo(
    () => (input ? (live ? BOARD_WORK.within((budget) => measureWalk({ ...input, budget })) : measureWalk({ ...input, budget: WorkBudget.none() })) : null),
    // `found` reads again what a frame's turn found.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input?.view, input?.sceneId, input?.stops, input?.viewer.role, input?.everything, live, found],
  );
  const searching = m?.searching === true;
  useLayoutEffect(() => {
    if (!input || !searching) return;
    const job = walkJob(input, more);
    BOARD_WORK.add(job);
    return () => BOARD_WORK.drop(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input?.view, input?.sceneId, input?.stops, input?.viewer.role, input?.everything, searching]);
  return m;
}

/**
 * The last walk `ruler` (walkRuler.ts heldKey) finished, kept while a
 * later walk of it searches (walkRuler.ts nextHeld, walkShown). `m` is what
 * this render measured, null when it measured nothing, which lets the held
 * walk go.
 */
export function useHeldWalk(m: WalkMeasure | null, ruler: string): WalkMeasure | null {
  const held = useRef<HeldWalk>(null);
  // Read and written in the render on purpose: it follows `m` and never asks for a render of its own.
  held.current = nextHeld(held.current, m, ruler);
  return held.current?.walk ?? null;
}
