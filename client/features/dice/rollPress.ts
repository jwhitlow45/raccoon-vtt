import { LongPress, TAP_SLOP_PX } from "../../lib/gestures.ts";

export const HOLD_HINT_MS = 200;
export type RollPressClock = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
const CLOCK: RollPressClock = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
export type RollPressPoint = { id: number; x: number; y: number };

/** DOM-free ownership of one roll control's press, including its later synthetic click. */
export class RollPress {
  private readonly hold: LongPress;
  private readonly clock: RollPressClock;
  private hintTimer: unknown = null;
  private point: RollPressPoint | null = null;
  private eligible = false;
  private blockedClick = false;
  private touch = false;
  private disposed = false;
  consumed = false;
  hint = false;
  private readonly env: { open(): boolean; show(by: "pointer" | "key"): void; close(): void; hint(on: boolean): void; releaseTouch?(): void; clock?: RollPressClock };
  constructor(env: RollPress["env"]) {
    this.env = env;
    this.clock = env.clock ?? CLOCK;
    this.hold = new LongPress({ timers: this.clock });
  }
  get pending(): boolean { return this.hold.pending || this.hintTimer !== null; }
  get activeId(): number | null { return this.point?.id ?? null; }
  get touchSequence(): boolean { return this.touch; }
  private clear(): void {
    this.hold.cancel();
    if (this.hintTimer !== null) this.clock.clear(this.hintTimer);
    this.hintTimer = null;
    this.hint = false;
    this.env.hint(false);
  }
  down(point: RollPressPoint, pointer: string, primary = true, button = 0): void {
    if (this.disposed || button !== 0) return;
    if (this.point !== null || !primary) { this.cancel(); return; }
    this.clear();
    this.point = point;
    this.touch = pointer === "touch";
    this.consumed = false;
    this.blockedClick = false;
    if (this.env.open()) {
      this.env.close();
      this.blockedClick = true;
      this.eligible = false;
      return;
    }
    this.eligible = this.touch;
    if (!this.eligible) return;
    this.hintTimer = this.clock.set(() => { this.hintTimer = null; this.hint = true; this.env.hint(true); }, HOLD_HINT_MS);
    this.hold.start(point, () => this.fire("pointer"));
  }
  private fire(by: "pointer" | "key"): void {
    this.clear();
    this.eligible = false;
    this.consumed = true;
    this.blockedClick = true;
    this.env.show(by);
  }
  move(point: RollPressPoint): void {
    if (this.point?.id !== point.id || this.consumed) return;
    if (Math.hypot(point.x - this.point.x, point.y - this.point.y) > TAP_SLOP_PX) this.cancel();
  }
  up(id: number): void {
    if (this.point?.id !== id) return;
    this.clear();
    this.point = null;
    this.eligible = false;
    this.consumed = false;
    this.env.releaseTouch?.();
  }
  cancel(): void {
    if (this.point || this.pending) this.blockedClick = true;
    this.clear();
    this.eligible = false;
    this.point = null;
    this.consumed = false;
    this.env.releaseTouch?.();
  }
  context(by: "mouse" | "touch" | "key"): void {
    if (this.disposed) return;
    if (by === "touch") {
      if (this.touch && this.point && this.eligible) this.fire("pointer");
      return;
    }
    this.clear();
    this.eligible = false;
    this.blockedClick = by !== "key";
    if (this.env.open()) this.env.close();
    else this.env.show(by === "key" ? "key" : "pointer");
  }
  /** Clear only the previous press. A new press elsewhere may scroll or select a menu item. */
  fresh(): void { this.cancel(); this.blockedClick = false; this.touch = false; }
  key(): void { this.fresh(); }
  /** False consumes this click before either the source or a menu row can act. */
  click(detail: number, source = true): boolean {
    if (this.disposed) return false;
    if (detail === 0) this.key();
    if (detail !== 0 && this.blockedClick) { this.blockedClick = false; return false; }
    if (source && this.env.open()) { this.env.close(); return false; }
    return true;
  }
  dispose(): void { this.cancel(); this.disposed = true; }
}

/**
 * Attach at pointerdown, before the browser fixes touch cancelability.
 * Inert until the hold fires. The first touchstart identifies this finger.
 */
export function attachConsumedTouch(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, consumed: () => boolean, initialId: number | null = null): () => void {
  let id: number | null = initialId;
  const start = (event: Event) => {
    const e = event as TouchEvent;
    if (id === null && e.changedTouches.length === 1) id = e.changedTouches[0]!.identifier;
  };
  const move = (event: Event) => {
    const e = event as TouchEvent;
    if (consumed() && id !== null && Array.from(e.changedTouches).some((t) => t.identifier === id) && e.cancelable) e.preventDefault();
  };
  target.addEventListener("touchstart", start, { capture: true, passive: true });
  target.addEventListener("touchmove", move, { capture: true, passive: false });
  return () => {
    target.removeEventListener("touchstart", start, true);
    target.removeEventListener("touchmove", move, true);
  };
}
