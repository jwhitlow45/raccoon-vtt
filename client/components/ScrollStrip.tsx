import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";

const FADE_PX = 32;

/**
 * A row of buttons that scrolls sideways when it does not fit, such as the
 * DM's nine tools on a 390 px phone.
 *
 * The scrollbar is hidden, because a classic one would take a third of a
 * 60 px toolbar. Instead the edge that hides more buttons fades out under a
 * chevron, which shows there is more to swipe to even when the last
 * visible button happens to end right at the edge. A tap on the chevron
 * scrolls a page's worth, for anyone who does not think to swipe. A vertical
 * mouse wheel scrolls the row sideways, so a narrow desktop window can
 * reach everything too. Whenever `active` changes, the button marked
 * `data-active` scrolls into view, so a tool picked from a panel never
 * hides off the edge, and a button that Tab reaches scrolls clear of the
 * fade, so the keyboard reads every one.
 */
export function ScrollStrip(props: {
  children: ReactNode;
  active?: string;
  role?: string;
  "aria-label"?: string;
  /** On the row itself, for a role whose keys move along it, such as a tab list's arrows. */
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  /** Between its buttons. */
  gap?: number;
  /**
   * Room at each end for the focus ring of the first and last button, 3 px
   * by default. The party line's chips draw their ring around a pill that
   * reaches their edges (components/HeaderRow.tsx), so they ask for 4. The
   * toolbar keeps 3: on a 390 px phone its tools fill the row to the pixel,
   * and one more at each end made it scroll.
   */
  edge?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A pixel of slack, because scrollLeft is fractional on high-density screens.
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, props.children]);

  /*
   * Clear of the fade on either side, so the button reads fully. Measured
   * from the boxes as drawn, and the scroll rounded outward: offsetLeft,
   * offsetWidth and clientWidth are whole pixels, and with a font whose
   * buttons are fractions of a pixel wide their rounding left a button up
   * to a pixel and a half under the fade. The strip has no border and no
   * scrollbar, so its box is the part that shows.
   *
   * The boxes as drawn are in the page's px, which the interface size's
   * zoom scales, while scrollLeft and the fade are in the strip's own px.
   * So each distance is divided by the strip's zoom before it meets them.
   * Mixed, a button at 130% stayed under the fade, and at 85% an active
   * tool far down the strip scrolled to well past its edge.
   */
  const reveal = useCallback(
    (target: HTMLElement | null) => {
      const el = ref.current;
      if (!el || !target) return;
      const strip = el.getBoundingClientRect();
      const button = target.getBoundingClientRect();
      const zoom = zoomOf(el, strip.width);
      const width = strip.width / zoom;
      const start = (button.left - strip.left) / zoom + el.scrollLeft - FADE_PX;
      const end = (button.right - strip.left) / zoom + el.scrollLeft + FADE_PX;
      if (start < el.scrollLeft) el.scrollLeft = Math.floor(start);
      else if (end > el.scrollLeft + width) el.scrollLeft = Math.ceil(end - width);
      measure();
    },
    [measure],
  );

  useLayoutEffect(() => {
    reveal(ref.current?.querySelector<HTMLElement>('[data-active="true"]') ?? null);
  }, [props.active, reveal]);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target !== e.currentTarget) reveal(e.target);
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
  };

  const page = (direction: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: direction * Math.max(FADE_PX, el.clientWidth - 2 * FADE_PX), behavior: "smooth" });
  };

  const mask = fadeMask(edges);
  return (
    // The wheel listens on the whole strip, so it scrolls over a chevron too, which lies over the strip's edge.
    <div onWheel={onWheel} style={{ position: "relative", display: "flex", minWidth: 0, ...props.style }}>
      <div
        ref={ref}
        role={props.role}
        aria-label={props["aria-label"]}
        onKeyDown={props.onKeyDown}
        onFocus={onFocus}
        onScroll={measure}
        style={{
          // The offset parent of the buttons, so their offsetLeft is in the strip's scroll space.
          position: "relative",
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: props.gap ?? theme.space(1),
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          overscrollBehaviorX: "contain",
          scrollbarWidth: "none",
          paddingInline: props.edge ?? 3,
          maskImage: mask,
          WebkitMaskImage: mask,
        }}
      >
        {props.children}
      </div>
      {edges.left ? <Chevron side="left" onPress={() => page(-1)} /> : null}
      {edges.right ? <Chevron side="right" onPress={() => page(1)} /> : null}
    </div>
  );
}

/**
 * Kept out of the tab order and hidden from screen readers: every button in
 * the strip is reachable by itself, and the chevron only saves a swipe.
 */
function Chevron(props: { side: "left" | "right"; onPress(): void }) {
  return (
    <button
      type="button"
      aria-hidden
      tabIndex={-1}
      onClick={props.onPress}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [props.side]: 0,
        width: 24,
        padding: 0,
        display: "grid",
        placeItems: "center",
        border: "none",
        background: "transparent",
        color: theme.color.textMuted,
        cursor: "pointer",
        pointerEvents: "auto",
      }}
    >
      <Icon name={props.side === "left" ? "back" : "chevronRight"} />
    </button>
  );
}

/**
 * How many of the page's px each of the element's own px draws as, the
 * zoom of every piece of chrome around it (features/device/layout.ts
 * chromeZoom). currentCSSZoom says so exactly. A browser without it gets
 * the drawn width over offsetWidth instead, which offsetWidth's rounding
 * to whole pixels leaves off by half a pixel in the strip's width at most.
 */
function zoomOf(el: HTMLElement, drawnWidth: number): number {
  const exact = (el as { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof exact === "number" && exact > 0) return exact;
  return el.offsetWidth > 0 && drawnWidth > 0 ? drawnWidth / el.offsetWidth : 1;
}

/** A mask reads only alpha, so any opaque color shows the strip. */
function fadeMask(edges: { left: boolean; right: boolean }): string | undefined {
  if (!edges.left && !edges.right) return undefined;
  const solid = theme.color.stage;
  const left = edges.left ? `transparent 0, ${solid} ${FADE_PX}px` : `${solid} 0`;
  const right = edges.right ? `${solid} calc(100% - ${FADE_PX}px), transparent 100%` : `${solid} 100%`;
  return `linear-gradient(to right, ${left}, ${right})`;
}
