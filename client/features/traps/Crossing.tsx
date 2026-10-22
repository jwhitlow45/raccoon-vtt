import { useMemo } from "react";
import type { Token, Trap } from "#shared/model.ts";
import type { Point } from "../../lib/camera.ts";
import { footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { Pill } from "../measure/Pill.tsx";
import { crossedTraps, crossesText, warnsOf } from "./rules.ts";

const NO_TRAPS: Readonly<Record<string, Trap>> = {};

/**
 * "Crosses Hidden Pit" under a drag's label (docs/design-v1-traps.md 4.5):
 * for a player the found traps not disarmed that the walk crosses, and for
 * the DM every armed one. Client only, from the traps this viewer holds.
 * `path` is the token's top-left corner along the walk, the start first.
 */
export function TrapCrossing(props: { token: Token; path: readonly Point[]; x: number; y: number; scale: number }) {
  const traps = useRoomView((s) => s.view?.traps ?? NO_TRAPS);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const { token, path } = props;
  const fp = footprint(token);
  const key = path.map((p) => `${p.x},${p.y}`).join(" ");
  const text = useMemo(() => {
    const live = Object.values(traps).filter((t) => t.sceneId === token.sceneId && warnsOf(t, role));
    return crossesText(crossedTraps(live, fp, path).map((t) => t.name));
    // The path is read by its points, which a drag's every frame rebuilds as a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traps, role, token.sceneId, fp.w, fp.h, key]);
  if (!text) return null;
  return <Pill x={props.x} y={props.y} scale={props.scale} value={text} size="screen" color={theme.color.warning} offsetPx={4} small />;
}
