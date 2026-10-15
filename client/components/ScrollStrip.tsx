import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from "react";
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
 * hides off the edge.
 */
export function ScrollStrip(props: {
  children: ReactNode;
  active?: string;
  role?: string;
  "aria-label"?: string;
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

  useLayoutEffect(() => {
    const el = ref.current;
    const target = el?.querySelector<HTMLElement>('[data-active="true"]');
    if (!el || !target) return;
    // Clear of the fade on either side, so the active button reads fully.
    const start = target.offsetLeft - FADE_PX;
    const end = target.offsetLeft + target.offsetWidth + FADE_PX;
    if (start < el.scrollLeft) el.scrollLeft = start;
    else if (end > el.scrollLeft + el.clientWidth) el.scrollLeft = end - el.clientWidth;
    measure();
  }, [props.active, measure]);

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
    <div style={{ position: "relative", display: "flex", minWidth: 0, ...props.style }}>
      <div
        ref={ref}
        role={props.role}
        aria-label={props["aria-label"]}
        onScroll={measure}
        onWheel={onWheel}
        style={{
          // The offset parent of the buttons, so their offsetLeft is in the strip's scroll space.
          position: "relative",
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: theme.space(1),
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          overscrollBehaviorX: "contain",
          scrollbarWidth: "none",
          // Room for the focus ring of the first and last button.
          paddingInline: 3,
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

/** A mask reads only alpha, so any opaque color shows the strip. */
function fadeMask(edges: { left: boolean; right: boolean }): string | undefined {
  if (!edges.left && !edges.right) return undefined;
  const solid = theme.color.stage;
  const left = edges.left ? `transparent 0, ${solid} ${FADE_PX}px` : `${solid} 0`;
  const right = edges.right ? `${solid} calc(100% - ${FADE_PX}px), transparent 100%` : `${solid} 100%`;
  return `linear-gradient(to right, ${left}, ${right})`;
}
