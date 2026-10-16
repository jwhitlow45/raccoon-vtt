import { useLayoutEffect, useRef } from "react";
import { Button } from "../components/Button.tsx";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { useScoped } from "../state/scope.ts";
import { barDockSlot, defaultBarWidth } from "./barDock.ts";

/** The steady line's first three buttons, which the default width keeps on one line. */
const STEADY = ["Conditions", "Hidden", "Multi-select"] as const;

/**
 * Three hidden copies of the token window's small buttons, which measure
 * its default width (docs/design-v1-token-window.md 3.3). Being real
 * buttons in the page, inside the chrome's zoom as the window is, they
 * carry this device's font and the browser's minimum font size, which a
 * width worked out from the labels' text would miss. Room draws them once
 * with the page, so the width lands in the Room scope in a layout effect,
 * before any window paints, and a font that loads late or a changed
 * minimum size resizes them and measures again.
 */
export function BarWidthProbe(props: { zoom: number }) {
  const store = useScoped(barDockSlot);
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      // The drawn width over the zoom: layout px, the same at every interface size.
      const widths = Array.from(el.children, (b) => b.getBoundingClientRect().width / props.zoom);
      if (widths.some((w) => w <= 0)) return;
      const width = defaultBarWidth(widths);
      if (store.getState().defaultWidth !== width) store.setState({ defaultWidth: width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const b of Array.from(el.children)) observer.observe(b);
    return () => observer.disconnect();
  }, [store, props.zoom]);
  return (
    <div
      ref={row}
      aria-hidden
      data-bar-width-probe=""
      {...smallUi(props.zoom)}
      style={{ position: "absolute", top: 0, left: 0, width: "max-content", display: "flex", visibility: "hidden", pointerEvents: "none", ...chromeZoom(props.zoom) }}
    >
      {STEADY.map((label) => (
        <Button key={label} size="sm" tabIndex={-1} style={{ flex: "none" }}>
          {label}
        </Button>
      ))}
    </div>
  );
}
