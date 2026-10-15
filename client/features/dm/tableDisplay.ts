import { useSyncExternalStore } from "react";
import type { EphEvent } from "#shared/protocol.ts";

/**
 * The DM's side of table displays (docs/design-v1-dm-tools.md 3.1): the
 * "Show my view on the table display" switch, which belongs to one DM
 * device in one room and is kept on it, and the camera it sends.
 */

const key = (roomId: string) => `rvtt.showView.${roomId}`;
const listeners = new Set<() => void>();
const cache = new Map<string, boolean>();

function read(roomId: string): boolean {
  const known = cache.get(roomId);
  if (known !== undefined) return known;
  let on = false;
  try {
    on = localStorage.getItem(key(roomId)) === "on";
  } catch {
    // Storage blocked: off until switched on here.
  }
  cache.set(roomId, on);
  return on;
}

export function setShowView(roomId: string, on: boolean): void {
  cache.set(roomId, on);
  try {
    localStorage.setItem(key(roomId), on ? "on" : "off");
  } catch {
    // The switch lasts until the page closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShowView(roomId: string): boolean {
  return useSyncExternalStore(subscribe, () => read(roomId));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The `view` event for a canvas: the center of its map area and its width
 * and height, in cells, inside the protocol's bounds (shared/protocol.ts), so
 * the server never drops it for its schema.
 */
export function viewEvent(stage: { x: number; y: number; scale: number; width: number; height: number }): Extract<EphEvent, { k: "view" }> {
  const scale = stage.scale > 0 ? stage.scale : 1;
  return {
    k: "view",
    x: clamp((stage.width / 2 - stage.x) / scale, -1_000, 1_000),
    y: clamp((stage.height / 2 - stage.y) / scale, -1_000, 1_000),
    w: clamp(stage.width / scale, 0.01, 2_000),
    h: clamp(stage.height / scale, 0.01, 2_000),
  };
}

/**
 * Whether this DM device sends its camera now: the switch is on and it views
 * the players' scene, so a TV never moves to a scene players cannot see.
 * Never during a pause, when a display shows the pause screen and gets no
 * events. A display clears what it holds of the scene when the pause ends,
 * so the end of a pause counts as this device coming to the players' scene,
 * and the camera goes out once more though it has not moved.
 */
export function sendsView(input: { dm: boolean; on: boolean; sceneId: string; playerSceneId: string | null; blackout: boolean }): boolean {
  return input.dm && input.on && input.sceneId === input.playerSceneId && !input.blackout;
}

/** "1 display connected" from the server's count of open display sockets. */
export function displaysText(n: number): string {
  if (n <= 0) return "No table display is connected.";
  return n === 1 ? "1 table display connected." : `${n} table displays connected.`;
}
