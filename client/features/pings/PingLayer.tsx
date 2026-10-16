import type Konva from "konva";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { Circle, Group } from "react-konva";
import { popoverSlot } from "../../components/popoverRules.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { useLowPower } from "../device/settings.ts";
import { LONG_PRESS_MS, TAP_SLOP_PX } from "../../lib/gestures.ts";
import { theme } from "../../lib/theme.ts";
import { PING_MS } from "../../state/ephemeral.ts";
import type { Ping } from "../../state/types.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { playPing, unlockAudio, vibrate } from "./feedback.ts";
import { reportHoldPing } from "./hold.ts";
import { markOwner } from "./who.ts";

/**
 * Pings on the overlay layer (design 13.3): rings that pulse outward in the
 * pinger's color and fade within the store's 3 s, with the pinger's name
 * when it is someone else. They animate with a
 * requestAnimationFrame loop that runs only while a ping is on screen
 * (design 14.2). In low power (docs/design-v1-dm-tools.md 3.15) a ping is
 * one still ring for its 3 s, with no loop, until the store sweeps it.
 *
 * Each new ping also plays a tone here, and someone else's buzzes an
 * Android phone. A DM's "look here" buzzes too: the store has already
 * moved the camera.
 *
 * This layer also gives the select tool a tap-and-hold ping: a press held
 * still for 500 ms on empty map pings it. A token under the finger keeps
 * its own long-press (it selects the token), and any movement past the tap
 * slop is a pan, so the hold never fights the select tool. Each press it
 * pings is reported (hold.ts), so its lift opens no label, door, readout
 * or pin.
 */

const PULSE_MS = 1_000;
const RING_MIN_PX = 6;
const RING_MAX_PX = 44;

export const PingLayer = memo(function PingLayer(props: LayerProps) {
  const pings = useRoomView((s) => s.ephemeral.pings);
  const members = useRoomView((s) => s.view?.members);
  const focus = useRoomView((s) => s.ephemeral.focus);
  const tool = useRoomView((s) => s.local.tool);
  const actions = useRoomActions();
  const scope = useRoomScope();
  const groupRef = useRef<Konva.Group>(null);
  const still = useLowPower();
  const now = useFrameClock(pings.length > 0 && !still);

  useFeedback(pings, focus?.id ?? null);
  useHoldToPing(
    groupRef,
    tool === "select",
    (x, y, pointerId) => {
      actions.sendEph({ k: "ping", x, y });
      reportHoldPing(scope, pointerId);
    },
    () => scope.get(popoverSlot).suppressesTool(),
  );

  return (
    <Group ref={groupRef} listening={false}>
      {pings.map((p) => (
        <PingRings key={p.id} ping={p} now={now} still={still} scale={props.scale} color={members?.[p.from]?.color ?? theme.color.accentSoft} name={markOwner(p, members)} />
      ))}
    </Group>
  );
});

function PingRings(props: { ping: Ping; now: number; still: boolean; scale: number; color: string; name: string | null }) {
  // A still ping has no clock to age by. The store drops it after its 3 s.
  const age = props.still ? 0 : Math.max(0, props.now - props.ping.at);
  if (age >= PING_MS) return null;
  const fade = 1 - age / PING_MS;
  // A ping exists to be seen: its rings grow with a close zoom, up to twice their size, but never shrink below it.
  const s = Math.min(2, Math.max(1, boardSizes(props.scale).f)) / props.scale;
  const rings = props.still
    ? [{ r: ((RING_MIN_PX + RING_MAX_PX) / 2) * s, opacity: 1 }]
    : [0, PULSE_MS / 2].map((offset) => {
        const t = ((age + offset) % PULSE_MS) / PULSE_MS;
        return { r: (RING_MIN_PX + (RING_MAX_PX - RING_MIN_PX) * t) * s, opacity: (1 - t) * fade };
      });
  return (
    <>
      {rings.map((r, i) => (
        <Circle key={i} x={props.ping.x} y={props.ping.y} radius={r.r} stroke={props.color} strokeWidth={3} strokeScaleEnabled={false} opacity={r.opacity} listening={false} />
      ))}
      <Circle x={props.ping.x} y={props.ping.y} radius={5 * s} fill={props.color} stroke={theme.color.textHalo} strokeWidth={1.5} strokeScaleEnabled={false} opacity={fade} listening={false} />
      {props.name ? <Pill x={props.ping.x} y={props.ping.y} scale={props.scale} name={props.name} size="map" color={props.color} small offsetPx={14} /> : null}
    </>
  );
}

/** Date.now() on every animation frame while `running`, the store's clock for ping times. Idle otherwise. */
export function useFrameClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  return running ? now : Date.now();
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

  useEffect(() => {
    document.addEventListener("pointerdown", unlockAudio, { capture: true });
    return () => document.removeEventListener("pointerdown", unlockAudio, { capture: true });
  }, []);
}

/** `closing` says a press is one that closes a popover or a menu (components/popoverRules.ts), which never pings. */
function useHoldToPing(ref: RefObject<Konva.Group | null>, enabled: boolean, ping: (x: number, y: number, pointerId: number) => void, closing: () => boolean): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pingRef = useRef(ping);
  pingRef.current = ping;
  const closingRef = useRef(closing);
  closingRef.current = closing;
  useEffect(() => {
    const stage = ref.current?.getStage();
    if (!stage) return;
    const el = stage.container();
    const pointers = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
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
      if (!enabledRef.current || pointers.size !== 1 || (e.pointerType === "mouse" && e.button !== 0) || closingRef.current()) return;
      const p = local(e);
      if (stage.getIntersection(p)?.findAncestor(".token", true)) return;
      start = p;
      const pointerId = e.pointerId;
      timer = setTimeout(() => {
        timer = null;
        const scale = stage.scaleX() || 1;
        pingRef.current((p.x - stage.x()) / scale, (p.y - stage.y()) / scale, pointerId);
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
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      clear();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [ref]);
}
