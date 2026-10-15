import { createStore } from "zustand/vanilla";
import type { Point, Size } from "../lib/camera.ts";
import { scopeSlot } from "../state/scope.ts";

/*
 * Where the token action bar sits (docs/design-v1-bar-dock.md), as plain
 * functions over boxes in the chrome's own pixels (features/device/layout.ts),
 * so every rule runs under node --test.
 *
 * On a screen 600 px or wider, or one wider than tall, the bar docks: it
 * keeps one spot in the map's free area, the bottom right unless the
 * viewer moved it, so it never covers the tokens it acts on. A phone held
 * upright keeps the bar that spans the screen under its token. A screen
 * too short for either opens the bar as a taller overlay. The fight
 * alerts column and the floating notices share the right side of the map
 * with the bar, and `shareLane` and `noticePlace` settle who gives way.
 */

/** The bar's width wherever it does not span. */
export const BAR_WIDTH = 304;
/** The right of the free area that the column and a docked bar share: the bar and an 8 px gap before the map. */
export const LANE_WIDTH = 312;
/** The margin the free area keeps from every edge, and the gap between the column and the bar. */
export const EDGE = 8;
/**
 * The least height a docked or spanning bar needs: its 48 px header and
 * two 44 px rows of buttons with their gaps, or under the alerts summary
 * row the header and one row. Shorter than this, it opens compact.
 */
export const MIN_BAR_HEIGHT = 148;
/** Below this layout width, a layout no wider than tall spans the bar as a phone does. */
export const DOCK_MIN_WIDTH = 600;
/** The narrowest bar the app already draws (an upright span at 320 px and 130%), so the narrowest room beside the lane. */
export const BESIDE_MIN = 230;
/** The least height the bar gives way to under the column's first card. */
export const BAR_FLOOR = 120;
/** The column's alerts summary row, which stands in for its cards when nothing else fits. */
export const SUMMARY_ROW = 44;
/** A dropped bar whose edge lands this close to the free area's edge snaps to it. */
export const SNAP_PX = 24;
/** The least room left of the lane for the notices to center there instead of spanning. */
export const NOTICES_BESIDE_MIN = 320;
/** Below this room inside its padding, the Select several bar shows the short hint, so it stays one row. */
export const LONG_HINT_MIN = 600;

export type Box = { left: number; top: number; width: number; height: number };
export type Sides = { top: number; right: number; bottom: number; left: number };
export type BarMode = "span" | "dock" | "compact";

/**
 * What Room measures of its chrome, in the chrome's own pixels. A safe
 * area counts at its full size, since the chrome adds `env()` inside its
 * zoom (design section 1).
 */
export type Chrome = {
  /** The top bar with the turn band and the top safe area. */
  top: number;
  /** The toolbar, the active tool's options and the bottom safe area. */
  bottom: number;
  /** As `bottom`, but only up to the highest button or field in the tool's options, so a hint wrapped above them is left out. */
  controls: number;
  /** The toolbar alone, with the bottom safe area. */
  toolbar: number;
  safe: Sides;
  /** A phone's sheet docked on the right in landscape, or 0. It covers the right safe area. */
  sheet: number;
};

export const NO_SIDES: Sides = { top: 0, right: 0, bottom: 0, left: 0 };

/** Until Room has measured: a 52 px top bar and a 60 px toolbar, no safe areas. */
export const DEFAULT_CHROME: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NO_SIDES, sheet: 0 };

/**
 * The part of the map a docked bar lives in: the map less the bars over
 * it, the side safe areas and a landscape sheet, with an 8 px margin all
 * round. Its height may come out at 0 or less on a short screen. `foot` is
 * a roll card standing on a narrow screen's toolbar and the active tool's
 * options (features/rolls/PlayerRolls.tsx), which the bar keeps above.
 */
export function freeArea(viewport: Size, chrome: Chrome, foot = 0): Box {
  const left = chrome.safe.left + EDGE;
  const right = viewport.width - (chrome.sheet > 0 ? chrome.sheet : chrome.safe.right) - EDGE;
  const top = chrome.top + EDGE;
  const bottom = viewport.height - chrome.bottom - Math.max(0, foot) - EDGE;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Span, dock or compact (design 1.1). `layout` is the window in the
 * chrome's pixels, which decides the device's shape, and `freeHeight` the
 * free area's height, which decides whether a bar fits at all.
 */
export function barMode(layout: Size, freeHeight: number): BarMode {
  if (freeHeight < MIN_BAR_HEIGHT) return "compact";
  return layout.width < DOCK_MIN_WIDTH && layout.width <= layout.height ? "span" : "dock";
}

/**
 * Where a bar hangs: from its top edge down, or from its bottom edge up,
 * as tall as its content up to `room`. A bar that hangs by its bottom
 * grows upward, so its buttons stay where the thumb left them.
 */
export type Hang = { left: number; width: number; anchor: "top" | "bottom"; at: number; room: number };

/** The box a bar draws for a content height. */
export function hangBox(hang: Hang, height: number): Box {
  const h = Math.max(0, Math.min(height, hang.room));
  return { left: hang.left, width: hang.width, top: hang.anchor === "top" ? hang.at : hang.at - h, height: h };
}

/**
 * The compact overlay (design 1.4): the dock's place across, or the
 * span's whole width on an upright layout, and down from 8 px under the
 * top bars to 8 px above the toolbar when that leaves it 148 px, else to
 * 8 px above the bottom safe area, over the toolbar too. It hangs by its
 * bottom, so a short bar sits where a docked one would.
 */
export function compactHang(layout: Size, viewport: Size, chrome: Chrome): Hang & { coversToolbar: boolean } {
  const free = freeArea(viewport, chrome);
  const upright = layout.width <= layout.height;
  const width = Math.max(0, upright ? free.width : Math.min(BAR_WIDTH, free.width));
  const left = upright ? free.left : free.left + free.width - width;
  const aboveToolbar = viewport.height - chrome.toolbar - EDGE;
  const coversToolbar = aboveToolbar - free.top < MIN_BAR_HEIGHT;
  const bottom = coversToolbar ? viewport.height - chrome.safe.bottom - EDGE : aboveToolbar;
  return { left, width, anchor: "bottom", at: bottom, room: Math.max(0, bottom - free.top), coversToolbar };
}

// ------------------------------------------------------------ the stored spot

export type Corner = "tl" | "tr" | "bl" | "br";

/**
 * Where the viewer left a docked bar, as `rvtt.tokenBarSpot` stores it:
 * the free area's corner nearest the bar's center, and the gaps from that
 * corner's two edges to the bar's matching corner. Kept as gaps from a
 * corner, so the bar keeps its corner through a resize, a rotation or a
 * sheet opening, and comes back to its spot when the room does.
 */
export type Spot = { corner: Corner; x: number; y: number };

export const SPOT_KEY = "rvtt.tokenBarSpot";
export const DEFAULT_SPOT: Spot = Object.freeze({ corner: "br", x: 0, y: 0 });
const SPOT_MAX = 4096;
const CORNERS: readonly Corner[] = ["br", "bl", "tl", "tr"];

/** The stored spot, or the default for anything else: a missing key, bad JSON, an unknown corner, a fraction, a negative or a gap past 4096. */
export function parseSpot(raw: string | null): Spot {
  if (raw === null) return DEFAULT_SPOT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SPOT;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_SPOT;
  const { corner, x, y } = value as Record<string, unknown>;
  const gap = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= SPOT_MAX;
  if (!CORNERS.includes(corner as Corner) || !gap(x) || !gap(y)) return DEFAULT_SPOT;
  return { corner: corner as Corner, x, y };
}

export function isDefaultSpot(spot: Spot): boolean {
  return spot.corner === "br" && spot.x === 0 && spot.y === 0;
}

/** What to store for a spot: null for the default, which is stored as no key. */
export function spotText(spot: Spot): string | null {
  return isDefaultSpot(spot) ? null : JSON.stringify({ corner: spot.corner, x: spot.x, y: spot.y });
}

/** The spot this device stored. Storage can throw (a private window, blocked site data), which reads as the default. */
export function readSpot(storage?: Pick<Storage, "getItem">): Spot {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return parseSpot(from?.getItem(SPOT_KEY) ?? null);
  } catch {
    return DEFAULT_SPOT;
  }
}

export function writeSpot(spot: Spot, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const to = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const text = spotText(spot);
    if (text === null) to?.removeItem(SPOT_KEY);
    else to?.setItem(SPOT_KEY, text);
  } catch {
    // The spot then lasts as long as the page, which is all a blocked storage allows.
  }
}

/**
 * A docked bar's hang from its spot. The gaps are clamped to keep a bar of
 * this size inside the free area, and the spot itself is left alone, so
 * the bar returns to it once the room comes back.
 */
export function spotHang(spot: Spot, free: Box, size: Size): Hang {
  const width = Math.max(0, Math.min(size.width, free.width));
  const height = Math.max(0, Math.min(size.height, free.height));
  const x = clamp(spot.x, 0, Math.max(0, free.width - width));
  const y = clamp(spot.y, 0, Math.max(0, free.height - height));
  const left = spot.corner[1] === "l" ? free.left + x : free.left + free.width - x - width;
  const room = Math.max(0, free.height - y);
  return spot.corner[0] === "t" ? { left, width, anchor: "top", at: free.top + y, room } : { left, width, anchor: "bottom", at: free.top + free.height - y, room };
}

/** A box dragged past the free area's edges, pulled back inside it. */
export function clampBox(box: Box, free: Box): Box {
  const left = clamp(box.left, free.left, Math.max(free.left, free.left + free.width - box.width));
  const top = clamp(box.top, free.top, Math.max(free.top, free.top + free.height - box.height));
  return { ...box, left, top };
}

/**
 * The spot a dropped bar takes: the free area's corner nearest its
 * center, and its gaps from that corner, whole pixels. A gap within 24 px
 * snaps to 0, so a bar dropped near the bottom right is in its default
 * spot again. There is no grid.
 */
export function releaseSpot(box: Box, free: Box): Spot {
  const right = box.left + box.width / 2 > free.left + free.width / 2;
  const bottom = box.top + box.height / 2 > free.top + free.height / 2;
  const x = right ? free.left + free.width - (box.left + box.width) : box.left - free.left;
  const y = bottom ? free.top + free.height - (box.top + box.height) : box.top - free.top;
  const gap = (n: number) => (n <= SNAP_PX ? 0 : clamp(Math.round(n), 0, SPOT_MAX));
  return { corner: `${bottom ? "b" : "t"}${right ? "r" : "l"}`, x: gap(x), y: gap(y) };
}

const CORNER_WORDS: Record<Corner, string> = { br: "Bar at bottom right", bl: "Bar at bottom left", tl: "Bar at top left", tr: "Bar at top right" };

/**
 * Move bar's press (design section 2): the next corner of the free area,
 * clockwise from the bottom right, flush with it, and what the bar's
 * status says.
 */
export function nextCorner(spot: Spot): { spot: Spot; status: string } {
  const next = CORNERS[(CORNERS.indexOf(spot.corner) + 1) % CORNERS.length] ?? "br";
  return { spot: next === "br" ? DEFAULT_SPOT : { corner: next, x: 0, y: 0 }, status: CORNER_WORDS[next] };
}

// ------------------------------------------------------------ the right lane

export type Lane = "none" | "stacked" | "beside" | "summary";

/** The column's measures as it publishes them: its top, its content's height and its first card's. */
export type ColumnFacts = { top: number; content: number; first: number };

/** The left edge of the lane, the right 312 px of the free area. */
export function laneLeft(free: Box): number {
  return free.left + free.width - LANE_WIDTH;
}

/** Whether a bar overlaps the lane across, so it meets the column. */
export function overlapsLane(hang: Pick<Hang, "left" | "width">, free: Box): boolean {
  return hang.left + hang.width > laneLeft(free);
}

/**
 * Who gives way when a bar and a column with cards overlap across
 * (design 1.3). `laneTop` and `laneHeight` are the free area's (the
 * overlay's when compact), and the first of these that fits wins:
 *
 * 1. Stacked: the column keeps at least its first card, and the bar sits
 *    8 px below it, no shorter than its floor, `min(120, L)`. Beyond the
 *    first card the column gives way first (it stops 8 px above the bar),
 *    then the bar down to its floor. A docked bar hung by its bottom moves
 *    down first, as far as the lane's bottom, so it keeps its content's
 *    height where the lane has room for it, and shrinks only past that.
 *    An upright span takes the first card's bottom as its top limit
 *    instead and stays off its token (placeBar).
 * 2. Beside: with 230 px or more left of the lane, the bar moves there,
 *    up to 304 px wide, with the lane's whole height, and the column keeps
 *    the lane whole.
 * 3. Summary: the column shows a 44 px summary row in place of its cards,
 *    and the bar takes the rest of the lane, 8 px below it.
 *
 * With no cards nothing changes. Every room comes out at 0 or more.
 */
export function shareLane(input: {
  hang: Hang;
  laneTop: number;
  laneHeight: number;
  column: ColumnFacts | null;
  /** The lane's left edge, which a bar beside it keeps to. */
  laneLeft: number;
  /** The free width less the lane. */
  besideRoom: number;
  /** The bar's content height, which a bar hung by its bottom keeps by moving down. */
  content: number;
}): { lane: Lane; hang: Hang } {
  const { hang, laneTop } = input;
  const laneBottom = laneTop + Math.max(0, input.laneHeight);
  const { lane, floor } = laneChoice(input);
  if (lane === "none") return { lane, hang };
  if (lane === "beside") {
    const width = Math.min(BAR_WIDTH, input.besideRoom);
    const room = Math.max(0, hang.anchor === "top" ? laneBottom - hang.at : hang.at - laneTop);
    return { lane, hang: { ...hang, left: input.laneLeft - width, width, room } };
  }
  // A compact overlay already hangs from the lane's bottom (its lane is the overlay), so this leaves its bottom where it is.
  if (hang.anchor === "top") return { lane, hang: { ...hang, at: Math.max(hang.at, floor), room: Math.max(0, laneBottom - Math.max(hang.at, floor)) } };
  const at = Math.min(laneBottom, Math.max(hang.at, floor + Math.min(Math.max(0, input.content), laneBottom - floor)));
  return { lane, hang: { ...hang, at, room: Math.max(0, at - floor) } };
}

/**
 * Which way the lane goes for a bar that meets a column with cards
 * (shareLane), and the top the bar keeps below: the first card's bottom
 * when stacked, the summary row's when summarized, and the lane's own top
 * beside it or with no card.
 */
export function laneChoice(input: { laneTop: number; laneHeight: number; column: ColumnFacts | null; besideRoom: number }): { lane: Lane; floor: number } {
  const { laneTop, column } = input;
  const height = Math.max(0, input.laneHeight);
  if (!column || column.first <= 0) return { lane: "none", floor: laneTop };
  const firstBottom = column.top + column.first + EDGE;
  if (laneTop + height - firstBottom >= Math.min(BAR_FLOOR, height) && height > 0) return { lane: "stacked", floor: firstBottom };
  if (input.besideRoom >= BESIDE_MIN) return { lane: "beside", floor: laneTop };
  return { lane: "summary", floor: column.top + SUMMARY_ROW + EDGE };
}

/**
 * The column's room while a bar shares the lane: down to 8 px above the
 * bar when stacked, nothing but the summary row when summarized, and the
 * whole lane otherwise. Null leaves the column as it is without a bar.
 */
export function columnRoom(input: { lane: Lane; columnTop: number; bar: Box }): number | null {
  if (input.lane === "stacked") return Math.max(0, input.bar.top - EDGE - input.columnTop);
  if (input.lane === "summary") return SUMMARY_ROW;
  return null;
}

// ------------------------------------------------------------ fit and find

/**
 * The bar's box as one inset over the map, for Fit the map, Find my token
 * and the pans that bring a token into view (design section 4). A bar in
 * the lane covers the lane's side, whatever its height, so a token never
 * lands under a bar that later grows. A bar elsewhere covers the side
 * that leaves the largest clear rectangle. Measured from the viewport's
 * edges, like `bars`, in the same pixels as everything passed in.
 */
export function barCover(viewport: Size, bars: Sides, bar: { box: Box; laneLeft: number } | null): Sides {
  if (!bar) return NO_SIDES;
  const { box } = bar;
  // A lane that does not fit the free area (a narrow phone) leaves the bar to cover a side like any other.
  if (bar.laneLeft > 0 && box.left >= bar.laneLeft - 0.5) return { ...NO_SIDES, right: Math.max(0, viewport.width - bar.laneLeft) };
  const sides: Sides[] = [
    { ...NO_SIDES, right: viewport.width - box.left },
    { ...NO_SIDES, bottom: viewport.height - box.top },
    { ...NO_SIDES, left: box.left + box.width },
    { ...NO_SIDES, top: box.top + box.height },
  ];
  const area = (cover: Sides) => {
    const clear = largerEach(bars, cover);
    return Math.max(0, viewport.width - clear.left - clear.right) * Math.max(0, viewport.height - clear.top - clear.bottom);
  };
  let best = sides[0]!;
  for (const side of sides) if (area(side) > area(best)) best = side;
  return best;
}

/** The larger inset on each side. */
export function largerEach(a: Sides, b: Sides): Sides {
  return { top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), left: Math.max(a.left, b.left) };
}

/** What a cover adds past the bars, for a caller that adds the two (features/find/findToken.ts findCamera). */
export function pastBars(cover: Sides, bars: Sides): Sides {
  return {
    top: Math.max(0, cover.top - bars.top),
    right: Math.max(0, cover.right - bars.right),
    bottom: Math.max(0, cover.bottom - bars.bottom),
    left: Math.max(0, cover.left - bars.left),
  };
}

/**
 * Where a pan lands its point once a cover takes part of the map: on each
 * axis the cover narrows, the middle of what it leaves. Without this a
 * 900 px window, whose map is 540 px wide, centers the token under the bar.
 */
export function clearAnchor(point: { x: number; y: number }, viewport: Size, bars: Sides, cover: Sides): { x: number; y: number } {
  const clear = largerEach(bars, cover);
  const x = cover.left > bars.left || cover.right > bars.right ? clear.left + (viewport.width - clear.left - clear.right) / 2 : point.x;
  const y = cover.top > bars.top || cover.bottom > bars.bottom ? clear.top + (viewport.height - clear.top - clear.bottom) / 2 : point.y;
  return x === point.x && y === point.y ? point : { x, y };
}

/** Below the token's name label, which hangs about 30 px under the footprint. */
export const OFFSET_Y = 34;
/** Room above the token's bottom edge for the token itself when the bar flips above it. */
const FLIP_CLEARANCE = 40;

/**
 * An upright phone's bar, the screen's width less the free area's margins:
 * below its token when it fits there, else above it, whichever has more
 * room. `top` is how high it may reach, the free area's top or under the
 * alerts column's first card. It never covers its token while the side it
 * takes leaves it its floor, `min(120, the room it has)`: a bar over the
 * creature it acts on is the very thing the dock exists to stop. Only on a
 * screen so short that neither side does, as at 320 x 480 at 130% under a
 * check, does it keep its floor over the token rather than shrink below
 * its header and buttons.
 */
function spanHang(anchor: Point, free: Box, height: number, top: number): Hang {
  const bottom = free.top + free.height;
  const ceiling = Math.max(free.top, top);
  const floor = Math.min(BAR_FLOOR, Math.max(0, bottom - ceiling));
  const topBelow = Math.max(ceiling, anchor.y + OFFSET_Y);
  const spaceBelow = bottom - topBelow;
  const bottomAbove = Math.min(bottom, anchor.y - OFFSET_Y - FLIP_CLEARANCE);
  const spaceAbove = bottomAbove - ceiling;
  if (height <= spaceBelow || spaceBelow >= spaceAbove) {
    const at = spaceBelow >= floor ? topBelow : bottom - floor;
    return { left: free.left, width: free.width, anchor: "top", at, room: Math.max(0, bottom - at) };
  }
  const at = spaceAbove >= floor ? bottomAbove : ceiling + floor;
  return { left: free.left, width: free.width, anchor: "bottom", at, room: Math.max(0, at - ceiling) };
}

/**
 * Where the bar hangs, before a drag: by its token when it spans, at its
 * spot when it docks, and the overlay's place when compact, then shared
 * with the column when they meet across. The one rule for the bar drawn
 * (TokenActionBar.tsx) and for where a pan expects it (restingBar). Null
 * only where the bar would span and no token is given to hang it by.
 */
export function placeBar(input: {
  layout: Size;
  viewport: Size;
  chrome: Chrome;
  foot: number;
  /** Under the selected token, for a bar that spans. */
  anchor: Point | null;
  spot: Spot;
  /** The bar's content height. */
  height: number;
  column: ColumnFacts | null;
}): { mode: BarMode; free: Box; hang: Hang; lane: Lane } | null {
  const free = freeArea(input.viewport, input.chrome, input.foot);
  const mode = barMode(input.layout, free.height);
  if (mode === "span") {
    if (!input.anchor) return null;
    // An upright span crosses the whole map, so it always meets the column: it keeps below the first card, or moves beside the lane, and never covers its token either way.
    const { lane, floor } = laneChoice({ laneTop: free.top, laneHeight: free.height, column: input.column, besideRoom: free.width - LANE_WIDTH });
    const hang = spanHang(input.anchor, free, input.height, floor);
    if (lane !== "beside") return { mode, free, hang, lane };
    const width = Math.min(BAR_WIDTH, free.width - LANE_WIDTH);
    return { mode, free, hang: { ...hang, left: laneLeft(free) - width, width }, lane };
  }
  const hang = mode === "compact" ? compactHang(input.layout, input.viewport, input.chrome) : spotHang(input.spot, free, { width: BAR_WIDTH, height: input.height });
  if (!input.column || !overlapsLane(hang, free)) return { mode, free, hang, lane: "none" };
  const shared = shareLane({
    hang,
    laneTop: free.top,
    laneHeight: mode === "compact" ? hang.room : free.height,
    column: input.column,
    laneLeft: laneLeft(free),
    besideRoom: free.width - LANE_WIDTH,
    content: input.height,
  });
  return { mode, free, ...shared };
}

/**
 * Where a docked or compact bar rests before it exists, for a pan that
 * opens it: its spot and the height it last had, shared with the column
 * as the drawn bar will be (placeBar). Null where the bar spans, since a
 * spanning bar is placed by its token.
 */
export function restingBar(input: { layout: Size; viewport: Size; chrome: Chrome; spot: Spot; height: number; foot?: number; column: ColumnFacts | null }): { box: Box; laneLeft: number } | null {
  const placed = placeBar({ ...input, foot: input.foot ?? 0, anchor: null });
  if (!placed || placed.mode === "span") return null;
  return { box: hangBox(placed.hang, input.height), laneLeft: laneLeft(placed.free) };
}

// ------------------------------------------------------------ notices

/**
 * Where the notice stack goes (design 1.3): centered left of the lane
 * when 320 px or more are left there, column or not, so nothing moves when
 * an alert arrives. Otherwise it spans as before, and the column starts
 * below its lasting notices.
 */
export function noticePlace(free: Box): { left: number; width: number } | null {
  const room = free.width - LANE_WIDTH;
  return room >= NOTICES_BESIDE_MIN ? { left: free.left, width: room } : null;
}

/**
 * What the column publishes after it measures itself: its cards' heights
 * while they are drawn, none when it has no card, and while they are
 * hidden (folded under a sheet or summarized beside the bar) the last
 * heights it had, at its top now. A turn band or a lasting notice still
 * moves the summary row that shows, and the bar must follow it. The same
 * object back when nothing changed, so nothing renders for nothing.
 */
export function columnFacts(prev: ColumnFacts | null, input: { top: number; measured: { content: number; first: number } | null }): ColumnFacts | null {
  const { top, measured } = input;
  if (!measured) return prev && prev.top !== top ? { ...prev, top } : prev;
  if (measured.first <= 0) return null;
  if (prev && prev.top === top && prev.content === measured.content && prev.first === measured.first) return prev;
  return { top, content: measured.content, first: measured.first };
}

/** The column's top: the lane's, or 8 px under the last lasting notice when the notices span over it. Toasts never move it. */
export function columnTop(laneTop: number, lastingBottom: number | null): number {
  return lastingBottom === null ? laneTop : Math.max(laneTop, lastingBottom + EDGE);
}

// ------------------------------------------------------------ the Select several hint

/**
 * The room the Select several bar's row has inside its padding, which
 * picks its hint (design section 3). From 900 px up the bar sizes to its
 * content, so the room comes from the map's width, never from the bar's
 * own drawn width, which would lock in whichever hint showed first. On a
 * phone it spans, and its own inner width is the room.
 */
export function hintRoom(input: { wide: boolean; mapWidth: number; padding: number; inner: number }): number {
  return input.wide ? Math.min(640, input.mapWidth - 2 * EDGE) - input.padding : input.inner;
}

export function shortHint(room: number): boolean {
  return room < LONG_HINT_MIN;
}

// ------------------------------------------------------------ the Room's slot

/** The bar as it shows, for the column, the notices and the camera. */
export type BarFacts = { box: Box; mode: BarMode; lane: Lane; laneLeft: number };

type BarDockState = {
  /** Room's chrome, measured. Null until it is. */
  chrome: Chrome | null;
  /** The bar while it shows, unfolded. */
  bar: BarFacts | null;
  /** The column's measures while it has cards to measure. */
  column: ColumnFacts | null;
  /** The bottom of the lasting notices while they span the map, which the column starts below. */
  notices: number | null;
  /** This Room's spot. A "view as a player" preview reads the device's and keeps its own changes to itself. */
  spot: Spot;
  /** The content height the bar last had, for where it will rest before it opens. */
  lastHeight: number;
  /** Set by Actions: the next bar to show takes focus on its frame. */
  focusFrame: boolean;
  /**
   * The height of a roll card standing on a narrow screen's toolbar and options bar
   * (features/rolls/PlayerRolls.tsx), or 0: a docked or spanning bar keeps
   * above it. Measured while it shows and kept while it is folded, so
   * folding it never changes where the bar goes.
   */
  foot: number;
  /** That card is folded because the bar opened compact, too short a screen for both, and the column's summary row stands for it. */
  footYields: boolean;
  /** The room between the top bars and the tool's options is under one whole alert card, and the column's summary row stands for its cards. */
  columnCramped: boolean;
};

/** Per Room page (state/scope.ts): a preview draws a second room with a bar and a column of its own. */
export const barDockSlot = scopeSlot(() =>
  createStore<BarDockState>(() => ({ chrome: null, bar: null, column: null, notices: null, spot: readSpot(), lastHeight: 200, focusFrame: false, foot: 0, footYields: false, columnCramped: false })),
);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
