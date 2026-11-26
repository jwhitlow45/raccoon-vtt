import type { MemberId, RoomState, SceneId, SightTile, Token } from "./model.ts";
import type { DoorRef } from "./protocol.ts";
import { legBlocker, lineClear, squeezeFits, type WalkEnd, type Walker } from "./rules/movement.ts";
import type { Point } from "./rules/geom.ts";
import type { Grid } from "./rules/grid.ts";
import { coldHolderSight, coldJoinedSight, coldPartySight, holderSight, joinedSight, partySight, sightFromTiles, type JoinedPart, type VisionWorld } from "./rules/vision.ts";
import { sceneWalls } from "./rules/walls.ts";
import { openingJoins } from "./rules/openingSight.ts";
import { ownEntry } from "./records.ts";

/**
 * The wave 4 rules as the core calls them (docs/design/design-v1-maps-vision.md
 * section 4.5). Permissions call the movement rules (shared/rules/movement.ts),
 * and projection and the "seen" marks call the vision rules
 * (shared/rules/vision.ts), through the two objects below rather than by
 * importing those files themselves.
 *
 * Why the indirection: this file is where the vision rules get the
 * derived walls (VISION_WORLD below), since vision.ts must not import
 * walls.ts, whose areas sweep uses atan2, and keeps to arithmetic every
 * engine rounds alike. The core (permissions, projection, the reducer's
 * "seen" marks) was also built against this one contract before the rules
 * existed, and tests still swap in their own rules by assigning to these
 * objects and putting the originals back when done.
 */

/**
 * Where a leg ends: the spot a move gives the token, its elevation included.
 * On hexes `squeeze` is the squeeze the move stores there, so the leg's end
 * stands as the token will. Without it the end stands squeezed where it lies
 * on a squeeze's anchors, as a route's stops do.
 */
export type LegEnd = { x: number; y: number; elevation: number; squeeze?: boolean };

/** What stops a leg: a wall (doors, windows and pillars included) or a ledge between two heights. */
export type Blocker = "wall" | "ledge";

/**
 * The state the movement test reads: the scene and its build, and for an
 * op stored before version 30 the mark that it reads every raised side
 * between two hexes of a stand as a wall, and for one stored before
 * version 66 the mark that the narrow-space test on squares reads walls
 * alone, without the scene's sides (movement.ts storedBuild).
 */
export type BuildState = Pick<RoomState, "scenes" | "buildChunks"> & { readonly ledgedBands?: true; readonly edgeOpen?: true };

export type MovementRules = {
  /**
   * What stops the token walking from where it stands to `to`, or null when
   * the leg is allowed (section 4.1): its core swept along the straight
   * path or a shifted one, against the stored movement set as players see
   * it, raised edges included for a walking or low-flying token. Callers
   * ask only on a scene whose `blockMovement` is on.
   */
  legBlocker(state: BuildState, token: Walker, to: LegEnd): Blocker | null;
  /** Section 4.1's four checks for a move whose walk stops the token squeezed at its end. */
  squeezeFits(state: BuildState, end: WalkEnd): boolean;
  /**
   * Whether the straight line from the token's footprint center to `to`, a
   * door's midpoint, crosses no movement blocker other than that door: the
   * clear line that reaching a door needs (section 4.1).
   */
  lineClear(state: BuildState, token: Token, to: Point, door: DoorRef): boolean;
};

/* Part 4B's rules (shared/rules/movement.ts). */
export const movementRules: MovementRules = { legBlocker, squeezeFits, lineClear };

/** A creature as sight judges it: its footprint at its stored position, squeezed or not. */
export type SightProbe = Pick<Token, "size" | "x" | "y"> & Partial<Pick<Token, "w" | "h" | "squeeze">>;

/** What the party sees on one scene. */
export type PartySight = {
  /**
   * Whether the creature is in the party's sight (section 4.3.2): any
   * sub-cell whose center lies inside its footprint, the squeezed one while
   * it squeezes, has a level above 0. On a hex scene its footprint is its
   * hexes (docs/design/design-v1-hex-grids.md HX-D10), so the scene's grid is the
   * second argument. Projection, drag frames and the "seen" marks call
   * seesCreature, which clips the footprint against walls before asking
   * seesSubcells, or uses seesToken where no clip is needed.
   */
  seesToken(token: SightProbe, grid: Grid): boolean;
  /** Whether any of these sub-cells has sight above 0, after a caller clips the footprint to its walls. */
  seesSubcells(subs: readonly (readonly [number, number])[]): boolean;
  /** Every tile with a level above 0, keyed `"<tx>,<ty>"`, as players and DMs receive them. */
  readonly tiles: ReadonlyMap<string, SightTile>;
};

export type VisionRules = {
  /**
   * On the server: the party's sight on a scene whose vision is on, from
   * 4C's cache. On a per-player scene this is the union of every source,
   * the DM's (docs/design/design-v1-per-player-vision.md 6.1), bit for bit what
   * the same scene sees as a whole-party one.
   */
  partySight(state: RoomState, sceneId: SceneId): PartySight;
  /**
   * On the server, for a per-player scene whose vision is on
   * (docs/design/design-v1-per-player-vision.md 6.1). With a member, what that
   * sight holder sees: the sources marked to share sight with the party and
   * the sources they own, among the union's sources. With null, the shared
   * sight alone, which every other viewer has. The union's own source cap
   * and order choose the sources, so each answer lies within `partySight`.
   * Viewers with the same sources may share one answer, and its tiles may
   * be worked out only when first read: a sweep's moment asks
   * seesCreature without reading the tiles. A scene whose vision is off,
   * or one the state lacks, sees nothing.
   */
  holderSight(state: RoomState, sceneId: SceneId, memberId: MemberId | null): PartySight;
  /**
   * On a client: the party's sight as the server sent it, from the sight
   * tiles a projected state holds (keyed `"<sceneId>:<tx>,<ty>"`). A scene
   * with none sees nothing.
   */
  sightFromTiles(tiles: Readonly<Record<string, SightTile>>, sceneId: SceneId): PartySight;
  /**
   * On the server: one class's sight on a floor, joined through its
   * openings (docs/design/design-v1-floors.md phase 4, 7.2). Its own answer
   * is the union's `partySight`, the shared class's `holderSight(F, null)`
   * on a per-player floor and `partySight` on a whole-party one, and a
   * holder's `holderSight(F, m)`, which a caller asks for only where m sees
   * for themselves on F. The joined answer raises it in each join's
   * sub-cells to the other floor's answer for the same class. `pending`
   * holds an exploration's joins not yet on the holder lists, by floor, of
   * which only those with `on` lend sight. With no join, the own answer.
   */
  sightFor(state: RoomState, sceneId: SceneId, cls: SightClass, pending?: PendingJoins): PartySight;
};

/** Whose sight on a floor (docs/design/design-v1-floors.md phase 4, 7.2): the DM's union, the shared class, or one sight holder's own. */
export type SightClass = "union" | "shared" | { holder: MemberId };

/** An exploration's joins to the holder lists, by floor, as explore.ts joinsOf finds them, each on or off at the cap. */
export type PendingJoins = Readonly<Record<SceneId, readonly { memberId: MemberId; on: boolean }[]>>;

/*
 * Sight reads the derived walls through this world, not by importing
 * walls.ts, whose areas sweep uses atan2: vision.ts and everything it
 * imports keep to the arithmetic every engine rounds alike (section 4.3.4).
 */
const VISION_WORLD: VisionWorld = { walls: sceneWalls, openings: openingJoins };

export const visionRules: VisionRules = {
  partySight: (state, sceneId) => partySight(state, sceneId, VISION_WORLD),
  holderSight: (state, sceneId, memberId) => holderSight(state, sceneId, memberId, VISION_WORLD),
  sightFromTiles,
  // Each floor's own answer reads the two rules above, so a test's stand-in sight answers here too.
  sightFor: (state, sceneId, cls, pending) => sightOfClass(state, sceneId, cls, pending, WARM),
};

/** Where a class's answers come from: each floor's own answer, and its join with the other floors'. */
type Answers = {
  own(state: RoomState, sceneId: SceneId, cls: SightClass): PartySight;
  join(state: RoomState, sceneId: SceneId, own: PartySight, parts: readonly JoinedPart[]): PartySight;
};

const WARM: Answers = {
  own: (state, sceneId, cls) => {
    if (cls === "union") return visionRules.partySight(state, sceneId);
    if (cls !== "shared") return visionRules.holderSight(state, sceneId, cls.holder);
    return perPlayerFloor(state, sceneId) ? visionRules.holderSight(state, sceneId, null) : visionRules.partySight(state, sceneId);
  },
  join: joinedSight,
};

const COLD: Answers = {
  own: (state, sceneId, cls) => {
    if (cls === "union") return coldPartySight(state, sceneId, VISION_WORLD);
    if (cls !== "shared") return coldHolderSight(state, sceneId, cls.holder, VISION_WORLD);
    return perPlayerFloor(state, sceneId) ? coldHolderSight(state, sceneId, null, VISION_WORLD) : coldPartySight(state, sceneId, VISION_WORLD);
  },
  join: (_state, _sceneId, own, parts) => coldJoinedSight(own, parts),
};

/** `sightFor` computed from nothing, joins included, ignoring and leaving the vision cache. For tests, which hold the warm answer to it. */
export function coldSightFor(state: RoomState, sceneId: SceneId, cls: SightClass, pending?: PendingJoins): PartySight {
  return sightOfClass(state, sceneId, cls, pending, COLD);
}

/*
 * 7.2's rule: the floor's own answer for the class, raised through each
 * join to the other floor's answer for the class matching it there. Class
 * meets class only, so an answer never borrows what its class may not
 * see: the shared class never reads a per-player floor's union or a
 * holder's own view.
 */
function sightOfClass(state: RoomState, sceneId: SceneId, cls: SightClass, pending: PendingJoins | undefined, answers: Answers): PartySight {
  const own = answers.own(state, sceneId, cls);
  const joins = VISION_WORLD.openings!(state, sceneId);
  if (joins.length === 0) return own;
  const parts = joins.map((join) => ({ join, other: answers.own(state, join.other, acrossClass(state, join.other, cls, pending)) }));
  return answers.join(state, sceneId, own, parts);
}

/**
 * The class a viewer's class matches on the other floor (7.2, D-261119-100
 * and 121): the union the union, the shared class the shared one, and a
 * holder their own view only where that floor is per-player and they hold
 * an enabled entry there, or one this exploration joins with `on`. A
 * registration stored off, as the cap makes one, lends nothing, so they
 * read that floor's shared answer.
 */
function acrossClass(state: RoomState, sceneId: SceneId, cls: SightClass, pending: PendingJoins | undefined): SightClass {
  if (typeof cls === "string") return cls;
  if (!perPlayerFloor(state, sceneId) || ownEntry(state.members, cls.holder)?.kind !== "player") return "shared";
  const listed = ownEntry(state.holders, sceneId)?.entries.some((e) => e.on && e.memberId === cls.holder) === true;
  const joining = pending !== undefined && Object.hasOwn(pending, sceneId) && pending[sceneId]!.some((e) => e.on && e.memberId === cls.holder);
  return listed || joining ? cls : "shared";
}

function perPlayerFloor(state: RoomState, sceneId: SceneId): boolean {
  return ownEntry(state.scenes, sceneId)?.vision?.perPlayer === true;
}

/** Stand-in vision rules a test swaps in, whose `sightFor` stays the real one and reads them (VisionRules.sightFor). */
export type StandInVision = Omit<VisionRules, "sightFor">;
