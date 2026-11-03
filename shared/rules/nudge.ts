import type { RoomState, Token } from "../model.ts";
import { keys, type EntityKey } from "../keys.ts";
import { ownEntry } from "../records.ts";
import { footprintRect, isSqueezed, snapStep, type PlacedToken } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { isHex, type Grid } from "./grid.ts";

/**
 * Snap off for a drag (docs/design/design-v1-snap-off.md 5): a token dropped
 * between squares stays on its snapped spot, which every rule reads, and
 * keeps a nudge, whole eighths of a square, that only drawing reads.
 *
 * The bound is under half a snap step, so the box a token would snap to from
 * where it is drawn is always the box under its stored spot (footprint.ts
 * `snap` rounds to the nearest step), for every size. That is also why
 * "within the bound of the landing" means "landed where it was aimed": a
 * move's aim is a snapped spot, and any other landing it may get, from a
 * wall, a touch or a trap, is a snapped spot at least one step away, beyond
 * the bound, or a spot off its grid, where no nudge is valid.
 */

export type Nudge = NonNullable<Token["nudge"]>;
type NudgedToken = PlacedToken & Pick<Token, "nudge">;

/** Eighths of a square, the lattice a nudge and a drop's `drawnAt` count in. */
export const NUDGE_STEPS = 8;

/** The most a nudge moves the token on each axis, in eighths: 3/8 square, or 1/8 for a token that snaps to half squares. */
export function nudgeBound(token: PlacedToken): number {
  return snapStep(token) < 1 ? 1 : 3;
}

/** Whether a token may be drawn off its spot at all (5.1): on squares, unsqueezed, standing on its own snapped spot. */
export function nudgeable(g: Grid, token: PlacedToken): boolean {
  if (isHex(g) || isSqueezed(token)) return false;
  const box = footprintRect(g, token);
  return box.x === token.x && box.y === token.y;
}

/** Whether a token's nudge holds (5.1): none, or one `nudgeable` allows, whole eighths within the bound, not both 0. */
export function nudgeValid(g: Grid, token: NudgedToken): boolean {
  const n = token.nudge;
  if (n === undefined) return true;
  const bound = nudgeBound(token);
  const fits = (v: number) => Number.isInteger(v) && Math.abs(v) <= bound;
  return fits(n.x) && fits(n.y) && (n.x !== 0 || n.y !== 0) && nudgeable(g, token);
}

/**
 * The nudge a move or an in-place drop leaves on a token that lands at
 * `landed` (5.3): none unless `drawnAt` is given, the landing can carry one,
 * and `drawnAt` is within the bound of it on each axis and not on it. No
 * clamp here: a `drawnAt` beyond the bound means the move landed somewhere
 * other than where it was aimed, and the token goes back on the grid.
 */
export function nudgeAt(g: Grid, landed: PlacedToken, drawnAt: Point | null | undefined): Nudge | undefined {
  if (!drawnAt || !nudgeable(g, landed)) return undefined;
  const bound = nudgeBound(landed);
  // Both are on the 1/8 lattice, so the difference in eighths is exact. A point off it never parses, and is refused here too.
  const x = (drawnAt.x - landed.x) * NUDGE_STEPS + 0;
  const y = (drawnAt.y - landed.y) * NUDGE_STEPS + 0;
  if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > bound || Math.abs(y) > bound || (x === 0 && y === 0)) return undefined;
  return { x, y };
}

/**
 * Where a free drop is drawn (6.4): the release, the drawn top-left the
 * pointer let go at, rounded to 1/8 square and held within the bound of the
 * spot the token lands on. The client sends it as the move's `drawnAt`.
 */
export function freeDrawnAt(landed: PlacedToken, release: Point): Point {
  const bound = nudgeBound(landed);
  const axis = (at: number, from: number) => from + Math.min(bound, Math.max(-bound, Math.round((at - from) * NUDGE_STEPS))) / NUDGE_STEPS + 0;
  return { x: axis(release.x, landed.x), y: axis(release.y, landed.y) };
}

/** Where a token is drawn, in cells: its stored top-left moved by its nudge, on a square scene. */
export function drawnSpot(g: Grid, token: NudgedToken): Point {
  if (!token.nudge || isHex(g)) return { x: token.x, y: token.y };
  return { x: token.x + token.nudge.x / NUDGE_STEPS, y: token.y + token.nudge.y / NUDGE_STEPS };
}

/** The token as a move or a pose leaves it, with the nudge given or none. */
export function withNudge<T extends NudgedToken>(token: T, nudge: Nudge | undefined): T {
  if (nudge) return { ...token, nudge };
  if (token.nudge === undefined) return token;
  const { nudge: _gone, ...rest } = token;
  return rest as T;
}

/**
 * The tokens whose nudges the pass at the end of every op judges (5.3,
 * D-261102-436): every token the op wrote, and every token of a scene whose
 * grid shape the op changed, which a switch to hexes leaves where it stood
 * but on no square. Only tokens with a nudge, sorted, so the pass writes in
 * the same order on every replay.
 */
export function nudgesToJudge(before: Pick<RoomState, "scenes">, after: Pick<RoomState, "scenes" | "tokens">, touched: readonly EntityKey[]): string[] {
  const ids = new Set<string>();
  const reshaped = new Set<string>();
  for (const key of touched) {
    if (key.startsWith(TOKEN)) ids.add(key.slice(TOKEN.length));
    else if (key.startsWith(SCENE)) {
      const id = key.slice(SCENE.length);
      const was = ownEntry(before.scenes, id);
      const now = ownEntry(after.scenes, id);
      if (was && now && was.gridShape !== now.gridShape) reshaped.add(id);
    }
  }
  if (reshaped.size > 0) {
    for (const token of Object.values(after.tokens)) if (token.nudge && reshaped.has(token.sceneId)) ids.add(token.id);
  }
  return [...ids].filter((id) => ownEntry(after.tokens, id)?.nudge !== undefined).sort();
}

const TOKEN = keys.token("");
const SCENE = keys.scene("");
