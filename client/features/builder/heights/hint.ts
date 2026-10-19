import type { AutoWalls } from "#shared/model.ts";
import type { HeightState } from "./store.ts";

/** What a gesture does in Height mode, for the bar's hint. Stairs say how the scene's automatic walls treat them (section 4.2). */
export function heightHint(s: Pick<HeightState, "paint" | "shape" | "stairs" | "height">, autoWalls: AutoWalls | undefined): string {
  const how = s.shape === "area" ? "Drag from corner to corner" : "Drag";
  if (s.paint === "height") {
    if (s.height === 0) return `${how} to clear heights back to the ground.`;
    return `${how} to paint the height. Tokens standing there rise or sink with it.`;
  }
  if (s.stairs === "remove") return `${how} to remove stair marks. Stairs terrain stays a stair.`;
  const walls = (autoWalls ?? "all") === "all" ? " Here they get walls toward unpainted squares." : autoWalls === "floor" ? " Over the map image they get no walls." : "";
  const point = s.stairs === "a" ? " Auto points them uphill. Use an arrow where a ? shows." : "";
  return `${how} to mark stairs.${point}${walls}`;
}

/** What a gesture does in Difficult ground mode (docs/design-v1-movement.md 3.4). */
export function roughHint(s: Pick<HeightState, "shape" | "rough">): string {
  const how = s.shape === "area" ? "Drag from corner to corner" : "Drag";
  if (s.rough === "clear") return `${how} to clear difficult ground.`;
  return "Difficult ground costs double to walk through. It paints over the map without hiding it.";
}
