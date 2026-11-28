import type { PathStop, RoomState, Token, TokenPath, Viewer } from "../model.ts";
import type { SrdRolls } from "../dice/bonus.ts";
import type { SrdMonster, StatBlockMonster } from "../srd/monsters.ts";
import type { DistanceSettings } from "./distance.ts";
import type { FootprintToken, PlacedToken } from "./footprint.ts";
import type { Grid } from "./grid.ts";
import type { Spot } from "./path.ts";
import type { WallSet } from "./walls.ts";

/**
 * Opportunity Attack notices (docs/design/design-v1-opportunity-attacks.md 4):
 * which enemies' reach a creature's move on its own turn leaves. Pure, and
 * shared by the drag's line, the turn card and the DM's toast, so the three
 * agree. Nothing here is stored: each device scans its own copy of the room,
 * so a player's answer reads only what their projection holds.
 *
 * A leave is a step from a spot within one of a creature's reaches to the
 * next spot beyond it. Walls and sight never make one: they are gates judged
 * at the departure spot, the last spot within that reach.
 */

/** One leg of the turn's path. `id` is the occurrence's (reconcileLegs). `provokes`: counted and not carried, read as a filter. */
export type ReachLeg = { id: number; from: PathStop; to: PathStop; provokes: boolean };

/**
 * A creature that could make an Opportunity Attack, as the scan reads it:
 * where it stands, its distinct reaches in feet, ascending, and what it
 * sees with. `known` is false where its reach was read as 5 ft for want of
 * its block. `extra` names the trait of its block that grants it more
 * Reactions ("Reactive Heads"), read once its block has loaded, else null.
 */
export type Reactor = {
  id: string;
  token: FootprintToken;
  reaches: readonly number[];
  blinded: boolean;
  blindsight: number;
  truesight: number;
  known: boolean;
  extra: string | null;
};

/**
 * One creature's reach left on a leg: `spot` is the index, in the leg's
 * walk (path.ts legSpots), of the first spot beyond `reach`, the spot before
 * it the departure spot. `extra` carries the reactor's trait for more
 * Reactions, so a row can stand with its Reaction used.
 */
export type ReachLeave = { id: string; spot: number; reach: number; extra?: string };

/** The SRD's monster blocks, once their chunk has loaded. */
export type SrdBlocks = readonly SrdMonster[];

/** The SRD chunks a scan reads, each passed in loaded or failed, never pending. */
export type Chunks = { rolls: SrdRolls | "failed"; monsters: SrdBlocks | "failed" };

/** The walls a scan's cover gate reads: the mover's scene's derived set (walls.ts sceneWalls). */
export type ReachWalls = WallSet;

/** What a scan is built from: this viewer's copy of the room, the DM's state or a player's projection. */
export type ReachView = Pick<RoomState, "meta" | "scenes" | "buildChunks" | "tokens" | "characters" | "companionBlocks" | "monsters" | "encounter">;

export type ScanInput = {
  grid: Grid;
  rules: DistanceSettings;
  walls: ReachWalls;
  /** The mover as it stands now, whose size a stop without a footprint was made at. */
  mover: PlacedToken & Partial<Pick<Token, "height">>;
  /** The mover is Invisible or has the Hidden status, so only Blindsight or Truesight sees it. */
  moverUnseen: boolean;
  reactors: readonly Reactor[];
};

/** A leg as one movement occurrence on this device. `parts`: the two records a join holds. */
export type LegRecord = { id: number; from: Spot; to: Spot; parts?: readonly LegRecord[] };

/** Work units a drag answer scans synchronously before it says the walk is checked after the drop. */
export const DRAG_WORK = 20_000;
/** Work units a stored leg's job scans between frames. */
export const SLICE_WORK = 20_000;
/** Work units past which one leg's scan stops: "Too many creatures here to check this walk." */
export const LEG_WORK_CAP = 2_000_000;
/** The longest reach a block's value is read as, in feet. */
export const MAX_REACH_FT = 120;

const NOT_BUILT = "not built";

/**
 * Matches a path update's legs to the previous ones by their from and to
 * spots, knowing the reducer's rewrites, so each leg keeps its occurrence id
 * through them. `added` are the new occurrences, `removed` the ones gone.
 */
export function reconcileLegs(prev: readonly LegRecord[], next: readonly Pick<ReachLeg, "from" | "to">[], newId: () => number): { legs: LegRecord[]; added: LegRecord[]; removed: LegRecord[] } {
  void prev;
  void next;
  void newId;
  throw new Error(NOT_BUILT);
}

/**
 * The creatures whose reach `leg` leaves, first leave first, skipping those
 * in `skip`. Yields the work done so far every `slice` units (SLICE_WORK by
 * default), and returns "over" past LEG_WORK_CAP.
 */
export function* reachScan(input: ScanInput, leg: ReachLeg, skip: ReadonlySet<string>, slice?: number): Generator<number, ReachLeave[] | "over"> {
  void input;
  void leg;
  void skip;
  void slice;
  yield 0;
  throw new Error(NOT_BUILT);
}

/**
 * The whole turn's scan at once: each leg in order with the creatures
 * earlier legs left as its `skip`, so a creature is reported once a turn.
 * A leg whose scan passes LEG_WORK_CAP reads "over" and adds nothing to the
 * skip. For tests and callers that need no slices.
 */
export function turnReach(input: ScanInput, legs: readonly ReachLeg[]): { id: number; leaves: ReachLeave[] | "over" }[] {
  void input;
  void legs;
  throw new Error(NOT_BUILT);
}

/** Which SRD chunks a scan of the mover's walk in this view waits for. */
export function chunksNeeded(view: ReachView, moverId: string): { rolls: boolean; monsters: boolean } {
  void view;
  void moverId;
  throw new Error(NOT_BUILT);
}

/**
 * The scan's input and the path's legs on the mover's floor, or null where
 * there is nothing to scan: no mover, no scene or no path. Each leg's `id`
 * here is the index of its end stop in `path.stops`, which the caller maps
 * to the leg's occurrence id.
 */
export function reachInput(view: ReachView, moverId: string, path: TokenPath | null, chunks: Chunks, viewer: Viewer): { input: ScanInput; legs: ReachLeg[] } | null {
  void view;
  void moverId;
  void path;
  void chunks;
  void viewer;
  throw new Error(NOT_BUILT);
}

/** Whether a cached leave still stands as a row: its creature in this viewer's copy, alive, not Incapacitated, and its Reaction free or more granted. */
export function rowStands(view: ReachView, leave: ReachLeave, viewer: Viewer): boolean {
  void view;
  void leave;
  void viewer;
  throw new Error(NOT_BUILT);
}

/** A creature's distinct reaches in feet, ascending, and whether they were read from its block or weapons rather than taken as 5 ft. */
export function reachOf(view: ReachView, token: Token, chunks: Chunks): { reaches: number[]; known: boolean } {
  void view;
  void token;
  void chunks;
  throw new Error(NOT_BUILT);
}

/** The name of the block's first entry that says the creature avoids Opportunity Attacks ("Flyby"), or null. */
export function avoidTrait(block: StatBlockMonster): string | null {
  void block;
  throw new Error(NOT_BUILT);
}

/** The name of the block's first entry that grants extra Reactions ("Reactive Heads"), or null. */
export function extraReactions(block: StatBlockMonster): string | null {
  void block;
  throw new Error(NOT_BUILT);
}

/**
 * The words naming the creatures whose reach a walk leaves, the creature and
 * the full stop left to the caller: "Leaves Goblin 2's reach", "left the
 * reach of Goblin 2 and Goblin 3", past `max` names the first `max - 1` and
 * "2 more", and with `max` 1 "left 3 creatures' reach". `fiveFt` words a
 * player's line where every creature named was counted at 5 ft: "Leaves 5 ft
 * of Goblin 2".
 */
export function reachWords(names: readonly string[], verb: "Leaves" | "left", fiveFt: boolean, max: number): string {
  void names;
  void verb;
  void fiveFt;
  void max;
  throw new Error(NOT_BUILT);
}

/** Whether the room's Opportunity Attack notices are on: absent reads on. Typed locally, so this builds before the room switch. */
export function opportunityNoticesOn(settings: { opportunityNotices?: boolean }): boolean {
  return settings.opportunityNotices !== false;
}
