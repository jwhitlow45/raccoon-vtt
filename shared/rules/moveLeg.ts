import { attaches, seatsOnSqueeze, walksRoutes } from "../migrate.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { inSightOfNonOwners } from "../project.ts";
import type { Op } from "../protocol.ts";
import { movementRules } from "../ruleHooks.ts";
import { carriedGroup, moveGroups, onHolder, publicMembers, standingSeatSpot, walkerFor, type SeenByAll } from "./attach.ts";
import { isSqueezed } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { isHex, sceneGrid } from "./grid.ts";
import { footing } from "./heights.ts";
import { groundUnder, landing, onSqueezedLattice, squeezeFits, walkEnds } from "./movement.ts";
import { followerTrace, pieceReach, routeWalkers, type RoutePoint, type WalkTrace } from "./route.ts";

/**
 * One description of a move (contract section 1, docs/design-v1-attach.md
 * 9): each token an op moves, where from and to, along which walk, how,
 * and, for a token that moved only because its holder did, which holder.
 * `planMove` reads it from the op and the state before, so the reducer
 * places a holder's group by it and traps can see the walk before it
 * happens. `describeMove` reads it after, and equals the plan for every op
 * nothing rewrote (a test checks that on random moves).
 *
 * What another viewer can observe of a group's move reads only its public
 * members (8.0), so each entry says which pass it walks in: `public` for a
 * named token every player sees and a group's public members, `private`
 * for the rest, a visible token carried by a holder players cannot see
 * among them, which follows its holder all the same (the carried-object
 * reveal).
 */

export type Pose = { sceneId: string; x: number; y: number; elevation: number };

export type MoveHow = "walk" | "teleport" | "scene" | "reshape";

export type MovedToken = {
  tokenId: string;
  from: Pose;
  to: Pose;
  /** The footprint's top-left corner from `from` to `to`, both included: two points for a straight leg. */
  route: RoutePoint[];
  /** The walk's trace along `route` (route.ts WalkTrace): its walker at each point, by its own walk or as its holder takes it along. */
  trace: WalkTrace;
  how: MoveHow;
  /** The direct holder, for a token that moved only because its holder did. */
  carriedBy?: string;
  pass: "public" | "private";
  /** Whether the move leaves it squeezed, which only its own `token.move` does, or an update that keeps its place. */
  squeezed?: true;
};

/** The op's envelope as the plan reads it: the version it was stored at, if any. */
type Versioned = { opVersion?: number };

function poseOf(token: Pick<Token, "sceneId" | "x" | "y" | "elevation">): Pose {
  return { sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation };
}

/** A named token's own move: where the op puts it, along which walk, how, and whether it ends squeezed. */
type Named = { token: Token; to: Pose; route: RoutePoint[]; trace: WalkTrace; how: MoveHow; squeezed?: true };

/** The tokens the op names and moves, with where it puts each. Ops that move nothing give none. */
function namedMoves(op: Op, before: RoomState, env: Versioned): Named[] {
  // Its walk off a holder on the ground as every walk of it reads it (attach.ts walkerFor), a straight leg its one piece.
  const walked = (token: Token, to: Pose, how: MoveHow, pieces: readonly (readonly [number, number, number, 0 | 1])[] = [[to.x, to.y, 0, 0]]): Named => {
    const trace = routeWalkers(before.buildChunks, walkerFor(before, token, seenIn(before, env), { opVersion: env.opVersion, to }), pieces, to.elevation);
    return { token, to, how, trace, route: trace.map(({ x, y, elevation }) => ({ x, y, elevation })) };
  };
  const straight = (token: Token, to: Pose, how: MoveHow): Named => walked(token, to, how);
  switch (op.t) {
    case "token.move": {
      const token = before.tokens[op.tokenId];
      if (!token) return [];
      const to: Pose = { sceneId: token.sceneId, x: op.x, y: op.y, elevation: op.elevation ?? token.elevation };
      const named = op.route && walksRoutes(env.opVersion) ? walked(token, to, "walk", op.route) : straight(token, to, op.teleport !== undefined ? "teleport" : "walk");
      return [op.squeeze ? { ...named, squeezed: true } : named];
    }
    case "token.moveMany":
      return op.moves.flatMap((m) => {
        const token = before.tokens[m.tokenId];
        return token ? [straight(token, { sceneId: token.sceneId, x: m.x, y: m.y, elevation: m.elevation ?? token.elevation }, "walk")] : [];
      });
    case "token.update": {
      const token = before.tokens[op.tokenId];
      const p = op.patch;
      if (!token || (p.x === undefined && p.y === undefined && p.elevation === undefined && p.sceneId === undefined && p.size === undefined && p.w === undefined && p.h === undefined)) return [];
      const to: Pose = { sceneId: p.sceneId ?? token.sceneId, x: p.x ?? token.x, y: p.y ?? token.y, elevation: p.elevation ?? token.elevation };
      const placed = p.x !== undefined || p.y !== undefined || p.size !== undefined || p.w !== undefined || p.h !== undefined;
      const named = straight(token, to, to.sceneId !== token.sceneId ? "scene" : placed ? "reshape" : "walk");
      // A change of height alone leaves a squeeze where it is (reducer/tokens.ts SQUEEZE_FIELDS).
      return [!placed && p.sceneId === undefined && token.squeeze === true ? { ...named, squeezed: true } : named];
    }
    case "token.attach": {
      // A drag leaves the creature where it stands. The rest step onto their seat, a walk.
      const token = before.tokens[op.tokenId];
      if (!token || !onHolder(op.kind) || !attaches(env.opVersion)) return [];
      // A seat is at its holder's elevation, whatever the op says (4.1).
      const elevation = before.tokens[op.to]?.elevation ?? op.elevation;
      return [straight(token, { sceneId: token.sceneId, x: op.x, y: op.y, elevation }, "walk")];
    }
    case "token.detach": {
      const token = before.tokens[op.tokenId];
      if (!token || op.x === undefined || op.y === undefined || !attaches(env.opVersion)) return [];
      return [straight(token, { sceneId: token.sceneId, x: op.x, y: op.y, elevation: op.elevation ?? token.elevation }, "walk")];
    }
    default:
      return [];
  }
}

/**
 * Every token an op moves (contract 3.1): the tokens it names, where it
 * puts them, and since op version 14 what each carries, split by the
 * nearest named ancestor (moveGroups). Each carried token follows the walk
 * its own holder took, offset by its place, top down: what sits on its
 * holder takes the holder's change of elevation, and a dragged creature
 * keeps to its own ground behind a holder that walked on the ground, else
 * takes the holder's change but never sinks below the ground (5.1). A
 * teleport leaves what it drags, and a scene change takes everything.
 *
 * On a player's walk on a scene whose walls stop moves, a dragged creature
 * outside the public members stops where its own leg test stops it, and
 * what it carries stops with it (4.2): the public members' legs are the
 * permissions' to test, so no landing or refusal reads a hidden one.
 * Sorted by token id.
 */
/** Whether every player sees a token in this state, by the op's envelope. */
function seenIn(state: RoomState, env: Versioned): (t: { id: string }) => boolean {
  return (t) => {
    const token = state.tokens[t.id];
    return token !== undefined && inSightOfNonOwners(state, token, env);
  };
}

export function planMove(op: Op, before: RoomState, actor: Viewer, env: Versioned): MovedToken[] {
  const named = namedMoves(op, before, env);
  if (named.length === 0) return [];
  const seen = seenIn(before, env);
  const out: MovedToken[] = [];
  const names = new Set(named.map((n) => n.token.id));
  // An attach names its holder too, which stays where it stands (8.0): the step onto the seat takes along nothing at or above
  // it, even round a loop the new link closes through a link the player's check cannot see.
  if (op.t === "token.attach") names.add(op.to);
  const groups = attaches(env.opVersion) ? moveGroups(before.tokens, [...names]) : new Map<string, string[]>();
  for (const n of named) {
    out.push({ tokenId: n.token.id, from: poseOf(n.token), to: n.to, route: n.route, trace: n.trace, how: n.how, pass: seen(n.token) ? "public" : "private", ...(n.squeezed ? { squeezed: true as const } : {}) });
    const members = groups.get(n.token.id) ?? [];
    if (members.length <= 1) continue;
    const shown = new Set(publicMembers(before.tokens, n.token.id, seen, names));
    const walked = new Map<string, MovedToken>([[n.token.id, out[out.length - 1]!]]);
    for (const id of members.slice(1)) {
      const member = before.tokens[id]!;
      const holderMove = walked.get(member.attached!.to);
      if (!holderMove) continue;
      const moved = follow(before, member, holderMove, shown.has(id) && shown.has(holderMove.tokenId), actor.role !== "dm", env);
      if (!moved) continue;
      walked.set(id, moved);
      if (!samePose(moved.from, moved.to)) out.push(moved);
    }
  }
  return out.sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));
}

function samePose(a: Pose, b: Pose): boolean {
  return a.sceneId === b.sceneId && a.x === b.x && a.y === b.y && a.elevation === b.elevation;
}

/**
 * How a carried token follows its holder's actual walk, or null when it
 * stays (a dragged creature a teleport leaves). On a player's walk
 * (`byPlayer`) a dragged creature outside the public members stops at walls.
 */
function follow(before: RoomState, member: Token, holder: MovedToken, isPublic: boolean, byPlayer: boolean, env: Versioned): MovedToken | null {
  const kind = member.attached!.kind;
  const from = poseOf(member);
  const pass = isPublic ? "public" : "private";
  const ox = member.x - holder.from.x;
  const oy = member.y - holder.from.y;
  if (holder.how === "teleport" && !onHolder(kind)) return null;
  if (holder.how === "scene" || onHolder(kind)) {
    // What sits on its holder keeps its height above it at every point, and a scene change takes all by the holder's change.
    const oz = member.elevation - holder.from.elevation;
    const seats = onHolder(kind) ? squeezedSeats(before, member, holder, env) : null;
    const route = holder.route.map((p, i) => ({ ...(seats?.[i] ?? { x: p.x + ox, y: p.y + oy }), elevation: p.elevation + oz }));
    const last = route[route.length - 1]!;
    return { tokenId: member.id, from, to: { sceneId: holder.to.sceneId, ...last }, route, trace: followerTrace(member, route), how: holder.how, carriedBy: holder.tokenId, pass };
  }
  const chunks = before.buildChunks;
  // A holder walking off its own mount walks on the ground once clear of it (attach.ts walkerFor), and so does what it drags:
  // as the holder's walk stands where it starts (route.ts WalkTrace).
  const grounded = footing(chunks, holder.trace[0]!) === "ground";
  // Its own ground behind a walker, under its own footprint as it walks (route.ts followerTrace), else the holder's change of
  // elevation, never below the ground there.
  const self = followerTrace(member, [from])[0]!;
  const elevationAt = (x: number, y: number, holderElevation: number): number => {
    const ground = groundUnder(chunks, self, { x, y });
    return grounded ? ground : Math.max(member.elevation + (holderElevation - holder.from.elevation), ground);
  };
  let route: RoutePoint[] = [{ x: member.x, y: member.y, elevation: member.elevation }];
  for (const p of holder.route.slice(1)) route.push({ x: p.x + ox, y: p.y + oy, elevation: elevationAt(p.x + ox, p.y + oy, p.elevation) });
  if (!isPublic && byPlayer && holder.how === "walk") route = stoppedAtWalls(before, member, route, holder.route, elevationAt);
  const last = route[route.length - 1]!;
  return { tokenId: member.id, from, to: { sceneId: member.sceneId, ...last }, route, trace: followerTrace(member, route), how: holder.how, carriedBy: holder.tokenId, pass };
}

/**
 * Where what sits on a holder sits at each point of the holder's walk when
 * that walk squeezes (D-261029-52 on hexes, D-261029-53 on squares), or
 * null where the offset holds all the way. It holds for ops stored before
 * version 29 (migrate.ts seatsOnSqueeze), for a walk that never squeezes,
 * whose offset keeps it on its seat, and for a change of scene or shape,
 * which no squeeze survives. At each point where the holder stands
 * squeezed, and at the first where it stands full after one, the token
 * takes the seat on the squares or hexes the holder stands on there
 * nearest where its offset would put it (attach.ts standingSeatSpot), and
 * keeps its offset from there on. So a rider sits on its mount's square or
 * hex through a corridor one wide, its light and sight with it, and the
 * walk's route, sweeps and ruler read it there. Its link reads the full
 * footprint (docs/design-v1-attach.md 5.1), which every such seat lies in,
 * so it never lets go mid-corridor.
 */
function squeezedSeats(before: RoomState, member: Token, holder: MovedToken, env: Versioned): (Point | null)[] | null {
  if (!seatsOnSqueeze(env.opVersion) || (holder.how !== "walk" && holder.how !== "teleport")) return null;
  const scene = before.scenes[member.sceneId];
  const standing = before.tokens[holder.tokenId];
  if (!scene || !standing) return null;
  const g = sceneGrid(scene);
  const last = holder.route.length - 1;
  // The holder's stand at each point: as it stood at the start, as the move leaves it at the end, and between by where it
  // stands, as a walk's spots read it (route.ts routeStands): on hexes its lattice, on squares the squeeze rule there.
  const between = (p: Point, i: number) => (isHex(g) ? onSqueezedLattice(g, standing, p) : squeezeFits(before, walkEnds(before, holder.trace[i - 1]!)(p)));
  const squeezedAt = holder.route.map((p, i) => (i === 0 ? isSqueezed(standing) : i === last ? holder.squeezed === true : between(p, i)));
  if (!squeezedAt.some((s) => s)) return null;
  const out: (Point | null)[] = [null];
  let offset = { x: member.x - holder.from.x, y: member.y - holder.from.y };
  for (let i = 1; i <= last; i++) {
    const p = holder.route[i]!;
    const seat = squeezedAt[i] || squeezedAt[i - 1] ? standingSeatSpot(g, { ...member, x: p.x + offset.x, y: p.y + offset.y }, { ...standing, x: p.x, y: p.y, squeeze: squeezedAt[i] ? true : undefined }) : null;
    if (seat) offset = { x: seat.x - p.x, y: seat.y - p.y };
    out.push(seat ?? { x: p.x + offset.x, y: p.y + offset.y });
  }
  return out;
}

/**
 * A routed walk's reach as the 300-square cap reads it (docs/design-v1-movement.md
 * 10, review R7-OPUS-1): piece by piece, the largest over the walker and
 * its public members, each on its own elevation path as the move takes it
 * along (`follow`), so a creature it drags over ground that rises and falls
 * counts its climbs, which the walker's own path never shows. A token on a
 * holder some player cannot see is not among them (L3-SOL-39), so no hidden
 * path decides the cap. The server's check (permissions.ts routeFits) and
 * the client's, of a route before it sends it (drop.ts landingOf), are this
 * one rule. A player's route on a scene with fog on counts no climbs or
 * falls (MD2-O-13): the trace reads the real ground's heights, so counting
 * them would refuse a route in place by the heights of ground the player
 * never touched. The cap only bounds the work a route costs, and its
 * squares across the ground do that alone. `squeezed` is whether the move
 * ends squeezed, so what sits on the walker is read on the seat the move
 * gives it there (review DP34-OPUS-3).
 */
export function checkSetReach(before: RoomState, token: Pick<Token, "id" | "sceneId" | "x" | "y" | "elevation">, trace: WalkTrace, seen: SeenByAll, feetPerCell: number, role: Viewer["role"], squeezed = false): number {
  const route = trace.map(({ x, y, elevation }) => ({ x, y, elevation }));
  const lead: MovedToken = { tokenId: token.id, from: poseOf(token), to: { sceneId: token.sceneId, ...route[route.length - 1]! }, route, trace, how: "walk", pass: "public", ...(squeezed ? { squeezed: true as const } : {}) };
  const walks = [lead];
  const walked = new Map<string, MovedToken>([[token.id, lead]]);
  for (const id of publicMembers(before.tokens, token.id, seen, new Set([token.id])).slice(1)) {
    const member = before.tokens[id];
    const holder = member?.attached ? walked.get(member.attached.to) : undefined;
    const moved = member && holder ? follow(before, member, holder, true, false, {}) : null;
    if (!moved) continue;
    walked.set(id, moved);
    walks.push(moved);
  }
  // Infinite feet per square make every rise no reach.
  const perSquare = role === "player" && before.scenes[token.sceneId]?.fogEnabled === true ? Infinity : feetPerCell;
  let reach = 0;
  for (let i = 1; i < route.length; i++) reach += Math.max(...walks.map((w) => pieceReach(w.route[i - 1]!, w.route[i]!, perSquare)));
  return reach;
}

/**
 * A dragged creature outside the public members, on a player's walk where
 * walls stop moves (4.2): its own offset walk up to its first piece the
 * leg test stops, which it ends at the last clear spot of, as a lone
 * token's drop lands (design 9.8), on its own ground there.
 */
function stoppedAtWalls(before: RoomState, member: Token, route: RoutePoint[], holderRoute: readonly RoutePoint[], elevationAt: (x: number, y: number, holderElevation: number) => number): RoutePoint[] {
  const scene = before.scenes[member.sceneId];
  if (scene?.blockMovement !== true) return route;
  // A creature a holder drags beside it walks as itself, since a drag is no seat (route.ts followerTrace).
  const trace = followerTrace(member, route);
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const at = trace[i - 1]!;
    if (movementRules.legBlocker(before, at, b) === null) continue;
    const stop = landing(before, at, b, "walk");
    const kept = route.slice(0, i);
    if (stop.x !== a.x || stop.y !== a.y) kept.push({ x: stop.x, y: stop.y, elevation: elevationAt(stop.x, stop.y, holderRoute[i - 1]!.elevation) });
    return kept;
  }
  return route;
}

/**
 * The same description after the op (contract 3.1, step 4 of 3.6): the
 * plan, each token where the op left it. It equals the plan whenever the
 * reducer placed every token as planned, which a test checks on random
 * moves. A token the op deleted has no entry.
 */
export function describeMove(op: Op, before: RoomState, after: RoomState, actor: Viewer, env: Versioned): MovedToken[] {
  const out: MovedToken[] = [];
  for (const moved of planMove(op, before, actor, env)) {
    const token = after.tokens[moved.tokenId];
    if (token) out.push({ ...moved, to: poseOf(token) });
  }
  return out;
}

/** The tokens of a group that sit on their holders all the way down, the holder first: what a ground change lifts with it (5.2). */
export function ridingGroup(tokens: RoomState["tokens"], holderId: string): string[] {
  return carriedGroup(tokens, holderId, new Set(), (child) => child.attached !== undefined && onHolder(child.attached.kind));
}
