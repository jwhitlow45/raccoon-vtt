import { useSyncExternalStore } from "react";
import type { BoardPick } from "../canvas/boardPick.ts";
import { cameraInZoomed } from "../features/device/layout.ts";
import type { Camera } from "../lib/camera.ts";
import { scopeSlot, useScoped } from "./scope.ts";

/**
 * The camera on screen, outside React (docs/design-v1-relief-pan.md 6.2).
 * In Isometric a pan inside the board's cull step moves the stages without
 * a React render, so the camera's one source of truth lives here: every
 * camera path writes it, `camRef` reads it, and the board's applier
 * positions both stages from it.
 *
 * It keeps two cameras. `camera` is the latest, written at once: gestures,
 * presses, the applier and the board's own Konva readers use it. `drawn`
 * is the camera the canvas last drew, which the board's frame scheduler
 * advances right after it draws: the chrome hung on map points renders
 * from it, so it moves in the canvas's own frame. One subscription serves both.
 */
export class LiveCamera {
  #camera: Camera | null = null;
  #drawn: Camera | null = null;
  readonly #listeners = new Set<() => void>();
  /**
   * The board's applier while an isometric board is shown: it moves both
   * stages to a camera and answers whether the view stays in the board's
   * rendered cull step ("inside"), crossed it with the old layout still
   * covering the strips ("step"), or left the layout ("out").
   */
  applier: ((camera: Camera) => CameraFit) | null = null;

  #appliedFrom: Camera | null = null;
  #applied: Camera | null = null;

  get camera(): Camera | null {
    return this.#camera;
  }

  /** Records the camera the stages took for `from`: its translation on the canvas's device grid. */
  setApplied(from: Camera, applied: Camera): void {
    this.#appliedFrom = from;
    this.#applied = applied;
  }

  /** The camera Konva draws with for `c`: the applied one when the board positioned its stages at `c`, else `c`. Presses read it, so a press and the drawing agree. */
  appliedFor(c: Camera): Camera {
    return c === this.#appliedFrom && this.#applied ? this.#applied : c;
  }

  get drawn(): Camera | null {
    return this.#drawn;
  }

  readonly getCamera = (): Camera | null => this.#camera;
  readonly getDrawn = (): Camera | null => this.#drawn;

  write(camera: Camera | null): void {
    if (same(camera, this.#camera)) return;
    this.#camera = camera;
    this.#notify();
  }

  /** The camera the canvas drew last: the board's scheduler after it draws, or null when no isometric board shows. */
  setDrawn(camera: Camera | null): void {
    if (same(camera, this.#drawn)) return;
    this.#drawn = camera;
    this.#notify();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #notify(): void {
    for (const l of [...this.#listeners]) l();
  }
}

export type CameraFit = "inside" | "step" | "out";

/**
 * A gesture's camera on its frame (Stage.tsx scheduleCam), written to the
 * slot at once. In Isometric a move at the same zoom goes to the board's
 * applier, which moves both stages: inside the rendered cull step nothing
 * renders, past it the board renders to lay out again, and a view that left
 * the layout renders at once, before the scheduler draws, so no strip lies
 * past what is laid out (docs/design-v1-relief-pan.md 5.6). A zoom, every
 * Top-down move, and the move a gesture ends on set state as before.
 * Says how MapStage's state follows: not at all, in its own time, or inside flushSync.
 */
export function showGestureCamera(live: LiveCamera, c: Camera, iso: boolean, ended: boolean): "none" | "later" | "now" {
  const was = live.camera;
  const applier = iso ? live.applier : null;
  live.write(c);
  if (!applier || !was || was.scale !== c.scale) return "later";
  const fit = applier(c);
  if (fit === "out") return "now";
  return fit === "step" || ended ? "later" : "none";
}

/** The camera a piece of chrome stands by: in Isometric the one the canvas last drew, once it has drawn one, else the rendered one. */
export function chromeCameraOf(chrome: Pick<ChromeCamera, "iso" | "rendered">, drawn: Camera | null): Camera {
  return chrome.iso && drawn ? drawn : chrome.rendered;
}

function same(a: Camera | null, b: Camera | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.scale === b.scale);
}

export const liveCameraSlot = scopeSlot(() => new LiveCamera());

/**
 * What the chrome over the map stands by (Stage.tsx): the camera the board
 * rendered with, whether an isometric board shows, the interface size, and
 * the board pick at a camera.
 */
export type ChromeCamera = { iso: boolean; rendered: Camera; zoom: number; pickOf: (camera: Camera) => BoardPick };

/** The camera a piece of chrome draws at, in the chrome's pixels (`camera`) and the canvas's (`raw`), with its pick. */
export type ChromeAt = { camera: Camera; raw: Camera; pick: BoardPick };

const NO_SUBSCRIBE = () => () => {};

/**
 * The camera for a piece of chrome hung on a map point. In Isometric it is
 * the camera the canvas last drew, read on every render, so the chrome
 * moves with the canvas whatever made it render. It subscribes only while
 * `shown`, so a mounted host showing nothing costs a pan nothing, and is
 * null then. In Top-down it is the camera the board rendered with, as before.
 */
export function useChromeCamera(chrome: ChromeCamera, shown: boolean): ChromeAt | null {
  const live = useScoped(liveCameraSlot);
  const drawn = useSyncExternalStore(shown && chrome.iso ? live.subscribe : NO_SUBSCRIBE, live.getDrawn, live.getDrawn);
  if (!shown) return null;
  const raw = chromeCameraOf(chrome, drawn);
  return { camera: cameraInZoomed(raw, chrome.zoom), raw, pick: chrome.pickOf(raw) };
}
