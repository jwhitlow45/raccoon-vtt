import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { theme } from "../../../lib/theme.ts";
import { useAccent } from "../../../state/accent.ts";
import { effectiveZoom } from "../../device/layout.ts";
import { TRAY_PX } from "./layout.ts";
import { diceSet } from "./sets.ts";
import { GONE_MS, LAND_MS, MIN_PANE_PX, type ShownThrow, type ThrowOrigin, type TrayGeometry } from "./store.ts";
import { useThrows, useThrowView } from "./useThrows.ts";

/**
 * The tray under the header line (docs/design-v1-roll-animation.md 7 and
 * 9): the stage's canvas hangs here, inside the pane's scroller, so the
 * pane clips it and the keyboard, a sheet's drag or a dialog move it with
 * the pane. The scrim behind the band and the rings and "+N" disc over it
 * are HTML, faded by CSS on the compositor. None of it takes a tap: taps
 * pass through to the panel.
 *
 * The tray's layout is in screen px, and the pane is zoomed by the
 * interface size, so every place here is a screen px over the zoom.
 */

/** The scrim between a ring and its die, and the ring's width, in screen px: the ring reads on every set, a gold die by a yellow accent included. */
const RING_GAP_PX = 6;
const RING_PX = 3;

/** The nearest scrolling ancestor: the pane's scroller. */
function scroller(el: HTMLElement): HTMLElement | null {
  const pane = el.closest<HTMLElement>("[data-pane-body]");
  if (pane) return pane;
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The tray for a throw from `origin`: the header line's width, and the
 * band with the strip down to the control that rolled, within the pane's
 * visible rect. Null where the pane is too short to hold the header line
 * and the tray, such as Dice in the bottom pane of two.
 */
export function measureTray(host: HTMLElement, origin: ThrowOrigin): TrayGeometry | null {
  const band = host.getBoundingClientRect();
  const pane = scroller(host)?.getBoundingClientRect();
  const viewBottom = globalThis.visualViewport ? globalThis.visualViewport.offsetTop + globalThis.visualViewport.height : innerHeight;
  const bottom = Math.min(pane?.bottom ?? viewBottom, viewBottom);
  const top = Math.max(pane?.top ?? 0, 0);
  if (bottom - top < MIN_PANE_PX || band.top + TRAY_PX > bottom || band.width <= 0) return null;
  const control = origin.element?.isConnected ? origin.element.getBoundingClientRect() : null;
  const height = Math.max(TRAY_PX, Math.min(bottom, control?.bottom ?? 0) - band.top);
  const from = control ? { x: clamp(control.left + control.width / 2 - band.left, 0, band.width), y: clamp(control.top + control.height / 2 - band.top, 0, height) } : null;
  return { width: band.width, height, zoom: effectiveZoom(host, band.width), from };
}

export function Tray() {
  const store = useThrows();
  const { shown } = useThrowView();
  const host = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    const parent = slot.current;
    if (!el || !parent) return;
    return store.attach({ parent, measure: (origin) => measureTray(el, origin) });
  }, [store]);
  return (
    <div
      ref={host}
      aria-hidden="true"
      data-dice-tray=""
      // Under the header line's border, as wide as the line, and no taller than nothing: what it holds overflows down into the pane.
      style={{ position: "absolute", left: 0, right: 0, top: `calc(100% + ${theme.line.border}px)`, height: 0, pointerEvents: "none" }}
    >
      {shown ? <Scrim key={`scrim-${shown.id}`} shown={shown} now={store.now()} /> : null}
      <div ref={slot} />
      {shown ? <Marks key={`marks-${shown.id}`} shown={shown} now={store.now()} /> : null}
    </div>
  );
}

/**
 * How late React first drew a throw's marks, by the store's clock. Read
 * once, as they mount: each later render of the throw, at "Rolling…" or
 * at its landing, would otherwise hand the running animation a new delay
 * and jump it ahead.
 */
function useLate(shown: ShownThrow, now: number): number {
  return useState(() => Math.max(0, now - shown.startedAt))[0];
}

/** A CSS animation's delay that keeps it in step with the throw, `late` ms after it began. */
function after(late: number, ms: number): string {
  return `${ms - late}ms`;
}

function Scrim(props: { shown: ShownThrow; now: number }) {
  const { shown } = props;
  const late = useLate(shown, props.now);
  const z = shown.geometry.zoom;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: TRAY_PX / z,
        // Square at the top, where it meets the header line's straight edge, and rounded at the foot.
        borderRadius: `0 0 ${theme.radius.md}px ${theme.radius.md}px`,
        background: theme.color.surface,
        opacity: 0.92,
        animation: `rvtt-tray-scrim ${GONE_MS}ms linear ${after(late, 0)} both`,
      }}
    />
  );
}

/** The rings around a deciding d20 and the "+N" disc, each at its die's landed place. */
function Marks(props: { shown: ShownThrow; now: number }) {
  const { shown } = props;
  const late = useLate(shown, props.now);
  const { accent } = useAccent();
  const z = shown.geometry.zoom;
  const px = (n: number) => n / z;
  const set = diceSet(shown.set);
  const disc = shown.plan.disc;
  return (
    <>
      {shown.plan.slots.flatMap((s, i) => {
        if (!s.mark) return [];
        const outer = s.size / 2 + RING_GAP_PX + RING_PX;
        const critical = s.mark === "critical";
        // A natural 20 rings once as the die lands. A natural 1's ring stays still. Under reduced motion both hold still.
        const animation = shown.reduced ? undefined : critical ? `rvtt-tray-ring 520ms ease-out ${after(late, LAND_MS)} both` : `rvtt-tray-mark ${GONE_MS}ms linear ${after(late, 0)} both`;
        const style: CSSProperties = {
          position: "absolute",
          zIndex: 2,
          left: px(s.x - outer),
          top: px(s.y - outer),
          width: px(2 * outer),
          height: px(2 * outer),
          boxSizing: "border-box",
          borderRadius: theme.radius.round,
          border: `${px(RING_PX)}px solid ${critical ? accent : theme.color.danger}`,
          opacity: 0.95,
          animation,
        };
        return [<span key={i} data-dice-ring={s.mark} style={style} />];
      })}
      {disc ? (
        <span
          data-dice-more=""
          style={{
            position: "absolute",
            zIndex: 2,
            left: px(disc.x - disc.size / 2),
            top: px(disc.y - disc.size / 2),
            width: px(disc.size),
            height: px(disc.size),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: theme.radius.round,
            background: set.body,
            border: `${px(theme.line.border)}px solid ${set.edge}`,
            color: set.ink,
            fontFamily: theme.font.body,
            // In the tray's own pixels, as its box is, so the number keeps inside the disc at every interface size.
            fontSize: px(theme.font.input),
            fontWeight: theme.weight.bold,
            fontVariantNumeric: "tabular-nums",
            animation: shown.reduced ? undefined : `rvtt-tray-disc ${GONE_MS}ms linear ${after(late, 0)} both`,
          }}
        >
          +{shown.plan.more}
        </span>
      ) : null}
    </>
  );
}
