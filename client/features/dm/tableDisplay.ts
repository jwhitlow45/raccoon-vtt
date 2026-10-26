import { useSyncExternalStore } from "react";
import type { EphEvent } from "#shared/protocol.ts";
import { screenToView } from "../../lib/camera.ts";
import { groundAtMiddle, toWorld, type Live } from "../../lib/view.ts";

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
 * The `view` event for a canvas: the ground at the middle of its map area
 * (lib/view.ts groundAtMiddle) and its width and height, in cells, inside
 * the protocol's bounds (shared/protocol.ts), so the server never drops it
 * for its schema.
 *
 * An Isometric DM's (docs/design-v1-isometric-view.md ISO-D17) keeps x, y,
 * w and h as the box of its canvas's corners on the ground at 0, and adds
 * its turn and its canvas's size in view units, centered on its middle at
 * 0. Every number is the DM's camera alone: no height is read, so hidden
 * terrain changes nothing it sends.
 */
export function viewEvent(live: Live): Extract<EphEvent, { k: "view" }> {
  const scale = live.camera.scale > 0 ? live.camera.scale : 1;
  const camera = { ...live.camera, scale };
  const middle = groundAtMiddle({ ...live, camera });
  const { width, height } = live.viewport;
  const at = { k: "view" as const, x: clamp(middle.x, -1_000, 1_000), y: clamp(middle.y, -1_000, 1_000) };
  if (live.view.kind === "topDown") return { ...at, w: clamp(width / scale, 0.01, 2_000), h: clamp(height / scale, 0.01, 2_000) };
  const view = live.view;
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ].map((p) => toWorld(view, screenToView(camera, p)));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    ...at,
    w: clamp(Math.max(...xs) - Math.min(...xs), 0.01, 2_000),
    h: clamp(Math.max(...ys) - Math.min(...ys), 0.01, 2_000),
    iso: { turn: view.turn, vw: clamp(width / scale, 0.01, 2_000), vh: clamp(height / scale, 0.01, 2_000) },
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
