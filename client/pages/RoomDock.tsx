import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { useStore } from "zustand";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { useAlertsSummaryEntry } from "../components/sheetFocus.ts";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { useScoped } from "../state/scope.ts";
import { alertsSummary, DOCK_PX, dockSlot, type AlertsSummary } from "./fold.ts";

/*
 * The dock on a phone's sheet (docs/design-v1-visual.md 3.2.1, pages/fold.ts):
 * while a portrait sheet folds the token bar and the fight alerts column,
 * one 48 px row on the sheet's top edge holds what they were. When the
 * dock and the sheet's minimum do not both fit, the same buttons sit in
 * the sheet's header instead. Room decides which, and what each tap does
 * to focus.
 */

/** What the dock's buttons do, which Room supplies: it closes the sheets and places focus once they are gone. */
export type DockActions = {
  showBar(): void;
  closeBar(): void;
  showAlerts(summary: AlertsSummary): void;
};

/**
 * The dock's summary of the folded alerts: the column's, and the rolls'
 * line that features/rolls publishes. The column's own summary row reads
 * the same, with the advice for what leaves it no room (`hides`): the
 * docked token bar, or a short screen's tool options.
 */
export function useDockSummary(hides: "sheet" | "bar" | "room" = "sheet"): AlertsSummary | null {
  const alerts = useStore(useScoped(dockSlot), (s) => s.alerts);
  const rolls = useAlertsSummaryEntry();
  const text = rolls?.text ?? null;
  const name = rolls?.name ?? null;
  const waiting = rolls?.waiting ?? false;
  const requests = rolls?.requests ?? 0;
  return useMemo(() => alertsSummary(text !== null && name !== null ? { text, name, waiting, requests } : null, alerts, hides), [alerts, text, name, waiting, requests, hides]);
}

/**
 * The dock's row, on the sheet's top edge: the token bar's group ("Thorn
 * actions", holding "Show Thorn actions" and its Close), then the alerts
 * summary. Short of room, the token's name shrinks first, then the
 * summary's text, each with an ellipsis, while the summary's count and
 * the Close stay whole.
 *
 * It follows the open sheet's top edge (`sheetHeight`, in the chrome's own
 * pixels), and Room keeps the dock and the gap above it free when it caps
 * the sheet (Sheet `reserveTop`).
 */
export function DockRow(props: {
  zoom: number;
  sheetHeight: number;
  summary: AlertsSummary | null;
  actions: DockActions;
  showRef: Ref<HTMLButtonElement>;
  summaryRef: Ref<HTMLButtonElement>;
}) {
  const bar = useStore(useScoped(dockSlot), (s) => s.bar);
  const { summary, actions } = props;
  return (
    <div
      data-rvtt-dock=""
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        position: "absolute",
        left: `calc(${theme.safe.left} + ${theme.space(2)}px)`,
        right: `calc(${theme.safe.right} + ${theme.space(2)}px)`,
        bottom: `calc(${theme.safe.bottom} + ${theme.layout.toolbar + props.sheetHeight}px)`,
        zIndex: theme.z.sheet,
        display: "flex",
        alignItems: "stretch",
        gap: theme.space(2),
        height: DOCK_PX,
        pointerEvents: "none",
      }}
    >
      {bar ? (
        <div
          role="group"
          aria-label={bar.label}
          style={{
            ...paneLook,
            // The token's name gives way first, down to its Show button's 44 px, before the summary's text does.
            flex: "0 100000 auto",
            minWidth: theme.touch * 2 + theme.space(1),
            display: "flex",
            alignItems: "center",
            padding: `0 ${theme.space(0.5)}px`,
          }}
        >
          <button ref={props.showRef} type="button" aria-label={bar.show} title={bar.show} onClick={actions.showBar} style={showStyle}>
            <span style={ellipsis}>{bar.text}</span>
            <Icon name="chevronRight" size="sm" />
          </button>
          <IconButton label={bar.closeLabel} icon="close" onClick={actions.closeBar} />
        </div>
      ) : null}
      {/* At the right, under where the column hangs when it is not folded. */}
      {summary ? (
        <SummaryButton
          ref={props.summaryRef}
          summary={summary}
          onClick={() => actions.showAlerts(summary)}
          style={{ ...paneLook, flex: "0 1 auto", marginLeft: "auto", padding: `0 ${theme.space(3)}px` }}
        />
      ) : null}
    </div>
  );
}

/**
 * The dock's buttons in the sheet's header, when the dock does not fit
 * above the sheet (3.2.1): the token's group is one outlined chip with
 * its name, whose tap shows the bar as "Show Thorn actions" does, with no
 * close of its own, so the header holds one close, the sheet's. Then the
 * alerts summary. The sheet's title shrinks first, down to a few letters,
 * then the chip's name and the summary's text.
 */
export function DockHeaderActions(props: { summary: AlertsSummary | null; actions: DockActions; showRef: Ref<HTMLButtonElement>; summaryRef: Ref<HTMLButtonElement> }) {
  const bar = useStore(useScoped(dockSlot), (s) => s.bar);
  const { summary, actions } = props;
  return (
    <>
      {bar ? (
        <button ref={props.showRef} type="button" aria-label={bar.show} title={bar.show} onClick={actions.showBar} style={{ ...chipStyle, flex: "0 1 auto" }}>
          <span style={ellipsis}>{bar.text}</span>
        </button>
      ) : null}
      {summary ? <SummaryButton ref={props.summaryRef} summary={summary} onClick={() => actions.showAlerts(summary)} style={{ ...chipStyle, flex: "0 1 auto" }} /> : null}
    </>
  );
}

/**
 * One button that names the most pressing alert and how many more wait
 * (fold.ts alertsSummary). It is the "sheet" kind, with no
 * `aria-expanded`: a tap closes the sheets and the full column shows. The
 * alerts column draws it too, as its summary row beside the docked token
 * bar, where a tap hides the bar instead
 * (features/encounter/InitiativeStrip.tsx).
 */
export function SummaryButton(props: { ref?: Ref<HTMLButtonElement>; summary: AlertsSummary; onClick(): void; style: CSSProperties }) {
  const { summary } = props;
  return (
    <button
      ref={props.ref}
      type="button"
      aria-label={summary.name}
      title={summary.name}
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(1.5),
        minWidth: theme.touch,
        minHeight: theme.touch,
        color: theme.color.text,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        cursor: "pointer",
        pointerEvents: "auto",
        ...props.style,
      }}
    >
      <span style={ellipsis}>{summary.text}</span>
      {summary.more ? <span style={{ flex: "none", color: theme.color.textMuted, fontWeight: theme.weight.bold }}>{summary.more}</span> : null}
    </button>
  );
}

const ellipsis: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** The look of a pane over the map (the token bar it stands for), as one row. */
const paneLook: CSSProperties = {
  boxSizing: "border-box",
  height: DOCK_PX,
  background: theme.color.surface,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  boxShadow: theme.shadow.pane,
  pointerEvents: "auto",
};

const showStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: theme.touch,
  minHeight: theme.touch,
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  padding: `0 ${theme.space(2)}px`,
  border: "none",
  borderRadius: theme.radius.md,
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.body,
  fontSize: theme.font.input,
  fontWeight: theme.weight.bold,
  cursor: "pointer",
};

/** An outlined chip in a sheet's header, 44 px tall like every target there. */
const chipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  minWidth: theme.touch,
  minHeight: theme.touch,
  padding: `0 ${theme.space(3)}px`,
  border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.pill,
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.body,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  cursor: "pointer",
};

/** How long after it arrived an alert that folds away still counts as news. */
const FRESH_MS = 1_000;

/**
 * Room's one status region for the folded alerts (3.2.1). The column's
 * time-up and notice cards are live regions of their own, and a hidden
 * column says nothing, so while it is folded each alert that arrives is
 * read out here instead. It sits outside the column and outside the
 * summary button: a hidden subtree leaves the accessibility tree, and a
 * live region inside a button reads poorly. It is always on the page, so
 * nothing announced goes quiet as the dock comes or goes. The alerts
 * column's summary row beside the docked token bar hides the cards the
 * same way, and Room counts it as folded here too.
 */
export function FoldStatus(props: { folded: boolean }) {
  const alerts = useStore(useScoped(dockSlot), (s) => s.alerts);
  const rolls = useAlertsSummaryEntry();
  const [text, setText] = useState("");
  const seen = useRef<Set<string> | null>(null);
  // When each alert first showed, and whether the alerts were folded last time: one that folds away as it arrives was never seen either.
  const arrived = useRef(new Map<string, number>());
  const wasFolded = useRef(props.folded);
  const rollsKey = rolls ? `rolls:${rolls.text}:${rolls.name}` : null;
  const rollsSays = rolls ? `${rolls.text}: ${rolls.name}.` : null;
  useEffect(() => {
    const items = alerts.map((a) => ({ id: a.id, says: a.says }));
    if (rollsKey !== null && rollsSays !== null) items.push({ id: rollsKey, says: rollsSays });
    const before = seen.current;
    seen.current = new Set(items.map((i) => i.id));
    const now = Date.now();
    for (const i of items) if (!arrived.current.has(i.id)) arrived.current.set(i.id, now);
    for (const id of arrived.current.keys()) if (!seen.current.has(id)) arrived.current.delete(id);
    const justFolded = props.folded && !wasFolded.current;
    wasFolded.current = props.folded;
    // What was there when the page opened was never news.
    if (before === null) return;
    if (!props.folded) {
      setText("");
      return;
    }
    // The column's summary row beside the token bar can take an alert's place a frame after it arrived (docs/design-v1-bar-dock.md 1.3).
    const fresh = items.filter((i) => !before.has(i.id) || (justFolded && now - (arrived.current.get(i.id) ?? 0) < FRESH_MS));
    if (fresh.length > 0) setText(fresh.map((i) => i.says).join(" "));
  }, [alerts, rollsKey, rollsSays, props.folded]);
  return (
    <div role="status" data-rvtt-fold-status="" style={VISUALLY_HIDDEN}>
      {text}
    </div>
  );
}

/**
 * An element's height as laid out in the chrome's own pixels, kept up to
 * date: its drawn height divided by the interface size, which zoomed
 * chrome multiplies (features/device/layout.ts). Measured in a layout
 * effect, so what follows it, such as the dock on a sheet's edge, never
 * paints a frame in the wrong place.
 */
export function useLayoutHeight(el: HTMLElement | null, zoom: number): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(el.getBoundingClientRect().height / zoom);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, zoom]);
  return height;
}

/**
 * The safe areas' insets in pixels, which only CSS can read (`env()`),
 * from a probe that pads itself by them. The dock needs the top and the
 * bottom to tell whether it fits above the sheet (fold.ts dockFits), and
 * the docked token bar all four for the map's free area
 * (canvas/barDock.ts freeArea).
 */
export function useSafeAreas(): { probe: (el: HTMLElement | null) => void; top: number; right: number; bottom: number; left: number } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [areas, setAreas] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const style = getComputedStyle(el);
      const next = {
        top: parseFloat(style.paddingTop) || 0,
        right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
        left: parseFloat(style.paddingLeft) || 0,
      };
      setAreas((prev) => (prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom && prev.left === next.left ? prev : next));
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [el]);
  const probe = useCallback((node: HTMLElement | null) => setEl(node), []);
  return { probe, ...areas };
}

/** The probe useSafeAreas reads: no size, never drawn, padded by the safe areas. */
export const SAFE_PROBE_STYLE: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  paddingTop: theme.safe.top,
  paddingRight: theme.safe.right,
  paddingBottom: theme.safe.bottom,
  paddingLeft: theme.safe.left,
  visibility: "hidden",
  pointerEvents: "none",
};
