import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type FocusEventHandler, type PointerEvent, type PointerEventHandler, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";

/** Hover waits this long, so a pointer passing over a row of icons shows nothing (docs/design-v1-icons.md 3.2). */
export const HOVER_MS = 500;
/** Keyboard focus waits less: the person is already on the control. */
export const FOCUS_MS = 150;
/** A touch screen has no hover. A held finger shows the name as a bonus, never as the only way to learn it. */
export const PRESS_MS = 500;
/** A long press keeps the name up this long after the finger lifts, so it can be read. */
export const KEEP_MS = 1500;
const GAP = 6;
const MARGIN = 8;

export type TipEvent =
  | { t: "enter"; pointer: string }
  | { t: "leave" }
  | { t: "down"; pointer: string }
  | { t: "up" }
  | { t: "focus"; visible: boolean }
  | { t: "blur" }
  | { t: "escape" }
  | { t: "scroll" };

export type TipClock = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

/**
 * When a tip shows, without React or a DOM, so its rules are tested on a
 * fake clock (Tooltip.test.ts). One timer at most is pending: a new event
 * that arms or closes replaces it.
 */
export class TipTimer {
  shown = false;
  #pending: unknown = null;
  readonly #clock: TipClock;
  readonly #onChange: (shown: boolean) => void;

  constructor(clock: TipClock, onChange: (shown: boolean) => void) {
    this.#clock = clock;
    this.#onChange = onChange;
  }

  send(e: TipEvent): void {
    switch (e.t) {
      case "enter":
        if (e.pointer === "mouse") this.#after(HOVER_MS, true);
        return;
      case "down":
        // A mouse press is a click on the control: its name is not in the way of it.
        if (e.pointer === "touch") this.#after(PRESS_MS, true);
        else this.#set(false);
        return;
      case "up":
        if (this.shown) this.#after(KEEP_MS, false);
        else this.#cancel();
        return;
      case "focus":
        // Only keyboard focus: a mouse or a finger that focuses the control by pressing it is handled by its pointer.
        if (e.visible) this.#after(FOCUS_MS, true);
        return;
      default:
        this.#set(false);
    }
  }

  dispose(): void {
    this.#cancel();
  }

  #after(ms: number, shown: boolean): void {
    this.#cancel();
    this.#pending = this.#clock.set(() => {
      this.#pending = null;
      this.#set(shown);
    }, ms);
  }

  #cancel(): void {
    if (this.#pending !== null) this.#clock.clear(this.#pending);
    this.#pending = null;
  }

  #set(shown: boolean): void {
    this.#cancel();
    if (this.shown === shown) return;
    this.shown = shown;
    this.#onChange(shown);
  }
}

type Box = { top: number; left: number; width: number; height: number };

/**
 * Where a tip goes: centered above its control with a 6 px gap, or below it
 * where the screen's top leaves no room, and 8 px inside the window's sides.
 * It never covers the control, so a click aimed at the control never lands
 * on its tip.
 */
export function placeTip(anchor: Box, tip: { width: number; height: number }, view: { width: number }): { top: number; left: number } {
  const above = anchor.top - GAP - tip.height;
  const top = above >= MARGIN ? above : anchor.top + anchor.height + GAP;
  const left = Math.max(MARGIN, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, view.width - MARGIN - tip.width));
  return { top, left };
}

export type TipAnchor = {
  onPointerEnter: PointerEventHandler<HTMLElement>;
  onPointerLeave: PointerEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onFocus: FocusEventHandler<HTMLElement>;
  onBlur: FocusEventHandler<HTMLElement>;
  "aria-describedby"?: string;
};

const BROWSER_CLOCK: TipClock = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * The name of an icon-only control, shown beside it on hover, on keyboard
 * focus and on a long press (docs/design-v1-icons.md 3.2). It replaces the
 * native `title`, which a keyboard never shows and which waits a second.
 *
 * `anchor(own)` gives the control's handlers, each calling the control's
 * own first, so a caller's `onPointerDown` or `onFocus` still runs.
 *
 * The tip opens in the browser's top layer (the popover attribute), so no
 * scrolling pane, sheet or dialog clips it. Escape is heard but not used
 * up, so the room's own Escape still runs. The control keeps its own
 * `aria-label`, and `describes` is set only when the tip says more than the
 * name.
 */
export function useTooltip(text: string, opts: { describes?: boolean } = {}): { anchor(own?: Partial<TipAnchor>): TipAnchor; tip: ReactNode } {
  const id = useId();
  const [at, setAt] = useState<DOMRect | null>(null);
  const anchorEl = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useMemo(() => new TipTimer(BROWSER_CLOCK, (shown) => setAt(shown && anchorEl.current ? anchorEl.current.getBoundingClientRect() : null)), []);
  useEffect(() => () => timer.dispose(), [timer]);
  useEffect(() => {
    if (!at) return;
    const tip = tipRef.current;
    if (!tip) return;
    tip.showPopover?.();
    const place = placeTip(at, tip.getBoundingClientRect(), { width: window.innerWidth });
    tip.style.top = `${place.top}px`;
    tip.style.left = `${place.left}px`;
    tip.style.visibility = "visible";
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      timer.send({ t: e instanceof KeyboardEvent ? "escape" : "scroll" });
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", close, true);
      if (tip.isConnected) tip.hidePopover?.();
    };
  }, [at, timer]);
  const arm = (el: HTMLElement, e: TipEvent) => {
    anchorEl.current = el;
    timer.send(e);
  };
  const describedBy = (own: Partial<TipAnchor>) => (opts.describes ? id : own["aria-describedby"]);
  return {
    anchor: (own = {}) => ({
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        own.onPointerEnter?.(e);
        arm(e.currentTarget, { t: "enter", pointer: e.pointerType });
      },
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        own.onPointerLeave?.(e);
        timer.send({ t: "leave" });
      },
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        own.onPointerDown?.(e);
        arm(e.currentTarget, { t: "down", pointer: e.pointerType });
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        own.onPointerUp?.(e);
        timer.send({ t: "up" });
      },
      onFocus: (e: FocusEvent<HTMLElement>) => {
        own.onFocus?.(e);
        arm(e.currentTarget, { t: "focus", visible: e.currentTarget.matches(":focus-visible") });
      },
      onBlur: (e: FocusEvent<HTMLElement>) => {
        own.onBlur?.(e);
        timer.send({ t: "blur" });
      },
      ...(describedBy(own) !== undefined ? { "aria-describedby": describedBy(own) } : {}),
    }),
    tip: (
      <div
        ref={tipRef}
        id={id}
        role="tooltip"
        popover="manual"
        style={{
          display: at ? "block" : "none",
          visibility: "hidden",
          position: "fixed",
          inset: "auto",
          margin: 0,
          // A popover scrolls by the browser's own rule, and a few words never need to: a script looking for a panel's scrolling body would find the tip first.
          overflow: "visible",
          maxWidth: 240,
          padding: `${theme.space(1)}px ${theme.space(2)}px`,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          borderRadius: theme.radius.sm,
          background: theme.color.surfaceRaised,
          color: theme.color.text,
          fontFamily: theme.font.body,
          fontSize: theme.font.small,
          lineHeight: theme.leading.tight,
          boxShadow: theme.shadow.float,
          pointerEvents: "none",
        }}
      >
        {text}
      </div>
    ),
  };
}
