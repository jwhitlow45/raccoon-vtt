import { serializedBytes } from "#shared/limits.ts";
import type { FogOp, FogShape } from "#shared/model.ts";
import { MAX_ASK_BYTES, MAX_FOG_CELLS, MAX_FOG_DRAFT_OPS, MAX_POLY_VERTICES, MAX_STROKE_POINTS, type ClientOp } from "#shared/protocol.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, parseHexKey, type HexGrid } from "#shared/rules/hex.ts";
import { floodHexRoom, floodRoom, type BuildIndex, type WallSet } from "#shared/rules/walls.ts";

/**
 * The DM's fog gestures as fog ops (design sections 13.1 and 13.2). Each op
 * must fit the schema: a stroke has at most 500 points, a polygon at most
 * 200 vertices, a "cells" shape at most 2,000 cells. Longer strokes and
 * larger rooms become several ops.
 */

export type Point = { x: number; y: number };
export type Bounds = { w: number; h: number };
export type FogMode = FogOp["mode"];

/** Fog resolves to a quarter cell, so shapes snap there and the preview shows exactly what will flip. */
export function snapQuarter(v: number): number {
  return Math.round(v * 4) / 4;
}

export function snapPoint(p: Point): Point {
  return { x: snapQuarter(p.x), y: snapQuarter(p.y) };
}

/** The rectangle between two drag points, snapped, or null when it has no area. */
export function rectShape(a: Point, b: Point): Extract<FogShape, { kind: "rect" }> | null {
  const x0 = snapQuarter(Math.min(a.x, b.x));
  const y0 = snapQuarter(Math.min(a.y, b.y));
  const x1 = snapQuarter(Math.max(a.x, b.x));
  const y1 = snapQuarter(Math.max(a.y, b.y));
  return x1 > x0 && y1 > y0 ? { kind: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A closed polygon from tapped points, or null with fewer than three. Extra taps past the limit are dropped. */
export function polyShape(points: readonly Point[]): Extract<FogShape, { kind: "poly" }> | null {
  if (points.length < 3) return null;
  return { kind: "poly", points: points.slice(0, MAX_POLY_VERTICES).flatMap((p) => [p.x, p.y]) };
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas-Peucker: drops points closer than `epsilon` (cells) to the line
 * through their neighbors. Iterative, so a long stroke cannot overflow the
 * stack. The first and last points always stay.
 */
export function simplify(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let worstDist = epsilon;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k]!, points[i]!, points[j]!);
      if (d > worstDist) {
        worst = k;
        worstDist = d;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i, worst], [worst, j]);
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** How far a simplified stroke may stray from the finger, in cells: a fraction of a fog sub-cell. */
export const STROKE_EPSILON = 0.05;

/**
 * Brush strokes, simplified, as stroke shapes of at most 500 points.
 * Consecutive pieces share their joining point, so the pieces leave no gap.
 */
export function strokeShapes(
  points: readonly Point[],
  width: number,
  maxPoints: number = MAX_STROKE_POINTS,
): Extract<FogShape, { kind: "stroke" }>[] {
  const simple = simplify(points, STROKE_EPSILON);
  if (simple.length === 0) return [];
  const out: Extract<FogShape, { kind: "stroke" }>[] = [];
  for (let start = 0; ; start += maxPoints - 1) {
    const part = simple.slice(start, start + maxPoints);
    out.push({ kind: "stroke", width, points: part.flatMap((p) => [p.x, p.y]) });
    if (start + maxPoints >= simple.length) break;
  }
  return out;
}

/** Splits cell keys into "cells" shapes of at most 2,000 cells. */
export function cellShapes(cells: readonly string[], max: number = MAX_FOG_CELLS): Extract<FogShape, { kind: "cells" }>[] {
  const out: Extract<FogShape, { kind: "cells" }>[] = [];
  for (let i = 0; i < cells.length; i += max) out.push({ kind: "cells", cells: cells.slice(i, i + max) });
  return out;
}

/**
 * "Reveal room" (design 13.2): the builder room under the tap, from a flood
 * fill bounded by walls, windows and closed doors. The fill is capped at the
 * scene's area, the most any room can hold, so its work is bounded however
 * the build looks. Empty when the tap is not on a builder floor.
 */
export function roomShapes(build: BuildIndex, at: Point, bounds: Bounds): { shapes: Extract<FogShape, { kind: "cells" }>[]; cells: number } {
  const { cells } = floodRoom(build, at, { bounds, maxCells: bounds.w * bounds.h });
  return { shapes: cellShapes(cells), cells: cells.length };
}

/**
 * "Reveal room" on a hex scene (docs/design/design-v1-hex-grids.md HX-D10): the
 * hexes flooded from the tap up to wall lines, windows and closed doors,
 * or to the scene's edge where nothing walls them in, as hex keys the
 * server reads by their sub-cells. The flood never leaves the scene's
 * hexes, so its work is bounded by them. Empty when the tap is on no whole
 * hex of the scene.
 */
export function hexRoomShapes(walls: WallSet, g: HexGrid, at: Point, bounds: Bounds): Extract<FogShape, { kind: "cells" }>[] {
  return cellShapes(floodHexRoom(walls, g, bounds, at).cells);
}

/**
 * One gesture's fog ops. A gesture of several shapes (a room over 2,000
 * cells, a long brush stroke) names its ops `<gesture>.<n>` (GESTURE_OP), so the draft
 * shows and counts them as the one edit the DM made, and Undo takes it
 * back whole (lastEditIds). A gesture of one shape keeps a plain id. The
 * server never reads the names.
 */
export function fogOps(shapes: readonly FogShape[], mode: FogMode, newId: () => string): FogOp[] {
  if (shapes.length === 1) return [{ id: newId(), mode, shape: shapes[0]! }];
  const gesture = newId();
  return shapes.map((shape, i) => ({ id: `${gesture}.${i}`, mode, shape }));
}

/**
 * An op id as fogOps names a gesture's ops: a gesture id the client's
 * newId made, version 8 sealed under its key or version 7 from a page
 * without one, a dot and the op's place, at most 499, since a draft holds
 * at most 500 ops. Fog op ids were never checked for form, so an older or
 * imported draft can hold ids such as `draft.1` and `draft.2` for separate
 * edits. Only this exact form is read as a gesture, and any other id is an
 * edit of its own.
 */
const GESTURE_OP = /^([0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(0|[1-9][0-9]?|[1-4][0-9]{2})$/;

/**
 * The gesture an op id names by its form (GESTURE_OP), or the id itself.
 * Whether the op is one of that gesture's edit is the draft's to say
 * (draftEdits). The app never calls it: it is kept so tests can check the
 * id form on its own.
 */
export function fogEditOf(id: string): string {
  return GESTURE_OP.exec(id)?.[1] ?? id;
}

/**
 * Each draft op's edit, in draft order. A gesture's ops are one edit only
 * as fogOps numbers them: from .0 up, in draft order. So an imported
 * draft's crafted ids, such as `<gesture>.1` and `<gesture>.2`, or a plain
 * id beside its own `.0`, stay edits of their own (H3-DATA-5), and every
 * draft the app wrote reads as it always did: its gestures start at .0,
 * and another DM's edit can only land between their ops. An op without an
 * id is an edit of its own.
 *
 * Edits that share an op id are one edit: Undo removes ops by id, so it
 * takes every op of an id back together, and a count or an outline that
 * kept them apart would promise an undo step that does not exist. Only an
 * imported draft can repeat an id, such as a gesture's `.0` and `.1` twice.
 */
function editKeys(ops: readonly { id?: string }[]): string[] {
  const keys = gestureKeys(ops);
  const merged = new Map<string, string>();
  const root = (key: string): string => {
    let at = key;
    for (let up = merged.get(at); up !== undefined; up = merged.get(at)) at = up;
    return at;
  };
  const byId = new Map<string, string>();
  ops.forEach((op, i) => {
    if (op.id === undefined) return;
    const seen = byId.get(op.id);
    if (seen === undefined) {
      byId.set(op.id, keys[i]!);
      return;
    }
    const a = root(seen);
    const b = root(keys[i]!);
    if (a !== b) merged.set(b, a);
  });
  return keys.map(root);
}

/** Each op's edit by its id's form and place alone (editKeys). */
function gestureKeys(ops: readonly { id?: string }[]): string[] {
  const open = new Map<string, { key: string; last: number }>();
  return ops.map((op, i) => {
    if (op.id === undefined) return `#${i}`;
    const gesture = GESTURE_OP.exec(op.id);
    if (!gesture) return `=${op.id}`;
    const n = Number(gesture[2]);
    const edit = open.get(gesture[1]!);
    if (edit && n > edit.last) {
      edit.last = n;
      return edit.key;
    }
    if (n !== 0) return `=${op.id}`;
    const key = `~${i}`;
    open.set(gesture[1]!, { key, last: 0 });
    return key;
  });
}

/** A draft's ops as the edits the DM made, each edit's ops together, in the order the edits began. */
export function draftEdits<T extends { id?: string }>(ops: readonly T[]): T[][] {
  const edits = new Map<string, T[]>();
  const keys = editKeys(ops);
  ops.forEach((op, i) => {
    const key = keys[i]!;
    const edit = edits.get(key);
    if (edit) edit.push(op);
    else edits.set(key, [op]);
  });
  return [...edits.values()];
}

/** The ids the fog bar's Undo takes out of a draft: every op of the edit its last op belongs to, so a room sent in several ops goes whole. */
export function lastEditIds(ops: readonly FogOp[]): string[] {
  if (ops.length === 0) return [];
  const keys = editKeys(ops);
  const last = keys[keys.length - 1];
  return [...new Set(ops.filter((_, i) => keys[i] === last).map((o) => o.id))];
}

/**
 * A React key for the draft's op at a place. An imported draft can repeat
 * an op id (`draftOutlines` takes care of the outlines), and two children
 * with one key are drawn or dropped wrongly when the draft changes. The
 * place alone would remount every op after one removed from the middle,
 * so the id rides with it.
 */
export function opKey(op: Pick<FogOp, "id">, index: number): string {
  return `${index}:${op.id}`;
}

/**
 * The draft's outlines of its "cells" ops, by op id: one outline round all
 * the cells of an edit, on its first cells op, and none on the rest, so a
 * room sent in several ops draws as one room and not as bands. The sides
 * of squares, or of hexes on a hex scene.
 */
export function draftOutlines(ops: readonly FogOp[], g: Grid): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const edit of draftEdits(ops)) {
    const cellOps = edit.filter((o) => o.shape.kind === "cells");
    if (cellOps.length === 0) continue;
    const cells = cellOps.flatMap((o) => (o.shape.kind === "cells" ? o.shape.cells : []));
    const first = cellOps[0]!.id;
    out.set(first, isHex(g) ? hexCellsOutline(g, cells) : cellsOutline(cells));
    // An imported draft can repeat the first op's id further on, which keeps its outline.
    for (const o of cellOps.slice(1)) if (o.id !== first) out.set(o.id, []);
  }
  return out;
}

/**
 * The most bytes one fog message's op carries: an ask's (protocol.ts
 * MAX_ASK_BYTES), so the op and the frame round it fit a socket frame
 * (server/rooms/ws.ts MAX_FRAME_BYTES). The server closes a socket on a
 * bigger frame, and the outbox would send the op again on every reconnect.
 */
export const MAX_FOG_MESSAGE_BYTES = MAX_ASK_BYTES;

export type FogMessage = Extract<ClientOp, { t: "fog.draft" | "fog.live" }>;

/**
 * One gesture's fog ops as the fewest `fog.draft` (or, live, `fog.live`)
 * ops that each hold at most MAX_FOG_DRAFT_OPS of them and
 * MAX_FOG_MESSAGE_BYTES, in order, to go out as one undo step. A Builder
 * room on a large hex scene runs to hundreds of kilobytes. One fog op
 * always fits alone: a shape holds at most 2,000 cells, 500 stroke points
 * or 200 corners.
 */
export function fogMessages(sceneId: string, ops: readonly FogOp[], live: boolean): FogMessage[] {
  const wrap = (batch: FogOp[]): FogMessage => (live ? { t: "fog.live", sceneId, ops: batch } : { t: "fog.draft", sceneId, add: batch });
  // An array's JSON is its items joined by commas inside its brackets, so a batch's size adds up without serializing it again.
  const empty = serializedBytes(wrap([]));
  const out: FogMessage[] = [];
  let batch: FogOp[] = [];
  let bytes = empty;
  for (const op of ops) {
    const size = serializedBytes(op);
    if (batch.length > 0 && (batch.length >= MAX_FOG_DRAFT_OPS || bytes + 1 + size > MAX_FOG_MESSAGE_BYTES)) {
      out.push(wrap(batch));
      batch = [];
      bytes = empty;
    }
    bytes += (batch.length > 0 ? 1 : 0) + size;
    batch.push(op);
  }
  if (batch.length > 0) out.push(wrap(batch));
  return out;
}

/**
 * The outline of a set of cells, as flat segments `[ax, ay, bx, by, ...]`:
 * every cell side that does not touch another cell of the set. For drawing a
 * "reveal room" draft as an outline.
 */
export function cellsOutline(cells: readonly string[]): number[] {
  const set = new Set(cells);
  const out: number[] = [];
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (!set.has(`${x},${y - 1}`)) out.push(x, y, x + 1, y);
    if (!set.has(`${x},${y + 1}`)) out.push(x, y + 1, x + 1, y + 1);
    if (!set.has(`${x - 1},${y}`)) out.push(x, y, x, y + 1);
    if (!set.has(`${x + 1},${y}`)) out.push(x + 1, y, x + 1, y + 1);
  }
  return out;
}

/**
 * The outline of a set of hexes, as cellsOutline gives a set of squares':
 * every side of a hex whose hex across is not in the set. The hex across a
 * side is the one holding the point as far past the side's middle as the
 * hex's center lies short of it, so no table of sides to neighbors is
 * needed for either orientation.
 */
export function hexCellsOutline(g: HexGrid, cells: readonly string[]): number[] {
  const set = new Set(cells);
  const out: number[] = [];
  for (const key of set) {
    const hex = parseHexKey(key);
    if (!hex) continue;
    const center = hexCenter(g, hex);
    const corners = hexCorners(g, hex).map((c) => cornerAt(g, c));
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      const beyond = hexAt(g, { x: a.x + b.x - center.x, y: a.y + b.y - center.y });
      if (!set.has(`${beyond.col},${beyond.row}`)) out.push(a.x, a.y, b.x, b.y);
    }
  }
  return out;
}

/**
 * The draft's publish button, named for what it does to the players' view:
 * a draft of reveals clears fog, one of hides adds it, and a mix does both.
 * The count is the number of draft edits: what the DM did, so one Builder
 * room tap is one however many ops it took (draftEdits).
 */
export function publishLabel(ops: readonly { id?: string; mode: FogMode }[]): string {
  const n = draftEdits(ops).length;
  if (ops.every((o) => o.mode === "reveal")) return `Reveal to players (${n})`;
  if (ops.every((o) => o.mode === "hide")) return `Fog for players (${n})`;
  return `Show players the changes (${n})`;
}

/** The publish button's short words where the row is narrow (docs/design/design-v1-tool-options.md 9.6): "Reveal (4)", "Fog (4)" or "Show (4)". Its tooltip keeps the whole sentence. */
export function publishShort(ops: readonly { id?: string; mode: FogMode }[]): string {
  const n = draftEdits(ops).length;
  if (ops.every((o) => o.mode === "reveal")) return `Reveal (${n})`;
  if (ops.every((o) => o.mode === "hide")) return `Fog (${n})`;
  return `Show (${n})`;
}

/** A brush width, in cells, as the room measures: "10 ft" at 5 ft a square. */
export function brushLabel(cells: number, feetPerCell: number): string {
  return `${cells * feetPerCell} ft`;
}
