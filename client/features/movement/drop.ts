import type { BuildChunk, Scene, Token } from "#shared/model.ts";
import { MAX_MOVES, MAX_ROUTE_PIECES, MAX_ROUTE_REACH, type ClientOp, type DoorRef, type OpOf } from "#shared/protocol.ts";
import type { Blocker, BuildState } from "#shared/ruleHooks.ts";
import { canSqueeze, footprintSize, snapStep } from "#shared/rules/footprint.ts";
import { footprintGround, standing } from "#shared/rules/heights.ts";
import { landing, legStop, previewSqueezed, squeezeFits, type DropMode } from "#shared/rules/movement.ts";
import { routeLattice, routePoints, routeReach, type RoutePiece, type RoutePoint } from "#shared/rules/route.ts";
import { LegCheck, type WalkRoute, type WalkWorld } from "#shared/rules/walk.ts";
import { snapPosition } from "../../lib/scene.ts";

/**
 * Where a dropped token lands when walls, doors and ledges stop players'
 * moves (docs/design-v1-maps-vision.md sections 4.1 and 4.2), as plain
 * functions for node --test. The rule itself is part 4B's
 * (shared/rules/movement.ts), the very test the server runs in
 * `canApply`, so a drop the map sends is one the server takes, and a drag
 * into a wall stops there instead of bouncing back.
 *
 * Only a player's walk on a scene whose walls stop moves is stopped. The
 * DM's moves never are, and on other scenes nothing is, but a creature that
 * can squeeze still lands squeezed where it is dropped into a narrow
 * opening, whoever drops it.
 */

export type Role = "dm" | "player";
export type Point = { x: number; y: number };

/** The token fields a drop reads. */
export type DropToken = Pick<Token, "id" | "sceneId" | "size" | "x" | "y" | "elevation"> & Partial<Pick<Token, "w" | "h" | "squeeze" | "name" | "number">>;

/**
 * A press planned from where the board last drew the token, read again
 * where the room now has it (review MV-O-16): a drop that waited for its
 * route and just landed moved it, and the press steps on from there, by the
 * same offset. A token the room no longer has stays as it was.
 */
export function rebased(tokens: Readonly<Record<string, DropToken | undefined>>, token: DropToken, at: Point): { token: DropToken; at: Point } {
  const now = tokens[token.id];
  if (!now) return { token, at };
  return { token: now, at: { x: at.x + now.x - token.x, y: at.y + now.y - token.y } };
}

/** The fields a landing's elevation reads: where the token stands and how high. */
export type LandingToken = Omit<DropToken, "id" | "name" | "number">;

/** How this viewer's drops are judged on this scene: walked, or placed where they land. */
export function dropMode(role: Role, scene: Pick<Scene, "blockMovement"> | undefined): Exclude<DropMode, "teleport"> {
  return role === "player" && scene?.blockMovement === true ? "walk" : "free";
}

/**
 * The elevation a token lands at (section 4.2, "Landings write the
 * ground"): a token that stood on the ground takes the ground where it
 * lands, a flier keeps its height or rises to the ground there, whichever
 * is higher, and a token inside the ground keeps its elevation, since
 * nothing raises one on its own.
 */
export function landedElevation(chunks: Readonly<Record<string, BuildChunk>>, token: LandingToken, at: Point & { squeeze?: boolean }): number {
  const before = standing(token.elevation, footprintGround(chunks, token));
  if (before === "inside") return token.elevation;
  const there = footprintGround(chunks, { ...token, x: at.x, y: at.y, squeeze: at.squeeze === true ? true : undefined });
  return before === "ground" ? there : Math.max(token.elevation, there);
}

/** One token's landing, as a move op carries it. `elevation` only when the landing changes it, `squeeze` only when it squeezes, `route` only for a walk that is not the straight leg. */
export type Landed = { tokenId: string; x: number; y: number; elevation?: number; squeeze?: true; route?: OpOf<"token.move">["route"] };

/** A walk that a wall, a door or a ledge stopped short of where the player dropped the token. */
export type Stop = {
  tokenId: string;
  sceneId: string;
  blocker: Blocker;
  /** The door in the way, when the player sees a door there: a secret door not yet found is a wall to them. */
  door: DoorRef | null;
  /** Where the player dropped the token, snapped: the ghost, and where "Teleport here" goes. */
  ghost: Point;
  /** The drop's own unsnapped point, from which a teleport finds its squeezed spot as the drop does (`squeezedSpot`). */
  aim: Point;
  /** Where the walk stopped, the start when it stopped at its first step. */
  at: Point;
  /** A route was looked for and none reaches the spot on ground the party has seen (docs/design-v1-movement.md 3.1). */
  searched?: true;
  /** The search gave up past its cap (5.2). */
  capped?: true;
};

export type DropPlan = {
  moves: Landed[];
  /** The lone token's walk, stopped short. */
  stop: Stop | null;
  /** Tokens of a group drag left where they were, since a wall or a ledge stood in their way (section 4.1). */
  held: { token: DropToken; blocker: Blocker }[];
  /** The lone walk turned too often for one move, so it landed partway (docs/design-v1-movement.md 5.2). */
  cut?: true;
};

function moved(token: DropToken, at: Point & { squeeze: boolean }): boolean {
  return at.x !== token.x || at.y !== token.y || at.squeeze !== (token.squeeze === true);
}

export function landed(chunks: Readonly<Record<string, BuildChunk>>, token: DropToken, at: Point & { squeeze: boolean }): Landed {
  const out: Landed = { tokenId: token.id, x: at.x, y: at.y };
  const elevation = landedElevation(chunks, token, at);
  if (elevation !== token.elevation) out.elevation = elevation;
  if (at.squeeze) out.squeeze = true;
  return out;
}

/**
 * The squeezed spot under a drop at the unsnapped point `raw`: the one
 * whose squeezed footprint, on cell boundaries, is centered nearest the
 * dragged footprint's center. That is half a cell off the grid on each
 * side a squeeze shrinks, and on the grid on the others. Null when the
 * token never squeezes, or does not squeeze there.
 *
 * A drop tries it before the rule's half-cell shifts from the snapped spot
 * (movement.ts `landing`). Those shifts are tried in a fixed order and
 * keep the first that passes, which can be a cell from the finger, or, for
 * a placement that walks no leg, a spot against the corridor's wall from
 * the far side. So a squeezed creature dragged along its corridor stays
 * in it, and a nudge leaves it where it is.
 */
export function squeezedSpot(state: BuildState, token: DropToken, raw: Point, mode: DropMode): (Point & { squeeze: true }) | null {
  if (!canSqueeze(token)) return null;
  const size = footprintSize(token);
  const to = snapPosition(raw.x, raw.y, size);
  const spot = { x: size.w >= 2 ? Math.floor(raw.x) + 0.5 : to.x, y: size.h >= 2 ? Math.floor(raw.y) + 0.5 : to.y };
  const land = landing(state, token, { ...spot, elevation: landedElevation(state.buildChunks, token, spot) }, mode);
  return land.squeeze && !land.stopped && land.x === spot.x && land.y === spot.y ? { ...spot, squeeze: true } : null;
}

/**
 * Where one token dropped at the unsnapped point `raw` lands: in the
 * squeezed spot under it when the creature squeezes there, else on its own
 * snap grid by the movement rule's landing (movement.ts `landing`), which
 * walks a player's token up to the last clear spot and lines a squeezing
 * creature up with a narrow opening.
 */
export function planOne(state: BuildState, token: DropToken, raw: Point, mode: Exclude<DropMode, "teleport">): DropPlan {
  const squeezed = squeezedSpot(state, token, raw, mode);
  if (squeezed) return { moves: moved(token, squeezed) ? [landed(state.buildChunks, token, squeezed)] : [], stop: null, held: [] };
  const to = snapPosition(raw.x, raw.y, footprintSize(token));
  if (to.x === token.x && to.y === token.y) return { moves: [], stop: null, held: [] };
  const elevation = landedElevation(state.buildChunks, token, to);
  const land = landing(state, token, { x: to.x, y: to.y, elevation }, mode);
  const at = { x: land.x, y: land.y, squeeze: land.squeeze };
  const moves = moved(token, at) ? [landed(state.buildChunks, token, at)] : [];
  const stop: Stop | null = land.stopped
    ? { tokenId: token.id, sceneId: token.sceneId, blocker: land.stopped.blocker, door: land.stopped.door, ghost: to, aim: { x: raw.x, y: raw.y }, at: { x: land.x, y: land.y } }
    : null;
  return { moves, stop, held: [] };
}

/** What a lone drag's route search answered for the drop's spot (routeDrag.ts): the straight leg, a route, or no route. */
export type Found = { kind: "open" } | { kind: "route"; route: Pick<WalkRoute, "pieces"> } | { kind: "none"; capped: boolean };

/**
 * The spot a lone drop's route aims at (docs/design-v1-movement.md 3.1):
 * where the drop would be placed, by the drop's own rule and squeezed where
 * the creature squeezes, with no leg test, since the route is the leg. A
 * route steps on the lattice from where the token stands, so a token that
 * stands off its grid lands on that lattice, the nearest spot to it.
 */
export function routeTarget(state: BuildState, token: DropToken, raw: Point): Point & { squeeze: boolean } {
  const placed = planOne(state, token, raw, "free").moves[0];
  const at = placed ? { x: placed.x, y: placed.y, squeeze: placed.squeeze === true } : { x: token.x, y: token.y, squeeze: token.squeeze === true };
  const L = routeLattice(token);
  const onLattice = (v: number, from: number) => from + Math.round((v - from) / L) * L;
  return { x: onLattice(at.x, token.x), y: onLattice(at.y, token.y), squeeze: at.squeeze };
}

/**
 * A route past 64 pieces, cut where the drop can land (5.2): at the last
 * piece end, no later than the 64th, where the creature stands as a drop
 * would, squeezed only where the squeeze is a real one (`squeezeFits`), and
 * where nothing pinches it only on its own snap grid from where it stands,
 * as `routeSpots` counts a stand. Null when the route needs no cut, or no
 * piece end is such a spot.
 */
export function cutRoute(state: BuildState, token: DropToken, pieces: readonly RoutePiece[]): { pieces: RoutePiece[]; at: Point & { squeeze: boolean } } | null {
  if (pieces.length <= MAX_ROUTE_PIECES) return null;
  const grid = snapStep(token);
  const onGrid = (v: number, from: number) => Math.abs((v - from) / grid - Math.round((v - from) / grid)) < 1e-9;
  for (let k = MAX_ROUTE_PIECES; k > 0; k--) {
    const [x, y] = pieces[k - 1]!;
    const at = { x, y };
    if (!previewSqueezed(state, token, at)) {
      if (onGrid(x, token.x) && onGrid(y, token.y)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: false } };
      continue;
    }
    if (squeezeFits(state, token, at)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: true } };
  }
  return null;
}

/**
 * The walk a lone drop lands with (3.1, 5.6), the same for the board's
 * picture of a drag and for the drop: the route to `target`, cut after 64
 * pieces where the creature can stand (`cutRoute`). Null when it cannot be
 * cut, or reaches past 300 squares, which the server refuses: the drop then
 * goes as the straight leg. So the picture never draws a walk the drop
 * would not take, and never reads one longer than the server takes.
 */
export function routeLanding(state: BuildState, token: DropToken, target: Point & { squeeze?: boolean }, pieces: readonly RoutePiece[], feetPerCell: number): { pieces: RoutePiece[]; at: Point & { squeeze?: boolean }; points: RoutePoint[]; cut: boolean } | null {
  const cut = cutRoute(state, token, pieces);
  if (pieces.length === 0 || (pieces.length > MAX_ROUTE_PIECES && !cut)) return null;
  const at = cut ? cut.at : target;
  const kept = cut ? cut.pieces : [...pieces];
  const points = routePoints(state.buildChunks, token, kept, landedElevation(state.buildChunks, token, at));
  return routeReach(points, feetPerCell) <= MAX_ROUTE_REACH ? { pieces: kept, at, points, cut: cut !== null } : null;
}

/**
 * What a straight leg finds (design 14.17, review MV-O-12), an arrow key's
 * press of one square most of all: never searched round a wall. A leg the
 * leg test stops, or one the straight leg already walks exactly (open
 * ground, no extra cost, an even rise), is the straight drop, stopped at
 * the wall as before. Any other goes as a route along the straight leg,
 * its pieces built by the very code a search's route is (walk.ts
 * `LegCheck`): at the creature's own lattice spacing, split where the cost
 * or the rise per step changes. So whatever it walks over, rubble, water,
 * a rise a Tiny creature climbs in half squares, or the space of a
 * creature it may end in, counts as a route counts it (reviews ASTRA-10,
 * ASTRA-13 and ASTRA-15). `charge` counts its steps against the frame's
 * budget.
 */
export function keyStep(world: WalkWorld, target: Point, charge: (units?: number) => void = () => {}): Found {
  const check = new LegCheck(world, target, true);
  // One straight leg, checked whole: a step that cannot stop partway, charged to the frame's budget.
  check.run((units) => {
    charge(units);
    return false;
  });
  if (check.open || check.stopped || !check.route) return { kind: "open" };
  return { kind: "route", route: { pieces: check.route.pieces } };
}

/**
 * An arrow key's press as the drop it makes (design 14.17): one square,
 * never searched, what it walks over counted (`keyStep`), and held at a
 * wall as a drop is.
 */
export function planPress(state: BuildState, world: WalkWorld | null, token: DropToken, at: Point, mode: Exclude<DropMode, "teleport">, feetPerCell: number, charge?: (units?: number) => void): DropPlan {
  const found = world ? keyStep(world, routeTarget(state, token, at), charge) : { kind: "open" as const };
  return planWalk(state, token, at, mode, found, feetPerCell, world ? (to) => keyStep(world, to, charge) : undefined);
}

/** The note when a walk turned too often for one move and landed partway. */
export const CUT_TEXT = "Stopped partway: the way there turns too often for one move. Drag again to go on.";

/**
 * A lone drop with what its route search found (docs/design-v1-movement.md
 * 3.1 and 5.6). The straight leg is today's drop. A route lands at its
 * spot and goes with the move, cut after 64 pieces, and goes without a
 * route past 300 squares of reach, which the server refuses. No route, a
 * search past its cap, or a scene not yet loaded fall back to today's
 * straight drop: a player's walk held at the wall with the note's new
 * words, the DM's drop straight through.
 *
 * That straight drop still counts what it walks over (`account`, the
 * straight leg's own route, `keyStep`): a walk held at a wall, or a drop
 * whose search gave up, pays for the rubble on its way as a route does,
 * since what a walk costs never hangs on whether a search could find its
 * way (review ASTRA-15). Past 64 pieces, or where the leg test stops the
 * straight leg, as the DM's drop through a wall, it goes as the straight
 * leg alone.
 */
export function planWalk(state: BuildState, token: DropToken, raw: Point, mode: Exclude<DropMode, "teleport">, found: Found, feetPerCell: number, account?: (to: Point) => Found): DropPlan {
  const walk = found.kind === "route" ? routeLanding(state, token, routeTarget(state, token, raw), found.route.pieces, feetPerCell) : null;
  if (walk) {
    const move = landed(state.buildChunks, token, { ...walk.at, squeeze: walk.at.squeeze === true });
    const route = walk.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
    return { moves: [{ ...move, route }], stop: null, held: [], ...(walk.cut ? { cut: true as const } : {}) };
  }
  const plan = planOne(state, token, raw, mode);
  if (found.kind === "none" && plan.stop) plan.stop = { ...plan.stop, searched: true, ...(found.capped ? { capped: true as const } : {}) };
  const straight = plan.moves.length === 1 && account ? plan.moves[0]! : null;
  if (straight && !straight.route) {
    const at = { x: straight.x, y: straight.y, ...(straight.squeeze ? { squeeze: true } : {}) };
    const own = account!(at);
    const kept = own.kind === "route" ? routeLanding(state, token, at, own.route.pieces, feetPerCell) : null;
    if (kept && !kept.cut) plan.moves = [{ ...straight, route: kept.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) }];
  }
  return plan;
}

/**
 * A group drag (features section 5): each token moves by the same offset
 * and snaps by its own footprint. Walking, each token's own leg is tested,
 * and only the allowed ones go, since the server refuses a group move whole
 * when one leg is stopped (section 4.1). A group move carries no squeeze,
 * so a creature that would have to squeeze to land stays put on a walk.
 */
export function planGroup(state: BuildState, tokens: readonly DropToken[], dx: number, dy: number, mode: Exclude<DropMode, "teleport">): DropPlan {
  const moves: Landed[] = [];
  const held: DropPlan["held"] = [];
  for (const token of tokens) {
    const to = snapPosition(token.x + dx, token.y + dy, footprintSize(token));
    if (to.x === token.x && to.y === token.y) continue;
    const elevation = landedElevation(state.buildChunks, token, to);
    const stopped = mode === "walk" ? legStop(state, token, { x: to.x, y: to.y, elevation }) : null;
    if (stopped) held.push({ token, blocker: stopped.blocker });
    else moves.push(landed(state.buildChunks, token, { ...to, squeeze: false }));
  }
  return { moves, stop: null, held };
}

/**
 * The ops for a plan's moves: one `token.move` for a lone token, which may
 * squeeze, else `token.moveMany` in batches the protocol takes, which never
 * squeezes.
 */
export function moveOpsOf(moves: readonly Landed[]): ClientOp[] {
  if (moves.length === 0) return [];
  if (moves.length === 1) return [{ t: "token.move", ...moves[0]! }];
  const plain = moves.map(({ squeeze: _squeeze, route: _route, ...m }) => m);
  const ops: ClientOp[] = [];
  for (let i = 0; i < plain.length; i += MAX_MOVES) ops.push({ t: "token.moveMany", moves: plain.slice(i, i + MAX_MOVES) });
  return ops;
}

/** What the map says while a drag is held at a wall or a ledge. */
export function holdLabel(blocker: Blocker): string {
  return blocker === "wall" ? "Wall in the way" : "Ledge in the way";
}

/**
 * The note after a stopped drop: what stopped it, and how to go on. A walk
 * whose search found no way says so (docs/design-v1-movement.md 3.1),
 * after "Too far to work out a way around" when the search gave up.
 */
export function stopText(stop: Pick<Stop, "blocker" | "door" | "searched" | "capped">): string {
  const far = stop.capped ? "Too far to work out a way around. " : "";
  if (stop.door) return `${far}A door is in the way. Tap it to open.`;
  if (!stop.searched) return stop.blocker === "ledge" ? "Ledge in the way. Take the stairs." : "Stopped at a wall. Drop at the corner first, then go on.";
  if (stop.blocker === "ledge") return `${far}Ledge in the way. No stairs you have seen lead there.`;
  return `${far}Stopped at a wall. There is no way around it that you have seen.`;
}

/** The note for the tokens of a group drag that stayed where they were. */
export function heldText(held: readonly { name: string; blocker: Blocker }[]): string | null {
  const first = held[0];
  if (!first) return null;
  if (held.length === 1) return `${first.name} stayed where it was: a ${first.blocker} is in the way.`;
  const what = held.every((h) => h.blocker === "wall") ? "walls are" : held.every((h) => h.blocker === "ledge") ? "ledges are" : "walls or ledges are";
  return `${held.length} tokens stayed where they were: ${what} in the way.`;
}
