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
 *
 * A handout of several pages reads like a PDF (docs/design-v1-pdf-handouts.md
 * section 5). Its fit is the width fit, and it zooms out below that to the
 * page fit, where the tallest page shows whole, so `scale` runs from the
 * frame's `min` up. It pages by the view's position (pageStep), loads only
 * the pages near the screen (visiblePages), and flings (flingStep). One
 * page keeps every step as it was, since its two fits are the same.
 */

export type ZoomView = { scale: number; x: number; y: number };
export type Box = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };
/**
 * The stage, the pages' size at the fit, the lowest scale (below 1 where
 * the page fit is below the width fit, so only for several pages), and the
 * stage pixels left under the column's end so its last page scrolls clear
 * of the controls row there.
 */
export type Frame = { stage: Box; fitted: Box; min: number; pad: number };

export const MAX_ZOOM = 6;
/** One double tap zooms this far, enough to read a letter's handwriting on a phone. */
export const TAP_ZOOM = 2.5;
/** Each press of Zoom in or Zoom out past the window's fit. */
export const STEP_ZOOM = 1.5;
/**
 * Between pages, as a share of the widest page's width: about 8 px on a
 * phone at its width fit and about 14 px on a card, the same look on every
 * screen. A fixed 16 page pixels was 3 px on a phone (5.2).
 */
export const PAGE_GAP_SHARE = 0.02;
/**
 * A pinch on a card must end past this to grow the card. Two fingers that
 * only rested on the picture jitter by a percent or so, and the card
 * should not jump to the window under them.
 */
export const PINCH_GROWS = 1.02;
/** A scale this close to the fit is the fit, so steps that multiply and divide by 1.5 land on it exactly. */
const SNAP = 1e-3;
/**
 * The page buttons step to a page top that lies more than this past the
 * stage's top edge, so a page already aligned there, give or take a
 * rounding, is not the one they step to (5.3).
 */
export const EDGE_PX = 1;
/**
 * The view is at an end of the stack within this. One tolerance for every
 * end test (the page buttons' enabling and their fallback, the indicator,
 * the keys), so a button is enabled exactly when its move changes the
 * scroll. A quarter pixel is below anything a person sees and above the
 * float noise of the layout's sums.
 */
export const END_PX = 0.25;

/** The fit. clampView centers it, whatever its corner says. */
export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

// ---------------------------------------------------------------- the pages

export type PageSize = { width: number; height: number };
export type PagesLayout = Box & { pages: Rect[] };

/** The pages in one column, each centered across the widest, with a gap between. */
export function layoutPages(pages: readonly PageSize[], gap?: number): PagesLayout {
  const width = pages.reduce((most, p) => Math.max(most, p.width), 0);
  const between = gap ?? width * PAGE_GAP_SHARE;
  let top = 0;
  const boxes = pages.map((p) => {
    const box = { left: (width - p.width) / 2, top, width: p.width, height: p.height };
    top += p.height + between;
    return box;
  });
  return { width, height: boxes.length > 0 ? top - between : 0, pages: boxes };
}

/** One page fits whole. Several fit the widest page's width, and the rest is reached by scrolling down. */
export function fitScale(stage: Box, layout: PagesLayout): number {
  if (layout.width <= 0 || layout.height <= 0) return 1;
  const across = stage.width / layout.width;
  return layout.pages.length > 1 ? across : Math.min(across, stage.height / layout.height);
}

/**
 * The page fit, as a multiple of the width fit: the tallest page whole in
 * the room the controls row leaves. Never above 1, since where every page
 * already shows whole at the width fit, that is the floor (5.2). One page's
 * fit already shows it whole.
 */
function pageFit(stage: Box, layout: PagesLayout, pad: number): number {
  if (layout.pages.length < 2 || layout.width <= 0) return 1;
  const tallest = layout.pages.reduce((most, p) => Math.max(most, p.height), 0);
  if (tallest <= 0) return 1;
  const across = stage.width / layout.width;
  const down = Math.max(1, stage.height - pad) / tallest;
  return Math.min(1, down / across);
}

export function frameOf(stage: Box, layout: PagesLayout, pad = 0): Frame {
  const fit = fitScale(stage, layout);
  const several = layout.pages.length > 1;
  return {
    stage: { width: stage.width, height: stage.height },
    fitted: { width: layout.width * fit, height: layout.height * fit },
    min: pageFit(stage, layout, several ? pad : 0),
    pad: several ? pad : 0,
  };
}

// ---------------------------------------------------------------- moving the view

/** Where `y` may lie at `scale`: the pages centered in the room above the pad when shorter than it, else no gap at either end. */
function yRange(scale: number, frame: Frame): { min: number; max: number } {
  const size = frame.fitted.height * scale;
  const room = frame.stage.height - frame.pad;
  if (size <= room) return { min: (room - size) / 2, max: (room - size) / 2 };
  return { min: room - size, max: 0 };
}

/**
 * Within the zoom's range, and inside the stage: centered across or down
 * where the pages are narrower or shorter than the stage that way, and
 * with no gap at an edge where they are larger. The column's end keeps the
 * frame's pad below it.
 */
export function clampView(v: ZoomView, frame: Frame): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(frame.min, v.scale));
  const width = frame.fitted.width * scale;
  const x = width <= frame.stage.width ? (frame.stage.width - width) / 2 : Math.min(0, Math.max(frame.stage.width - width, v.x));
  const down = yRange(scale, frame);
  return { scale, x, y: Math.min(down.max, Math.max(down.min, v.y)) };
}

/**
 * Zooms by `factor`, keeping the point of the pages under `anchor` (in
 * stage pixels) where it is. `floor` is the lowest scale the view's state
 * allows, the frame's own by default.
 */
export function zoomAround(v: ZoomView, anchor: Point, factor: number, frame: Frame, floor = frame.min): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(floor, v.scale * factor));
  const grow = scale / v.scale;
  return clampView({ scale, x: anchor.x - (anchor.x - v.x) * grow, y: anchor.y - (anchor.y - v.y) * grow }, frame);
}

export type PinchBase = { view: ZoomView; mid: Point; dist: number };

/**
 * A pinch, from the view and the fingers when the second one landed. Worked
 * out from that baseline every time, so the point between the fingers
 * stays under them with no drift, and moving both fingers pans.
 */
export function pinchView(base: PinchBase, now: { mid: Point; dist: number }, frame: Frame, floor = frame.min): ZoomView {
  const ratio = base.dist > 0 ? now.dist / base.dist : 1;
  const scale = Math.min(MAX_ZOOM, Math.max(floor, base.view.scale * ratio));
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

// ---------------------------------------------------------------- the wheel and the fling (5.5)

/** A wheel that reports lines (Firefox, `deltaMode` 1) moves this far a line, about a line of a page's text. */
export const WHEEL_LINE_PX = 40;

/**
 * A plain wheel over several pages, as the stage pixels to scroll. Lines
 * and pages are turned into pixels, so every wheel scrolls at a reading
 * pace, and Shift with a wheel that sends only `deltaY` scrolls across.
 */
export function wheelScroll(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }, stage: Box): { dx: number; dy: number } {
  const unit = (page: number) => (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? page : 1);
  if (e.shiftKey && e.deltaX === 0) return { dx: e.deltaY * unit(stage.width), dy: 0 };
  return { dx: e.deltaX * unit(stage.width), dy: e.deltaY * unit(stage.height) };
}

/** How fast a fling slows: its speed falls by e every this many milliseconds. */
export const FLING_DECAY_MS = 325;
/** A fling ends under this speed, in stage pixels a millisecond. A finger lifted slower than this does not fling. */
export const FLING_STOP = 0.02;
/** The finger's speed is read over its moves this long before it lifted. */
export const FLING_SAMPLE_MS = 100;

/**
 * One frame of a fling: the distance it travels in `elapsedMs` and its
 * speed after. The decay is worked out from elapsed time, not counted per
 * frame, so a fling travels as far at 60 frames a second as at 120.
 */
export function flingStep(velocity: Point, elapsedMs: number): { velocity: Point; dx: number; dy: number; done: boolean } {
  const decay = Math.exp(-Math.max(0, elapsedMs) / FLING_DECAY_MS);
  const travel = FLING_DECAY_MS * (1 - decay);
  const next = { x: velocity.x * decay, y: velocity.y * decay };
  return { velocity: next, dx: velocity.x * travel, dy: velocity.y * travel, done: Math.hypot(next.x, next.y) < FLING_STOP };
}

/** The finger's speed as it lifted, over its moves in the last FLING_SAMPLE_MS. A finger that rested first has none. */
export function releaseVelocity(samples: readonly { at: number; p: Point }[], at: number): Point {
  const recent = samples.filter((s) => at - s.at <= FLING_SAMPLE_MS);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last.at - first.at <= 0) return { x: 0, y: 0 };
  const ms = last.at - first.at;
  return { x: (last.p.x - first.p.x) / ms, y: (last.p.y - first.p.y) / ms };
}

/** A fling faster than a stage height in a third of a second mounts no new page (5.4). */
export function flingIsFast(velocity: Point, stage: Box): boolean {
  return Math.abs(velocity.y) > stage.height / 333 || Math.abs(velocity.x) > stage.width / 333;
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
  /** The stage pixels the controls row takes at the stage's bottom, measured. Only several pages leave room for it. */
  pad: number;
  /**
   * Set by a step that changes the stage (the card growing or shrinking,
   * Expand): the point of the pages, in their own pixels, that was at the
   * stage's center, and the scale to show it at once the new stage is
   * measured. So no such step jumps 30 pages back to page 1 (5.2).
   */
  anchor: { point: Point; scale: number } | null;
  /** The page a page button brought to the top, which the indicator shows until the view moves another way (5.3). */
  aligned: number | null;
  /** The page to open at, a remembered one, applied once the pages are laid out on a measured stage (5.1). */
  start: number | null;
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
  /** The wheel or a fling over several pages, which scroll rather than zoom, in stage pixels: positive moves on through the pages. */
  | { t: "scroll"; dx: number; dy: number }
  | { t: "double"; at: Point }
  | { t: "pinch"; base: PinchBase; now: { mid: Point; dist: number } }
  | { t: "pan"; base: ZoomView; dx: number; dy: number }
  /** An arrow key, a tenth of the stage each way. */
  | { t: "arrow"; dx: number; dy: number }
  /** PageDown or PageUp, or Space and Shift+Space on the dialog: a stage height less a tenth (5.6). */
  | { t: "screen"; dir: 1 | -1 }
  /** Home: the top of page 1. */
  | { t: "home" }
  /** End: the bottom of the last page. */
  | { t: "end" }
  /** Next page or Previous page (pageStep). */
  | { t: "step"; dir: 1 | -1 }
  /** The last finger lifted. */
  | { t: "release" }
  /** What the component measured: the layout's kind, the stage's box, the pages, the controls row's room. */
  | { t: "layout"; card?: boolean; stage?: Rect; layout?: PagesLayout | null; pad?: number }
  /** Another showing, which starts at rest, at its remembered page when it has one. */
  | { t: "pages"; start?: number };

export type ViewerPhase = "card" | "window" | "magnified";

export function viewerStart(card: boolean, start = 0): ViewerState {
  return { card, grown: !card, pinned: false, view: FIT, stage: null, layout: null, keep: null, pad: 0, anchor: null, aligned: null, start: start > 0 ? start : null };
}

export function viewerFrame(s: ViewerState): Frame | null {
  return s.stage && s.layout ? frameOf(s.stage, s.layout, s.pad) : null;
}

/** "card" while the dialog is a card, a pinch on it included. */
export function viewerPhase(s: ViewerState): ViewerPhase {
  if (!s.grown) return "card";
  return s.view.scale < 1 + SNAP ? "window" : "magnified";
}

/** The pages' count, once laid out. */
function pageCount(s: ViewerState): number {
  return s.layout?.pages.length ?? 0;
}

/** The lowest scale of the state the view is in: the page fit on a card or where the window is the floor, else the window's width fit, below which the step goes to the card. */
function stateFloor(s: ViewerState, frame: Frame): number {
  return !s.grown || windowIsFloor(s) ? frame.min : 1;
}

/**
 * At the floor of the steps out (5.2): the card's page fit, or the
 * window's page fit where the window is the floor (a whole-screen layout,
 * or Expand pressed). One page's page fit is its fit. Zoom out is then
 * disabled, as it would do nothing.
 */
export function zoomOutDisabled(s: ViewerState): boolean {
  if (s.grown && !windowIsFloor(s)) return false;
  const frame = viewerFrame(s);
  return s.view.scale < (frame?.min ?? 1) + SNAP;
}

/** At 6 times the window's fit. */
export function zoomInDisabled(s: ViewerState): boolean {
  return s.grown && s.view.scale > MAX_ZOOM - SNAP;
}

/**
 * Reset zoom shows only while the view is off the resting state's width
 * fit, above it or below it (5.2). So at rest it is hidden though Zoom out
 * may still go lower, to the page fit.
 */
export function resetShown(s: ViewerState): boolean {
  const atFit = Math.abs(s.view.scale - 1) < SNAP;
  return !(atFit && (!s.grown || windowIsFloor(s)));
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
  return frame.fitted.width * scale > frame.stage.width + 0.5 || frame.fitted.height * scale + frame.pad > frame.stage.height + 0.5;
}

// ---------------------------------------------------------------- where the reader is (5.3, 5.4)

/** Each page's box in stage pixels, as drawn now. */
export function pageRects(s: ViewerState): Rect[] | null {
  const frame = viewerFrame(s);
  if (!frame || !s.layout || s.layout.width <= 0) return null;
  const v = clampView(s.view, frame);
  const k = (frame.fitted.width / s.layout.width) * v.scale;
  return s.layout.pages.map((p) => ({ left: v.x + p.left * k, top: v.y + p.top * k, width: p.width * k, height: p.height * k }));
}

/** Whether the view is at the stack's start or its end, within END_PX. */
function ends(s: ViewerState): { start: boolean; end: boolean } | null {
  const frame = viewerFrame(s);
  if (!frame) return null;
  const v = clampView(s.view, frame);
  const range = yRange(v.scale, frame);
  return { start: v.y >= range.max - END_PX, end: v.y <= range.min + END_PX };
}

/**
 * Every page shows whole: the column fits the stage both ways, as two
 * short pages do, or a short document at its page fit. The indicator then
 * reads "All 2 pages", and the page buttons and keys do nothing (5.3).
 */
export function allPagesShown(s: ViewerState): boolean {
  const frame = viewerFrame(s);
  if (!frame) return false;
  const scale = clampView(s.view, frame).scale;
  return frame.fitted.height * scale + frame.pad <= frame.stage.height + END_PX && frame.fitted.width * scale <= frame.stage.width + END_PX;
}

/**
 * The page the indicator shows, from 0: the page a page button last
 * brought to the top while the view stays there, else the page with the
 * most height showing, the earlier on a tie, except page 1 at the very top
 * and the last page at the very end, however short (5.3).
 */
export function currentPage(s: ViewerState): number {
  if (s.aligned !== null) return s.aligned;
  const rects = pageRects(s);
  const at = ends(s);
  const stage = s.stage;
  if (!rects || !at || !stage) return 0;
  if (at.start) return 0;
  if (at.end) return rects.length - 1;
  let best = 0;
  let most = -1;
  rects.forEach((r, i) => {
    const shown = Math.min(r.top + r.height, stage.height) - Math.max(r.top, 0);
    if (shown > most) {
      best = i;
      most = shown;
    }
  });
  return best;
}

/**
 * Next page (`dir` 1) or Previous page (-1), stepping by where the view is,
 * not by the indicator (5.3), so every press moves the view whatever the
 * pages' heights. Next brings to the stage's top edge the top of the first
 * page lying more than EDGE_PX below it, clamped at the stack's end, and
 * with no such page (a tall last page, or a magnified one) it goes to the
 * end. Previous brings there the top of the last page lying more than
 * EDGE_PX above it, and with none it goes to the start. Each keeps the
 * zoom and the place across. Null when the view is already at that end, so
 * a button is enabled exactly when its move changes the scroll. The page
 * is the one the step brought to the top: the last page when Next reached
 * the end first, page 1 when Previous went to the start.
 */
export function pageStep(s: ViewerState, dir: 1 | -1): { state: ViewerState; page: number } | null {
  const frame = viewerFrame(s);
  const rects = pageRects(s);
  if (!frame || !rects || rects.length < 2) return null;
  const v = clampView(s.view, frame);
  const range = yRange(v.scale, frame);
  const last = rects.length - 1;
  let y: number;
  let page: number;
  if (dir > 0) {
    if (v.y <= range.min + END_PX) return null;
    const next = rects.findIndex((r) => r.top > EDGE_PX);
    const target = next < 0 ? range.min : v.y - rects[next]!.top;
    y = Math.max(range.min, target);
    page = next < 0 || target < range.min ? last : next;
  } else {
    if (v.y >= range.max - END_PX) return null;
    let prev = -1;
    rects.forEach((r, i) => {
      if (r.top < -EDGE_PX) prev = i;
    });
    y = prev < 0 ? range.max : Math.min(range.max, v.y - rects[prev]!.top);
    page = prev < 0 ? 0 : prev;
  }
  return { state: { ...s, view: { ...v, y }, aligned: page }, page };
}

/** Stage heights from the visible area within which a page's image mounts, and beyond which it unmounts (5.4). */
export const MOUNT_AHEAD = 1;
export const KEEP_AHEAD = 3;

/**
 * The pages whose box lies within `ahead` stage heights of the visible
 * area, above or below, nearest first, so the pages in view load before
 * the ones beyond. Distances, not page counts: a page on a phone held
 * sideways can be several stages tall.
 */
export function visiblePages(s: ViewerState, ahead: number): number[] {
  const rects = pageRects(s);
  const stage = s.stage;
  if (!rects || !stage) return [];
  const reach = ahead * stage.height;
  const away = rects.map((r, i) => ({ i, d: Math.max(0, -(r.top + r.height), r.top - stage.height) }));
  return away
    .filter((a) => a.d <= reach)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((a) => a.i);
}

/**
 * The pages whose images stay mounted: those already mounted within
 * KEEP_AHEAD, and those within MOUNT_AHEAD unless a fast fling is passing
 * over them. The gap between the two keeps an image from mounting and
 * unmounting at a boundary.
 */
export function mountedPages(prev: ReadonlySet<number>, s: ViewerState, fast: boolean): Set<number> {
  const keep = new Set(visiblePages(s, KEEP_AHEAD));
  const out = new Set([...prev].filter((i) => keep.has(i)));
  if (!fast) for (const i of visiblePages(s, MOUNT_AHEAD)) out.add(i);
  return out;
}

// ---------------------------------------------------------------- keys (5.6)

/** Where focus is as a key comes: Space pages only while focus is on the dialog itself, and a button keeps Space. */
export type KeyContext = { shift?: boolean; onDialog?: boolean };

/** What a key does while focus is in the viewer, or null to leave it alone. */
export function viewerKey(key: string, s: ViewerState, at: KeyContext = {}): ViewerAction | null {
  switch (key) {
    case "+":
    case "=":
      return { t: "in" };
    case "-":
      return { t: "out" };
    case "0":
      return { t: "reset" };
  }
  if (pageCount(s) > 1 && !allPagesShown(s)) {
    switch (key) {
      case "PageDown":
        return { t: "screen", dir: 1 };
      case "PageUp":
        return { t: "screen", dir: -1 };
      case " ":
        return at.onDialog ? { t: "screen", dir: at.shift ? -1 : 1 } : null;
      case "Home":
        return { t: "home" };
      case "End":
        return { t: "end" };
    }
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

/** The viewer's own controls that a step can take away from under focus. */
export type ViewerControl = "prev" | "next" | "out" | "in" | "reset";

/**
 * Where focus goes when the control that has it leaves under a step, or
 * null when it stays. A page button disabled at an end hands it to the
 * other, else to a zoom button. Zoom out at the floor hands it to Zoom in,
 * Zoom in at 6 times to Zoom out, and Reset zoom, which hides at the width
 * fit while Zoom out may still go lower, to Zoom out, else Zoom in
 * (PDF-P-34). Otherwise focus would fall to the page under the modal
 * dialog and the keys would stop reaching the viewer.
 */
export function focusHandOff(from: ViewerControl, next: ViewerState): ViewerControl | null {
  const open: Record<ViewerControl, boolean> = {
    prev: pageStep(next, -1) !== null,
    next: pageStep(next, 1) !== null,
    out: !zoomOutDisabled(next),
    in: !zoomInDisabled(next),
    reset: resetShown(next),
  };
  if (open[from]) return null;
  const order: Record<ViewerControl, ViewerControl[]> = { prev: ["next", "out", "in"], next: ["prev", "out", "in"], out: ["in"], in: ["out"], reset: ["out", "in"] };
  return order[from].find((c) => open[c]) ?? null;
}

/**
 * Whether a finger's lift is a tap: it did not move, it was not cancelled,
 * and it did not land on a fling, which a touch only stops, so it can
 * never start a double tap (5.5).
 */
export function isTap(input: { moved: boolean; lifted: boolean; stoppedFling: boolean }): boolean {
  return !input.moved && input.lifted && !input.stoppedFling;
}

/** The moves after which the status line says the page, when it changed (5.7). Scrolling by touch, wheel or arrows says nothing. */
export function announcesPage(a: ViewerAction): boolean {
  return a.t === "step" || a.t === "screen" || a.t === "home" || a.t === "end";
}

// ---------------------------------------------------------------- the steps

function windowIsFloor(s: ViewerState): boolean {
  return !s.card || s.pinned;
}

/** The view kept inside the stage measured last, where there is one. */
function settled(s: ViewerState): ViewerState {
  const frame = viewerFrame(s);
  return frame ? { ...s, view: clampView(s.view, frame) } : s;
}

/** The point of the pages, in their own pixels, at the stage's center now. */
function centerPoint(s: ViewerState): Point | null {
  const frame = viewerFrame(s);
  if (!frame || !s.layout || s.layout.width <= 0) return null;
  const v = clampView(s.view, frame);
  const k = (frame.fitted.width / s.layout.width) * v.scale;
  return { x: (frame.stage.width / 2 - v.x) / k, y: (frame.stage.height / 2 - v.y) / k };
}

/** `point` of the pages at the stage's center, at `scale`, as far as clamping lets it. */
function centeredOn(s: ViewerState, point: Point, scale: number): ViewerState {
  const frame = viewerFrame(s);
  if (!frame || !s.layout || s.layout.width <= 0) return s;
  const k = (frame.fitted.width / s.layout.width) * scale;
  return { ...s, view: clampView({ scale, x: frame.stage.width / 2 - point.x * k, y: frame.stage.height / 2 - point.y * k }, frame) };
}

/**
 * The card grown to the window's fit, or shrunk back to its own, keeping
 * the place: the point at the stage's center goes to the new stage's
 * center once it is measured. One page at its fit lands centered, as when
 * these steps went to FIT.
 */
function resized(s: ViewerState, grown: boolean): ViewerState {
  const point = centerPoint(s);
  return settled({ ...s, grown, keep: null, view: FIT, anchor: point ? { point, scale: 1 } : null });
}

/** The window's fit. The next layout measures the larger stage and centers the pages' point there. */
function windowFit(s: ViewerState): ViewerState {
  return resized(s, true);
}

/**
 * The view zoomed to `scale` about `at`, the stage's center when null,
 * within the state's floor and the most. The same state when nothing moves.
 */
function zoomedTo(s: ViewerState, at: Point | null, scale: number): ViewerState {
  const frame = viewerFrame(s);
  if (!frame) return s;
  const v = clampView(s.view, frame);
  const target = Math.min(MAX_ZOOM, Math.max(stateFloor(s, frame), scale));
  const anchor = at ?? { x: frame.stage.width / 2, y: frame.stage.height / 2 };
  const grow = target / v.scale;
  const view = clampView({ scale: target, x: anchor.x - (anchor.x - v.x) * grow, y: anchor.y - (anchor.y - v.y) * grow }, frame);
  return sameView(view, s.view) ? s : { ...s, view };
}

/** A step by `factor`, stopping at the width fit when it would cross it: each step out or in stops at the next fit (5.2). */
function stepped(s: ViewerState, at: Point | null, factor: number): ViewerState {
  const from = s.view.scale;
  let to = from * factor;
  if ((from < 1 - SNAP && to > 1) || (from > 1 + SNAP && to < 1)) to = 1;
  return zoomedTo(s, at, to);
}

/** Where Reset zoom goes: the resting state's width fit, card fit unless the window is the floor, keeping the place. */
function rest(s: ViewerState): ViewerState {
  if (windowIsFloor(s)) return s.grown ? zoomedTo(s, null, 1) : windowFit(s);
  return s.grown ? resized(s, false) : zoomedTo(s, null, 1);
}

/** Zoom out: toward the window's fit while magnified, then to the card unless the window is the floor, then down to the page fit. */
function stepOut(s: ViewerState, at: Point | null, factor: number): ViewerState {
  if (s.grown && !windowIsFloor(s) && s.view.scale < 1 + SNAP) return resized(s, false);
  return stepped(s, at, factor);
}

function panned(s: ViewerState, dx: number, dy: number): ViewerState {
  const frame = viewerFrame(s);
  return frame ? { ...s, view: panView(s.view, dx, dy, frame) } : s;
}

/** The view's `y` set to an end of the stack, keeping the zoom and the place across. */
function toEnd(s: ViewerState, end: "start" | "end"): ViewerState {
  const frame = viewerFrame(s);
  if (!frame) return s;
  const v = clampView(s.view, frame);
  const range = yRange(v.scale, frame);
  return { ...s, view: { ...v, y: end === "start" ? range.max : range.min } };
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

/**
 * A page's top at the stage's top, at the view's zoom and its place
 * across: a remembered page as a showing starts, or a paged-to page as the
 * stage turns. The indicator holds that page, as after a page button, so a
 * short last page clamped below the top still reads as the page the reader
 * was on.
 */
function startedAt(s: ViewerState, page: number): ViewerState {
  const frame = viewerFrame(s);
  if (!frame || !s.layout) return s;
  const at = Math.min(page, s.layout.pages.length - 1);
  const box = s.layout.pages[at];
  const k = s.layout.width > 0 ? frame.fitted.width / s.layout.width : 0;
  const v = clampView(s.view, frame);
  return { ...s, start: null, aligned: at, view: clampView({ ...v, y: -(box?.top ?? 0) * k * v.scale }, frame) };
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameView(a: ZoomView, b: ZoomView): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y;
}

export function viewerStep(s: ViewerState, a: ViewerAction): ViewerState {
  const next = step(s, a);
  // The indicator holds a page button's page only until the view moves another way (5.3), or the stage turns under it, which keeps the page at the top.
  const kept = a.t === "step" || (a.t === "layout" && next.aligned !== null && (stageResized(s, a) || (s.start !== null && next.start === null)));
  if (!kept && next !== s && next.aligned !== null && !sameView(next.view, s.view)) return { ...next, aligned: null };
  return next;
}

/** A stage measured at another size than the last: a window resized, a phone turned, or the dialog grown or shrunk. */
function stageResized(s: ViewerState, a: Extract<ViewerAction, { t: "layout" }>): boolean {
  return a.stage !== undefined && s.stage !== null && (s.stage.width !== a.stage.width || s.stage.height !== a.stage.height);
}

function step(s: ViewerState, a: ViewerAction): ViewerState {
  switch (a.t) {
    case "in":
      if (s.grown) return stepped(s, null, STEP_ZOOM);
      return s.view.scale < 1 - SNAP ? stepped(s, null, STEP_ZOOM) : windowFit(s);
    case "out":
      return stepOut(s, null, 1 / STEP_ZOOM);
    case "reset":
      return rest(s);
    case "expand":
      // Pressed on a grown card, the zoom stays: the card is at the window's size already.
      if (!s.pinned) return s.grown ? { ...s, pinned: true } : windowFit({ ...s, pinned: true });
      return rest({ ...s, pinned: false });
    case "wheel":
      // Below the width fit the wheel stays in the state it is in, so a card never grows from a zoom out (5.2).
      if (a.factor > 1) {
        if (s.grown) return zoomedTo(s, a.at, s.view.scale * a.factor);
        return s.view.scale < 1 - SNAP ? zoomedTo(s, a.at, Math.min(1, s.view.scale * a.factor)) : windowFit(s);
      }
      if (a.factor < 1) {
        if (s.grown && !windowIsFloor(s) && s.view.scale < 1 + SNAP) return resized(s, false);
        return zoomedTo(s, a.at, s.view.scale * a.factor);
      }
      return s;
    case "scroll":
      return panned(s, -a.dx, -a.dy);
    case "double": {
      // At the width fit it zooms in about the tap. Above it, back to the width fit, keeping the place. Below it, to the width fit about the tap.
      if (!s.grown) return s.view.scale < 1 - SNAP ? zoomedTo(s, a.at, 1) : windowFit(s);
      if (s.view.scale > 1 + SNAP) return zoomedTo(s, null, 1);
      return zoomedTo(s, a.at, s.view.scale < 1 - SNAP ? 1 : TAP_ZOOM);
    }
    case "pinch": {
      const frame = viewerFrame(s);
      return frame ? { ...s, view: pinchView(a.base, a.now, frame, stateFloor(s, frame)) } : s;
    }
    case "pan": {
      const frame = viewerFrame(s);
      return frame ? { ...s, view: panView(a.base, a.dx, a.dy, frame) } : s;
    }
    case "arrow": {
      const frame = viewerFrame(s);
      return frame ? panned(s, (-a.dx * frame.stage.width) / 10, (-a.dy * frame.stage.height) / 10) : s;
    }
    case "screen": {
      // Less about a tenth, so a line at the edge stays in view, as a browser scrolls.
      const frame = viewerFrame(s);
      return frame ? panned(s, 0, -a.dir * frame.stage.height * 0.9) : s;
    }
    case "home":
      return toEnd(s, "start");
    case "end":
      return toEnd(s, "end");
    case "step":
      return pageStep(s, a.dir)?.state ?? s;
    case "release": {
      if (s.grown) return s;
      if (s.view.scale > PINCH_GROWS) {
        const box = contentBox(s);
        return box ? { ...s, grown: true, keep: box } : windowFit(s);
      }
      // Short of growing, it settles at the card's fit, or stays below it where several pages zoom out further.
      return s.view.scale < 1 - SNAP ? s : zoomedTo(s, null, 1);
    }
    case "layout": {
      const card = a.card ?? s.card;
      const layout = a.layout === undefined ? s.layout : a.layout;
      const pad = a.pad ?? s.pad;
      const moved = a.stage !== undefined && !sameRect(s.stage, a.stage);
      if (card === s.card && layout === s.layout && pad === s.pad && !moved && !(a.stage && s.anchor)) return s;
      const next: ViewerState = { ...s, card, grown: s.grown || !card, layout, pad, stage: a.stage ?? s.stage };
      // Only a stage measured after the card grew can take over the kept box.
      if (next.keep && moved && next.grown) return keptIn(next, next.keep);
      // A stage measured after a step that changed it takes the point that was at its center.
      if (next.anchor && a.stage) return centeredOn({ ...next, anchor: null }, next.anchor.point, next.anchor.scale);
      if (next.start !== null && viewerFrame(next)) return startedAt(next, next.start);
      /*
       * A window resized or a phone turned keeps the page being read at the
       * stage's center (5.2). A page a page button brought to the top stays
       * at the top instead, with the indicator on it: a short page aligned
       * there leaves the center on the next one, which the center alone
       * would turn into the page being read. One page keeps its place as
       * built.
       */
      if (stageResized(s, a) && pageCount(next) > 1 && layout === s.layout) {
        if (s.aligned !== null) return startedAt({ ...next, view: { ...s.view } }, s.aligned);
        const point = centerPoint(s);
        if (point) return centeredOn(next, point, s.view.scale);
      }
      return settled(next);
    }
    case "pages":
      return settled({ ...s, grown: !s.card || s.pinned, layout: null, keep: null, anchor: null, aligned: null, start: a.start && a.start > 0 ? a.start : null, view: FIT });
  }
}
