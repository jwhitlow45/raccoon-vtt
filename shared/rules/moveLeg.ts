import { attaches, walksRoutes } from "../migrate.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { inSightOfNonOwners } from "../project.ts";
import type { Op } from "../protocol.ts";
import { movementRules } from "../ruleHooks.ts";
import { carriedGroup, moveGroups, onHolder, publicMembers, walkerFor } from "./attach.ts";
import { footing, footprintGround } from "./heights.ts";
import { landing } from "./movement.ts";
import { routePoints, type RoutePoint } from "./route.ts";

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
  how: MoveHow;
  /** The direct holder, for a token that moved only because its holder did. */
  carriedBy?: string;
  pass: "public" | "private";
};

/** The op's envelope as the plan reads it: the version it was stored at, if any. */
type Versioned = { opVersion?: number };

function poseOf(token: Token): Pose {
  return { sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation };
}

/** A named token's own move: where the op puts it, along which walk, and how. */
type Named = { token: Token; to: Pose; route: RoutePoint[]; how: MoveHow };

/** The tokens the op names and moves, with where it puts each. Ops that move nothing give none. */
function namedMoves(op: Op, before: RoomState, env: Versioned): Named[] {
  const straight = (token: Token, to: Pose, how: MoveHow): Named => ({ token, to, how, route: [poseOf(token), to].map(({ x, y, elevation }) => ({ x, y, elevation })) });
  switch (op.t) {
    case "token.move": {
      const token = before.tokens[op.tokenId];
      if (!token) return [];
      const to: Pose = { sceneId: token.sceneId, x: op.x, y: op.y, elevation: op.elevation ?? token.elevation };
      if (op.route && walksRoutes(env.opVersion)) return [{ token, to, how: "walk", route: routePoints(before.buildChunks, walkerFor(before, token, to, seenIn(before, env)), op.route, to.elevation) }];
      return [straight(token, to, op.teleport !== undefined ? "teleport" : "walk")];
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
      return [straight(token, to, to.sceneId !== token.sceneId ? "scene" : placed ? "reshape" : "walk")];
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
    out.push({ tokenId: n.token.id, from: poseOf(n.token), to: n.to, route: n.route, how: n.how, pass: seen(n.token) ? "public" : "private" });
    const members = groups.get(n.token.id) ?? [];
    if (members.length <= 1) continue;
    const shown = new Set(publicMembers(before.tokens, n.token.id, seen, names));
    const walked = new Map<string, MovedToken>([[n.token.id, out[out.length - 1]!]]);
    for (const id of members.slice(1)) {
      const member = before.tokens[id]!;
      const holderMove = walked.get(member.attached!.to);
      if (!holderMove) continue;
      const moved = follow(before, actor, member, holderMove, shown.has(id) && shown.has(holderMove.tokenId), seen);
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

/** How a carried token follows its holder's actual walk, or null when it stays (a dragged creature a teleport leaves). */
function follow(before: RoomState, actor: Viewer, member: Token, holder: MovedToken, isPublic: boolean, seen: (t: { id: string }) => boolean): MovedToken | null {
  const kind = member.attached!.kind;
  const from = poseOf(member);
  const pass = isPublic ? "public" : "private";
  const ox = member.x - holder.from.x;
  const oy = member.y - holder.from.y;
  if (holder.how === "teleport" && !onHolder(kind)) return null;
  if (holder.how === "scene" || onHolder(kind)) {
    // What sits on its holder keeps its height above it at every point, and a scene change takes all by the holder's change.
    const oz = member.elevation - holder.from.elevation;
    const route = holder.route.map((p) => ({ x: p.x + ox, y: p.y + oy, elevation: p.elevation + oz }));
    const last = route[route.length - 1]!;
    return { tokenId: member.id, from, to: { sceneId: holder.to.sceneId, ...last }, route, how: holder.how, carriedBy: holder.tokenId, pass };
  }
  const chunks = before.buildChunks;
  const holderToken = before.tokens[holder.tokenId];
  // A holder walking off its own mount walks on the ground (attach.ts walkerFor), and so does what it drags.
  const grounded = holderToken !== undefined && footing(chunks, { ...walkerFor(before, holderToken, holder.to, seen), x: holder.from.x, y: holder.from.y, elevation: holder.from.elevation, squeeze: undefined }) === "ground";
  // Its own ground behind a walker, else the holder's change of elevation, never below the ground there.
  const elevationAt = (x: number, y: number, holderElevation: number): number => {
    const ground = footprintGround(chunks, { ...member, x, y, squeeze: undefined });
    return grounded ? ground : Math.max(member.elevation + (holderElevation - holder.from.elevation), ground);
  };
  let route: RoutePoint[] = [{ x: member.x, y: member.y, elevation: member.elevation }];
  for (const p of holder.route.slice(1)) route.push({ x: p.x + ox, y: p.y + oy, elevation: elevationAt(p.x + ox, p.y + oy, p.elevation) });
  if (!isPublic && actor.role !== "dm" && holder.how === "walk") route = stoppedAtWalls(before, member, route, holder.route, elevationAt);
  const last = route[route.length - 1]!;
  return { tokenId: member.id, from, to: { sceneId: member.sceneId, ...last }, route, how: holder.how, carriedBy: holder.tokenId, pass };
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
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const at: Token = { ...member, x: a.x, y: a.y, elevation: a.elevation };
    delete at.squeeze;
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
