import type { RoomState } from "#shared/model.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import { standing, type Standing } from "#shared/rules/heights.ts";
import { dropView, seenSeat, type DropToken, type Role } from "../features/movement/drop.ts";
import { screenToView, viewToScreen, type Camera, type Point } from "../lib/camera.ts";
import { footprint, snapPosition } from "../lib/scene.ts";
import { footprintCells, type GroundCell } from "../lib/groundCells.ts";
import { drawnBase, seenFootprintGround, toView, toWorld, type DrawnHeights, type DrawnSource, type View, type ViewPoint } from "../lib/view.ts";
import type { Grid } from "#shared/rules/grid.ts";

/**
 * The isometric view's drag adapter (docs/design-v1-isometric-view.md 6.3),
 * as pure functions. Konva gives the pressed node's screen point each
 * move, and the grab offset turns it into where the ring's center should
 * show (`v`, in view space). A point on screen names a whole line of world
 * points, one per height, so the adapter picks the height the token would
 * land at there: a token on the ground scans the drawn heights from the
 * highest down for the first it would stand at, a flier keeps its base
 * unless the ground there is higher, and a token inside the ground keeps
 * its base. A rider keeps its seat while the seat holds, and off it goes by
 * its holder's footing, as the drop lands it (movement/drop.ts
 * dropLanding). Every height read is drawn ground, which holds only what
 * this viewer has seen, so pick and preview agree with the drop wherever
 * its ground is seen, and hidden terrain never moves a preview.
 */

/** How a dragged token's height goes as it moves, in cells of drawn height. */
export type DragRule = { kind: "walk" } | { kind: "fly"; base: number } | { kind: "fixed"; base: number };

/** What a drag reads of its token, made once at its start. */
export type DragPlan = {
  /** The footprint in cells. */
  w: number;
  h: number;
  /** The token's own rule, from its footing on seen ground. */
  own: DragRule;
  /** A seat on a holder every player sees: its drawn height, whether it holds with the token's corner at a spot, and the rule off it, from the holder's footing. */
  seat: { base: number; keptAt(at: Point): boolean; off: DragRule } | null;
  /** The height a base over a drawn ground draws at, its lift capped (relief/standee.ts cappedBase): where the ray under the finger meets the ring. */
  drawn(base: number, ground: number): number;
};

/** The drawn ground a drag reads. */
export type DragGround = {
  /** Every drawn height on the scene in cells, highest first, 0 among them. */
  levels: readonly number[];
  /** The highest drawn ground under the footprint with its corner at a spot. */
  footGround(at: Point): number;
  /** Where the drop would snap a corner. */
  snap(at: Point): Point;
};

/**
 * Konva's `dragBoundFunc` for a pressed node: `pos` is where Konva would
 * put the node's corner on screen, the pointer less the grab Konva kept.
 * At the start the ring's center showed at `start.ring` and the corner at
 * `start.node`, so the ring now belongs at `pos` moved by their difference:
 * the pointer plus the grab offset from the pointer to the ring. The lead
 * lands by its plan, and the pressed node keeps its offset from the lead
 * (`rel`, in cells), so a rider's press moves its mount by the mount's own
 * rule. Returns the pressed node's corner on screen, at height 0, where
 * the ground group puts it.
 */
export function dragBound(input: { camera: Camera; view: View; ground: DragGround; plan: DragPlan; start: { node: Point; ring: Point }; rel: Point }, pos: Point): Point {
  const { camera, view, start, rel } = input;
  const ring = { x: pos.x + start.ring.x - start.node.x, y: pos.y + start.ring.y - start.node.y };
  const at = dragLanding(view, input.ground, input.plan, screenToView(camera, ring));
  return viewToScreen(camera, toView(view, { x: at.x + rel.x, y: at.y + rel.y }));
}

/** Where a dragged token's corner goes and the height its ring stands at, for the ring's view point `v`. */
export function dragLanding(view: View, ground: DragGround, plan: DragPlan, v: ViewPoint): Point & { z: number } {
  const at = (z: number, ray: number): Point & { z: number } => {
    const c = toWorld(view, v, ray);
    return { x: c.x - plan.w / 2, y: c.y - plan.h / 2, z };
  };
  // A base held above the ground meets the ray where its ring draws, lower than it stands where its lift is capped (ISO34-OPUS-10), and keeps its height.
  const place = (z: number): Point & { z: number } => placeDrawn(at, ground, (g) => plan.drawn(z, g), z);
  // A token standing on the ground at z has no lift to cap: its ring draws at z.
  const stand = (z: number): Point & { z: number } => at(z, z);
  if (plan.seat) {
    const seated = place(plan.seat.base);
    if (plan.seat.keptAt(ground.snap(seated))) return seated;
    return byRule(plan.seat.off, place, stand, ground);
  }
  return byRule(plan.own, place, stand, ground);
}

/**
 * Where a token at height `z` goes for the ray, when its ring draws at a
 * height that hangs on the ground under it (`drawn`): a capped lift, or a
 * flat creature on the ground. Each drawn ground from the highest down
 * gives a ray height and a spot, and the first whose spot has that ground
 * under it wins, so the ring stands where it draws there: a fixed point
 * (ISO34-OPUS-12, ASTRA-11). Failing one, the first whose spot's ground is
 * higher, then the lowest, as the scan's are. A ring that draws at one
 * height over any ground takes the ray there at once.
 */
function placeDrawn(at: (z: number, ray: number) => Point & { z: number }, ground: DragGround, drawn: (g: number) => number, z: number): Point & { z: number } {
  const levels = ground.levels;
  const lowest = levels[levels.length - 1] ?? 0;
  const top = drawn(levels[0] ?? 0);
  if (top === drawn(lowest)) return at(z, top);
  let above: (Point & { z: number }) | null = null;
  for (const g of levels) {
    const found = at(z, drawn(g));
    const under = ground.footGround(ground.snap(found));
    if (under === g) return found;
    if (under > g) above ??= found;
  }
  return above ?? at(z, drawn(lowest));
}

function byRule(rule: DragRule, place: (z: number) => Point & { z: number }, stand: (z: number) => Point & { z: number }, ground: DragGround): Point & { z: number } {
  if (rule.kind === "fixed") return place(rule.base);
  if (rule.kind === "walk") return scan(stand, ground, ground.levels, (at) => ground.footGround(at));
  const flying = place(rule.base);
  if (ground.footGround(ground.snap(flying)) <= rule.base) return flying;
  // Over higher ground a flier lands on it, as the drop lands it: the scan by that rule, its own height among the ones tried.
  const levels = [...new Set([...ground.levels, rule.base])].sort((a, b) => b - a);
  return scan((z) => (z === rule.base ? flying : stand(z)), ground, levels, (at) => Math.max(rule.base, ground.footGround(at)));
}

/**
 * The scan: at each drawn height from the highest down, the footprint
 * centered on the ray's point there and snapped as the drop snaps it. The
 * first height the landing rule over drawn ground stands it at exactly
 * wins, and failing one, the first it would stand at or above, so a Large
 * straddling a ledge stays under the finger. The lowest height always
 * qualifies, since no ground lies below it.
 */
function scan(place: (z: number) => Point & { z: number }, ground: DragGround, levels: readonly number[], landing: (at: Point) => number): Point & { z: number } {
  let above: (Point & { z: number }) | null = null;
  for (const z of levels) {
    const at = place(z);
    const stands = landing(ground.snap(at));
    if (stands === z) return at;
    if (stands > z) above ??= at;
  }
  return above ?? place(levels[levels.length - 1] ?? 0);
}

const levelCache = new WeakMap<DrawnHeights, readonly number[]>();

/** A scene's drawn heights in cells, highest first, 0 among them, kept with the heights object. */
export function levelsOf(heights: DrawnHeights): readonly number[] {
  if (heights.high === 0 && heights.low === 0) return ZERO;
  let levels = levelCache.get(heights);
  if (levels) return levels;
  const seen = new Set<number>([0]);
  for (const c of heights.cellsIn({ x0: 0, y0: 0, x1: heights.bounds.w, y1: heights.bounds.h })) seen.add(heights.atCell(c));
  levels = [...seen].sort((a, b) => b - a);
  levelCache.set(heights, levels);
  return levels;
}

const ZERO: readonly number[] = [0];

type Placed = FootprintToken & { id: string; sceneId: string };

/**
 * The drawn ground a token's drag reads: its footprint's highest drawn
 * ground at a spot, and the drop's snap, both on the scene's grid, so a
 * hex scene's drag snaps to the hexes Top-down's does (hex grids, H1).
 */
export function dragGround(heights: DrawnHeights, token: Placed, grid: Grid): DragGround {
  const size = footprint(token);
  return {
    levels: levelsOf(heights),
    footGround: (at) => highest(heights, footprintCells(grid, { ...token, x: at.x, y: at.y, squeeze: undefined })),
    snap: (at) => snapPosition(grid, at.x, at.y, size),
  };
}

/** The highest drawn ground over a footprint's own cells, from minus infinity, so a footprint wholly in pits reads its pits. Off the scene a cell reads 0. */
function highest(heights: DrawnHeights, cells: readonly GroundCell[]): number {
  let top = -Infinity;
  for (const c of cells) top = Math.max(top, heights.atCell(c));
  return top === -Infinity ? 0 : top;
}

/**
 * A drag's plan at its start: the footing of the token, and of the holder
 * it sits on, judged on the ground this viewer has seen (`src`), each
 * base in cells of drawn height (view.ts drawnBase). The seat is the
 * drop's own (drop.ts seenSeat), read from this viewer's copy.
 */
export function dragPlan(input: { room: RoomState; role: Role; src: DrawnSource; grid: Grid; feetPerCell: number; token: Placed & DropToken; drawn?: DragPlan["drawn"] }): DragPlan {
  const { room, role, src, grid, feetPerCell, token } = input;
  const drawn = input.drawn ?? UNCAPPED;
  const size = footprint(token);
  const ruleOf = (t: Placed, base: number): DragRule => ruleFor(seenStanding(src, grid, t), base);
  const ownBase = drawnBase(src, footprintCells(grid, token), token.elevation) / feetPerCell;
  const own = ruleOf(token, ownBase);
  const seat = seenSeat(dropView(room, role), token);
  if (!seat) return { w: size.w, h: size.h, own, seat: null, drawn };
  const holder = seat.holder as Placed;
  return {
    w: size.w,
    h: size.h,
    own,
    seat: {
      base: drawnBase(src, footprintCells(grid, holder), holder.elevation) / feetPerCell,
      keptAt: seat.keptAt,
      // Off a holder on the ground the token walks, off a flier it keeps its own height, off one inside the ground its own base.
      off: ruleFor(seenStanding(src, grid, holder), ownBase),
    },
    drawn,
  };
}

const UNCAPPED: DragPlan["drawn"] = (base) => base;

function seenStanding(src: DrawnSource, grid: Grid, t: Placed): Standing {
  return standing(t.elevation, seenFootprintGround(src, footprintCells(grid, t)));
}

function ruleFor(footing: Standing, base: number): DragRule {
  return footing === "ground" ? { kind: "walk" } : footing === "flying" ? { kind: "fly", base } : { kind: "fixed", base };
}
