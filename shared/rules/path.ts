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
 * Whether two stops were made at one size (docs/design-v1-token-window.md
 * 8.7): a stop without a footprint was made at the size now (`now`). A leg
 * whose ends differ is a resize's, or legs joined across one. A squeeze
 * keeps the size, so a move into or out of one is a leg at one size.
 * Without `now`, a stop with a footprint and one without differ.
 */
export function oneSize(a: Pick<PathStop, "footprint">, b: Pick<PathStop, "footprint">, now?: { w: number; h: number }): boolean {
  const sa = a.footprint ?? now;
  const sb = b.footprint ?? now;
  if (!sa || !sb) return sa === sb;
  return sa.w === sb.w && sa.h === sb.h;
}

/**
 * Whether the leg from `a` to `b` changed the creature's footprint rather
 * than moved it (docs/design-v1-token-window.md 8.7): a resize, whose ends
 * differ in size wherever it left the creature, or a squeeze taken or left
 * where the creature stands. Neither is movement, so the reducer never
 * counts such a leg and "Doesn't count" has nothing to mark on it. A move
 * into or out of a squeeze goes somewhere, and is a move. `now` is the
 * footprint now, which a stop without one was made at.
 */
export function reshapeLeg(a: PathStop, b: PathStop, now: { w: number; h: number; squeeze?: true }): boolean {
  if (!oneSize(a, b, now)) return true;
  return sameSpot(a, b) && (a.footprint ?? now).squeeze !== (b.footprint ?? now).squeeze;
}

/**
 * The path with one more stop. Once it holds MAX_PATH_STOPS, the oldest
 * corner whose two legs lie at one size goes, so they read as one straight
 * leg, and the start and the latest moves stay as they were. A resize's
 * stop and the stop before it are never such a corner, so a joined leg
 * never spans a resize while another corner remains. Where none does, as
 * in a turn of a move and a resize after another until the path is full,
 * the oldest corner goes all the same. `now` is the size the creature has
 * now, which a stop without a footprint was made at (oneSize).
 *
 * The joined leg does not count only when neither leg counted, so the
 * distance never drops a leg that did. And the corner players who do not
 * own the creature could not see keeps them from the joined leg's mark, as
 * it did while it was there: their line already joined the two legs, and
 * the mark would now tell them how the creature moved out of their sight.
 * The joined stop keeps the later stop's other fields, its size with them.
 */
export function withStop(path: TokenPath, stop: PathStop, now?: { w: number; h: number }): TokenPath {
  const stops = [...path.stops, stop];
  while (stops.length > MAX_PATH_STOPS) {
    let i = 1;
    while (i < stops.length - 1 && !(oneSize(stops[i - 1]!, stops[i]!, now) && oneSize(stops[i]!, stops[i + 1]!, now))) i++;
    if (i === stops.length - 1) i = 1;
    const corner = stops[i]!;
    const { uncounted: _uncounted, ...next } = stops[i + 1]!;
    const joined: PathStop = corner.uncounted === true && stops[i + 1]!.uncounted === true ? { ...next, uncounted: true } : next;
    if (corner.seen !== true || corner.joinedUnseen === true) joined.joinedUnseen = true;
    stops.splice(i, 2, joined);
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

/*
 * A stop without the marks of who could see it. Its size goes with it to
 * owners and others alike: it is the size the creature had where they saw
 * it, so it tells them nothing they could not see, and every viewer's
 * trail and feet read each stop at its own size.
 */
function plainStop(stop: PathStop, uncounted: boolean): PathStop {
  const out: PathStop = { x: stop.x, y: stop.y, elevation: stop.elevation };
  if (uncounted) out.uncounted = true;
  if (stop.footprint) out.footprint = { w: stop.footprint.w, h: stop.footprint.h, ...(stop.footprint.squeeze ? { squeeze: true as const } : {}) };
  return out;
}
