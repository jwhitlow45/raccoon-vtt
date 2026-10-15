import { createStore } from "zustand/vanilla";
import type { Scene } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * Whether the map draws the party's sight, and how
 * (docs/design-v1-maps-vision.md section 4.3.1):
 *
 * - `party`: a player on a scene with party vision sees the levels: bright
 *   clear, dim and darkvision's grey shaded, ground explored before dimmed.
 * - `veil`: the DM, with "Party sight" on, sees what the party cannot see
 *   veiled at 40%, and keeps a fully lit map otherwise.
 * - null: nothing is drawn. The DM's own view stays fully lit by default.
 */
export type SightMode = "party" | "veil";

/**
 * Whether a scene has party vision on. A `vision` the client cannot read
 * counts as on, so the overlay errs toward drawing: what players may not
 * see is already withheld by the server, and the overlay only shades.
 */
export function visionOn(scene: Pick<Scene, "vision">): boolean {
  const vision = scene.vision as { on?: unknown } | null | undefined;
  return vision !== undefined && vision !== null && vision.on !== false;
}

export function sightMode(input: { role: "dm" | "player"; visionOn: boolean; partySight: boolean }): SightMode | null {
  if (!input.visionOn) return null;
  if (input.role === "player") return "party";
  return input.partySight ? "veil" : null;
}

/**
 * The DM's "Party sight" switch, beside "View as a player". Per Room page
 * (client/state/scope.ts), so the player preview never reads it, and kept
 * only for this visit: it is a way of looking, not a setting of the room.
 */
export const partySightSlot = scopeSlot(() => createStore<{ on: boolean }>(() => ({ on: false })));

/**
 * The fog tool's hint on a scene with party vision (section 4.3.3): a
 * DM's undo puts back the DM's own fog layer, never the party's explored
 * one, so undoing a hide does not bring back what it cleared.
 */
export const EXPLORED_UNDO_HINT = "Undo brings back your fog, not what the party explored. Reveal it again by hand.";
