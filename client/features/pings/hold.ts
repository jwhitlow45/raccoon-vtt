import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/**
 * The select tool's hold-to-ping (PingLayer.tsx) reports each press it
 * pinged, so what else answers that press's lift treats it as a hold and
 * opens nothing: the canvas's tap on empty map (a label, a door, the height
 * readout, Stage.tsx through lib/gestures.ts `hold`) and a pin's tap
 * (PinLayer.tsx). Held means the ping fired rather than that 500 ms passed,
 * so a press the ping's timer was late for, on a busy phone, still acts as
 * the tap it was (docs/design-v1-heights-readout.md section 2).
 */

type Listener = (pointerId: number) => void;

const holdSlot = scopeSlot(() => new Set<Listener>());

/** Hears each press the hold-to-ping fires for. Returns the way to stop. */
export function onHoldPing(scope: RoomScope, listener: Listener): () => void {
  const listeners = scope.get(holdSlot);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function reportHoldPing(scope: RoomScope, pointerId: number): void {
  for (const listener of scope.get(holdSlot)) listener(pointerId);
}
