/**
 * The handout viewer's zoom (docs/design-v1-layout-hierarchy.md section 5).
 * The room stops the page itself from zooming (a pinch on a phone would
 * otherwise strand the player in a zoomed page), so a handout's small print
 * needs a zoom of its own: pinch, double tap, the wheel, the zoom buttons
 * and keys, with Reset.
 *
 * The stage is the dialog's whole body under its header, not a box the
 * size of the fitted image, so a zoom grows into all the room there is.
 * The pages lie in one column (layoutPages). At rest they fit the stage,
 * centered. A view's `scale` multiplies that fit, so 1 is the fit and
 * MAX_ZOOM the most, and `x` and `y` place the pages' top-left corner in
 * stage pixels. The pages are drawn by a CSS transform from that corner,
 * and never leave a gap at an edge once larger than the stage, so a pan
 * cannot lose them.
 *
 * Where the viewer is a card (a layout at least 600 x 500), it has three
 * states: card fit, window fit (the card grown to the window, the pages
 * fitted to that larger stage) and magnified (grown and zoomed past that
 * fit). viewerStep is every step between them, so the component only
 * measures, draws and passes on what the hands and keys do.
 */

export type ZoomView = { scale: number; x: number; y: number };
export type Box = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };
/** The stage, and the pages' size at the fit. */
export type Frame = { stage: Box; fitted: Box };

export const MAX_ZOOM = 6;
/** One double tap zooms this far, enough to read a letter's handwriting on a phone. */
export const TAP_ZOOM = 2.5;
/** Each press of Zoom in or Zoom out past the window's fit. */
export const STEP_ZOOM = 1.5;
/** Between pages, in the pages' own pixels. */
export const PAGE_GAP = 16;
/**
 * A pinch on a card must end past this to grow the card. Two fingers that
 * only rested on the picture jitter by a percent or so, and the card
 * should not jump to the window under them.
 */
export const PINCH_GROWS = 1.02;
/** A scale this close to the fit is the fit, so steps that multiply and divide by 1.5 land on it exactly. */
const SNAP = 1e-3;

/** The fit. clampView centers it, whatever its corner says. */
export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

// ---------------------------------------------------------------- the pages

export type PageSize = { width: number; height: number };
export type PagesLayout = Box & { pages: Rect[] };

/** The pages in one column, each centered across the widest, with a gap between. */
export function layoutPages(pages: readonly PageSize[], gap: number = PAGE_GAP): PagesLayout {
  const width = pages.reduce((most, p) => Math.max(most, p.width), 0);
  let top = 0;
  const boxes = pages.map((p) => {
    const box = { left: (width - p.width) / 2, top, width: p.width, height: p.height };
    top += p.height + gap;
    return box;
  });
  return { width, height: boxes.length > 0 ? top - gap : 0, pages: boxes };
}

/** One page fits whole. Several fit the widest page's width, and the rest is reached by scrolling down. */
export function fitScale(stage: Box, layout: PagesLayout): number {
  if (layout.width <= 0 || layout.height <= 0) return 1;
  const across = stage.width / layout.width;
  return layout.pages.length > 1 ? across : Math.min(across, stage.height / layout.height);
}

export function frameOf(stage: Box, layout: PagesLayout): Frame {
  const fit = fitScale(stage, layout);
  return { stage: { width: stage.width, height: stage.height }, fitted: { width: layout.width * fit, height: layout.height * fit } };
}

// ---------------------------------------------------------------- moving the view

/**
 * Within the zoom's range, and inside the stage: centered across or down
 * where the pages are narrower or shorter than the stage that way, and
 * with no gap at an edge where they are larger.
 */
export function clampView(v: ZoomView, frame: Frame): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale));
  const place = (at: number, stage: number, fitted: number) => {
    const size = fitted * scale;
    return size <= stage ? (stage - size) / 2 : Math.min(0, Math.max(stage - size, at));
  };
  return { scale, x: place(v.x, frame.stage.width, frame.fitted.width), y: place(v.y, frame.stage.height, frame.fitted.height) };
}

/** Zooms by `factor`, keeping the point of the pages under `anchor` (in stage pixels) where it is. */
export function zoomAround(v: ZoomView, anchor: Point, factor: number, frame: Frame): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale * factor));
  const grow = scale / v.scale;
  return clampView({ scale, x: anchor.x - (anchor.x - v.x) * grow, y: anchor.y - (anchor.y - v.y) * grow }, frame);
}

export type PinchBase = { view: ZoomView; mid: Point; dist: number };

/**
 * A pinch, from the view and the fingers when the second one landed. Worked
 * out from that baseline every time, so the point between the fingers
 * stays under them with no drift, and moving both fingers pans.
 */
export function pinchView(base: PinchBase, now: { mid: Point; dist: number }, frame: Frame): ZoomView {
  const ratio = base.dist > 0 ? now.dist / base.dist : 1;
  const scale = Math.min(MAX_ZOOM, Math.max(1, base.view.scale * ratio));
  const grow = scale / base.view.scale;
  return clampView({ scale, x: now.mid.x - (base.mid.x - base.view.x) * grow, y: now.mid.y - (base.mid.y - base.view.y) * grow }, frame);
}

export function panView(base: ZoomView, dx: number, dy: number, frame: Frame): ZoomView {
  return clampView({ scale: base.scale, x: base.x + dx, y: base.y + dy }, frame);
}

/** Two taps this close in time and place make a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

export function isDoubleTap(prev: { at: number; p: Point } | null, now: { at: number; p: Point }): boolean {
  return prev !== null && now.at - prev.at <= DOUBLE_TAP_MS && Math.hypot(now.p.x - prev.p.x, now.p.y - prev.p.y) <= DOUBLE_TAP_PX;
}

// ---------------------------------------------------------------- the viewer's states (5.1)

export type ViewerState = {
  /** A card layout, at least 600 x 500. Elsewhere the viewer fills the screen from the start and has no card fit. */
  card: boolean;
  /** The dialog fills the window. Always so where `card` is false. */
  grown: boolean;
  /** Expand is pressed: the dialog keeps the window's size at any zoom. */
  pinned: boolean;
  /** Against the stage measured last, which the component keeps up to date. */
  view: ZoomView;
  /** The stage's box on the screen, once measured. */
  stage: Rect | null;
  /** The pages, once every one has a size. */
  layout: PagesLayout | null;
  /**
   * Set as a pinch's end grows the card: the pages' box on the screen,
   * which the window's stage takes over once it is laid out, so the
   * picture stays where the fingers left it.
   */
  keep: Rect | null;
};

export type ViewerAction =
  /** Zoom in: the button, + or =. */
  | { t: "in" }
  /** Zoom out: the button or −. */
  | { t: "out" }
  /** Reset zoom: the button or 0. */
  | { t: "reset" }
  | { t: "expand" }
  /** A wheel step about the pointer, `factor` above 1 to zoom in. */
  | { t: "wheel"; at: Point; factor: number }
  /** The wheel over several pages, which scrolls them rather than zooming. */
  | { t: "scroll"; dy: number }
  | { t: "double"; at: Point }
  | { t: "pinch"; base: PinchBase; now: { mid: Point; dist: number } }
  | { t: "pan"; base: ZoomView; dx: number; dy: number }
  /** An arrow key, a tenth of the stage each way. */
  | { t: "arrow"; dx: number; dy: number }
  /** The last finger lifted. */
  | { t: "release" }
  /** What the component measured: the layout's kind, the stage's box, the pages. */
  | { t: "layout"; card?: boolean; stage?: Rect; layout?: PagesLayout | null }
  /** Other pages to show, such as the next handout, which start at rest. */
  | { t: "pages" };

export type ViewerPhase = "card" | "window" | "magnified";

export function viewerStart(card: boolean): ViewerState {
  return { card, grown: !card, pinned: false, view: FIT, stage: null, layout: null, keep: null };
}

export function viewerFrame(s: ViewerState): Frame | null {
  return s.stage && s.layout ? frameOf(s.stage, s.layout) : null;
}

/** "card" while the dialog is a card, a pinch on it included. */
export function viewerPhase(s: ViewerState): ViewerPhase {
  if (!s.grown) return "card";
  return s.view.scale < 1 + SNAP ? "window" : "magnified";
}

/**
 * At the state's floor: card fit, or the window's fit where the window is
 * the floor (a whole-screen layout, or Expand pressed). Zoom out is then
 * disabled and Reset zoom hidden, as both would do nothing.
 */
export function zoomOutDisabled(s: ViewerState): boolean {
  const phase = viewerPhase(s);
  if (phase === "card") return s.view.scale < 1 + SNAP;
  return phase === "window" && windowIsFloor(s);
}

/** At 6 times the window's fit. */
export function zoomInDisabled(s: ViewerState): boolean {
  return s.grown && s.view.scale > MAX_ZOOM - SNAP;
}

/** The pages' box on the screen, as drawn now. */
export function contentBox(s: ViewerState): Rect | null {
  const frame = viewerFrame(s);
  if (!frame || !s.stage) return null;
  const v = clampView(s.view, frame);
  return { left: s.stage.left + v.x, top: s.stage.top + v.y, width: frame.fitted.width * v.scale, height: frame.fitted.height * v.scale };
}

/** Whether the pages are larger than the stage either way, so the arrow keys have somewhere to pan. */
export function canPan(s: ViewerState): boolean {
  const frame = viewerFrame(s);
  if (!frame) return false;
  const scale = clampView(s.view, frame).scale;
  return frame.fitted.width * scale > frame.stage.width + 0.5 || frame.fitted.height * scale > frame.stage.height + 0.5;
}

/** What a key does while focus is in the viewer, or null to leave it alone. */
export function viewerKey(key: string, s: ViewerState): ViewerAction | null {
  switch (key) {
    case "+":
    case "=":
      return { t: "in" };
    case "-":
      return { t: "out" };
    case "0":
      return { t: "reset" };
  }
  if (!canPan(s)) return null;
  switch (key) {
    case "ArrowLeft":
      return { t: "arrow", dx: -1, dy: 0 };
    case "ArrowRight":
      return { t: "arrow", dx: 1, dy: 0 };
    case "ArrowUp":
      return { t: "arrow", dx: 0, dy: -1 };
    case "ArrowDown":
      return { t: "arrow", dx: 0, dy: 1 };
  }
  return null;
}

function windowIsFloor(s: ViewerState): boolean {
  return !s.card || s.pinned;
}

/** The view kept inside the stage measured last, where there is one. */
function settled(s: ViewerState): ViewerState {
  const frame = viewerFrame(s);
  return frame ? { ...s, view: clampView(s.view, frame) } : s;
}

/** The window's fit. The next layout measures the larger stage and centers the pages in it. */
function windowFit(s: ViewerState): ViewerState {
  return settled({ ...s, grown: true, keep: null, view: FIT });
}

/** Where Reset zoom goes: card fit, unless the window is the floor. */
function rest(s: ViewerState): ViewerState {
  return windowIsFloor(s) ? windowFit(s) : settled({ ...s, grown: false, keep: null, view: FIT });
}

/** A zoom about a point of the stage, its center when none is given. Under the fit it stops at the fit. */
function zoomed(s: ViewerState, at: Point | null, factor: number): ViewerState {
  const frame = viewerFrame(s);
  if (!frame) return s;
  const view = zoomAround(s.view, at ?? { x: frame.stage.width / 2, y: frame.stage.height / 2 }, factor, frame);
  return { ...s, view: view.scale < 1 + SNAP ? clampView(FIT, frame) : view };
}

/** A step out: toward the window's fit while magnified, then to the card unless the window is the floor. */
function stepOut(s: ViewerState, out: (s: ViewerState) => ViewerState): ViewerState {
  if (!s.grown) return s;
  if (s.view.scale >= 1 + SNAP) return out(s);
  return windowIsFloor(s) ? s : rest(s);
}

function panned(s: ViewerState, dx: number, dy: number): ViewerState {
  const frame = viewerFrame(s);
  return frame ? { ...s, view: panView(s.view, dx, dy, frame) } : s;
}

/**
 * The pages' box from before the card grew, in the window's stage: the
 * same size on the screen, so the scale is worked out again against the
 * window's fit, and the same place, shifted only as far as clamping needs.
 * Never under the window's fit: a pinch that ended short of it settles
 * there, centered.
 */
function keptIn(s: ViewerState, keep: Rect): ViewerState {
  const frame = viewerFrame(s);
  if (!frame || !s.stage) return { ...s, keep: null };
  const scale = frame.fitted.width > 0 ? keep.width / frame.fitted.width : 1;
  const view = scale < 1 + SNAP ? FIT : { scale, x: keep.left - s.stage.left, y: keep.top - s.stage.top };
  return { ...s, keep: null, view: clampView(view, frame) };
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export function viewerStep(s: ViewerState, a: ViewerAction): ViewerState {
  switch (a.t) {
    case "in":
      return s.grown ? zoomed(s, null, STEP_ZOOM) : windowFit(s);
    case "out":
      return stepOut(s, (st) => zoomed(st, null, 1 / STEP_ZOOM));
    case "reset":
      return rest(s);
    case "expand":
      // Pressed on a grown card, the zoom stays: the card is at the window's size already.
      if (!s.pinned) return s.grown ? { ...s, pinned: true } : windowFit({ ...s, pinned: true });
      return rest({ ...s, pinned: false });
    case "wheel":
      if (a.factor > 1) return s.grown ? zoomed(s, a.at, a.factor) : windowFit(s);
      if (a.factor < 1) return stepOut(s, (st) => zoomed(st, a.at, a.factor));
      return s;
    case "scroll":
      return panned(s, 0, -a.dy);
    case "double":
      if (!s.grown) return windowFit(s);
      return s.view.scale >= 1 + SNAP ? windowFit(s) : zoomed(s, a.at, TAP_ZOOM);
    case "pinch": {
      const frame = viewerFrame(s);
      return frame ? { ...s, view: pinchView(a.base, a.now, frame) } : s;
    }
    case "pan": {
      const frame = viewerFrame(s);
      return frame ? { ...s, view: panView(a.base, a.dx, a.dy, frame) } : s;
    }
    case "arrow": {
      const frame = viewerFrame(s);
      return frame ? panned(s, (-a.dx * frame.stage.width) / 10, (-a.dy * frame.stage.height) / 10) : s;
    }
    case "release": {
      if (s.grown) return s;
      if (s.view.scale <= PINCH_GROWS) return settled({ ...s, view: FIT });
      const box = contentBox(s);
      return box ? { ...s, grown: true, keep: box } : windowFit(s);
    }
    case "layout": {
      const card = a.card ?? s.card;
      const layout = a.layout === undefined ? s.layout : a.layout;
      const moved = a.stage !== undefined && !sameRect(s.stage, a.stage);
      if (card === s.card && layout === s.layout && !moved) return s;
      const next: ViewerState = { ...s, card, grown: s.grown || !card, layout, stage: a.stage ?? s.stage };
      // Only a stage measured after the card grew can take over the kept box.
      if (next.keep && moved && next.grown) return keptIn(next, next.keep);
      return settled(next);
    }
    case "pages":
      return settled({ ...s, grown: !s.card || s.pinned, layout: null, keep: null, view: FIT });
  }
}
