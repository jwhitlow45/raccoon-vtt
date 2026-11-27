import type Konva from "konva";
import { useEffect, useRef } from "react";
import { popoverSlot } from "../../components/popoverRules.ts";
import { boardPickOf, pressAt } from "../../canvas/boardPick.ts";
import { cameraOfStage } from "../../lib/camera.ts";
import { LONG_PRESS_MS, TAP_SLOP_PX } from "../../lib/gestures.ts";
import type { Ping } from "../../state/types.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useLowPower } from "../device/settings.ts";
import type { ControllerProps } from "../layers.ts";
import { useModule } from "../modules/Gate.tsx";
import { playPing, unlockAudioOnGesture, vibrate } from "./feedback.ts";
import { frameClockSlot, useRunFrameClock } from "./frameClock.ts";
import { reportHoldPing } from "./hold.ts";

/**
 * Everything pings and the laser do besides drawing (PingLayer.tsx,
 * LaserLayer.tsx), as one of the board's controllers (features/layers.ts
 * CONTROLLERS), mounted once outside both drawing trees, so each ping
 * plays its tone and buzzes once, and one frame clock runs, whichever view
 * shows (docs/design/design-v1-isometric-view.md 5.1):
 *
 * - The frame clock (frameClock.ts) runs while a ping or a laser trail is on
 *   screen, outside low power (docs/design/design-v1-dm-tools.md 3.15).
 * - Each new ping plays a tone, and someone else's buzzes an Android phone.
 *   A DM's "look here" buzzes too: the store has already moved the camera.
 * - The select tool's tap-and-hold ping: a press held still for 500 ms on
 *   empty map pings it, at the ground the press means (canvas/boardPick.ts,
 *   in Isometric the first drawn ground its ray meets, design 6.2). A token
 *   under the finger keeps its own long-press (it selects the token), and
 *   any movement past the tap slop is a pan, so the hold never fights the
 *   select tool. Each press it pings is reported (hold.ts), so its lift
 *   opens no label, door, readout or pin. Ping and laser hidden on this
 *   device turns the hold off, and pings from others still draw and sound
 *   (docs/design/design-v1-features.md 8, D-261127-309).
 */
export function PingController(props: ControllerProps): null {
  const pings = useRoomView((s) => s.ephemeral.pings);
  const lasing = useRoomView((s) => Object.values(s.ephemeral.lasers).some((t) => t.points.length > 0));
  const focus = useRoomView((s) => s.ephemeral.focus);
  const tool = useRoomView((s) => s.local.tool);
  const actions = useRoomActions();
  const scope = useRoomScope();
  const lowPower = useLowPower();
  // Read on every render, whatever the tool: the controller stays mounted across tool changes, so a read inside the condition would change the hooks' order (D-261127-392).
  const pingShown = useModule("ping");
  useRunFrameClock(scope.get(frameClockSlot), !lowPower && (pings.length > 0 || lasing));
  useFeedback(pings, focus?.id ?? null);

  useHoldToPing(
    props.stage,
    tool === "select" && pingShown,
    // The board's own pick (design 6.2), the Stage's camera standing in until the board has measured itself.
    (stage, p) => pressAt(boardPickOf({ scope, camera: () => cameraOfStage(stage) }), p),
    (x, y, pointerId) => {
      actions.sendEph({ k: "ping", x, y });
      reportHoldPing(scope, pointerId);
    },
    () => scope.get(popoverSlot).suppressesTool(),
  );
  return null;
}

function useFeedback(pings: readonly Ping[], focusId: number | null): void {
  const heard = useRef<number>(pings.reduce((m, p) => Math.max(m, p.id), 0));
  useEffect(() => {
    let remote = false;
    let fresh = false;
    for (const p of pings) {
      if (p.id <= heard.current) continue;
      heard.current = p.id;
      fresh = true;
      if (!p.local) remote = true;
    }
    if (fresh) playPing();
    if (remote) vibrate(60);
  }, [pings]);

  const lastFocus = useRef(focusId);
  useEffect(() => {
    if (focusId === null || focusId === lastFocus.current) return;
    lastFocus.current = focusId;
    vibrate(120);
  }, [focusId]);

  useEffect(() => unlockAudioOnGesture(), []);
}

/** The page around a stage that a hold listens on, as a test stands in for it. */
export type HoldTargets = {
  /** The stage's container, which takes the press. */
  el: Pick<HTMLElement, "addEventListener" | "removeEventListener" | "getBoundingClientRect">;
  /** The window, which takes the move and the lift wherever they go. */
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Whether a token stands under a point of the stage, which keeps its own long-press. */
  onToken(p: { x: number; y: number }): boolean;
};

export type HoldParts = {
  /** Read at the press and again as the hold's time is up: a hold that a tool change or Ping hidden ended in between sends nothing (D-261127-309). */
  enabled(): boolean;
  /** The map point a stage point means. */
  at(p: { x: number; y: number }): { x: number; y: number };
  ping(x: number, y: number, pointerId: number): void;
  closing(): boolean;
  setTimer(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
};

/**
 * The hold's listeners on one stage, apart from React so a test drives
 * them. `cancel` drops a hold under way, as turning the hold off does, and
 * `stop` takes the listeners away.
 */
export function listenHoldToPing(targets: HoldTargets, parts: HoldParts): { cancel(): void; stop(): void } {
  const { el, win } = targets;
  const pointers = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  const clear = () => {
    if (timer) parts.clearTimer(timer);
    timer = null;
    start = null;
  };
  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: PointerEvent) => {
    pointers.add(e.pointerId);
    clear();
    if (!parts.enabled() || pointers.size !== 1 || (e.pointerType === "mouse" && e.button !== 0) || parts.closing()) return;
    const p = local(e);
    if (targets.onToken(p)) return;
    start = p;
    const pointerId = e.pointerId;
    timer = parts.setTimer(() => {
      timer = null;
      start = null;
      if (!parts.enabled()) return;
      const point = parts.at(p);
      parts.ping(point.x, point.y, pointerId);
    }, LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => {
    if (!timer || !start) return;
    const p = local(e);
    if (Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP_PX) clear();
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    clear();
  };
  el.addEventListener("pointerdown", down as EventListener);
  win.addEventListener("pointermove", move as EventListener);
  win.addEventListener("pointerup", up as EventListener);
  win.addEventListener("pointercancel", up as EventListener);
  return {
    cancel: clear,
    stop() {
      clear();
      el.removeEventListener("pointerdown", down as EventListener);
      win.removeEventListener("pointermove", move as EventListener);
      win.removeEventListener("pointerup", up as EventListener);
      win.removeEventListener("pointercancel", up as EventListener);
    },
  };
}

/**
 * The hold on the stage on screen. `at` turns the press's point on the
 * stage into the map point it means. `closing` says a press is one that
 * closes a popover or a menu (components/popoverRules.ts), which never
 * pings. Turned off, it drops a hold under way.
 */
function useHoldToPing(
  stage: Konva.Stage | null,
  enabled: boolean,
  at: (stage: Konva.Stage, p: { x: number; y: number }) => { x: number; y: number },
  ping: (x: number, y: number, pointerId: number) => void,
  closing: () => boolean,
): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const atRef = useRef(at);
  atRef.current = at;
  const pingRef = useRef(ping);
  pingRef.current = ping;
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const hold = useRef<{ cancel(): void } | null>(null);
  useEffect(() => {
    if (!stage) return;
    const listening = listenHoldToPing(
      { el: stage.container(), win: window, onToken: (p) => !!stage.getIntersection(p)?.findAncestor(".token", true) },
      {
        enabled: () => enabledRef.current,
        at: (p) => atRef.current(stage, p),
        ping: (x, y, pointerId) => pingRef.current(x, y, pointerId),
        closing: () => closingRef.current(),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (id) => clearTimeout(id),
      },
    );
    hold.current = listening;
    return () => {
      listening.stop();
      hold.current = null;
    };
  }, [stage]);
  useEffect(() => {
    if (!enabled) hold.current?.cancel();
  }, [enabled]);
}
