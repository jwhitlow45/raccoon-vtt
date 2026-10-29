import type { DiagonalRule, Drawing, RoomSettings } from "#shared/model.ts";
import { MAX_RULER_STOPS, type DrawingInput } from "#shared/protocol.ts";
import { pathDistanceFt, pointCellBox, tokenCellBox, type CellBox } from "#shared/rules/distance.ts";
import { footprintRect, hexAnchor, occupiedHexes, type FootprintToken } from "#shared/rules/footprint.ts";
import type { Rect } from "#shared/rules/geom.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexAt, hexCenter, type Hex, type HexGrid } from "#shared/rules/hex.ts";

/**
 * Ruler math and the ruler's gesture rules (design section 9.2), kept free of
 * React and Konva so they are tested under plain Node.
 *
 * A ruler is a list of stops. A stop on a token measures from the token's
 * footprint (its edge), so a ruler from one creature to another reads the
 * same distance as `distanceFt`. A free stop sits on the center of the cell
 * it was dropped in, so the line drawn is exactly the cells measured, and it
 * stands on the ground there as the measurer sees it (`z`, in feet,
 * docs/design-v1-heights-readout.md section 3). The stop carries that
 * height in the ruler's ephemeral frame and in a kept ruler, so every
 * receiver reads the measurer's distance, whatever its own fog hides.
 *
 * On a hex scene (docs/design-v1-hex-grids.md 4.3) a free stop sits on the
 * center of the hex it was dropped in, every hex is one step, and a line
 * from a token starts where it leaves the outline of the token's hexes.
 * The scene's grid goes with every reading, so the typecheck lists them.
 */

export type Point = { x: number; y: number };

/** One ruler point, as the `ruler` ephemeral frame carries it. `z` is a free stop's ground in feet, left out at 0. */
export type RulerStop = { x: number; y: number; z?: number; tokenId?: string };

/**
 * The ground under a cell in feet, as the measurer may read it: all of it
 * for the DM, and for a player 0 where their fog hides it, so a ruler
 * cannot probe the dark (features/builder/heights/ground.ts seenGround).
 * On a hex scene the cell is a hex, `x` its column and `y` its row.
 */
export type GroundReader = (cell: Point) => number;

export type DistanceRules = Pick<RoomSettings, "feetPerCell" | "diagonal">;

/** The token fields a ruler reads. */
export type RulerToken = FootprintToken & { id: string };

/** A ruler, live or kept, has at most this many stops (shared/protocol.ts). */
export const MAX_RULER_POINTS = MAX_RULER_STOPS;

export function freeStop(g: Grid, p: Point, ground?: GroundReader): RulerStop {
  if (isHex(g)) {
    const hex = hexAt(g, p);
    return onGround(hexCenter(g, hex), ground?.({ x: hex.col, y: hex.row }) ?? 0);
  }
  const cell = { x: Math.floor(p.x), y: Math.floor(p.y) };
  return onGround({ x: cell.x + 0.5, y: cell.y + 0.5 }, ground?.(cell) ?? 0);
}

function onGround(at: Point, z: number): RulerStop {
  return z === 0 ? { x: at.x, y: at.y } : { x: at.x, y: at.y, z };
}

export function tokenStop(g: Grid, token: RulerToken): RulerStop {
  const r = footprintRect(g, token);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2, tokenId: token.id };
}

/** The stop for a pointer: on the token under it when there is one, which stands at its own height, else on the ground. */
export function stopAt(g: Grid, world: Point, token: RulerToken | undefined, ground?: GroundReader): RulerStop {
  return token ? tokenStop(g, token) : freeStop(g, world, ground);
}

/**
 * The cells a stop stands for. A stop whose token this view cannot resolve
 * (deleted, or hidden from this viewer) falls back to the point it was drawn at.
 */
export function stopBox(g: Grid, stop: RulerStop, tokens: Readonly<Record<string, RulerToken | undefined>>, feetPerCell: number): CellBox {
  const token = stop.tokenId ? tokens[stop.tokenId] : undefined;
  return token ? tokenCellBox(g, token, feetPerCell) : pointCellBox(g, { x: stop.x, y: stop.y, z: stop.z }, feetPerCell);
}

/**
 * Feet for each leg and the total. Under fiveTen the diagonal count carries
 * across waypoints, as the DMG variant asks, and heights count: a token's
 * elevation, and the ground a free stop stands on.
 */
export function measureStops(
  g: Grid,
  stops: readonly RulerStop[],
  tokens: Readonly<Record<string, RulerToken | undefined>>,
  rules: DistanceRules,
): { totalFt: number; legsFt: number[] } {
  return pathDistanceFt(
    stops.map((s) => stopBox(g, s, tokens, rules.feetPerCell)),
    rules,
  );
}

/** "35 ft". Half feet show one decimal, which only Tiny moves and odd scales produce. */
export function formatFeet(ft: number): string {
  const rounded = Math.round(ft * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ft`;
}

/**
 * What the ruler's line says the room counts. A hex has no diagonal (every
 * hex is one step, and the diagonal rule counts only height there, HX-D3),
 * so a hex scene's line speaks of hexes and never of diagonals.
 */
export function diagonalLabel(rule: DiagonalRule, g: Grid, feetPerCell: number): string {
  if (isHex(g)) {
    const per = `every hex ${feetPerCell} ft`;
    return rule === "five" ? per : rule === "fiveTen" ? `${per}, height 5-10-5` : `${per}, height by true distance`;
  }
  return rule === "five" ? "every diagonal 5 ft" : rule === "fiveTen" ? "diagonals 5-10-5" : "true distance";
}

/** Where the segment from the rectangle's center toward `toward` crosses its edge. */
export function rectExit(r: Rect, toward: Point): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity);
  if (t >= 1) return { x: cx, y: cy };
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Where the segment from a creature's anchor toward `toward` leaves the
 * outline of its hexes: the last point along it that is still on one of
 * them, which is the outline's crossing, since every footprint is
 * star-shaped from its anchor. The anchor itself when `toward` lies on the
 * hexes.
 */
export function hexesExit(g: HexGrid, hexes: readonly Hex[], anchor: Point, toward: Point): Point {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  if (dx === 0 && dy === 0) return anchor;
  let t = 0;
  for (const h of hexes) t = Math.max(t, segmentLeaves(g, h, anchor, dx, dy));
  if (t >= 1) return anchor;
  return { x: anchor.x + dx * t, y: anchor.y + dy * t };
}

/**
 * How far along `from + s * (dx, dy)` the segment leaves one hex, as a
 * fraction of it, or 0 when it never enters it: the convex hexagon's
 * clip, from its six sides' outward normals.
 */
function segmentLeaves(g: HexGrid, h: Hex, from: Point, dx: number, dy: number): number {
  const c = hexCenter(g, h);
  // The hex as six half-planes n . p <= d round its center: flats half a cell out, the other four sides too, at 60 degrees apart.
  const rowsNormals = [
    { x: 1, y: 0 },
    { x: 0.5, y: HEX_R * 1.5 },
    { x: -0.5, y: HEX_R * 1.5 },
    { x: -1, y: 0 },
    { x: -0.5, y: -HEX_R * 1.5 },
    { x: 0.5, y: -HEX_R * 1.5 },
  ];
  const normals = g.orient === "rows" ? rowsNormals : rowsNormals.map((n) => ({ x: n.y, y: n.x }));
  let lo = 0;
  let hi = 1;
  for (const n of normals) {
    const p = n.x * dx + n.y * dy;
    const q = 0.5 - (n.x * (from.x - c.x) + n.y * (from.y - c.y));
    if (p === 0) {
      if (q < 0) return 0;
      continue;
    }
    const t = q / p;
    if (p > 0) hi = Math.min(hi, t);
    else lo = Math.max(lo, t);
  }
  return lo <= hi ? hi : 0;
}

/**
 * The points to draw. A ruler that starts or ends on a token starts or ends
 * at the token's edge, where its distance is counted from: on a hex scene
 * the outline of its hexes. A waypoint on a token stays at the token's
 * center.
 *
 * A stop on a token is where that token stands now, not where its point
 * was saved, so an end leaves its token toward where the next stop's token
 * went rather than across the token's art.
 */
export function drawnPoints(g: Grid, stops: readonly RulerStop[], tokens: Readonly<Record<string, RulerToken | undefined>>): Point[] {
  const tokenOf = (s: RulerStop) => (s.tokenId ? tokens[s.tokenId] : undefined);
  const centers = stops.map((s): Point => {
    const token = tokenOf(s);
    if (!token) return { x: s.x, y: s.y };
    const center = tokenStop(g, token);
    return { x: center.x, y: center.y };
  });
  const edge = (token: RulerToken, toward: Point) => (g.shape === "hex" ? hexesExit(g, occupiedHexes(g, token), hexAnchor(g, token), toward) : rectExit(footprintRect(g, token), toward));
  return stops.map((s, i) => {
    const token = tokenOf(s);
    if (!token || stops.length < 2) return centers[i]!;
    if (i === 0) return edge(token, centers[1]!);
    if (i === stops.length - 1) return edge(token, centers[i - 1]!);
    return centers[i]!;
  });
}

/**
 * The ruler tool's state: the fixed stops, and the live end that follows a
 * finger during a drag.
 */
export type RulerState = { id: string; stops: RulerStop[]; live: RulerStop | null; shared: boolean };

/**
 * One finger on the map with the ruler tool. `extend` says whether it went
 * down on the ruler's last stop, so a drag from there carries the ruler on
 * instead of starting a new one.
 */
export type RulerGesture = { start: Point; startToken: RulerToken | undefined; extend: boolean; dragging: boolean; grid: Grid };

/** How close, in screen pixels, a finger must land to the last stop to carry the ruler on. */
export const EXTEND_RADIUS_PX = 28;

/**
 * `reach` is the camera's scale, or how far a stop shows from the press in
 * screen pixels where that is not the world distance times the scale, as
 * in the isometric view (canvas/boardPick.ts pressGap).
 */
export function beginGesture(
  state: RulerState | null,
  world: Point,
  token: RulerToken | undefined,
  reach: number | ((stop: RulerStop) => number),
  grid: Grid,
): RulerGesture {
  const last = state?.stops[state.stops.length - 1];
  const gap = (stop: RulerStop) => (typeof reach === "number" ? Math.hypot(world.x - stop.x, world.y - stop.y) * reach : reach(stop));
  const extend = !!last && gap(last) <= EXTEND_RADIUS_PX;
  return { start: world, startToken: token, extend, dragging: false, grid };
}

/**
 * The finger moved past the tap slop. A drag that started away from the
 * ruler measures afresh from where it started. One that started on the last
 * stop adds a leg to the finger.
 */
export function dragTo(
  state: RulerState | null,
  g: RulerGesture,
  world: Point,
  token: RulerToken | undefined,
  newId: () => string,
  ground?: GroundReader,
): RulerState {
  const live = stopAt(g.grid, world, token, ground);
  if (g.extend && state) return { ...state, live };
  return { id: state?.id ?? newId(), stops: [stopAt(g.grid, g.start, g.startToken, ground)], live, shared: state?.shared ?? false };
}

/**
 * The finger lifted. A drag fixes its live end as a stop. A tap adds a
 * waypoint, or starts a ruler when there is none.
 */
export function release(
  state: RulerState | null,
  g: RulerGesture,
  world: Point,
  token: RulerToken | undefined,
  newId: () => string,
  ground?: GroundReader,
): RulerState {
  if (g.dragging && state?.live) {
    return { ...state, stops: [...state.stops, state.live].slice(0, MAX_RULER_POINTS), live: null };
  }
  const stop = stopAt(g.grid, world, token, ground);
  if (!state) return { id: newId(), stops: [stop], live: null, shared: false };
  // A tap on the last stop would only add a leg of zero length.
  if (g.extend || state.stops.length >= MAX_RULER_POINTS) return { ...state, live: null };
  return { ...state, stops: [...state.stops, stop], live: null };
}

/** The stops a frame or a measurement covers: the fixed ones and the live end. */
export function allStops(state: RulerState): RulerStop[] {
  return state.live ? [...state.stops, state.live].slice(0, MAX_RULER_POINTS) : state.stops;
}

/**
 * Two taps this close in time and place make a double tap, which keeps the
 * ruler on the map (features section 4, design 14.3).
 */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

/** A tap that ended a gesture, in the page's milliseconds and screen pixels. */
export type Tap = { at: number; screen: Point };

export function isDoubleTap(prev: Tap | null, now: Tap): boolean {
  return prev !== null && now.at - prev.at <= DOUBLE_TAP_MS && Math.hypot(now.screen.x - prev.screen.x, now.screen.y - prev.screen.y) <= DOUBLE_TAP_PX;
}

/** A tap the ruler tool remembers, with the ruler as it was before that tap. */
export type LastTap = Tap & { before: RulerState | null };

/**
 * The finger lifted, as the ruler tool sees it: a double tap keeps the
 * ruler as it was before the pair, since the first tap of the pair already
 * added a waypoint or started a ruler. Anything else is a release, and a
 * tap is remembered for the next one.
 */
export function lift(input: {
  state: RulerState | null;
  gesture: RulerGesture & { before: RulerState | null };
  tap: Tap;
  lastTap: LastTap | null;
  world: Point;
  token: RulerToken | undefined;
  newId: () => string;
  ground?: GroundReader;
}): { keep: RulerState | null; lastTap: null } | { ruler: RulerState; lastTap: LastTap | null } {
  const { gesture: g, lastTap } = input;
  if (!g.dragging && lastTap && isDoubleTap(lastTap, input.tap)) return { keep: lastTap.before, lastTap: null };
  return {
    ruler: release(input.state, g, input.world, input.token, input.newId, input.ground),
    lastTap: g.dragging ? null : { ...input.tap, before: g.before },
  };
}

/**
 * The ruler as a drawing to keep on the map, or null while it measures
 * nothing. A stop on a token stays on it, so the kept ruler reads from
 * where that token stands, as the live one did. A free stop keeps the
 * ground it stood on, one `z` entry per stop with 0 on a token, written
 * only when some stop stands off the ground at 0. It is shared exactly
 * when the live ruler was: always for a player, and for the DM only once
 * Shared.
 */
export function keptDrawing(input: { id: string; sceneId: string; stops: readonly RulerStop[]; ownerId: string; color: string; shared: boolean; walk?: boolean }): DrawingInput | null {
  const stops = input.stops.slice(0, MAX_RULER_POINTS);
  if (stops.length < 2) return null;
  const drawing: DrawingInput = {
    id: input.id,
    sceneId: input.sceneId,
    kind: "ruler",
    points: stops.flatMap((s) => [s.x, s.y]),
    style: { stroke: input.color, width: 3, opacity: 1 },
    ownerId: input.ownerId,
    visibility: input.shared ? "all" : "dm",
  };
  if (stops.some((s) => s.tokenId !== undefined)) drawing.anchors = stops.map((s) => s.tokenId ?? null);
  const z = stops.map((s) => (s.tokenId === undefined ? (s.z ?? 0) : 0));
  if (z.some((feet) => feet !== 0)) drawing.z = z;
  // A walking ruler stays one when kept (docs/design-v1-movement.md 3.3).
  if (input.walk) drawing.walk = true;
  return drawing;
}

/**
 * What keeping a ruler does: the drawing to create, or, while the ruler
 * measures nothing yet, the ruler to leave on the map as it was (null for
 * none), so a stray double tap loses nothing.
 */
export function keepPlan(
  ruler: RulerState | null,
  input: Omit<Parameters<typeof keptDrawing>[0], "stops"> | null,
): { create: DrawingInput } | { leave: RulerState | null } {
  const drawing = ruler && input ? keptDrawing({ ...input, stops: ruler.stops }) : null;
  return drawing ? { create: drawing } : { leave: ruler };
}

/** A kept ruler's stops, measured and drawn the same way as a live ruler's. One kept before stops stood on the ground has no `z`, and reads at 0 as it did. */
export function keptStops(d: Pick<Drawing, "points" | "anchors" | "z">): RulerStop[] {
  const stops: RulerStop[] = [];
  for (let i = 0; i + 1 < d.points.length; i += 2) {
    const tokenId = d.anchors?.[i / 2];
    const z = d.z?.[i / 2] ?? 0;
    const at = { x: d.points[i]!, y: d.points[i + 1]! };
    stops.push(tokenId ? { ...at, tokenId } : z !== 0 ? { ...at, z } : at);
  }
  return stops;
}
