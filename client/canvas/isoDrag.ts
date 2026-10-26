import type { RoomState } from "#shared/model.ts";
import { occupiedRange, type CellRange, type FootprintToken } from "#shared/rules/footprint.ts";
import { standing, type Standing } from "#shared/rules/heights.ts";
import { dropView, seenSeat, type DropToken, type Role } from "../features/movement/drop.ts";
import { screenToView, viewToScreen, type Camera, type Point } from "../lib/camera.ts";
import { footprint, snapPosition } from "../lib/scene.ts";
import { drawnBase, seenFootprintGround, toView, toWorld, type DrawnHeights, type DrawnSource, type View, type ViewPoint } from "../lib/view.ts";

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
  // That height hangs on the ground at the spot the ray finds, so it is sought until the spot holds (ISO34-OPUS-12): a few steps, bounded, since two spots on uneven ground can take turns.
  const place = (z: number): Point & { z: number } => {
    let spot = ground.snap(at(z, z));
    let found = at(z, plan.drawn(z, ground.footGround(spot)));
    for (let step = 0; step < SETTLE_STEPS; step++) {
      const next = ground.snap(found);
      if (next.x === spot.x && next.y === spot.y) break;
      spot = next;
      found = at(z, plan.drawn(z, ground.footGround(spot)));
    }
    return found;
  };
  if (plan.seat) {
    const seated = place(plan.seat.base);
    if (plan.seat.keptAt(ground.snap(seated))) return seated;
    return byRule(plan.seat.off, place, ground);
  }
  return byRule(plan.own, place, ground);
}

/** How many more spots a capped ring's ray height may be sought at before the last one stands. */
const SETTLE_STEPS = 4;

function byRule(rule: DragRule, place: (z: number) => Point & { z: number }, ground: DragGround): Point & { z: number } {
  if (rule.kind === "fixed") return place(rule.base);
  if (rule.kind === "walk") return scan(place, ground, ground.levels, (at) => ground.footGround(at));
  const flying = place(rule.base);
  if (ground.footGround(ground.snap(flying)) <= rule.base) return flying;
  // Over higher ground a flier lands on it, as the drop lands it: the scan by that rule, its own height among the ones tried.
  const levels = [...new Set([...ground.levels, rule.base])].sort((a, b) => b - a);
  return scan(place, ground, levels, (at) => Math.max(rule.base, ground.footGround(at)));
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
  for (let y = 0; y < heights.bounds.h; y++) for (let x = 0; x < heights.bounds.w; x++) seen.add(heights.at(x, y));
  levels = [...seen].sort((a, b) => b - a);
  levelCache.set(heights, levels);
  return levels;
}

const ZERO: readonly number[] = [0];

type Placed = FootprintToken & { id: string; sceneId: string };

/** The drawn ground a token's drag reads: its footprint's highest drawn ground at a spot, and the drop's snap. */
export function dragGround(heights: DrawnHeights, token: Placed): DragGround {
  const size = footprint(token);
  return {
    levels: levelsOf(heights),
    footGround: (at) => highest(heights, occupiedRange({ ...token, x: at.x, y: at.y, squeeze: undefined })),
    snap: (at) => snapPosition(at.x, at.y, size),
  };
}

function highest(heights: DrawnHeights, r: CellRange): number {
  let top = -Infinity;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) top = Math.max(top, inScene(heights, x, y) ? heights.at(x, y) : 0);
  return top === -Infinity ? 0 : top;
}

function inScene(heights: DrawnHeights, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < heights.bounds.w && y < heights.bounds.h;
}

/**
 * A drag's plan at its start: the footing of the token, and of the holder
 * it sits on, judged on the ground this viewer has seen (`src`), each
 * base in cells of drawn height (view.ts drawnBase). The seat is the
 * drop's own (drop.ts seenSeat), read from this viewer's copy.
 */
export function dragPlan(input: { room: RoomState; role: Role; src: DrawnSource; feetPerCell: number; token: Placed & DropToken; drawn?: DragPlan["drawn"] }): DragPlan {
  const { room, role, src, feetPerCell, token } = input;
  const drawn = input.drawn ?? UNCAPPED;
  const size = footprint(token);
  const ruleOf = (t: Placed, base: number): DragRule => ruleFor(seenStanding(src, t), base);
  const ownBase = drawnBase(src, occupiedRange(token), token.elevation) / feetPerCell;
  const own = ruleOf(token, ownBase);
  const seat = seenSeat(dropView(room, role), token);
  if (!seat) return { w: size.w, h: size.h, own, seat: null, drawn };
  const holder = seat.holder as Placed;
  return {
    w: size.w,
    h: size.h,
    own,
    seat: {
      base: drawnBase(src, occupiedRange(holder), holder.elevation) / feetPerCell,
      keptAt: seat.keptAt,
      // Off a holder on the ground the token walks, off a flier it keeps its own height, off one inside the ground its own base.
      off: ruleFor(seenStanding(src, holder), ownBase),
    },
    drawn,
  };
}

const UNCAPPED: DragPlan["drawn"] = (base) => base;

function seenStanding(src: DrawnSource, t: Placed): Standing {
  return standing(t.elevation, seenFootprintGround(src, occupiedRange(t)));
}

function ruleFor(footing: Standing, base: number): DragRule {
  return footing === "ground" ? { kind: "walk" } : footing === "flying" ? { kind: "fly", base } : { kind: "fixed", base };
}
