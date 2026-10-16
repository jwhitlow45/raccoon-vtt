import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog, DIALOG_PHONE_MAX } from "../../components/Dialog.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useLayoutSize } from "../device/layout.ts";
import { SHORT_LANDSCAPE_MAX } from "../encounter/band.ts";
import {
  canPan,
  clampView,
  fitScale,
  isDoubleTap,
  layoutPages,
  viewerFrame,
  viewerKey,
  viewerStart,
  viewerStep,
  zoomInDisabled,
  zoomOutDisabled,
  type PageSize,
  type PinchBase,
  type Point,
  type ViewerAction,
  type ViewerState,
  type ZoomView,
} from "./zoom.ts";

/**
 * A page to show. Its size, when known ahead, lays it out before it loads.
 * A handout's is not (the room's state does not hold it), so the image's
 * own size is read once it arrives.
 */
export type ViewerPage = { src: string; alt: string; width?: number; height?: number };

/**
 * The one way to look at an image large (docs/design-v1-layout-hierarchy.md
 * section 5): a handout the DM shows (HandoutPopup.tsx), and any image in
 * the Library (images/LibraryGrid.tsx).
 *
 * The image fills the dialog's whole body, so a zoom grows into all the
 * room there is rather than inside a box the size of the fitted image.
 * Where a card fits (a layout at least 600 x 500), the dialog opens as one
 * and grows to the window on the first zoom step in, or when a pinch ends
 * past its fit. A pinch never resizes the card under the fingers, since
 * that would move the pinch's baseline. Elsewhere it fills the screen from
 * the start. zoom.ts viewerStep holds every state and step.
 *
 * The dialog keeps 100% whatever the interface size (`zoom={false}`): its
 * image pans and pinches under the finger, which a zoomed box would put in
 * other units than the pointer. touch-action: none on the stage hands
 * every touch here, so the page itself never zooms.
 */
export function HandoutViewer(props: {
  title: string;
  onClose(): void;
  pages: readonly ViewerPage[];
  /** Header buttons before Expand, such as the popup's Download. */
  headerActions?: ReactNode;
  /** Lines between the header and the image, such as "The DM shows you". */
  lead?: ReactNode;
  /** Android's Back closes the viewer (lib/backClose.ts). */
  backClose?: boolean;
  /** Where focus returns on close, when not to whatever had it as the viewer opened. */
  opener?: RefObject<HTMLElement | null>;
}) {
  const layout = useLayoutSize();
  const card = layout.width >= DIALOG_PHONE_MAX && layout.height >= SHORT_LANDSCAPE_MAX;
  const [state, setState] = useState(() => viewerStart(card));
  // Ahead of the render, so steps that come in one event (a tap, then the fingers lifting) each start from the last.
  const latest = useRef<ViewerState>(state);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);

  /**
   * Every step goes through here. A step that disables the button pressed
   * (Zoom out at the floor, Zoom in at 6 times) or hides it (Reset zoom)
   * hands focus to the other zoom button first, or focus would fall to the
   * page under the modal dialog and the keys would stop reaching it.
   */
  const act = useCallback((a: ViewerAction) => {
    const before = latest.current;
    const next = viewerStep(before, a);
    if (next === before) return;
    const active = document.activeElement;
    const lost =
      (active === zoomOutRef.current && zoomOutDisabled(next)) || (active === resetRef.current && zoomOutDisabled(next)) || (active === zoomInRef.current && zoomInDisabled(next));
    if (lost) (zoomInDisabled(next) ? zoomOutRef.current : zoomInRef.current)?.focus({ preventScroll: true });
    latest.current = next;
    setState(next);
  }, []);

  // The pages' sizes, for the pages now shown. Until every one has its size, the stage says it is loading.
  const srcKey = props.pages.map((p) => p.src).join("\n");
  const [sizes, setSizes] = useState<{ key: string; got: (PageSize | undefined)[] }>({ key: srcKey, got: [] });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const got = sizes.key === srcKey ? sizes.got : [];
  const ready = props.pages.length > 0 && props.pages.every((_, i) => got[i] !== undefined);
  const failed = failedKey === srcKey;
  const pagesLayout = useMemo(() => (ready ? layoutPages(got as PageSize[]) : null), [ready, got]);
  const loadedPage = (i: number, img: HTMLImageElement) => {
    if (img.naturalWidth <= 0) return;
    const page = props.pages[i];
    const size = { width: page?.width ?? img.naturalWidth, height: page?.height ?? img.naturalHeight };
    setSizes((prev) => {
      const list = prev.key === srcKey ? [...prev.got] : [];
      if (list[i]?.width === size.width && list[i]?.height === size.height) return prev;
      list[i] = size;
      return { key: srcKey, got: list };
    });
  };

  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    act({ t: "layout", stage: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, [act]);
  useLayoutEffect(() => act({ t: "layout", card }), [act, card]);
  useLayoutEffect(() => act({ t: "layout", layout: pagesLayout }), [act, pagesLayout]);
  // The next handout starts at rest. The first pages already do.
  const shownKey = useRef(srcKey);
  useLayoutEffect(() => {
    if (shownKey.current === srcKey) return;
    shownKey.current = srcKey;
    act({ t: "pages" });
  }, [act, srcKey]);
  /*
   * Measured again before paint whenever the dialog grows or shrinks, so a
   * pinch's kept box is placed in the window's stage before it is ever
   * drawn in the card's. Resizes of the window, or of the lines above the
   * stage, come through the observer.
   */
  useLayoutEffect(measure, [measure, state.grown]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // The keys work wherever focus is in the dialog: on the dialog itself as it opens, on Download, Expand or a zoom button.
  useEffect(() => {
    const dialog = stageRef.current?.closest("dialog");
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const action = viewerKey(e.key, latest.current);
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [act]);

  // ---------------------------------------------------------------- gestures

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ kind: "pan"; view: ZoomView; start: Point } | ({ kind: "pinch" } & PinchBase) | null>(null);
  const lastTap = useRef<{ at: number; p: Point } | null>(null);
  const moved = useRef(false);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };
  const drawn = (): ZoomView => {
    const s = latest.current;
    const frame = viewerFrame(s);
    return frame ? clampView(s.view, frame) : s.view;
  };
  /** A new baseline whenever a finger lands or lifts, so the image never jumps. */
  const rebase = () => {
    const pts = [...pointers.current.values()];
    if (pts.length === 1) gesture.current = { kind: "pan", view: drawn(), start: pts[0]! };
    else if (pts.length === 2) {
      const [a, b] = pts as [Point, Point];
      gesture.current = { kind: "pinch", view: drawn(), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    } else gesture.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) moved.current = false;
    rebase();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) moved.current = true;
      if (canPan(latest.current)) act({ t: "pan", base: g.view, dx: p.x - g.start.x, dy: p.y - g.start.y });
    } else {
      moved.current = true;
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      act({ t: "pinch", base: g, now: { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) } });
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 0) {
      if (!moved.current && e.type === "pointerup") {
        const tap = { at: e.timeStamp, p: local(e) };
        if (isDoubleTap(lastTap.current, tap)) {
          act({ t: "double", at: tap.p });
          lastTap.current = null;
        } else lastTap.current = tap;
      }
      // Only now may a pinch on the card grow it.
      act({ t: "release" });
    }
    rebase();
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    // Several pages scroll under the wheel, and zoom with Ctrl as a trackpad's pinch sends it.
    if ((latest.current.layout?.pages.length ?? 0) > 1 && !e.ctrlKey) {
      act({ t: "scroll", dy: e.deltaY });
      return;
    }
    act({ t: "wheel", at: local(e), factor: Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.002) });
  };

  // ---------------------------------------------------------------- drawing

  const frame = viewerFrame(state);
  const view = frame ? clampView(state.view, frame) : state.view;
  const fit = state.stage && state.layout ? fitScale(state.stage, state.layout) : 1;
  const outOff = zoomOutDisabled(state);
  const inOff = zoomInDisabled(state);
  const shown = frame !== null && !failed;
  const expand = card ? <IconButton icon="expand" label="Expand" pressed={state.pinned} onClick={() => act({ t: "expand" })} /> : null;

  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      width="lg"
      phone="fill"
      full={state.grown}
      scrim={theme.color.overlay}
      dismissOnBackdrop={false}
      zoom={false}
      backClose={props.backClose}
      opener={props.opener}
      headerActions={
        props.headerActions || expand ? (
          <>
            {props.headerActions}
            {expand}
          </>
        ) : undefined
      }
      bodyStyle={{ display: "flex", flexDirection: "column", padding: 0 }}
    >
      {props.lead ? (
        <div style={{ flex: "none", display: "grid", gap: theme.space(2), padding: `${theme.space(3)}px ${theme.space(4)}px ${theme.space(2)}px` }}>{props.lead}</div>
      ) : null}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{
          position: "relative",
          flex: "1 1 0",
          minHeight: 120,
          overflow: "hidden",
          touchAction: "none",
          cursor: canPan(state) ? "grab" : "zoom-in",
        }}
      >
        {failed ? (
          <p role="alert" style={{ margin: 0, padding: theme.space(4), fontSize: theme.font.body14, color: theme.color.textMuted }}>
            The image could not be loaded. Check your connection.
          </p>
        ) : ready ? null : (
          // A handout is up to 2048 px, seconds on a slow phone.
          <Loading text="Loading the image…" style={{ position: "absolute", inset: 0, justifyContent: "center" }} />
        )}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: pagesLayout?.width,
            height: pagesLayout?.height,
            transformOrigin: "0 0",
            transform: frame ? `translate(${view.x}px, ${view.y}px) scale(${fit * view.scale})` : undefined,
            // Laid out but unseen until it has a size, so it never shows at its own size first.
            visibility: shown ? "visible" : "hidden",
          }}
        >
          {props.pages.map((page, i) => {
            const box = pagesLayout?.pages[i];
            return (
              <img
                key={`${i}:${page.src}`}
                src={page.src}
                alt={page.alt}
                draggable={false}
                onLoad={(e) => loadedPage(i, e.currentTarget)}
                onError={() => setFailedKey(srcKey)}
                ref={(img) => {
                  // An image the browser already holds can finish before React listens.
                  if (img?.complete) loadedPage(i, img);
                }}
                style={{
                  position: "absolute",
                  display: "block",
                  left: box?.left ?? 0,
                  top: box?.top ?? 0,
                  width: box?.width,
                  height: box?.height,
                  maxWidth: "none",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                }}
              />
            );
          })}
        </div>
        {shown ? (
          // The buttons take their own taps: the stage would capture the pointer, and the click would never reach them.
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "absolute", right: theme.space(2), bottom: theme.space(2), display: "flex", alignItems: "center", gap: theme.space(2) }}
          >
            <IconButton ref={zoomOutRef} icon="minus" label="Zoom out" disabled={outOff} onClick={() => act({ t: "out" })} style={overLook(outOff)} />
            <IconButton ref={zoomInRef} icon="plus" label="Zoom in" disabled={inOff} onClick={() => act({ t: "in" })} style={overLook(inOff)} />
            {outOff ? null : (
              <Button ref={resetRef} size="sm" onClick={() => act({ t: "reset" })} style={{ background: theme.color.overlay }}>
                Reset zoom
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The zoom buttons on the overlay's fill, as Reset zoom beside them, so they read on any picture. */
function overLook(disabled: boolean): CSSProperties {
  return { background: theme.color.overlay, border: `${theme.line.border}px solid ${theme.color.border}`, color: disabled ? theme.color.textDisabled : theme.color.text };
}
