import { useEffect, useMemo, useState } from "react";
import { SLICE_MS } from "../movement/routeDrag.ts";
import { measureWalk, type WalkInput, type WalkMeasure } from "./walkRuler.ts";

/**
 * A walking ruler's walk, searched a time slice a frame as a drag's route
 * is (docs/design-v1-movement.md 5.2), so a stop with no way through on a
 * large map never holds the page. While it searches the walk comes back
 * `searching`, and the next frame asks again. `null` input measures nothing.
 */
export function useWalkMeasure(input: WalkInput | null): WalkMeasure | null {
  const [frame, setFrame] = useState(0);
  const m = useMemo(
    () => (input ? measureWalk({ ...input, deadline: performance.now() + SLICE_MS }) : null),
    // `frame` asks again where the last slice stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input?.view, input?.sceneId, input?.stops, input?.viewer.role, input?.everything, frame],
  );
  useEffect(() => {
    if (!m?.searching) return;
    const handle = requestAnimationFrame(() => setFrame((n) => n + 1));
    return () => cancelAnimationFrame(handle);
  }, [m]);
  return m;
}
