import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type FocusEventHandler, type MouseEvent, type MouseEventHandler, type PointerEvent, type PointerEventHandler, type ReactNode } from "react";
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
  | { t: "leave"; pointer: string }
  | { t: "down"; pointer: string }
  | { t: "up" }
  | { t: "cancel" }
  | { t: "focus"; visible: boolean }
  | { t: "blur" }
  /** Any key but Escape, anywhere, while the tip is up. */
  | { t: "key" }
  | { t: "escape" }
  | { t: "scroll" };

/** What `takeClick` reads of a click: `detail` 0 for Enter or Space, and the pointer, which some browsers do not name. */
export type TipClick = { detail: number; pointerType?: string };

export type TipClock = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

/**
 * When a tip shows, without React or a DOM, so its rules are tested on a
 * fake clock (Tooltip.test.ts). One timer at most is pending: a new event
 * that arms or closes replaces it.
 */
export class TipTimer {
  shown = false;
  #pending: unknown = null;
  /** A finger is on the control. */
  #pressing = false;
  /**
   * A held finger showed the name, so the click its lift makes is not a tap
   * (`takeClick`). Only while the name is up: a hold whose click never came
   * (Android's context menu) must not take a later one.
   */
  #pressShown = false;
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
      case "leave":
        // A lifted finger or pen leaves the control at once (Pointer Events), which must not end the 1.5 s a long press keeps its name up.
        if (e.pointer === "mouse") this.#set(false);
        return;
      case "down":
        this.#pressing = e.pointer === "touch";
        this.#pressShown = false;
        // A mouse press is a click on the control: its name is not in the way of it.
        if (e.pointer === "touch") this.#after(PRESS_MS, true);
        else this.#set(false);
        return;
      case "up":
        this.#pressing = false;
        if (this.shown) this.#after(KEEP_MS, false);
        else this.#cancel();
        return;
      case "cancel":
        this.#pressing = false;
        this.#pressShown = false;
        this.#set(false);
        return;
      case "focus":
        // Only keyboard focus: a mouse or a finger that focuses the control by pressing it is handled by its pointer.
        if (e.visible) {
          this.#pressShown = false;
          this.#after(FOCUS_MS, true);
        }
        return;
      case "key":
        // A key means the next click may be the keyboard's or a reader's, which is never the hold's.
        this.#pressShown = false;
        return;
      default:
        this.#set(false);
    }
  }

  /**
   * True once after a held finger showed the name: the click its lift
   * makes then belongs to learning the name, not to the control, so a long
   * press on Delete never deletes. A tap, or a press that ended first, is
   * a click as usual. So is a keyboard's click, and one whose pointer the
   * browser names as anything but a finger or a pen, such as a screen
   * reader's, which names none (""). Where the browser names no pointer at
   * all, the hold's flag alone decides, and it lasts only while the name
   * is up.
   */
  takeClick(click: TipClick): boolean {
    const held = this.#pressShown;
    this.#pressShown = false;
    if (!held || click.detail === 0) return false;
    return click.pointerType === undefined || click.pointerType === "touch" || click.pointerType === "pen";
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
    if (shown && this.#pressing) this.#pressShown = true;
    if (!shown) this.#pressShown = false;
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

/**
 * `placeTip` for a tip inside CSS `zoom` (the interface size, Sheet.tsx and
 * the room's layers): the boxes a browser measures already carry the zoom,
 * and the tip's `top` and `left` get it again, so each is divided by the
 * zoom first. At 130% a tip placed in measured pixels landed 30% further
 * down and right, and off the screen by its edges.
 */
export function placeTipZoomed(anchor: Box, tip: { width: number; height: number }, view: { width: number }, zoom: number): { top: number; left: number } {
  const z = zoom > 0 ? zoom : 1;
  return placeTip({ top: anchor.top / z, left: anchor.left / z, width: anchor.width / z, height: anchor.height / z }, { width: tip.width / z, height: tip.height / z }, { width: view.width / z });
}

/** The zoom an element is drawn at: the browser's own figure where it gives one, else its drawn width over its laid-out width. */
export function effectiveZoom(el: HTMLElement): number {
  const own = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof own === "number" && own > 0) return own;
  return el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1;
}

/**
 * Whether a tooltip's words add any to a control's name, so a reader would
 * hear something new in its description. "Roll again" on a button named
 * "Roll again: 1d20+5 Stealth" adds nothing and is not read twice.
 */
export function addsWords(title: string | undefined, name: string | undefined): boolean {
  if (title === undefined || title.trim() === "") return false;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const known = new Set(words(name ?? ""));
  return words(title).some((w) => !known.has(w));
}

export type TipAnchor = {
  onPointerEnter: PointerEventHandler<HTMLElement>;
  onPointerLeave: PointerEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onClickCapture: MouseEventHandler<HTMLElement>;
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
 * name (`addsWords`), its id joined to any description the control has.
 * A long press that showed the name keeps the click its lift makes from
 * reaching the control (`TipTimer.takeClick`).
 */
export function useTooltip(text: string, opts: { describes?: boolean } = {}): { anchor(own?: Partial<TipAnchor>): TipAnchor; tip: ReactNode } {
  const id = useId();
  const [at, setAt] = useState<DOMRect | null>(null);
  const anchorEl = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useMemo(() => new TipTimer(BROWSER_CLOCK, (shown) => setAt(shown && anchorEl.current ? anchorEl.current.getBoundingClientRect() : null)), []);
  useEffect(() => () => timer.dispose(), [timer]);
  // Before paint, so a tip shown again never draws a frame where it last stood.
  useLayoutEffect(() => {
    if (!at) return;
    const tip = tipRef.current;
    if (!tip) return;
    tip.showPopover?.();
    const place = placeTipZoomed(at, tip.getBoundingClientRect(), { width: window.innerWidth }, effectiveZoom(tip));
    tip.style.top = `${place.top}px`;
    tip.style.left = `${place.left}px`;
    tip.style.visibility = "visible";
    // Heard only while the tip is up, the only time a hold can have armed takeClick, so every key before a keyboard's click reaches the timer.
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) timer.send({ t: e.key === "Escape" ? "escape" : "key" });
      else timer.send({ t: "scroll" });
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", close, true);
      tip.style.visibility = "hidden";
      if (tip.isConnected) tip.hidePopover?.();
    };
  }, [at, timer]);
  const arm = (el: HTMLElement, e: TipEvent) => {
    anchorEl.current = el;
    timer.send(e);
  };
  const describedBy = (own: Partial<TipAnchor>) => [own["aria-describedby"], opts.describes ? id : undefined].filter(Boolean).join(" ") || undefined;
  return {
    anchor: (own = {}) => ({
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        own.onPointerEnter?.(e);
        arm(e.currentTarget, { t: "enter", pointer: e.pointerType });
      },
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        own.onPointerLeave?.(e);
        timer.send({ t: "leave", pointer: e.pointerType });
      },
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        own.onPointerDown?.(e);
        arm(e.currentTarget, { t: "down", pointer: e.pointerType });
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        own.onPointerUp?.(e);
        timer.send({ t: "up" });
      },
      onPointerCancel: (e: PointerEvent<HTMLElement>) => {
        own.onPointerCancel?.(e);
        timer.send({ t: "cancel" });
      },
      // Capture, so the control's own onClick never hears it.
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (timer.takeClick(e.nativeEvent as TipClick)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        own.onClickCapture?.(e);
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
