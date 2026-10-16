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
} from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog, DIALOG_PHONE_MAX } from "../../components/Dialog.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Loading } from "../../components/Loading.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useLayoutSize } from "../device/layout.ts";
import { SHORT_LANDSCAPE_MAX } from "../encounter/band.ts";
import { pageMemorySlot, rememberedPage, rememberPage } from "./pageMemory.ts";
import {
  allPagesShown,
  announcesPage,
  canPan,
  clampView,
  currentPage,
  fitScale,
  flingIsFast,
  flingStep,
  FLING_STOP,
  focusHandOff,
  isDoubleTap,
  isTap,
  layoutPages,
  mountedPages,
  pageRects,
  pageStep,
  releaseVelocity,
  resetShown,
  viewerFrame,
  viewerKey,
  viewerStart,
  viewerStep,
  visiblePages,
  wheelScroll,
  zoomInDisabled,
  zoomOutDisabled,
  type PageSize,
  type PinchBase,
  type Point,
  type Rect,
  type ViewerAction,
  type ViewerControl,
  type ViewerState,
  type ZoomView,
} from "./zoom.ts";

/**
 * A page to show. Its size, when known ahead, lays it out before it loads:
 * a handout of pages carries every page's size (docs/design-v1-pdf-handouts.md
 * 3.1). One image does not, so its own size is read once it arrives.
 */
export type ViewerPage = {
  src: string;
  /** The page's small copy, shown stretched to its box while `src` is slow (docs/design-v1-pdf-handouts.md 5.4). */
  thumb?: string;
  alt: string;
  width?: number;
  height?: number;
};

const NO_SIZES: readonly (PageSize | undefined)[] = [];

/** A page's `full` image that has not arrived by now also asks for its `thumb`, so a slow link shows the page soon (decision 8). */
const THUMB_AFTER_MS = 400;
/** The placeholder a page shows until its image arrives: a sheet, so the column reads as pages before anything loads. */
const PAGE_FILL = theme.color.surfaceRaised;

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
 * A handout of several pages reads like a PDF (docs/design-v1-pdf-handouts.md
 * section 5): one column of pages, a page row with Previous page and Next
 * page, the page keys, a fling, and pages that load near the screen. Two
 * layers draw it. The page layer, under the CSS transform, holds only the
 * pages' fills and images. Everything a person reads or presses (each
 * page's border, its loading indicator, its failure and Try again) draws
 * in an overlay in stage pixels, so a control is the same size at any zoom
 * and never sits inside an image's semantics (5.1).
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
  /**
   * Which showing this is (docs/design-v1-pdf-handouts.md 5.1): the popup's
   * `showingKey`, or the Library's `doc:<id>` or `image:<id>`. A new key
   * starts at rest on its remembered page, and the same key arriving again,
   * as a reconnect's resync, keeps the page, the zoom and any gesture.
   */
  showing: string;
  /** Header buttons before Expand, such as the popup's Download or the Library's Delete. */
  headerActions?: ReactNode;
  /**
   * What is shown, in the header under the title: the Library's size,
   * bytes, use and credit (docs/design-v1-pdf-handouts.md 8.4). Small and
   * muted, wrapping as it needs.
   */
  details?: ReactNode;
  /** Lines between the header and the image, such as "The DM shows you". */
  lead?: ReactNode;
  /** Android's Back closes the viewer (lib/backClose.ts). */
  backClose?: boolean;
  /** Where focus returns on close, when not to whatever had it as the viewer opened. */
  opener?: RefObject<HTMLElement | null>;
}) {
  const layout = useLayoutSize();
  const card = layout.width >= DIALOG_PHONE_MAX && layout.height >= SHORT_LANDSCAPE_MAX;
  const memory = useScoped(pageMemorySlot);
  const [state, setState] = useState(() => viewerStart(card, rememberedPage(memory, props.showing)));
  // Ahead of the render, so steps that come in one event (a tap, then the fingers lifting) each start from the last.
  const latest = useRef<ViewerState>(state);
  // The showing the state belongs to, set before the step that starts it, so the page memory never files one showing's page under another's key.
  const shownKey = useRef(props.showing);
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const count = props.pages.length;

  // ---------------------------------------------------------------- where the reader is, said aloud (5.7)

  // A polite line speaks only when its text changes, so each saying ends in a space or not by turns, and the same page said again after a silent move is heard.
  const [status, setStatus] = useState({ text: "", n: 0 });
  const say = useCallback((text: string) => setStatus((now) => ({ text, n: now.n + 1 })), []);

  // Where focus goes when the control that has it leaves under a step (zoom.ts focusHandOff), placed once the step is drawn, when a button the step enables can take it.
  const handTo = useRef<HTMLElement | null>(null);
  // The dialog a part of the viewer left with focus inside (handsOnFocus below).
  const lostIn = useRef<HTMLElement | null>(null);
  const lostFocus = useCallback((next: ViewerState): HTMLElement | null => {
    const refs = { prev: prevRef, next: nextRef, out: zoomOutRef, in: zoomInRef, reset: resetRef };
    const from = (Object.keys(refs) as ViewerControl[]).find((k) => refs[k].current !== null && refs[k].current === document.activeElement);
    const to = from ? focusHandOff(from, next) : null;
    return to ? refs[to].current : null;
  }, []);

  /** Every step goes through here: the focus a step takes away, the page said after a paging move, and the page remembered. */
  const act = useCallback(
    (a: ViewerAction) => {
      const before = latest.current;
      const next = viewerStep(before, a);
      if (next === before) return;
      handTo.current = lostFocus(next) ?? handTo.current;
      latest.current = next;
      setState(next);
      const pages = next.layout?.pages.length ?? 0;
      if (pages < 2 || !viewerFrame(next)) return;
      const page = currentPage(next);
      const was = viewerFrame(before) ? currentPage(before) : null;
      if (page !== was) rememberPage(memory, shownKey.current, page);
      if (announcesPage(a) && page !== was) say(`Page ${page + 1} of ${pages}`);
    },
    [lostFocus, memory, say],
  );
  useLayoutEffect(() => {
    const to = handTo.current;
    handTo.current = null;
    if (to?.isConnected && !(to as HTMLButtonElement).disabled) to.focus({ preventScroll: true });
    const dialog = lostIn.current;
    lostIn.current = null;
    if (!dialog) return;
    // The buttons as this step drew them, enabled or not: a page scrolled to the end enables Previous page in the same step that takes Try again away.
    const stays = [prevRef.current, nextRef.current, zoomInRef.current, zoomOutRef.current].find((b) => b !== null && b.isConnected && !b.disabled);
    (stays ?? dialog.querySelector<HTMLButtonElement>('button[aria-label^="Close"]'))?.focus({ preventScroll: true });
  });

  /*
   * A part of the viewer that leaves while the viewer stays: Expand when
   * the window gets too small for a card, the zoom buttons while another
   * image loads, a page's Try again as its page scrolls out of the
   * overlay. With focus inside, focus goes to a page button or a zoom
   * button that stays, else the viewer's Close, or it would fall to the
   * page under the modal dialog and the keys would stop reaching the
   * viewer. React lets go of a removed element's ref before it takes the
   * element off the page, while focus is still inside. Closing the viewer
   * removes them too, and then where focus goes is the dialog's to decide.
   */
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const handsOnFocus = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return () => {
      if (!mounted.current || !el.contains(document.activeElement)) return;
      // Where it goes is chosen once the step is drawn (the effect above), when the buttons it enables can take it.
      lostIn.current = el.closest("dialog");
    };
  }, []);

  // ---------------------------------------------------------------- the pages' sizes and states

  /*
   * A handout of pages knows every size, so the whole column lays out at
   * once. One image without a size waits until it has loaded, and the
   * stage says it is loading until then (5.4, 5.8).
   */
  const srcKey = props.pages.map((p) => p.src).join("\n");
  const sizeKey = props.pages.map((p) => `${p.width ?? ""}x${p.height ?? ""}`).join(",");
  const known = props.pages.length > 0 && props.pages.every((p) => p.width !== undefined && p.height !== undefined);
  const [sizes, setSizes] = useState<{ key: string; got: (PageSize | undefined)[] }>({ key: srcKey, got: [] });
  // One empty list for every render, or the layout below would be new each time another showing's sizes are still in hand.
  const got = sizes.key === srcKey ? sizes.got : NO_SIZES;
  const ready = known || (props.pages.length > 0 && props.pages.every((_, i) => got[i] !== undefined));
  const knownSizes = useMemo(
    () => (known ? sizeKey.split(",").map((s) => ({ width: Number(s.split("x")[0]), height: Number(s.split("x")[1]) })) : null),
    [known, sizeKey],
  );
  const pagesLayout = useMemo(() => (knownSizes ? layoutPages(knownSizes) : ready ? layoutPages(got as PageSize[]) : null), [knownSizes, ready, got]);
  const loadedSize = (i: number, img: HTMLImageElement) => {
    if (known || img.naturalWidth <= 0) return;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    setSizes((prev) => {
      const list = prev.key === srcKey ? [...prev.got] : [];
      if (list[i]?.width === size.width && list[i]?.height === size.height) return prev;
      list[i] = size;
      return { key: srcKey, got: list };
    });
  };

  // Each page's image: loaded or failed, by its source, and how often its Try again asked for it again.
  const [loads, setLoads] = useState<ReadonlyMap<string, "loaded" | "failed">>(() => new Map());
  const [tries, setTries] = useState<ReadonlyMap<string, number>>(() => new Map());
  const settle = useCallback((src: string, how: "loaded" | "failed") => {
    setLoads((prev) => (prev.get(src) === how ? prev : new Map(prev).set(src, how)));
  }, []);
  const tryAgain = (src: string) => {
    setLoads((prev) => {
      const next = new Map(prev);
      next.delete(src);
      return next;
    });
    setTries((prev) => new Map(prev).set(src, (prev.get(src) ?? 0) + 1));
  };
  // One page keeps today's message over the whole stage. Several fail each in its own box (5.4, 5.8).
  const first = props.pages[0];
  const failedWhole = count === 1 && first !== undefined && loads.get(first.src) === "failed";

  // ---------------------------------------------------------------- measuring

  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    act({ t: "layout", stage: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, [act]);
  useLayoutEffect(() => act({ t: "layout", card }), [act, card]);
  useLayoutEffect(() => act({ t: "layout", layout: pagesLayout }), [act, pagesLayout]);
  /*
   * Measured again before paint whenever the dialog grows or shrinks, so a
   * pinch's kept box, or the point a step keeps at the center, is placed
   * in the new stage before it is ever drawn in the old. Resizes of the
   * window, or of the lines above the stage, come through the observer.
   */
  useLayoutEffect(measure, [measure, state.grown]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  // The room the controls row takes at the stage's bottom, so the last page scrolls clear of it (5.2).
  const shown = viewerFrame(state) !== null && !failedWhole;
  useLayoutEffect(() => {
    const el = controlsRef.current;
    if (!el || count < 2) return;
    const room = () => act({ t: "layout", pad: el.offsetHeight + theme.space(2) * 2 });
    room();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(room);
    observer.observe(el);
    return () => observer.disconnect();
  }, [act, count, shown]);

  // ---------------------------------------------------------------- gestures

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ kind: "pan"; view: ZoomView; start: Point } | ({ kind: "pinch" } & PinchBase) | null>(null);
  const lastTap = useRef<{ at: number; p: Point } | null>(null);
  const moved = useRef(false);
  // This touch landed on a fling, which it only stops: it is no tap, so it cannot start a double tap (5.5).
  const stoppedFling = useRef(false);
  // Two fingers came down during this touch, so its end is no fling.
  const pinched = useRef(false);
  const samples = useRef<{ at: number; p: Point }[]>([]);

  const fling = useRef<number | null>(null);
  const [fast, setFast] = useState(false);
  const stopFling = useCallback(() => {
    if (fling.current !== null) cancelAnimationFrame(fling.current);
    fling.current = null;
    setFast(false);
  }, []);
  useEffect(() => stopFling, [stopFling]);

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

  /**
   * A drag that ends while moving goes on and slows to a stop, as a PDF
   * reader's scroll does (5.5). It draws frames only while it moves, ends
   * at the document's ends or under a small speed, and stops on any key,
   * wheel step, zoom or touch. It runs under reduced motion too, as a
   * phone's own scrolling does, since it follows the finger.
   */
  const startFling = (velocity: Point) => {
    stopFling();
    const stage = latest.current.stage;
    if (!stage) return;
    let speed = velocity;
    let last = performance.now();
    setFast(flingIsFast(speed, stage));
    const frame = (now: number) => {
      const step = flingStep(speed, now - last);
      last = now;
      speed = step.velocity;
      const before = latest.current.view;
      act({ t: "pan", base: drawn(), dx: step.dx, dy: step.dy });
      const after = latest.current.view;
      if (step.done || (after.x === before.x && after.y === before.y)) {
        stopFling();
        return;
      }
      setFast(flingIsFast(speed, stage));
      fling.current = requestAnimationFrame(frame);
    };
    fling.current = requestAnimationFrame(frame);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) {
      moved.current = false;
      pinched.current = false;
      stoppedFling.current = fling.current !== null;
      samples.current = [{ at: e.timeStamp, p: local(e) }];
    } else pinched.current = true;
    stopFling();
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
      samples.current = [...samples.current.slice(-15), { at: e.timeStamp, p }];
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
      if (isTap({ moved: moved.current, lifted: e.type === "pointerup", stoppedFling: stoppedFling.current })) {
        const tap = { at: e.timeStamp, p: local(e) };
        if (isDoubleTap(lastTap.current, tap)) {
          act({ t: "double", at: tap.p });
          lastTap.current = null;
        } else lastTap.current = tap;
      }
      // A finger flings. A mouse drags with no fling.
      const velocity = releaseVelocity(samples.current, e.timeStamp);
      const flings = moved.current && !pinched.current && e.type === "pointerup" && e.pointerType !== "mouse" && Math.hypot(velocity.x, velocity.y) > FLING_STOP;
      // Only now may a pinch on the card grow it.
      act({ t: "release" });
      if (flings && canPan(latest.current)) startFling(velocity);
    }
    rebase();
  };

  // React's wheel listener is passive, so Ctrl with the wheel would also zoom the browser's page. A native listener can claim it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopFling();
      const s = latest.current;
      // Several pages scroll under the wheel, and zoom with Ctrl as a trackpad's pinch sends it.
      if ((s.layout?.pages.length ?? 0) > 1 && !e.ctrlKey) {
        if (s.stage) act({ t: "scroll", ...wheelScroll(e, s.stage) });
        return;
      }
      act({ t: "wheel", at: local(e), factor: Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.002) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [act, stopFling]);

  // The keys work wherever focus is in the dialog: on the dialog itself as it opens, on Download, Expand, a page button or a zoom button.
  useEffect(() => {
    const dialog = stageRef.current?.closest("dialog");
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      stopFling();
      const action = viewerKey(e.key, latest.current, { shift: e.shiftKey, onDialog: e.target === dialog });
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [act, stopFling]);

  // A press on one of the viewer's own buttons stops a fling first, as a key or a wheel step does. The buttons take their own pointers, so the stage never hears them.
  const control = (a: ViewerAction) => {
    stopFling();
    act(a);
  };

  // ---------------------------------------------------------------- another showing (5.1)

  const mountedRef = useRef<ReadonlySet<number>>(new Set());
  useLayoutEffect(() => {
    if (shownKey.current === props.showing) return;
    shownKey.current = props.showing;
    // A new showing drops any gesture and fling, and starts at rest on its remembered page.
    stopFling();
    pointers.current.clear();
    gesture.current = null;
    lastTap.current = null;
    mountedRef.current = new Set();
    act({ t: "pages", start: rememberedPage(memory, props.showing) });
    // The same pages shown anew keep their layout's identity, so its own effect would not lay them out again.
    act({ t: "layout", layout: pagesLayout });
    // Only the key starts a showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showing]);

  // ---------------------------------------------------------------- drawing

  const frame = viewerFrame(state);
  const view = frame ? clampView(state.view, frame) : state.view;
  const fit = state.stage && state.layout ? fitScale(state.stage, state.layout) : 1;
  const outOff = zoomOutDisabled(state);
  const inOff = zoomInDisabled(state);
  const several = count > 1 && state.layout !== null && state.layout.pages.length === count;
  const rects = several ? pageRects(state) : null;
  /*
   * Which images are on the page: for a handout of pages, those near the
   * screen once the stage is measured, and none before, or the first
   * render would ask for all 30 (5.4). One image, and pages whose sizes
   * only their images can tell, mount at once.
   */
  const onScreen = known && count > 1 ? (several && frame ? mountedPages(mountedRef.current, state, fast) : new Set<number>()) : null;
  if (onScreen) mountedRef.current = onScreen;
  const inView = new Set(several ? visiblePages(state, 0) : []);
  const page = several ? currentPage(state) : 0;
  const whole = several && allPagesShown(state);
  const prevOff = !several || pageStep(state, -1) === null;
  const nextOff = !several || pageStep(state, 1) === null;
  const expand = card ? <IconButton ref={handsOnFocus} icon="expand" label="Expand" pressed={state.pinned} onClick={() => control({ t: "expand" })} /> : null;

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
      headerDetail={
        props.details ? <div style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.small, color: theme.color.textMuted, lineHeight: theme.leading.body }}>{props.details}</div> : undefined
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
        style={{
          position: "relative",
          flex: "1 1 0",
          minHeight: 120,
          overflow: "hidden",
          touchAction: "none",
          cursor: canPan(state) ? "grab" : "zoom-in",
        }}
      >
        {failedWhole ? (
          <p role="alert" style={{ margin: 0, padding: theme.space(4), fontSize: theme.font.body14, color: theme.color.textMuted }}>
            The image could not be loaded. Check your connection.
          </p>
        ) : ready && !(first !== undefined && count === 1 && loads.get(first.src) !== "loaded") ? null : (
          // A handout is up to 2048 px, seconds on a slow phone. One page says so over the whole stage, as built, its size known or not.
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
          {props.pages.map((p, i) => (
            <PageImage
              key={`${i}:${p.src}`}
              page={p}
              box={pagesLayout?.pages[i]}
              placeholder={known}
              mounted={onScreen ? onScreen.has(i) : true}
              soon={!onScreen || inView.has(i)}
              loaded={loads.get(p.src) === "loaded"}
              failed={several && loads.get(p.src) === "failed"}
              attempt={tries.get(p.src) ?? 0}
              onSize={(img) => loadedSize(i, img)}
              onSettle={(how) => settle(p.src, how)}
            />
          ))}
        </div>
        {rects && state.stage ? (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {rects.map((r, i) => {
              const p = props.pages[i];
              const stage = state.stage!;
              // Only the pages that meet the stage draw anything here.
              if (!p || r.top >= stage.height || r.top + r.height <= 0 || r.left >= stage.width || r.left + r.width <= 0) return null;
              return <PageOverlay key={`${i}:${p.src}`} rect={r} stage={stage} pad={state.pad} number={i + 1} state={loads.get(p.src)} onRetry={() => tryAgain(p.src)} handsOnFocus={handsOnFocus} />;
            })}
          </div>
        ) : null}
        {shown ? (
          /*
           * The page row at the left of the stage's bottom edge and the
           * zoom buttons at its right. Where both do not fit side by side,
           * as on a 320 px phone while magnified, the page row wraps onto
           * its own line above. They never overlap (5.3). Each group takes
           * its own presses: the stage would capture the pointer, and the
           * click would never reach them.
           */
          <div
            ref={controlsRef}
            style={{
              position: "absolute",
              left: theme.space(2),
              right: theme.space(2),
              bottom: theme.space(2),
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-end",
              gap: theme.space(2),
              pointerEvents: "none",
            }}
          >
            {several ? (
              <div ref={handsOnFocus} onPointerDown={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: theme.space(2), pointerEvents: "auto" }}>
                <IconButton ref={prevRef} icon="back" label="Previous page" disabled={prevOff} onClick={() => control({ t: "step", dir: -1 })} style={overLook(prevOff)} />
                {/* The page buttons and the status line say the page to a screen reader. */}
                <span aria-hidden style={INDICATOR}>
                  {whole ? `All ${count} pages` : `${page + 1} of ${count}`}
                </span>
                <IconButton ref={nextRef} icon="chevronRight" label="Next page" disabled={nextOff} onClick={() => control({ t: "step", dir: 1 })} style={overLook(nextOff)} />
              </div>
            ) : null}
            <div
              ref={handsOnFocus}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: theme.space(2), pointerEvents: "auto" }}
            >
              <IconButton ref={zoomOutRef} icon="minus" label="Zoom out" disabled={outOff} onClick={() => control({ t: "out" })} style={overLook(outOff)} />
              <IconButton ref={zoomInRef} icon="plus" label="Zoom in" disabled={inOff} onClick={() => control({ t: "in" })} style={overLook(inOff)} />
              {resetShown(state) ? (
                <Button ref={resetRef} size="sm" onClick={() => control({ t: "reset" })} style={{ background: theme.color.overlay }}>
                  Reset zoom
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div role="status" style={VISUALLY_HIDDEN}>
        {status.text === "" ? "" : `${status.text}${status.n % 2 === 0 ? "\u00a0" : ""}`}
      </div>
    </Dialog>
  );
}

/**
 * A page in the page layer: its fill at its exact size, and its image once
 * it is near the screen, with its `thumb` stretched under it while the
 * `full` image is slow. The page has one name: its image's `alt` once
 * mounted, else its fill's, so a screen reader finds every page in order,
 * loaded or not (5.7). One image without a size has no fill, as built.
 */
function PageImage(props: {
  page: ViewerPage;
  box: Rect | undefined;
  /** The page's size is known, so its fill holds its place until the image arrives. */
  placeholder: boolean;
  mounted: boolean;
  /** In view: its image is asked for ahead of the pages beyond (5.4). */
  soon: boolean;
  loaded: boolean;
  /** Failed in its own box: its image steps aside, so the fill takes the page's name back and no broken image shows. */
  failed: boolean;
  attempt: number;
  onSize(img: HTMLImageElement): void;
  onSettle(how: "loaded" | "failed"): void;
}) {
  const { page, box } = props;
  const [slow, setSlow] = useState(false);
  // Only a page laid out ahead has a box for its thumb. One image without a size waits for its own, as built.
  const waiting = props.placeholder && props.mounted && !props.loaded && page.thumb !== undefined;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), THUMB_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  const place: CSSProperties = { position: "absolute", display: "block", left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width, height: box?.height, maxWidth: "none" };
  const image: CSSProperties = { ...place, userSelect: "none", WebkitUserSelect: "none" };
  const loaded = (img: HTMLImageElement) => {
    props.onSize(img);
    props.onSettle("loaded");
  };
  const imaged = props.mounted && !props.failed;
  return (
    <>
      {props.placeholder ? (
        <div role={imaged ? undefined : "img"} aria-label={imaged ? undefined : page.alt} aria-hidden={imaged ? true : undefined} style={{ ...place, background: PAGE_FILL }} />
      ) : null}
      {waiting && slow && page.thumb ? <img src={page.thumb} alt="" aria-hidden draggable={false} decoding="async" style={image} /> : null}
      {imaged ? (
        <img
          key={props.attempt}
          src={page.src}
          alt={page.alt}
          draggable={false}
          decoding="async"
          fetchPriority={props.soon ? "high" : "low"}
          onLoad={(e) => loaded(e.currentTarget)}
          onError={() => props.onSettle("failed")}
          ref={(img) => {
            // An image the browser already holds can finish before React listens.
            if (img?.complete && img.naturalWidth > 0) loaded(img);
          }}
          style={image}
        />
      ) : null}
    </>
  );
}

/**
 * What a page shows over itself, in stage pixels: its border, the shared
 * loading indicator once it has waited, and its failure with Try again,
 * placed in the part of the page on the stage so a tall page's message is
 * never off screen. A sibling of the page's image, never inside it (5.4).
 */
function PageOverlay(props: {
  rect: Rect;
  stage: Rect;
  /** The controls row's room at the stage's bottom. */
  pad: number;
  number: number;
  state: "loaded" | "failed" | undefined;
  onRetry(): void;
  handsOnFocus(el: HTMLElement | null): (() => void) | undefined;
}) {
  const { rect, stage } = props;
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  // The room above the controls row, so a message never sits under the page buttons.
  const visible = { left, top, width: Math.min(stage.width, rect.left + rect.width) - left, height: Math.min(stage.height - props.pad, rect.top + rect.height) - top };
  return (
    <>
      <div aria-hidden style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, outline: `${theme.line.border}px solid ${theme.color.border}` }} />
      {props.state === undefined && visible.height >= LOADING_ROOM ? (
        <div style={{ position: "absolute", ...visible, display: "grid", placeItems: "center" }}>
          <Loading text={`Loading page ${props.number}…`} style={{ padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.overlay }} />
        </div>
      ) : props.state === "failed" && visible.height >= FAILURE_ROOM ? (
        <div style={{ position: "absolute", ...visible, display: "grid", placeItems: "center", padding: theme.space(2) }}>
          <div
            ref={props.handsOnFocus}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              display: "grid",
              justifyItems: "center",
              gap: theme.space(2),
              maxWidth: "100%",
              padding: theme.space(3),
              borderRadius: theme.radius.md,
              background: theme.color.overlay,
              pointerEvents: "auto",
              textAlign: "center",
            }}
          >
            <p style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.text }}>Page {props.number} could not be loaded.</p>
            <Button size="sm" onClick={props.onRetry}>
              Try page {props.number} again
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A page's message shows once this much of the page is in the room above
 * the controls row: a sliver at the stage's edge would show a cut-off
 * message or a button half under the page buttons. It comes as the page
 * scrolls in.
 */
const LOADING_ROOM = 44;
const FAILURE_ROOM = 140;

const INDICATOR: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: theme.touch,
  padding: `0 ${theme.space(2)}px`,
  borderRadius: theme.radius.md,
  background: theme.color.overlay,
  color: theme.color.text,
  fontSize: theme.font.body14,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** The zoom buttons on the overlay's fill, as Reset zoom beside them, so they read on any picture. */
function overLook(disabled: boolean): CSSProperties {
  return { background: theme.color.overlay, border: `${theme.line.border}px solid ${theme.color.border}`, color: disabled ? theme.color.textDisabled : theme.color.text };
}
