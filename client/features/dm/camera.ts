import type { EphEvent } from "#shared/protocol.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/**
 * Where the DM is looking, for "Follow me" and "Bring everyone here"
 * (features section 13). The camera is the map canvas's own state, so the
 * canvas layer in CameraLayer.tsx publishes it here and the DM panel reads
 * it when the DM taps. Not room state: it changes on every pan frame,
 * belongs to this device alone, and nothing renders from it. It is kept per
 * Room page (client/state/scope.ts), so closing "view as a player" never
 * clears the DM's own.
 */

export type Focus = { sceneId: string; x: number; y: number; zoom: number };

const focusSlot = scopeSlot(() => ({ current: null as Focus | null, listeners: new Set<() => void>() }));

export function publishFocus(scope: RoomScope, next: Focus | null): void {
  const f = scope.get(focusSlot);
  f.current = next;
  for (const listener of f.listeners) listener();
}

export function currentFocus(scope: RoomScope): Focus | null {
  return scope.get(focusSlot).current;
}

export function subscribeFocus(scope: RoomScope, listener: () => void): () => void {
  const listeners = scope.get(focusSlot).listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The world point at the middle of the canvas and its zoom (screen pixels
 * per cell), the form a focus event carries. A receiving canvas centers that
 * point at the same zoom, whatever its own size.
 */
export function focusFromStage(stage: { x: number; y: number; scale: number; width: number; height: number }): { x: number; y: number; zoom: number } {
  const scale = stage.scale > 0 ? stage.scale : 1;
  return { x: (stage.width / 2 - stage.x) / scale, y: (stage.height / 2 - stage.y) / scale, zoom: scale };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The event, inside the protocol's bounds (shared/protocol.ts): a camera can
 * zoom to 400 px per cell, but a focus event carries at most 100, and the
 * server drops a message that breaks its schema.
 */
export function focusEvent(f: Pick<Focus, "x" | "y" | "zoom">): Extract<EphEvent, { k: "focus" }> {
  return { k: "focus", x: clamp(f.x, -1_000, 1_000), y: clamp(f.y, -1_000, 1_000), zoom: clamp(f.zoom, 0.01, 100) };
}
