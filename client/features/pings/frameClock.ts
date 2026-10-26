import { useEffect } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useTreeShownStore } from "../../canvas/relief/context.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";

/**
 * The one frame clock pings and the laser animate by (design 14.2): the
 * store's time, Date.now(), written on each animation frame while a ping
 * or a laser trail is on screen, and idle otherwise. It runs in the board's
 * ping controller (PingController.ts), mounted once outside both drawing
 * trees (docs/design-v1-isometric-view.md 5.1), so a second tree adds no
 * second loop, and both trees' layers read it.
 */
export type FrameClock = StoreApi<{ now: number }>;

export const frameClockSlot = scopeSlot((): FrameClock => createStore(() => ({ now: Date.now() })));

/**
 * The clock's time while `running`, else the time of this render. A hidden
 * tree holds its last read, so the loop renders nothing there.
 */
export function useFrameNow(running: boolean): number {
  const now = useTreeShownStore(useScoped(frameClockSlot), (s) => s.now);
  return running ? now : Date.now();
}

/** Runs the clock while `running`: the controller's half. The first frame's time is written at once, so a ping that just arrived is aged from now, not from the clock's last stop. */
export function useRunFrameClock(clock: FrameClock, running: boolean): void {
  useEffect(() => {
    if (!running) return;
    clock.setState({ now: Date.now() });
    let frame = 0;
    const tick = () => {
      clock.setState({ now: Date.now() });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clock, running]);
}
