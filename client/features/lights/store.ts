import { createStore } from "zustand/vanilla";
import type { Point } from "../../lib/camera.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * The builder's Light mode on this Room page (client/state/scope.ts): the
 * preset a tap places, whether the selected light's pane is open, and the
 * gesture in progress. Which light is selected, and where it is being
 * dragged to, live in the builder's own light slot (builder/lightTap.ts),
 * which draws its rings.
 */
export type LightModeState = {
  /** The name of the preset a tap places (vision/presets.ts PLACED_LIGHTS). */
  preset: string;
  /** The selected light's pane is open. A tap on a light opens it, placing one does not. */
  paneOpen: boolean;
};

export type LightGesture =
  /** A press on a light: a tap opens its pane, a drag moves it. `grab` is where on the light the finger is. */
  | { kind: "light"; id: string; sceneId: string; grab: Point; downAt: Point }
  /** A press on empty map: a tap places a light. */
  | { kind: "place"; sceneId: string; downAt: Point };

export const lightModeSlot = scopeSlot(() => ({
  store: createStore<LightModeState>(() => ({ preset: "Torch", paneOpen: false })),
  gesture: null as LightGesture | null,
}));
