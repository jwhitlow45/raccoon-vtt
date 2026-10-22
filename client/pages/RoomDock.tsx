import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { useAlertsSummaryEntry } from "../components/sheetFocus.ts";
import { SHEET_MAX_WIDTH } from "../components/sheetCap.ts";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { GRAB_STYLE, SWIPE_REST_EVENT, SWIPING_ATTR } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { useScoped } from "../state/scope.ts";
import { alertsSummary, DOCK_PX, dockSlot, useFoldUnderPane, type AlertsSummary, type SummaryHides } from "./fold.ts";
import { inModal, useModalSlot } from "./modalSlot.tsx";

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
export function useDockSummary(hides: SummaryHides = "sheet"): AlertsSummary | null {
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
 * the sheet (Sheet `reserveTop`). It takes the sheet's width and place, 8
 * px in from its sides past the safe areas the sheet holds: a phone's
 * whole width, or the medium dialog's width a wider screen centers the
 * sheet at (components/sheetCap.ts SHEET_MAX_WIDTH), the same rule in CSS
 * as the sheet's, so the two never part. It rides the sheet's swipe (Sheet
 * `riders`): it moves with the sheet, and a drag on it moves the sheet,
 * while its buttons still take a tap.
 */
export function DockRow(props: {
  ref?: Ref<HTMLDivElement>;
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
      ref={props.ref}
      data-rvtt-dock=""
      {...smallUi(props.zoom)}
      style={{
        ...chromeZoom(props.zoom),
        ...GRAB_STYLE,
        position: "absolute",
        left: `calc(${theme.safe.left} + ${theme.space(2)}px)`,
        right: `calc(${theme.safe.right} + ${theme.space(2)}px)`,
        maxWidth: `calc(${SHEET_MAX_WIDTH - 2 * theme.space(2)}px - ${theme.safe.left} - ${theme.safe.right})`,
        margin: "0 auto",
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
 * A map pane shown as a bottom sheet (`on`: a label's, pin's, light's or
 * trap's, features/builder/labelEdit.ts panePlacement) folds the alerts
 * column (fold.ts useFoldUnderPane), and their summary docks on the pane's
 * top edge in its place, as on a panel sheet (docs/design-v1-visual.md
 * 3.2.1), with advice to close the pane. The token bar keeps the panel
 * sheets' rule. `reserve` is the room the pane keeps free above itself
 * under the top bars while the summary shows, so the row never stands
 * over the bars, and the row stands on the pane, never over its header
 * and Close. Where the row and the pane's least height do not both fit
 * (`fits`, fold.ts paneDockFits), the pane keeps no row, and the alerts
 * come back as it closes. The row rides the pane's swipe as a panel
 * sheet's dock does (`row` for PaneDockRow's ref, `riders` for
 * useSheetSwipe).
 */
export function usePaneDock(on: boolean, fits: boolean): { reserve: number; summary: AlertsSummary | null; row: (el: HTMLDivElement | null) => void; riders: readonly (HTMLElement | null)[] } {
  useFoldUnderPane(on);
  const summary = useDockSummary("pane");
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const riders = useMemo(() => [row], [row]);
  const shows = on && fits && summary !== null;
  return { reserve: shows ? DOCK_PX : 0, summary: shows ? summary : null, row: setRow, riders };
}

/**
 * The alerts summary on a map pane's top edge (usePaneDock): `bottom` is
 * where the pane's foot stands, and the row follows the pane's top as the
 * pane grows and shrinks. Its tap closes the pane, and Room shows what it
 * named once the alerts unfold: a roll waiting for this viewer opens, else
 * the alert it names takes focus.
 */
export function PaneDockRow(props: { ref?: Ref<HTMLDivElement>; pane: RefObject<HTMLElement | null>; bottom: number; summary: AlertsSummary; onClose(): void }) {
  const { summary } = props;
  const store = useScoped(dockSlot);
  const rolls = useAlertsSummaryEntry();
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = props.pane.current;
    if (!el) return;
    const read = () => setHeight(el.offsetHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.pane]);
  return (
    <div
      ref={props.ref}
      data-rvtt-pane-dock=""
      style={{
        ...GRAB_STYLE,
        position: "absolute",
        left: `calc(${theme.safe.left} + ${theme.space(2)}px)`,
        right: `calc(${theme.safe.right} + ${theme.space(2)}px)`,
        bottom: props.bottom + height,
        zIndex: theme.z.pane,
        display: "flex",
        justifyContent: "flex-end",
        height: DOCK_PX,
        pointerEvents: "none",
        visibility: height > 0 ? undefined : "hidden",
      }}
    >
      <SummaryButton
        summary={summary}
        onClick={() => {
          store.setState({ paneShow: summary.first.kind === "rolls" && rolls?.waiting ? { kind: "rolls" } : { kind: "alert", first: summary.first } });
          props.onClose();
        }}
        style={{ ...paneLook, flex: "0 1 auto", minWidth: 0, padding: `0 ${theme.space(3)}px` }}
      />
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
  /*
   * Inside a very short sheet while one shows (pages/modalSlot.tsx), where
   * the modal leaves the room's region out of reach. Its record of what it
   * has said stays here, and its region starts empty in its new place, so
   * it speaks only what arrives after the move.
   */
  const slot = useModalSlot("status");
  const [speaksIn, setSpeaksIn] = useState(slot);
  if (speaksIn !== slot) {
    setSpeaksIn(slot);
    setText("");
  }
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
  return inModal(
    <div role="status" data-rvtt-fold-status="" style={VISUALLY_HIDDEN}>
      {text}
    </div>,
    slot,
  );
}

/**
 * An element's height as laid out in the chrome's own pixels, kept up to
 * date: its drawn height divided by the interface size, which zoomed
 * chrome multiplies (features/device/layout.ts). Measured in a layout
 * effect, so what follows it, such as the dock on a sheet's edge, never
 * paints a frame in the wrong place.
 *
 * It holds still while a swipe moves the sheet (lib/sheetSwipe.ts), whose
 * one box change for a drag above its normal top would otherwise render
 * Room on the move, and measures again once the sheet is at rest.
 */
export function useLayoutHeight(el: HTMLElement | null, zoom: number): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!el) {
      setHeight(0);
      return;
    }
    const measure = () => {
      if (!el.hasAttribute(SWIPING_ATTR)) setHeight(el.getBoundingClientRect().height / zoom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener(SWIPE_REST_EVENT, measure);
    return () => {
      observer.disconnect();
      el.removeEventListener(SWIPE_REST_EVENT, measure);
    };
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
