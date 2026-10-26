import type { MemberId, RoomState, SceneId, SightTile, Token } from "./model.ts";
import type { DoorRef } from "./protocol.ts";
import { legBlocker, lineClear, squeezeFits, type WalkEnd, type Walker } from "./rules/movement.ts";
import type { Point } from "./rules/geom.ts";
import { holderSight, partySight, sightFromTiles, type VisionWorld } from "./rules/vision.ts";
import { sceneWalls } from "./rules/walls.ts";

/**
 * The wave 4 rules as the core calls them (docs/design-v1-maps-vision.md
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

/** Where a leg ends: the spot a move gives the token, its elevation included. */
export type LegEnd = { x: number; y: number; elevation: number };

/** What stops a leg: a wall (doors, windows and pillars included) or a ledge between two heights. */
export type Blocker = "wall" | "ledge";

/** The state the movement test reads: the scene and its build. */
export type BuildState = Pick<RoomState, "scenes" | "buildChunks">;

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
   * it squeezes, has a level above 0. Projection, drag frames and the "seen"
   * marks all ask this one question.
   */
  seesToken(token: SightProbe): boolean;
  /** Every tile with a level above 0, keyed `"<tx>,<ty>"`, as players and DMs receive them. */
  readonly tiles: ReadonlyMap<string, SightTile>;
};

export type VisionRules = {
  /**
   * On the server: the party's sight on a scene whose vision is on, from
   * 4C's cache. On a per-player scene this is the union of every source,
   * the DM's (docs/design-v1-per-player-vision.md 6.1), bit for bit what
   * the same scene sees as a whole-party one.
   */
  partySight(state: RoomState, sceneId: SceneId): PartySight;
  /**
   * On the server, for a per-player scene whose vision is on
   * (docs/design-v1-per-player-vision.md 6.1). With a member, what that
   * sight holder sees: the sources marked to share sight with the party and
   * the sources they own, among the union's sources. With null, the shared
   * sight alone, which every other viewer has. The union's own source cap
   * and order choose the sources, so each answer lies within `partySight`.
   * Viewers with the same sources may share one answer, and its tiles may
   * be worked out only when first read: a sweep's moment asks `seesToken`
   * alone. A scene whose vision is off, or one the state lacks, sees
   * nothing.
   */
  holderSight(state: RoomState, sceneId: SceneId, memberId: MemberId | null): PartySight;
  /**
   * On a client: the party's sight as the server sent it, from the sight
   * tiles a projected state holds (keyed `"<sceneId>:<tx>,<ty>"`). A scene
   * with none sees nothing.
   */
  sightFromTiles(tiles: Readonly<Record<string, SightTile>>, sceneId: SceneId): PartySight;
};

/*
 * Sight reads the derived walls through this world, not by importing
 * walls.ts, whose areas sweep uses atan2: vision.ts and everything it
 * imports keep to the arithmetic every engine rounds alike (section 4.3.4).
 */
const VISION_WORLD: VisionWorld = { walls: sceneWalls };

export const visionRules: VisionRules = {
  partySight: (state, sceneId) => partySight(state, sceneId, VISION_WORLD),
  holderSight: (state, sceneId, memberId) => holderSight(state, sceneId, memberId, VISION_WORLD),
  sightFromTiles,
};
