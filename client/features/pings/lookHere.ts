import type { EphEvent } from "#shared/protocol.ts";
import { focusEvent } from "../dm/camera.ts";

/**
 * The least zoom a "look here" asks for, so a DM zoomed far out still shows
 * players a spot they can read on a phone. `focusEvent` caps the other end
 * at the protocol's limit.
 */
const FOCUS_MIN = 24;

/** The focus event a DM's "look here" tap sends: the tapped point at the DM's own zoom, within those bounds. */
export function lookHereEvent(world: { x: number; y: number }, scale: number): Extract<EphEvent, { k: "focus" }> {
  return focusEvent({ x: world.x, y: world.y, zoom: Math.max(FOCUS_MIN, scale) });
}
