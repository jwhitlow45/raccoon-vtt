import type { RoomState, Scene, Token } from "#shared/model.ts";
import { MAX_MOVES, MAX_ROUTE_PIECES, MAX_ROUTE_REACH, type ClientOp, type DoorRef, type OpOf } from "#shared/protocol.ts";
import { SOMETHING_BLOCKS, stopWords, WALL_IN_THE_WAY } from "#shared/permissions.ts";
import type { Blocker, BuildState, LegEnd } from "#shared/ruleHooks.ts";
import { holderOf, linkHolds, onHolder, publicMembers, walkerFor, type SeenByAll } from "#shared/rules/attach.ts";
import { canSqueeze, footprintSize, snapStep } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { deviceGround } from "#shared/rules/held.ts";
import { footing } from "#shared/rules/heights.ts";
import { groundUnder, landedElevation, landing, legStop, onSqueezedLattice, ownWalk, previewChunks, previewSqueezed, squeezeFits, walkEnd, walkFrom, type DropMode, type Walker } from "#shared/rules/movement.ts";
import { followerTrace, routeLattice, routePoints, routeStop, routeWalkers, walkTrace, type RoutePiece, type RoutePoint } from "#shared/rules/route.ts";
import { checkSetReach } from "#shared/rules/moveLeg.ts";
import type { WalkRoute } from "#shared/rules/walk.ts";
import { routeLegCheck, type RouteWorld } from "#shared/rules/hexWalk.ts";
import { publicToken } from "#shared/rules/walkWorld.ts";
import { displayName, snapPosition } from "../../lib/scene.ts";

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

/**
 * The grid of the scene a token stands on, squares where this copy does
 * not hold the scene. On a hex scene (docs/design-v1-hex-grids.md 4.2 and
 * phase H2) a drop snaps to its size's nearest anchor, and the movement
 * rule's landing (movement.ts landing) holds a walk at the wall and lines
 * a creature up with a narrow space by squeezing onto the anchors of the
 * size one smaller (HX-D17).
 */
export function dropGrid(state: Pick<BuildState, "scenes">, token: Pick<DropToken, "sceneId">): Grid {
  const scene = state.scenes[token.sceneId];
  return scene ? sceneGrid(scene) : SQUARES;
}

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

/** How this viewer's drops are judged on this scene: walked, or placed where they land. */
export function dropMode(role: Role, scene: Pick<Scene, "blockMovement"> | undefined): Exclude<DropMode, "teleport"> {
  return role === "player" && scene?.blockMovement === true ? "walk" : "free";
}

/**
 * What a drop's landing reads beside the build: the tokens, the settings
 * and which tokens every player sees as this device's copy shows them
 * (`seen`), when it has them, so a token on a holder every player sees
 * lands by it (dropLanding). The walk and the planners read a whole
 * `DropView`, which always has `seen` (review AT-O-27), so no drop is ever
 * walked as if no player saw its holder. dropView gives all three.
 */
export type DropState = BuildState & {
  tokens?: Readonly<Record<string, (DropToken & Pick<Token, "kind"> & Partial<Pick<Token, "attached" | "height">>) | undefined>>;
  meta?: Pick<RoomState["meta"], "settings">;
  seen?: SeenByAll;
};

/** A room as this viewer's drops read it: with who every player sees (attach/walk.ts seenIn, the path's `seen` marks), and the viewer's role, which the reach cap reads. */
export type DropView = RoomState & { seen: SeenByAll; role: Role };

const dropViews = new WeakMap<RoomState, Partial<Record<Role, DropView>>>();

/** The room as this viewer's drops read it, one per copy and role, so what a drag keeps by the room's identity still holds. */
export function dropView(view: RoomState, role: Role): DropView {
  let byRole = dropViews.get(view);
  if (!byRole) dropViews.set(view, (byRole = {}));
  return (byRole[role] ??= {
    ...view,
    role,
    seen: (t) => {
      const token = view.tokens[t.id];
      return token !== undefined && publicToken(view, token, { role });
    },
  });
}

const previewViews = new WeakMap<DropView, DropView>();

/**
 * The room as a drag's picture and a walking ruler read it
 * (docs/design-v1-map-discovery.md 5.2): what nothing checks after, so the
 * pieces of a player's held build stop anything within their band
 * (movement.ts previewChunks), where a drop, a press and every other
 * action this device sends read them by the gate test and let the
 * server's landing decide. One per view, so what a drag keeps by the
 * room's identity still holds.
 */
export function previewView(view: DropView): DropView {
  let out = previewViews.get(view);
  if (!out) previewViews.set(view, (out = { ...view, buildChunks: previewChunks(view.buildChunks) }));
  return out;
}

/**
 * The elevation a drop lands a token at. One that sits on a holder
 * (docs/design-v1-attach.md 4.1 and 4.3) lands by the holder, not by the
 * ground under its seat, which differs where the holder straddles two
 * heights: at the holder's elevation where the link still holds there, the
 * height the server takes for a new seat, else as a Get off lands
 * (landedElevation off the holder). That reads only a link every player
 * sees, the token and the holder both (`seen`, review AT-O-22): off or on
 * a holder some player cannot see, the DM's drop lands the token as if it
 * had no holder, so the op and every player's copy are the ones of a room
 * without it (8.0). Any other token lands by its own footing
 * (landedElevation). Every drop, its picture on the board and the op it
 * sends read this one landing, so the band reads the leg the server stores
 * and the leg tests judge the height sent.
 */
export function dropLanding(state: DropState, token: DropToken, at: Point & { squeeze?: boolean }): number {
  const seat = seenSeat(state, token);
  if (!seat) return landedElevation(state.buildChunks, token, at);
  return seat.keptAt(at) ? seat.holder.elevation : landedElevation(state.buildChunks, token, at, seat.holder);
}

/** The holder a token sits on, when every player sees both, and whether its link still holds with the token dropped at a spot. */
export function seenSeat(state: DropState, token: DropToken): { holder: DropToken; keptAt: (at: Point) => boolean } | null {
  const seated = state.tokens?.[token.id];
  const link = seated?.attached;
  const holder = seated && link && onHolder(link.kind) && state.tokens ? (holderOf(state.tokens, seated) as NonNullable<typeof seated> | undefined) : undefined;
  const settings = state.meta?.settings;
  if (!link || !holder || !settings || !state.seen || !state.seen(seated) || !state.seen(holder)) return null;
  return { holder, keptAt: (at) => linkHolds(dropGrid(state, seated), settings, link.kind, { ...seated, x: at.x, y: at.y, elevation: holder.elevation }, holder) };
}

/**
 * The token as its walk reads it (rules/attach.ts walkerFor): off a holder
 * every player sees that stands on the ground, on the ground, crossing only
 * the holder's inner ledges until it is clear of the holder, so the route
 * search, the drop, its picture and the server's checks all judge the one
 * walk the op sends. `to` is where the walk lands, when it is known: one
 * that keeps its seat starts at the seat, any other on the ground under it
 * (rules/attach.ts walkerFor), as the server counts it.
 */
export function walkerOf<T extends DropToken>(state: DropView, token: T, to?: Point): T & Walker {
  const seated = state.tokens[token.id];
  // A token the room does not hold yet has no holder to leave.
  if (!seated) return ownWalk(token);
  const walker = walkerFor({ tokens: state.tokens, buildChunks: state.buildChunks, scenes: state.scenes }, seated, state.seen, to ? { to } : {});
  // The seated token's walk, at the place this one stands.
  return walker.offHolder ? ({ ...token, footing: "ground", offHolder: walker.offHolder, ...(walker.groundStart ? { groundStart: true } : {}) } as T & Walker) : ownWalk(token);
}

/**
 * The walker where its walk starts, as the move counts it (movement.ts
 * walkFrom): off a holder on the ground, when the walk leaves it, on the
 * ground under its own footprint, so stepping off a holder that straddles
 * a step never reads the drop as distance (review LP12-AT-4), and at its
 * seat when the walk keeps the seat. A drag's label reads a plain leg from
 * here.
 */
export function walkStart<T extends DropToken & Walker>(state: Pick<BuildState, "buildChunks">, walking: T): T {
  const elevation = walkFrom(state.buildChunks, walking).elevation;
  return elevation === walking.elevation ? walking : { ...walking, elevation };
}

/** One token's landing, as a move op carries it. `elevation` only when the landing changes it, `squeeze` only when it squeezes, `route` only for a walk that is not the straight leg. */
export type Landed = { tokenId: string; x: number; y: number; elevation?: number; squeeze?: true; route?: OpOf<"token.move">["route"] };

/**
 * What stopped a walk as a player hears of it: a wall or a ledge, or
 * `unknown` where the stop is on ground they do not see live, which names
 * no kind (docs/design-v1-map-discovery.md 6, the words): a remembered
 * wall may be gone, and the real build may stop them where they hold
 * nothing. "Teleport here" past it sends `teleport: "unknown"`.
 */
export type StopBlocker = Blocker | "unknown";

/** A walk that a wall, a door or a ledge stopped short of where the player dropped the token. */
export type Stop = {
  tokenId: string;
  sceneId: string;
  blocker: StopBlocker;
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
  /** The creature the walker drags beside it that cannot follow where the walker alone would go, by the name players see (docs/design-v1-attach.md 4.2). */
  follower?: string;
};

export type DropPlan = {
  moves: Landed[];
  /** The lone token's walk, stopped short. */
  stop: Stop | null;
  /** Tokens of a group drag left where they were, since a wall or a ledge stood in their way (section 4.1). */
  held: { token: DropToken; blocker: StopBlocker }[];
  /** The lone walk turned too often for one move, so it landed partway (docs/design-v1-movement.md 5.2). */
  cut?: true;
};

function moved(token: DropToken, at: Point & { squeeze: boolean }): boolean {
  return at.x !== token.x || at.y !== token.y || at.squeeze !== (token.squeeze === true);
}

export function landed(state: DropState, token: DropToken, at: Point & { squeeze: boolean }): Landed {
  const out: Landed = { tokenId: token.id, x: at.x, y: at.y };
  const elevation = dropLanding(state, token, at);
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
export function squeezedSpot(state: DropView, token: DropToken, raw: Point, mode: DropMode): (Point & { squeeze: true }) | null {
  const g = dropGrid(state, token);
  if (!canSqueeze(token) || isHex(g)) return null;
  const size = footprintSize(token);
  const to = snapPosition(g, raw.x, raw.y, size);
  const spot = { x: size.w >= 2 ? Math.floor(raw.x) + 0.5 : to.x, y: size.h >= 2 ? Math.floor(raw.y) + 0.5 : to.y };
  const land = landing(state, walkerOf(state, token), { ...spot, elevation: dropLanding(state, token, spot) }, mode);
  return land.squeeze && !land.stopped && land.x === spot.x && land.y === spot.y ? { ...spot, squeeze: true } : null;
}

/**
 * Where one token dropped at the unsnapped point `raw` lands: in the
 * squeezed spot under it when the creature squeezes there, else on its own
 * snap grid by the movement rule's landing (movement.ts `landing`), which
 * walks a player's token up to the last clear spot and lines a squeezing
 * creature up with a narrow opening.
 */
export function planOne(state: DropView, token: DropToken, raw: Point, mode: Exclude<DropMode, "teleport">): DropPlan {
  const squeezed = squeezedSpot(state, token, raw, mode);
  if (squeezed) return { moves: moved(token, squeezed) ? [landed(state, token, squeezed)] : [], stop: null, held: [] };
  const g = dropGrid(state, token);
  const to = snapPosition(g, raw.x, raw.y, footprintSize(token));
  if (to.x === token.x && to.y === token.y) return { moves: [], stop: null, held: [] };
  const elevation = dropLanding(state, token, to);
  // Walked as the route search, the server's check and the route walk it (walkerOf): on the ground, crossing only the inner ledges of a holder every player sees that stands on the ground.
  const land = landing(state, walkerOf(state, token), { x: to.x, y: to.y, elevation }, mode);
  const at = { x: land.x, y: land.y, squeeze: land.squeeze };
  const moves = moved(token, at) ? [landed(state, token, at)] : [];
  const named = land.stopped ? heardStop(state, walkerOf(state, token), { x: to.x, y: to.y, elevation }, land.stopped) : null;
  const stop: Stop | null = named ? { tokenId: token.id, sceneId: token.sceneId, ...named, ghost: to, aim: { x: raw.x, y: raw.y }, at: { x: land.x, y: land.y } } : null;
  return { moves, stop, held: [] };
}

/**
 * What a player's device says stopped its own walk to `to`
 * (docs/design-v1-map-discovery.md 6, the words), by the rule the server
 * words a stop by (permissions.ts stopWords) on the device's own held
 * build and live ground (rules/held.ts deviceGround): the kind, and the
 * door, only where the part of the blocker the walk met is live to it
 * (D-261027-04), else `unknown`, with no door named. With fog off
 * everything is live, so the stop is today's. The device's live ground
 * holds no more than the server's, so where it names a kind the server
 * would too, and where it cannot the server's answer settles it.
 */
export function heardStop(state: DropView, walker: Walker, to: LegEnd, stopped: { blocker: Blocker; door: DoorRef | null }): { blocker: StopBlocker; door: DoorRef | null } {
  // With fog off the rule does not speak, as the server's does not (permissions.ts Check liveGround): today's kind.
  const ground = state.scenes[walker.sceneId]?.fogEnabled === true ? deviceGround(state, walker.sceneId) : null;
  if (!ground) return stopped;
  const words = stopWords(state, ground, walker, to, stopped.blocker);
  if (words === SOMETHING_BLOCKS) return { blocker: "unknown", door: null };
  return { blocker: words === WALL_IN_THE_WAY ? "wall" : "ledge", door: words === WALL_IN_THE_WAY ? stopped.door : null };
}

/** What a lone drag's route search answered for the drop's spot (routeDrag.ts): the straight leg, a route, or no route. */
export type Found = { kind: "open" } | { kind: "route"; route: Pick<WalkRoute, "pieces"> } | { kind: "none"; capped: boolean; follower?: string };

/**
 * The spot a lone drop's route aims at (docs/design-v1-movement.md 3.1):
 * where the drop would be placed, by the drop's own rule and squeezed where
 * the creature squeezes, with no leg test, since the route is the leg. A
 * route steps on the lattice from where the token stands, so a token that
 * stands off its grid lands on that lattice, the nearest spot to it.
 */
export function routeTarget(state: DropView, token: DropToken, raw: Point): Point & { squeeze: boolean } {
  const placed = planOne(state, token, raw, "free").moves[0];
  const at = placed ? { x: placed.x, y: placed.y, squeeze: placed.squeeze === true } : { x: token.x, y: token.y, squeeze: token.squeeze === true };
  // On hexes the drop's own rule already stands it on an anchor, which is where a route's pieces end (route.ts hexPiece).
  if (isHex(dropGrid(state, token))) return at;
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
export function cutRoute(state: DropView, token: DropToken, pieces: readonly RoutePiece[]): { pieces: RoutePiece[]; at: Point & { squeeze: boolean } } | null {
  if (pieces.length <= MAX_ROUTE_PIECES) return null;
  const grid = snapStep(token);
  const onGrid = (v: number, from: number) => Math.abs((v - from) / grid - Math.round((v - from) / grid)) < 1e-9;
  // Squeezed or not as the end of the walk up to each piece's end (walkerOf, movement.ts WalkEnd): off the holder for good once a stop before was clear of it.
  const walking = walkerOf(state, token);
  const points = routePoints(state.buildChunks, walking, pieces.slice(0, MAX_ROUTE_PIECES), walking.elevation);
  const g = dropGrid(state, token);
  for (let k = MAX_ROUTE_PIECES; k > 0; k--) {
    const [x, y] = pieces[k - 1]!;
    const at = { x, y };
    const end = walkEnd(state, walking, at, points.slice(1, k));
    if (isHex(g)) {
      // A piece's end on hexes squeezes by where it stands (movement.ts HexStand), and a full one fits, as the search left it.
      if (!onSqueezedLattice(g, token, at)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: false } };
      if (squeezeFits(state, end)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: true } };
      continue;
    }
    if (!previewSqueezed(state, end)) {
      if (onGrid(x, token.x) && onGrid(y, token.y)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: false } };
      continue;
    }
    if (squeezeFits(state, end)) return { pieces: pieces.slice(0, k), at: { ...at, squeeze: true } };
  }
  return null;
}

/**
 * The walk a lone drop lands with (3.1, 5.6), the same for the board's
 * picture of a drag and for the drop: the route to `target`, cut after 64
 * pieces where the creature can stand (`cutRoute`). On a scene that stops
 * moves its every piece passes the server's own check (route.ts
 * `routeStop`, permissions.ts `routeCheck`, review MV-O-24). Null when it
 * cannot be cut, fails that check, or reaches past 300 squares, which the
 * server refuses: the drop then goes as the straight leg. So the picture
 * never draws a walk the drop would not take, and the drop never sends one
 * the server refuses. Kept per route, so a drag's every frame reads it
 * once.
 */
export function routeLanding(state: DropView, token: DropToken, target: Point & { squeeze?: boolean }, pieces: readonly RoutePiece[], feetPerCell: number): Landing | null {
  const key = `${token.sceneId},${token.size},${token.w},${token.h},${token.x},${token.y},${token.elevation},${token.squeeze === true},${target.x},${target.y},${target.squeeze === true},${feetPerCell},${state.role},${holderKey(state, token)},${membersKey(state, token)}`;
  const known = landings.get(pieces);
  if (known && known.key === key && known.chunks === state.buildChunks && known.scene === state.scenes[token.sceneId]) return known.landing;
  const landing = landingOf(state, token, target, pieces, feetPerCell);
  landings.set(pieces, { key, chunks: state.buildChunks, scene: state.scenes[token.sceneId], landing });
  return landing;
}

type Landing = { pieces: RoutePiece[]; at: Point & { squeeze?: boolean }; points: RoutePoint[]; cut: boolean };

/**
 * Whether a lone drop with this answer goes as the straight leg: the
 * search found no route, or one `routeLanding` will not take. The board's
 * picture and the drop read it alike.
 */
export function goesStraight(state: DropView, token: DropToken, target: Point & { squeeze?: boolean }, answer: Found | { kind: "searching" }, feetPerCell: number): boolean {
  return answer.kind === "none" || (answer.kind === "route" && !routeLanding(state, token, target, answer.route.pieces, feetPerCell));
}

/** Where a token stands and whether it squeezes there: its landing height and cost read the squeezed footprint where it does. */
export type Pose = Point & { squeeze?: true };

export function samePose(a: Pose | null, b: Pose | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.squeeze === b.squeeze);
}

/** Where a lone drop's plan leaves the token: at its move, held at the wall or not, or where it stands (review ASTRA-18). */
export function planLands(plan: DropPlan, token: DropToken): Pose {
  const at = plan.moves[0] ?? token;
  return at.squeeze === true ? { x: at.x, y: at.y, squeeze: true } : { x: at.x, y: at.y };
}

const landings = new WeakMap<readonly RoutePiece[], { key: string; chunks: object; scene: unknown; landing: Landing | null }>();

/**
 * What a landing kept per route reads of the token's holder (dropLanding,
 * walkerOf): the link and the holder's place, and only while every player
 * sees both, so it is worked out again when any of them changes.
 */
function holderKey(state: DropState, token: DropToken): string {
  const seated = state.tokens?.[token.id];
  const link = seated?.attached;
  const holder = seated && link && state.meta && state.tokens && onHolder(link.kind) ? (holderOf(state.tokens, seated) as NonNullable<typeof seated> | undefined) : undefined;
  if (!seated || !link || !holder || !state.seen || !state.seen(seated) || !state.seen(holder)) return "";
  return `${link.kind},${holder.id},${holder.size},${holder.w},${holder.h},${holder.x},${holder.y},${holder.elevation}`;
}

/** What a landing kept per route reads of what the token takes along (checkSetReach): each public member's link and place. */
function membersKey(state: DropView, token: DropToken): string {
  return publicMembers(state.tokens, token.id, state.seen, new Set([token.id]))
    .slice(1)
    .map((id) => {
      const t = state.tokens[id]!;
      return `${id},${t.attached?.kind},${t.attached?.to},${t.size},${t.w},${t.h},${t.x},${t.y},${t.elevation}`;
    })
    .join(";");
}

function landingOf(state: DropView, token: DropToken, target: Point & { squeeze?: boolean }, pieces: readonly RoutePiece[], feetPerCell: number): Landing | null {
  const cut = cutRoute(state, token, pieces);
  if (pieces.length === 0 || (pieces.length > MAX_ROUTE_PIECES && !cut)) return null;
  const at = cut ? cut.at : target;
  const elevation = dropLanding(state, token, at);
  // Walked as the search and the server walk it (walkerOf): on the ground, crossing only the inner ledges of a holder every player sees that stands on the ground.
  const walking = walkerOf(state, token, at);
  const kept = passing(state, walking, cut ? cut.pieces : [...pieces], elevation);
  if (!kept) return null;
  const trace = routeWalkers(state.buildChunks, walking, kept, elevation);
  const points = trace.map(({ x, y, elevation }) => ({ x, y, elevation }));
  // A squeeze at the walk's end is judged as the end of the walk, as the server judges it (permissions.ts squeezeFits).
  if (at.squeeze && !squeezeFits(state, walkEnd(state, walking, at, points.slice(1, -1)))) return null;
  // The cap reads what the token takes along too, each on its own ground, as the server's does (moveLeg.ts checkSetReach).
  return checkSetReach(state, token, trace, state.seen, feetPerCell, state.role) <= MAX_ROUTE_REACH ? { pieces: kept, at, points, cut: cut !== null } : null;
}

/**
 * The route as it is, on a scene that stops moves, when the server's check
 * takes it (route.ts `routeStop`): piece by piece, or for the straight
 * walk's own route by the test of its whole leg, as the plain move is
 * judged, so a straight drop keeps what it walks over (review MV-PLAIN-1).
 * Null when the check refuses it: the drop then goes as the plain straight
 * leg. A piece that fails is never split into its lattice steps: a split
 * reads the ground at other stands (route.ts `routePoints`), so it can
 * change what the walk costs, and in review no split passed where its
 * piece failed (MV-O-28).
 */
function passing(state: BuildState, token: DropToken & Walker, pieces: RoutePiece[], landing: number): RoutePiece[] | null {
  if (state.scenes[token.sceneId]?.blockMovement !== true) return pieces;
  return routeStop(state, token, pieces, landing) ? null : pieces;
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
export function keyStep(world: RouteWorld, target: Point, charge: (units?: number) => void = () => {}): Found {
  const check = routeLegCheck(world, target, true);
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
export function planPress(state: DropView, world: RouteWorld | null, token: DropToken, at: Point, mode: Exclude<DropMode, "teleport">, feetPerCell: number, charge?: (units?: number) => void): DropPlan {
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
export function planWalk(state: DropView, token: DropToken, raw: Point, mode: Exclude<DropMode, "teleport">, found: Found, feetPerCell: number, account?: (to: Point) => Found): DropPlan {
  const walk = found.kind === "route" ? routeLanding(state, token, routeTarget(state, token, raw), found.route.pieces, feetPerCell) : null;
  if (walk) {
    const move = landed(state, token, { ...walk.at, squeeze: walk.at.squeeze === true });
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
 *
 * `walkersOf` names the creatures a token drags beside it
 * (docs/design-v1-attach.md 4.2), each tested on the token's leg offset by
 * its place: a token one of them could not follow stays where it was.
 */
export function planGroup(state: DropView, tokens: readonly DropToken[], dx: number, dy: number, mode: Exclude<DropMode, "teleport">, walkersOf: (token: DropToken) => readonly DropToken[] = () => []): DropPlan {
  const moves: Landed[] = [];
  const held: DropPlan["held"] = [];
  for (const token of tokens) {
    const g = dropGrid(state, token);
    const to = snapPosition(g, token.x + dx, token.y + dy, footprintSize(token));
    if (to.x === token.x && to.y === token.y) continue;
    const elevation = dropLanding(state, token, to);
    const from = { x: token.x, y: token.y, elevation: token.elevation };
    // Its leg and what it drags beside it, walked as the server walks them (walkerOf): on the ground, crossing only the inner ledges of a holder every player sees that stands on the ground.
    const walking = walkerOf(state, token);
    // A group move stores no squeeze, so on hexes its leg ends full size wherever it lies (LegEnd), as the server judges it.
    const end = { x: to.x, y: to.y, elevation, ...(isHex(g) ? { squeeze: false } : {}) };
    const own = mode === "walk" ? legStop(state, walking, end) : null;
    const stopped = own ? heardStop(state, walking, end, own) : mode === "walk" ? followersOf(state, walking, [from, end], walkersOf(token)).stop(1, end) : null;
    if (stopped) held.push({ token, blocker: stopped.blocker });
    else moves.push(landed(state, token, { ...to, squeeze: false }));
  }
  return { moves, stop: null, held };
}

/**
 * The walks of the creatures a holder drags beside it along the holder's
 * walk `points` (docs/design-v1-attach.md 5.1), as the reducer moves them
 * (shared/rules/moveLeg.ts): each from where it stands, offset by its
 * place, on its own ground behind a holder whose walk is on the ground,
 * else by the holder's change of height, never below the ground, and
 * walked by its own rule (route.ts followerTrace). `stop` is the first of
 * them whose leg from the holder's piece `i`'s start a wall or a ledge
 * stops, with the holder at `to` on that piece.
 */
function followersOf(state: BuildState, lead: Walker, points: readonly RoutePoint[], walkers: readonly DropToken[]): { stop: (i: number, to: RoutePoint) => { blocker: Blocker } | null } {
  // As the holder's walk stands where it starts (route.ts WalkTrace).
  const grounded = footing(state.buildChunks, walkFrom(state.buildChunks, lead)) === "ground";
  const follows = walkers.map((w) => {
    const self = followerTrace(w, [w])[0]!;
    const spot = (p: RoutePoint): RoutePoint => {
      const x = p.x + w.x - lead.x;
      const y = p.y + w.y - lead.y;
      const ground = groundUnder(state.buildChunks, self, { x, y });
      return { x, y, elevation: grounded ? ground : Math.max(w.elevation + p.elevation - lead.elevation, ground) };
    };
    return { spot, trace: followerTrace(w, [{ x: w.x, y: w.y, elevation: w.elevation }, ...points.slice(1).map(spot)]) };
  });
  return {
    stop: (i, to) => {
      for (const f of follows) {
        const stop = legStop(state, f.trace[i - 1]!, f.spot(to));
        if (stop) return stop;
      }
      return null;
    },
  };
}

/**
 * Where a holder's walk is cut so the creatures it drags can follow: the
 * spot, and how many of its pieces it keeps whole before it. `plain` when
 * the cut goes as the plain straight leg to the spot, with no route, so
 * it keeps no piece.
 */
export type WalkersCut = { at: Point; pieces: number; plain?: true };

/** Whether two walkers cuts are the same in every field the preview reads, so a change of any of them draws the walk again. */
export function sameCut(a: WalkersCut | null, b: WalkersCut | null): boolean {
  if (!a || !b) return a === b;
  return a.at.x === b.at.x && a.at.y === b.at.y && a.pieces === b.pieces && a.plain === b.plain;
}

/**
 * A route cut at a walkers stop (walkersStop): the pieces kept whole, then
 * one to the stop with the extra the piece it cuts had. Stopped where a
 * piece starts, the walk keeps the pieces before it, since a piece of no
 * length is no piece.
 */
export function cutPieces(points: readonly RoutePoint[], pieces: readonly RoutePiece[], cut: WalkersCut): RoutePiece[] {
  if (cut.plain) return [];
  const start = points[cut.pieces];
  const piece = pieces[cut.pieces];
  const kept = pieces.slice(0, cut.pieces);
  if (!start || !piece || (start.x === cut.at.x && start.y === cut.at.y)) return kept;
  return [...kept, [cut.at.x, cut.at.y, piece[2], piece[3]]];
}

/**
 * Where a holder's walk along `points` (its start, then each piece's end)
 * stops so that every creature it drags beside it can walk too
 * (docs/design-v1-attach.md 4.2): the first piece some walker's leg is
 * stopped on is walked back, a lattice step at a time from its end and on
 * back through the pieces before it, to the last spot the holder and
 * every walker reach clear, its start when none. Each spot is snapped to
 * the holder's lattice, as a route's are, so a cut on a piece along no
 * axis or diagonal is one the server takes. Null when all of them walk
 * the whole way. `pieces` counts the pieces kept whole before it.
 *
 * A walk along `route` keeps a spot only where the server takes the cut
 * whole (review FU20A-CUTSTOP): the holder's own check of the cut route
 * (route.ts routeStop), which may judge a straight walk's own route by
 * its whole leg where a shorter cut of it has no such leg, else the plain
 * straight leg there (`plain`), the holder's and every walker's. `landing`
 * is the height the drop lands at a spot, as the op will carry it.
 */
export function walkersStop(
  state: BuildState,
  lead: DropToken & Walker,
  points: readonly RoutePoint[],
  walkers: readonly DropToken[],
  walk: { route?: readonly RoutePiece[]; landing?: (at: Point) => number } = {},
): { at: RoutePoint; pieces: number; blocker: Blocker; plain?: true } | null {
  if (walkers.length === 0) return null;
  const L = routeLattice(lead);
  // The holder's walk (route.ts WalkTrace): the leg test of each piece counts from its walker where it starts.
  const trace = walkTrace(state.buildChunks, lead, points);
  const followers = followersOf(state, lead, points, walkers);
  const route = walk.route && state.scenes[lead.sceneId]?.blockMovement === true ? walk.route : undefined;
  const start = points[0]!;
  // The cut to `c`, `whole` pieces kept and then one on to it unless a piece starts there: as the route it sends, else as the plain leg.
  const taken = (c: RoutePoint, whole: number): { plain?: true } | null => {
    if (!route) return {};
    if (routeStop(state, lead, cutPieces(points, route, { at: c, pieces: whole }), walk.landing ? walk.landing(c) : c.elevation) === null) return {};
    return legStop(state, trace[0]!, c) === null && followersOf(state, lead, [start, c], walkers).stop(1, c) === null ? { plain: true } : null;
  };
  for (let i = 1; i < points.length; i++) {
    const stopped = followers.stop(i, points[i]!);
    if (!stopped) continue;
    for (let j = i; j >= 1; j--) {
      const a = points[j - 1]!;
      const b = points[j]!;
      const at = trace[j - 1]!;
      const n = Math.max(1, Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / L));
      const along = (d: number, k: number) => Math.round((d * k) / n / L) * L + 0;
      for (let k = n - 1; k >= 1; k--) {
        const c = { x: a.x + along(b.x - a.x, k), y: a.y + along(b.y - a.y, k), elevation: 0 };
        c.elevation = landedElevation(state.buildChunks, at, c);
        if (legStop(state, at, c) !== null || followers.stop(j, c) !== null) continue;
        const kept = taken(c, j - 1);
        if (kept) return { at: c, pieces: kept.plain ? 0 : j - 1, blocker: stopped.blocker, ...kept };
      }
      const kept = j === 1 ? {} : taken(a, j - 1);
      if (kept) return { at: a, pieces: kept.plain ? 0 : j - 1, blocker: stopped.blocker, ...kept };
    }
    return { at: start, pieces: 0, blocker: stopped.blocker };
  }
  return null;
}

/**
 * A holder's drop cut short where a creature it drags cannot follow
 * (docs/design-v1-attach.md 4.2), only for a player's walk where walls
 * stop moves: the plan's lone move ends at walkersStop's spot, its route
 * kept up to there, and the walk is stopped there as a lone walk is at a
 * wall, with the note that says so: a search that found no way says so
 * still.
 */
export function cutForWalkers(state: DropView, lead: DropToken, plan: DropPlan, walkers: readonly DropToken[], mode: Exclude<DropMode, "teleport">): DropPlan {
  const move = plan.moves.find((m) => m.tokenId === lead.id);
  if (mode !== "walk" || walkers.length === 0 || !move) return plan;
  const landing = move.elevation ?? lead.elevation;
  const walking = walkerOf(state, lead, move);
  const points = move.route ? routePoints(state.buildChunks, walking, move.route, landing) : [{ x: lead.x, y: lead.y, elevation: lead.elevation }, { x: move.x, y: move.y, elevation: landing }];
  const stop = walkersStop(state, walking, points, walkers, { ...(move.route ? { route: move.route } : {}), landing: (at) => dropLanding(state, lead, at) });
  if (!stop) return plan;
  const others = plan.moves.filter((m) => m !== move);
  const searched = plan.stop?.searched ? { searched: true as const, ...(plan.stop.capped ? { capped: true as const } : {}) } : {};
  const halted: Stop = { tokenId: lead.id, sceneId: lead.sceneId, blocker: stop.blocker, door: null, ghost: { x: move.x, y: move.y }, aim: { x: move.x, y: move.y }, at: { x: stop.at.x, y: stop.at.y }, ...searched };
  if (stop.at.x === lead.x && stop.at.y === lead.y) return { ...plan, moves: others, stop: halted };
  const cut = landed(state, lead, { x: stop.at.x, y: stop.at.y, squeeze: false });
  if (move.route && !stop.plain) cut.route = cutPieces(points, move.route, stop).map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
  return { ...plan, moves: [...others, cut], stop: halted };
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

/**
 * A walk's stop once its search found no way because a creature the
 * walker drags beside it cannot follow (Found `follower`): held where the
 * straight walk is, at the walker's own wall or where that creature meets
 * one, and naming it (docs/design-v1-attach.md 4.2, review LP12-AT-2).
 */
export function namedFollower(state: DropView, plan: DropPlan, found: Found): DropPlan {
  if (found.kind !== "none" || found.follower === undefined || !plan.stop) return plan;
  const follower = state.tokens[found.follower];
  return { ...plan, stop: { ...plan.stop, searched: true, follower: follower ? displayName(follower) : "A creature you drag" } };
}

/** What the map says while a drag is held at a wall or a ledge, or where a creature it drags finds no way through with it. */
export function holdLabel(blocker: StopBlocker, noWay = false): string {
  if (noWay) return "No way through";
  return blocker === "wall" ? "Wall in the way" : blocker === "ledge" ? "Ledge in the way" : "Something in the way";
}

/**
 * The note after a stopped drop: what stopped it, and how to go on. A walk
 * whose search found no way says so (docs/design-v1-movement.md 3.1),
 * after "Too far to work out a way around" when the search gave up, and
 * names the creature it drags that cannot follow when that is why
 * (docs/design-v1-attach.md 4.2).
 */
export function stopText(stop: Pick<Stop, "blocker" | "door" | "searched" | "capped" | "follower">): string {
  if (stop.follower !== undefined) return `${stop.follower} can't follow through there.`;
  const far = stop.capped ? "Too far to work out a way around. " : "";
  if (stop.blocker === "unknown") return `${far}${SOMETHING_BLOCKS}`;
  if (stop.door) return `${far}A door is in the way. Tap it to open.`;
  if (!stop.searched) return stop.blocker === "ledge" ? "Ledge in the way. Take the stairs." : "Stopped at a wall. Drop at the corner first, then go on.";
  if (stop.blocker === "ledge") return `${far}Ledge in the way. No stairs you have seen lead there.`;
  return `${far}Stopped at a wall. There is no way around it that you have seen.`;
}

/** The note for the tokens of a group drag that stayed where they were. */
export function heldText(held: readonly { name: string; blocker: StopBlocker }[]): string | null {
  const first = held[0];
  if (!first) return null;
  const unknown = held.some((h) => h.blocker === "unknown");
  if (held.length === 1) return unknown ? `${first.name} stayed where it was: something blocks the way.` : `${first.name} stayed where it was: a ${first.blocker} is in the way.`;
  if (unknown) return `${held.length} tokens stayed where they were: something blocks the way.`;
  const what = held.every((h) => h.blocker === "wall") ? "walls are" : held.every((h) => h.blocker === "ledge") ? "ledges are" : "walls or ledges are";
  return `${held.length} tokens stayed where they were: ${what} in the way.`;
}

/**
 * The note after a group drag some of whose moves the real build stopped
 * short (`blocked`, docs/design-v1-map-discovery.md 6): which ones, and by
 * what, the server does not say.
 */
export const GROUP_BLOCKED_TEXT = "Some of them stopped short: something blocks the way.";
