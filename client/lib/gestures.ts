import { MIN_SCALE, panBy, pinchCamera, type Camera, type Point } from "./camera.ts";

/**
 * Pointer gestures on the map (design section 14.3), as plain state machines
 * with no DOM, so they can be unit tested. The canvas feeds them Pointer
 * Events and applies what they return.
 */

/** Movement that still counts as a tap, and that cancels a long-press. */
export const TAP_SLOP_PX = 8;
export const LONG_PRESS_MS = 500;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * - `pan`: one pointer that went down on empty map. It drags the camera.
 * - `tool`: one pointer that went down on something (a token). Konva owns it.
 * - `pinch`: two pointers. They pan and zoom together.
 * - `ignored`: three or more pointers. Nothing moves until some lift.
 */
export type GestureMode = "idle" | "pan" | "tool" | "pinch" | "ignored";

type Baseline =
  | { kind: "none" }
  | { kind: "pan"; cam: Camera; start: Point }
  | { kind: "pinch"; cam: Camera; mid: Point; dist: number };

export class CameraGesture {
  readonly pointers = new Map<number, Point>();
  mode: GestureMode = "idle";
  /** How far a pinch may zoom out: the scene's own floor (camera.ts sceneMinScale). */
  minScale = MIN_SCALE;
  private base: Baseline = { kind: "none" };
  /** Whether the gesture so far can still be a tap: one pointer, never past the slop. */
  private tapCandidate = false;
  /** Whether the press was held until the select tool's hold-to-ping fired (`hold`). */
  private held = false;
  private downAt: Point = { x: 0, y: 0 };

  /**
   * A pointer went down. `onEmpty` says whether it hit empty map rather than
   * a token. Returns the new mode. A return of `pinch` means a second finger
   * just landed, and the caller must stop any token drag in progress.
   */
  down(id: number, p: Point, cam: Camera, onEmpty: boolean): GestureMode {
    this.pointers.set(id, p);
    if (this.pointers.size === 1) {
      this.mode = onEmpty ? "pan" : "tool";
      this.base = { kind: "pan", cam, start: p };
      this.tapCandidate = true;
      this.held = false;
      this.downAt = p;
    } else {
      this.tapCandidate = false;
      this.rebaseline(cam);
    }
    return this.mode;
  }

  /** A pointer moved. Returns the camera to show, or null when this gesture does not move it. */
  move(id: number, p: Point): Camera | null {
    if (!this.pointers.has(id)) return null;
    this.pointers.set(id, p);
    if (this.tapCandidate && distance(p, this.downAt) > TAP_SLOP_PX) this.tapCandidate = false;
    if (this.mode === "pan" && this.base.kind === "pan") {
      return panBy(this.base.cam, p.x - this.base.start.x, p.y - this.base.start.y);
    }
    if (this.mode === "pinch" && this.base.kind === "pinch") {
      const [a, b] = [...this.pointers.values()];
      return pinchCamera(this.base, { mid: midpoint(a!, b!), dist: distance(a!, b!) }, this.minScale);
    }
    return null;
  }

  /**
   * The select tool's hold-to-ping fired for this pointer
   * (features/pings/hold.ts), so its press is a hold: on its lift the
   * canvas neither lets go of the selection, hides the token bar nor opens
   * a label, door or height readout, since a hold that pings should do
   * nothing but ping (docs/design-v1-bar-dock.md section 3). "Held" means
   * the ping fired, not that 500 ms passed: a busy phone can fire the
   * ping's timer late, and a press lifted before it pinged nothing and
   * stays a tap.
   */
  hold(id: number): void {
    if (this.pointers.size === 1 && this.pointers.has(id) && this.tapCandidate) this.held = true;
  }

  /**
   * A pointer lifted or was cancelled. `cam` is the camera now on screen, so
   * the pointers that remain continue from it without a jump. Returns whether
   * the whole gesture was a tap on empty map, and whether a still press of
   * one finger was held until it pinged, wherever it went down: Select
   * several's box tap reads it too (Stage.tsx).
   */
  up(id: number, cam: Camera): { tapOnEmpty: boolean; held: boolean } {
    if (!this.pointers.delete(id)) return { tapOnEmpty: false, held: false };
    if (this.pointers.size === 0) {
      const tapOnEmpty = this.tapCandidate && this.mode === "pan";
      const held = this.tapCandidate && this.held;
      this.mode = "idle";
      this.base = { kind: "none" };
      this.tapCandidate = false;
      this.held = false;
      return { tapOnEmpty, held };
    }
    // Going from two fingers to one: the remaining finger keeps panning
    // from where it is. A finger left over from a token press only pans
    // after a pinch, since its drag was already stopped.
    this.rebaseline(cam);
    return { tapOnEmpty: false, held: false };
  }

  private rebaseline(cam: Camera): void {
    const points = [...this.pointers.values()];
    if (points.length === 1) {
      this.mode = "pan";
      this.base = { kind: "pan", cam, start: points[0]! };
    } else if (points.length === 2) {
      this.mode = "pinch";
      this.base = { kind: "pinch", cam, mid: midpoint(points[0]!, points[1]!), dist: distance(points[0]!, points[1]!) };
    } else {
      this.mode = "ignored";
      this.base = { kind: "none" };
    }
  }
}

type TimerApi = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/**
 * Long-press is only a shortcut (iOS Safari never fires `contextmenu`), so
 * nothing may depend on it. It fires after 500 ms unless the pointer moves
 * more than 8 px, a second pointer lands, or the press ends first.
 */
export class LongPress {
  private handle: unknown = null;
  private origin: Point = { x: 0, y: 0 };
  private readonly timers: TimerApi;
  private readonly delayMs: number;

  constructor(options: { timers?: TimerApi; delayMs?: number } = {}) {
    this.timers = options.timers ?? realTimers;
    this.delayMs = options.delayMs ?? LONG_PRESS_MS;
  }

  start(p: Point, onFire: () => void): void {
    this.cancel();
    this.origin = p;
    this.handle = this.timers.set(() => {
      this.handle = null;
      onFire();
    }, this.delayMs);
  }

  move(p: Point): void {
    if (this.handle !== null && distance(p, this.origin) > TAP_SLOP_PX) this.cancel();
  }

  cancel(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  get pending(): boolean {
    return this.handle !== null;
  }
}
