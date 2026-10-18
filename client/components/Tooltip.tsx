import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";

/** Hover waits this long, so a pointer passing over a row of icons shows nothing (docs/design-v1-icons.md 3). */
const HOVER_MS = 500;
/** Keyboard focus waits less: the person is already on the control. */
const FOCUS_MS = 150;
/** A touch screen has no hover. A held finger shows the name as a bonus, never as the only way to learn it. */
const PRESS_MS = 500;
const GAP = 6;
const MARGIN = 8;

/**
 * The name of an icon-only control, shown beside it on hover, on keyboard
 * focus and on a long press (docs/design-v1-icons.md 3). It replaces the
 * native `title`, which a keyboard never shows and which waits a second.
 *
 * It opens in the browser's top layer (the popover attribute), so no
 * scrolling pane, sheet or dialog clips it, above the control, or below it
 * where the screen's top leaves no room, and never over the control it
 * names. Escape, a scroll, the pointer leaving or focus leaving close it.
 * The tip is decoration for sighted users: the control keeps its own
 * `aria-label`, and `describes` is set only when the tip says more than the
 * name.
 */
export function useTooltip(text: string, opts: { describes?: boolean } = {}): {
  anchor: {
    onPointerEnter(e: PointerEvent<HTMLElement>): void;
    onPointerLeave(): void;
    onPointerDown(e: PointerEvent<HTMLElement>): void;
    onPointerUp(): void;
    onFocus(e: FocusEvent<HTMLElement>): void;
    onBlur(): void;
    "aria-describedby"?: string;
  };
  tip: ReactNode;
} {
  const id = useId();
  const [at, setAt] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (el: HTMLElement, ms: number) => {
    clear();
    timer.current = setTimeout(() => setAt(el.getBoundingClientRect()), ms);
  };
  const hide = () => {
    clear();
    setAt(null);
  };
  useEffect(() => {
    if (!at) return;
    const tip = tipRef.current;
    if (!tip) return;
    tip.showPopover?.();
    const box = tip.getBoundingClientRect();
    const above = at.top - GAP - box.height;
    const top = above >= MARGIN ? above : at.bottom + GAP;
    const left = Math.min(Math.max(MARGIN, at.left + at.width / 2 - box.width / 2), window.innerWidth - MARGIN - box.width);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.style.visibility = "visible";
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      hide();
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", close, true);
      if (tip.isConnected) tip.hidePopover?.();
    };
  }, [at]);
  useEffect(() => clear, []);
  return {
    anchor: {
      onPointerEnter: (e) => {
        if (e.pointerType === "mouse") later(e.currentTarget, HOVER_MS);
      },
      onPointerLeave: hide,
      onPointerDown: (e) => {
        if (e.pointerType === "touch") later(e.currentTarget, PRESS_MS);
        else hide();
      },
      onPointerUp: () => {
        // A long press keeps the name up a moment after the finger lifts, so it can be read.
        if (at) setTimeout(hide, 1500);
        else clear();
      },
      onFocus: (e) => {
        if (e.currentTarget.matches(":focus-visible")) later(e.currentTarget, FOCUS_MS);
      },
      onBlur: hide,
      ...(opts.describes ? { "aria-describedby": id } : {}),
    },
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
