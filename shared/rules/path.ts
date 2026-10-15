import type { Encounter, PathStop, Token, TokenPath, TurnStart } from "../model.ts";
import { MAX_PATH_STOPS } from "../protocol.ts";

/**
 * A creature's path on its turn (features section 4, design 6): the rules
 * the reducer records legs by, the projection filters by, and the client
 * draws and measures by.
 *
 * A path lives on its token, tagged with the turn it belongs to, so a move
 * writes only the token and the turn passing writes nothing. A path whose
 * tag is not the turn under way counts as empty wherever it is read.
 */

/** Where a token stands, as a path counts it. Facing is not movement. */
export type Spot = { x: number; y: number; elevation: number };

export function sameSpot(a: Spot, b: Spot): boolean {
  return a.x === b.x && a.y === b.y && a.elevation === b.elevation;
}

/** The start of the turn under way, when its moves are recorded: the active row's, named by its seq. */
export function turnUnderWay(encounter: Pick<Encounter, "activeEntryId" | "turnStart"> | null | undefined): (TurnStart & { seq: number }) | null {
  const start = encounter?.turnStart;
  if (!encounter || !start || start.seq === undefined || start.entryId !== encounter.activeEntryId) return null;
  return start as TurnStart & { seq: number };
}

/** The token's path when it belongs to the turn under way, which is then its own turn. */
export function pathThisTurn(encounter: Pick<Encounter, "activeEntryId" | "turnStart"> | null | undefined, token: Pick<Token, "id" | "path">): TokenPath | null {
  const turn = turnUnderWay(encounter);
  const path = token.path;
  return turn && path && turn.tokenId === token.id && path.turn === turn.seq ? path : null;
}

/**
 * The path with one more stop. Once it holds MAX_PATH_STOPS, the oldest
 * corner goes, so its two legs read as one straight leg, and the start
 * and the latest moves stay as they were.
 *
 * The joined leg does not count only when neither leg counted, so the
 * distance never drops a leg that did. And the corner players who do not
 * own the creature could not see keeps them from the joined leg's mark, as
 * it did while it was there: their line already joined the two legs, and
 * the mark would now tell them how the creature moved out of their sight.
 */
export function withStop(path: TokenPath, stop: PathStop): TokenPath {
  const stops = [...path.stops, stop];
  while (stops.length > MAX_PATH_STOPS) {
    const corner = stops[1]!;
    const { uncounted: _uncounted, ...next } = stops[2]!;
    const joined: PathStop = corner.uncounted === true && stops[2]!.uncounted === true ? { ...next, uncounted: true } : next;
    if (corner.seen !== true || corner.joinedUnseen === true) joined.joinedUnseen = true;
    stops.splice(1, 2, joined);
  }
  return { turn: path.turn, stops };
}

/**
 * The stops players who do not own the token get: those they could see,
 * without the mark that says so. A leg reaches them as uncounted only when
 * they saw both its ends. Otherwise their line joins two stops with unseen
 * ones between, and the mark would tell them how the creature moved where
 * they could not see it. So all they read, the trail and the distance
 * alike, comes from what they saw.
 */
export function stopsForNonOwners(stops: readonly PathStop[]): PathStop[] {
  const out: PathStop[] = [];
  for (const [i, stop] of stops.entries()) {
    if (!stop.seen) continue;
    const wholeLegSeen = i > 0 && stops[i - 1]!.seen === true && stop.joinedUnseen !== true;
    out.push(plainStop(stop, wholeLegSeen && stop.uncounted === true));
  }
  return out;
}

/** The stops an owner gets: every one, without the marks of who could see it. */
export function stopsForOwners(stops: readonly PathStop[]): PathStop[] {
  return stops.map((stop) => plainStop(stop, stop.uncounted === true));
}

function plainStop(stop: PathStop, uncounted: boolean): PathStop {
  const out: PathStop = { x: stop.x, y: stop.y, elevation: stop.elevation };
  if (uncounted) out.uncounted = true;
  return out;
}
