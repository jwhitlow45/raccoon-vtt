import type { Encounter, PathStop, Token, TokenPath, TurnStart } from "../model.ts";
import { MAX_PATH_CORNERS, MAX_PATH_STOPS } from "../protocol.ts";
import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import type { PlacedToken } from "./footprint.ts";
import { straightCost, type LegCost, type SizedSpot } from "./route.ts";

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
export function withStop(path: TokenPath, stop: PathStop, now?: { w: number; h: number }, walk?: Walked): TokenPath {
  const stops = [...path.stops, stop];
  while (stops.length > MAX_PATH_STOPS) {
    let i = 1;
    while (i < stops.length - 1 && !(oneSize(stops[i - 1]!, stops[i]!, now) && oneSize(stops[i]!, stops[i + 1]!, now))) i++;
    if (i === stops.length - 1) i = 1;
    const corner = stops[i]!;
    const { uncounted: _uncounted, ...next } = stops[i + 1]!;
    const joined: PathStop = corner.uncounted === true && stops[i + 1]!.uncounted === true ? { ...next, uncounted: true } : next;
    if (corner.seen !== true || corner.joinedUnseen === true) joined.joinedUnseen = true;
    if (walk) joinWalked(stops, i, joined, walk);
    stops.splice(i, 2, joined);
  }
  if (walk) capCorners(stops);
  return { turn: path.turn, stops };
}

/**
 * What a path's joins and readers need since op version 13
 * (docs/design-v1-movement.md 6.2): the token as it stands now, whose size
 * a stop without a footprint was made at, and the room's distance rules.
 */
export type Walked = { token: PlacedToken; rules: DistanceSettings };

/**
 * A joined leg's accounting (6.2, "Joins"): `moved`, `cost` and `diag` are
 * the sums over its counted parts, all parts when none counted, a part
 * without them first given them from its geometry with the counters at its
 * place. Its corners are both legs' with the one that goes, and it was seen
 * whole only when both legs were and that corner was seen.
 */
function joinWalked(stops: readonly PathStop[], i: number, joined: PathStop, walk: Walked): void {
  const corner = stops[i]!;
  const next = stops[i + 1]!;
  const counter = pathCounters(walk.token, stops.slice(0, i), walk.rules);
  const a = legTaken(walk.token, stops[i - 1]!, corner, walk.rules, counter);
  if (corner.uncounted !== true) {
    counter.h += a.diag[0];
    counter.v += a.diag[1];
  }
  const b = legTaken(walk.token, corner, next, walk.rules, counter);
  const counted = [corner.uncounted !== true ? a : null, next.uncounted !== true ? b : null].filter((p): p is LegCost => p !== null);
  const parts = counted.length > 0 ? counted : [a, b];
  joined.moved = parts.reduce((n, p) => n + p.moved, 0);
  joined.cost = parts.reduce((n, p) => n + p.cost, 0);
  const diag: [number, number] = [parts.reduce((n, p) => n + p.diag[0], 0), parts.reduce((n, p) => n + p.diag[1], 0)];
  if (diag[0] !== 0 || diag[1] !== 0) joined.diag = diag;
  else delete joined.diag;
  joined.via = [...(corner.via ?? []), corner.x, corner.y, ...(next.via ?? [])];
  if (corner.routeSeen === true && next.routeSeen === true && corner.seen === true) joined.routeSeen = true;
  else delete joined.routeSeen;
}

/** A path keeps at most MAX_PATH_CORNERS corners: past that the oldest legs lose theirs and draw straight. Accounting never changes. */
function capCorners(stops: PathStop[]): void {
  let corners = stops.reduce((n, s) => n + (s.via?.length ?? 0) / 2, 0);
  for (let i = 1; i < stops.length && corners > MAX_PATH_CORNERS; i++) {
    const via = stops[i]!.via;
    if (!via) continue;
    corners -= via.length / 2;
    const { via: _via, ...rest } = stops[i]!;
    stops[i] = rest;
  }
}

/**
 * What the leg ending at `to` took, as readers count it (6.2): its stored
 * `moved`, `cost` and `diag` since op version 13, else its geometry as a
 * straight leg with the 5-10-5 count at its place (`counter`, read only),
 * as before. A leg that holds only a `cost`, such as attach's mount legs,
 * keeps it beside its geometry's feet.
 */
export function legTaken(token: PlacedToken, from: PathStop, to: PathStop, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  if (to.moved !== undefined) return { moved: to.moved, cost: to.cost ?? to.moved, diag: to.diag ?? [0, 0] };
  const geometry = straightCost(token, from, to, rules, counter);
  return to.cost !== undefined ? { ...geometry, cost: to.cost } : geometry;
}

/** The true 5-10-5 counters after these stops' counted legs: the sum of their diagonals, a leg that does not count taking none. */
export function pathCounters(token: PlacedToken, stops: readonly PathStop[], rules: DistanceSettings): DiagonalCounter {
  const counter = { h: 0, v: 0 };
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.uncounted === true) continue;
    const t = legTaken(token, stops[i - 1]!, stops[i]!, rules, counter);
    counter.h += t.diag[0];
    counter.v += t.diag[1];
  }
  return counter;
}

/**
 * Whether players who do not own the creature saw the leg ending at stop
 * `i` whole (7.3): both its ends seen, not joined across a stop they could
 * not see, and every spot of it seen (`routeSeen`). On a stored path, the
 * DM's, that reads the marks. A player's copy carries `routeSeen` only on
 * legs seen whole (stopsForOwners, stopsForNonOwners), and no other marks.
 */
export function seenWhole(stops: readonly PathStop[], i: number, stored: boolean): boolean {
  const stop = stops[i];
  if (!stop || i === 0 || stop.routeSeen !== true) return false;
  return !stored || (stops[i - 1]!.seen === true && stop.seen === true && stop.joinedUnseen !== true);
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
    const plain = plainStop(stop, wholeLegSeen && stop.uncounted === true);
    // A leg's bends reach them only when they saw it whole, and never what it took: they read its length from what they received (7.3).
    if (seenWhole(stops, i, true)) {
      if (stop.via) plain.via = [...stop.via];
      plain.routeSeen = true;
    }
    out.push(plain);
  }
  return out;
}

/**
 * The stops an owner gets: every one, with what each leg took and its
 * bends, without the marks of who could see it. `routeSeen` stays on the
 * legs other players saw whole, so the owner's device starts a 5-10-5
 * route from the counters every device starts it from (5.5).
 */
export function stopsForOwners(stops: readonly PathStop[]): PathStop[] {
  return stops.map((stop, i) => {
    const plain = plainStop(stop, stop.uncounted === true);
    if (stop.via) plain.via = [...stop.via];
    if (stop.moved !== undefined) plain.moved = stop.moved;
    if (stop.cost !== undefined) plain.cost = stop.cost;
    if (stop.diag) plain.diag = [stop.diag[0], stop.diag[1]];
    if (seenWhole(stops, i, true)) plain.routeSeen = true;
    return plain;
  });
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

/**
 * The 5-10-5 counters a route's search starts from (5.5, "History"): the
 * diagonals of this turn's earlier counted legs that players who do not own
 * the creature saw whole, read from their geometry, the stop and its
 * corners. So which diagonal of a new route costs 10 ft never depends on a
 * leg only the owners saw. `stored` says the stops are the DM's, which
 * hold the marks of who saw what.
 */
export function publicCounters(token: PlacedToken, stops: readonly PathStop[], rules: DistanceSettings, stored: boolean): DiagonalCounter {
  const counter = { h: 0, v: 0 };
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.uncounted === true || !seenWhole(stops, i, stored)) continue;
    const t = legGeometry(token, stops[i - 1]!, stops[i]!, rules, counter);
    counter.h += t.diag[0];
    counter.v += t.diag[1];
  }
  return counter;
}

/**
 * What a leg takes read from its geometry alone, its stops and corners, as
 * players who do not own the creature read it (7.3): each straight part by
 * `straightCost`, the 5-10-5 count running on from `counter` (read only).
 */
export function legGeometry(token: PlacedToken, from: PathStop, to: PathStop, rules: DistanceSettings, counter: DiagonalCounter): LegCost {
  const running = { ...counter };
  let moved = 0;
  for (const [a, b] of legParts(from, to)) {
    const t = straightCost(token, a, b, rules, running);
    moved += t.moved;
    running.h += t.diag[0];
    running.v += t.diag[1];
  }
  return { moved, cost: moved, diag: rules.diagonal === "fiveTen" ? [running.h - counter.h, running.v - counter.v] : [0, 0] };
}

/**
 * A leg as the straight parts its stops and corners draw (6.2's `via`). The
 * corners carry no height: they stand at the leg's start, and the last part
 * takes the stop's, so a walk up a stair counts its rise once.
 */
export function legParts(from: PathStop, to: PathStop): [SizedSpot, SizedSpot][] {
  const via = to.via ?? [];
  const spots: SizedSpot[] = [from];
  for (let k = 0; k + 1 < via.length; k += 2) spots.push({ x: via[k]!, y: via[k + 1]!, elevation: from.elevation, ...(to.footprint ? { footprint: to.footprint } : {}) });
  spots.push(to);
  return spots.slice(1).map((b, i) => [spots[i]!, b]);
}
