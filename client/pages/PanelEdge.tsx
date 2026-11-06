import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { applyPanelWidth, restorePanelWidth, setPanelWidth } from "../features/device/settings.ts";
import { keyboardFocus } from "../lib/inputModality.ts";
import { theme } from "../lib/theme.ts";
import { dragWidth, edgeKey, keyWrite, PANEL_MIN, releaseWrite, resetWrite, widthAt, widthText, type WidthWrite } from "./panelWidth.ts";

/**
 * The side panel's edge (docs/design/design-v1-panel-size.md 4.1): a strip
 * on the aside's left border, 8 px over the map, the 1 px border and 4 px
 * into the panel, that a drag, a double-click or the keys resize the panel
 * from. It stands under every map layer with a z (theme.z.panelEdge), so a
 * control at the map's right edge keeps its presses.
 *
 * A drag shows through the setting's page-only `apply` and the release
 * commits or restores (pages/panelWidth.ts releaseWrite), as the split
 * bar's and the token window's drags do: Escape, a cancelled pointer, S
 * hiding the panel and the layout dropping under 900 px, which unmounts
 * the edge, put it back and store nothing.
 */

/** The strip's parts in its own px: over the map, the aside's border, then into the panel. */
const OVER_MAP = 8;
const INTO_PANEL = 4;
const STRIP = OVER_MAP + theme.line.border + INTO_PANEL;
/** The border's middle, from the strip's left, which the grip and the pressed line are centered on. */
const BORDER_MID = OVER_MAP + theme.line.border / 2;
const GRIP = { width: 6, height: 32 };
const LINE = 3;

type Drag = { pointerId: number; el: HTMLElement; x: number; start: number; width: number | null };

/** Whether any pointer is coarse, read live, so a tablet joined to a mouse or a finger on a touch laptop finds the larger grip. */
const COARSE = "(any-pointer: coarse)";
function subscribeCoarse(listener: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(COARSE);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function anyCoarse(): boolean {
  return typeof matchMedia === "function" && matchMedia(COARSE).matches;
}
const noCoarse = () => false;

export function PanelEdge(props: {
  ref?: Ref<HTMLDivElement>;
  /** The width the panel draws now, and the most it may draw in this layout. */
  width: number;
  cap: number;
  /** What this device stores, which the reset compares with. */
  stored: number | null;
  /** The layout's width, which the bounds follow (pages/panelWidth.ts panelCap). */
  layoutWidth: number;
  zoom: number;
  hidden: boolean;
  /** The aside's id. */
  controls: string;
}) {
  const coarse = useSyncExternalStore(subscribeCoarse, anyCoarse, noCoarse);
  const [pressed, setPressed] = useState(false);
  const [keyFocus, setKeyFocus] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  const dragRef = useRef<Drag | null>(null);
  /** Ends a drag. A drag that moved goes back to the device's own width unless its release already wrote one. */
  const endDrag = useRef((_restore: boolean) => {});
  const onEscape = useRef((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Taken first, in the capture phase, and its preventDefault leaves Room's Escape alone, as the split bar's does.
    e.preventDefault();
    endDrag.current(true);
  });
  endDrag.current = (restore) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPressed(false);
    window.removeEventListener("keydown", onEscape.current, true);
    if (drag?.el.hasPointerCapture(drag.pointerId)) drag.el.releasePointerCapture(drag.pointerId);
    if (restore && drag?.width !== null && drag?.width !== undefined) restorePanelWidth();
  };
  // S hiding the panel ends a drag as a cancelled pointer does, and so does the edge leaving, as it does under 900 px.
  useEffect(() => {
    if (props.hidden && dragRef.current) endDrag.current(true);
  }, [props.hidden]);
  useEffect(() => () => endDrag.current(true), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // One pointer at a time, and a mouse's main button only.
    if (dragRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    // No text selection starts across the panel as the pointer moves.
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, el: e.currentTarget, x: e.clientX, start: props.width, width: null };
    setPressed(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = dragWidth({ start: drag.start, fromX: drag.x, toX: e.clientX, zoom: props.zoom, layoutWidth: props.layoutWidth, moved: drag.width !== null });
    if (next === null) return;
    if (drag.width === null) window.addEventListener("keydown", onEscape.current, true);
    if (next === drag.width) return;
    drag.width = next;
    applyPanelWidth(next);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.width !== null) write(releaseWrite(drag.start, drag.width));
    endDrag.current(false);
  };
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) endDrag.current(true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || dragRef.current) return;
    const key = edgeKey(e.key, e.shiftKey);
    if (key === null) return;
    e.preventDefault();
    // A key on the edge is the keyboard's, whatever moved focus here.
    setKeyFocus(true);
    const p = latest.current;
    if (key.kind === "home") resetPanelWidth(p.stored);
    else write(keyWrite(p.width, key.kind === "end" ? p.cap : widthAt(p.width, key.delta, p.layoutWidth)));
  };

  const active = pressed || keyFocus;
  return (
    <div
      ref={props.ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Side panel width"
      aria-controls={props.controls}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={props.cap}
      aria-valuenow={props.width}
      aria-valuetext={widthText(props.width)}
      data-panel-edge=""
      // The ring goes on the grip alone (globals.css's pill rule): one round the whole strip covered the party dock's first letters.
      data-pill-focus=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={() => resetPanelWidth(latest.current.stored)}
      onKeyDown={onKeyDown}
      onFocus={(e) => setKeyFocus(keyboardFocus(e.currentTarget))}
      onBlur={() => setKeyFocus(false)}
      style={STRIP_STYLE}
    >
      <span aria-hidden style={{ ...LINE_STYLE, ...(active ? null : { display: "none" }) }} />
      <span aria-hidden data-pill="" data-edge-grip="" style={{ ...GRIP_STYLE, ...(active ? { background: theme.color.accent, borderColor: theme.color.accent } : null) }} />
      {/* On a coarse pointer the grip takes a finger's 44 px, all over the map, so it never takes the split bar's grip or a row in the panel at that height. */}
      {coarse ? <span aria-hidden data-edge-hit="" style={HIT_STYLE} /> : null}
    </div>
  );
}

/** Double-click, Home and Reset width: the default, stored whenever the stored width is not already it. */
export function resetPanelWidth(stored: number | null): void {
  write(resetWrite(stored));
}

function write(w: WidthWrite): void {
  if (w.kind === "set") setPanelWidth(w.value);
  else if (w.kind === "restore") restorePanelWidth();
}

const STRIP_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  // From the aside's padding box, whose left is the border's right.
  left: -(OVER_MAP + theme.line.border),
  width: STRIP,
  zIndex: theme.z.panelEdge,
  cursor: "col-resize",
  touchAction: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
};

const LINE_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: BORDER_MID - LINE / 2,
  width: LINE,
  background: theme.color.accent,
  pointerEvents: "none",
};

const GRIP_STYLE: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: BORDER_MID - GRIP.width / 2,
  width: GRIP.width,
  height: GRIP.height,
  marginTop: -GRIP.height / 2,
  boxSizing: "border-box",
  borderRadius: theme.radius.pill,
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
  pointerEvents: "none",
};

const HIT_STYLE: CSSProperties = {
  position: "absolute",
  top: "50%",
  width: theme.touch,
  height: theme.touch,
  marginTop: -theme.touch / 2,
  // Its right edge is the border's right, so it reaches 43 px over the map and none into the panel.
  left: OVER_MAP + theme.line.border - theme.touch,
};
