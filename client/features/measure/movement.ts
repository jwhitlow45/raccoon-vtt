import type { PathStop, TokenPath, TurnStart } from "#shared/model.ts";
import { legFeet, type DiagonalCounter } from "#shared/rules/distance.ts";
import { footprintRect, footprintSize, isSqueezed, type PlacedToken } from "#shared/rules/footprint.ts";
import type { Rect } from "#shared/rules/geom.ts";
import { pathThisTurn, sameSpot } from "#shared/rules/path.ts";
import { formatFeet, type DistanceRules, type Point } from "./ruler.ts";

/**
 * How far a creature has moved this turn (features sections 4 and 10), kept
 * free of React and Konva so it is tested under plain Node.
 *
 * The active creature's moves on its turn are a path on its token, one stop
 * per drop (shared/rules/path.ts), so every device and a reload agree on
 * the route and the distance. The distance is the sum of its legs, each by
 * the room's diagonal rule with climbing counted, less the legs marked as
 * not counting, such as a shove. A turn that began before paths were
 * recorded reads straight from where it began, as it did before.
 */

/** Where a token stands, as far as movement counts it: cells and feet. */
export type Spot = { x: number; y: number; elevation: number };

/** The token fields a movement reading needs. */
export type MovingToken = PlacedToken & Spot & { id: string; sceneId: string; path?: TokenPath };

/** The encounter fields movement reads, as a DM's or a player's copy holds them. */
export type TurnView = {
  activeEntryId: string | null;
  started?: boolean;
  turnStart?: TurnStart;
  entries: readonly { id: string; tokenId?: string }[];
};

/**
 * A spot with the footprint the creature had there, squeeze and all, where
 * that differs from the token's footprint now (PathStop.footprint).
 * Without it, the spot is read with the token's footprint now.
 */
export type SizedSpot = Spot & Pick<PathStop, "footprint">;

/** The token as it stood at a spot, at the size it had there and squeezed if it was. */
function standingAt(token: PlacedToken, spot: SizedSpot): PlacedToken {
  if (!spot.footprint) return { ...token, x: spot.x, y: spot.y };
  const { w, h, squeeze } = spot.footprint;
  return { size: "custom", w, h, x: spot.x, y: spot.y, ...(squeeze ? { squeeze } : {}) };
}

/** The footprint a trail draws at a spot, in cells, at the size the creature had there. */
export function spotRect(token: PlacedToken, spot: SizedSpot): Rect {
  return footprintRect(standingAt(token, spot));
}

/**
 * Feet between two spots of one token: the steps its snapped top-left
 * corner takes, with its change of elevation as the vertical steps. Counting
 * the corner means a Large creature moved one square has moved 5 ft, where
 * an edge-to-edge reading would call its old and new footprints overlapping.
 * Each end is snapped and measured at its own size, so a Tiny's half-square
 * leg keeps its 2.5 ft after it grows. A leg whose ends differ in size, a
 * resize's or legs joined across one once the path is full (rules/path.ts
 * withStop), or whose ends differ in squeeze, a move into or out of one,
 * runs between the two footprints' middles: a squeezed footprint sits
 * centered and unsnapped, so its corner is no measure beside a full one's.
 *
 * `counter` carries the diagonals of earlier legs under the 5-10-5 rule,
 * which counts every second diagonal of the whole move double, and is
 * updated in place, as a ruler's legs do (rules/distance.ts).
 */
export function movedFeet(token: PlacedToken, from: SizedSpot, to: SizedSpot, rules: DistanceRules, counter?: DiagonalCounter): number {
  const a = spotRect(token, from);
  const b = spotRect(token, to);
  const standA = standingAt(token, from);
  const standB = standingAt(token, to);
  const sizeA = footprintSize(standA);
  const sizeB = footprintSize(standB);
  const differ = sizeA.w !== sizeB.w || sizeA.h !== sizeB.h || isSqueezed(standA) !== isSqueezed(standB);
  const across = differ ? { x: (b.w - a.w) / 2, y: (b.h - a.h) / 2 } : { x: 0, y: 0 };
  const dz = Math.abs(to.elevation - from.elevation) / rules.feetPerCell;
  const ft = legFeet(Math.abs(b.x - a.x + across.x), Math.abs(b.y - a.y + across.y), dz, rules.diagonal, rules.feetPerCell, counter);
  return rules.diagonal === "euclid" ? Math.round(ft) : ft;
}

/**
 * The token's path this turn as this viewer holds it, or null. A DM's copy
 * keeps paths of earlier turns, which count as empty. A player gets a path
 * only while it is the turn under way's (design 7.3), but not the turn's
 * start when they could not see where it began, so a path in a player's
 * copy of the active creature with no start to check it against is this
 * turn's.
 */
export function pathNow(encounter: TurnView | null | undefined, token: Pick<MovingToken, "id" | "path">, role: "dm" | "player"): TokenPath | null {
  if (!encounter || !token.path || encounter.activeEntryId === null) return null;
  const start = encounter.turnStart;
  if (start?.entryId === encounter.activeEntryId) return pathThisTurn(encounter, token);
  if (role === "dm") return null;
  return encounter.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId === token.id ? token.path : null;
}

/** One leg of a trail: the straight line between two spots, and whether it counts against speed. */
export type TrailLeg = { from: Spot; to: Spot; counted: boolean };

export type TurnTrail = {
  /** Where the turn began, each stop since, and where the creature stands now, in order. */
  spots: Spot[];
  /** The footprint at each spot, in cells, at the size the creature had there. */
  rects: Rect[];
  /** `legs[i]` joins `spots[i]` and `spots[i + 1]`. */
  legs: TrailLeg[];
  /** The counted legs' feet. */
  movedFt: number;
  /** The diagonals the counted legs took, for a drag to count on from under the 5-10-5 rule. */
  diagonals: DiagonalCounter;
  /** The footprints where the turn began, at the size it began at, and where the creature stands now, in cells. */
  from: Rect;
  to: Rect;
};

/**
 * The trail of the active creature on this scene, or null when there is
 * none to draw: no turn has started, the creature is not the active one,
 * it is on another scene, or it has not moved yet.
 *
 * A player who does not own the creature holds only the stops they saw,
 * and a spot where it stands now that they see may not be one of them
 * (the fog lifted since). Their trail joins it on with a counted leg, so
 * what they read comes from what they saw and nothing else.
 */
export function turnTrail(input: {
  encounter: TurnView | null | undefined;
  sceneId: string;
  token: MovingToken | undefined;
  rules: DistanceRules;
  role: "dm" | "player";
}): TurnTrail | null {
  const { encounter, token } = input;
  if (!encounter || !token || token.sceneId !== input.sceneId) return null;
  const path = pathNow(encounter, token, input.role);
  const start = encounter.turnStart;
  let stops: (SizedSpot & Pick<PathStop, "uncounted">)[];
  if (path) stops = [...path.stops];
  else if (start && start.entryId === encounter.activeEntryId && start.tokenId === token.id && start.sceneId === token.sceneId) stops = [start];
  else return null;
  const last = stops[stops.length - 1]!;
  if (!sameSpot(last, token)) stops.push({ x: token.x, y: token.y, elevation: token.elevation });
  if (stops.length < 2) return null;
  const spots = stops.map((s): Spot => ({ x: s.x, y: s.y, elevation: s.elevation }));
  const legs = spots.slice(1).map((to, i): TrailLeg => ({ from: spots[i]!, to, counted: stops[i + 1]!.uncounted !== true }));
  // A leg that does not count takes no diagonals either, so the 5-10-5 count runs on across it, a resize's leg included.
  const diagonals: DiagonalCounter = { h: 0, v: 0 };
  const movedFt = legs.reduce((sum, leg, i) => (leg.counted ? sum + movedFeet(token, stops[i]!, stops[i + 1]!, input.rules, diagonals) : sum), 0);
  const rects = stops.map((stop) => spotRect(token, stop));
  return { spots, rects, legs, movedFt, diagonals, from: rects[0]!, to: footprintRect(token) };
}

/**
 * Where the line from the center of an ellipse inscribed in `r` toward
 * `toward` leaves it, so a line between two tokens starts and ends at their
 * round edges instead of crossing their art.
 */
export function ellipseExit(r: Rect, toward: Point): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  const k = Math.hypot(dx / (r.w / 2), dy / (r.h / 2));
  if (k <= 1) return { x: cx, y: cy };
  return { x: cx + dx / k, y: cy + dy / k };
}

/** The speeds movement is read against (features section 4). Climbing and burrowing are left to the table. */
export type SpeedKind = "walk" | "fly" | "swim";

export type Speeds = Partial<Record<SpeedKind | "climb" | "burrow", number>> & { hover?: boolean };

/**
 * What one speed has left: the 2024 rules take the distance already moved
 * off whichever speed a creature switches to, so every speed reads against
 * the same total. `band` places the total against this speed: within it,
 * within a Dash (twice it), or past both.
 */
export type SpeedLeft = { kind: SpeedKind; speed: number; leftFt: number; band: "walk" | "dash" | "over" };

/**
 * The creature's speeds against the feet it has used, the one it is most
 * likely moving by first: flying when it is above the ground and can fly,
 * walking otherwise. Speeds of 0 are left out, so a token with none set
 * reads as unknown (an empty list) rather than as unable to move.
 */
export function speedsLeft(speeds: Speeds | undefined, elevation: number, usedFt: number): SpeedLeft[] {
  if (!speeds) return [];
  const kinds: SpeedKind[] = elevation > 0 && (speeds.fly ?? 0) > 0 ? ["fly", "walk", "swim"] : ["walk", "fly", "swim"];
  const out: SpeedLeft[] = [];
  for (const kind of kinds) {
    const speed = speeds[kind] ?? 0;
    if (!(speed > 0)) continue;
    const band = usedFt <= speed ? "walk" : usedFt <= speed * 2 ? "dash" : "over";
    const leftFt = band === "walk" ? speed - usedFt : band === "dash" ? speed * 2 - usedFt : usedFt - speed * 2;
    out.push({ kind, speed, leftFt, band });
  }
  return out;
}

/**
 * The marker's text: the feet moved and, for a viewer who knows the
 * creature's speeds (the DM and its owners, design 7.3), what is left.
 * "Dash" counts the extra movement a Dash gives, equal to the speed.
 */
export function movementText(usedFt: number, left: readonly SpeedLeft[]): string {
  const moved = `Moved ${formatFeet(usedFt)}`;
  const [first, ...rest] = left;
  if (!first) return moved;
  const others = rest.filter((s) => s.band === "walk").map((s) => `${s.kind} ${formatFeet(s.leftFt)}`);
  return `${moved}\n${[leftText(first), ...others].join(" · ")}`;
}

/** "15 ft left", "Fly: 5 ft left with Dash", "10 ft past Dash". */
export function leftText(left: SpeedLeft): string {
  const name = left.kind === "walk" ? "" : `${capitalize(left.kind)}: `;
  const ft = formatFeet(left.leftFt);
  return name + (left.band === "walk" ? `${ft} left` : left.band === "dash" ? `${ft} left with Dash` : `${ft} past Dash`);
}

/**
 * How a token drag reads against the creature's speed (features section 4):
 * the feet this drag covers, and the speed its total falls in. During a
 * fight only the active creature is read, and its total is its path so
 * far (turnTrail) plus the leg being dragged, so the band counts every leg
 * of the turn that counts, and the 5-10-5 rule's diagonals run on from the
 * path into the drag. Outside a fight any token is read from where the drag
 * began. `left` is absent when there is nothing to read against: another
 * creature during a fight, or no speed this viewer knows (only the DM and
 * owners get speeds, design 7.3).
 */
export function dragReading(input: {
  token: MovingToken;
  /** The snapped drop point. */
  to: Point;
  encounter: TurnView | null | undefined;
  /** The token whose turn it is, when this viewer knows. */
  activeTokenId: string | null;
  speeds: Speeds | undefined;
  rules: DistanceRules;
  role: "dm" | "player";
}): { dragFt: number; left?: SpeedLeft } {
  const { token, encounter, rules } = input;
  const to = { x: input.to.x, y: input.to.y, elevation: token.elevation };
  const fighting = encounter ? (encounter.started ?? encounter.activeEntryId !== null) : false;
  const active = fighting && input.activeTokenId === token.id;
  const trail = active ? turnTrail({ encounter, sceneId: token.sceneId, token, rules, role: input.role }) : null;
  const dragFt = movedFeet(token, token, to, rules, trail ? { ...trail.diagonals } : undefined);
  if (fighting && !active) return { dragFt };
  const left = speedsLeft(input.speeds, token.elevation, (trail?.movedFt ?? 0) + dragFt)[0];
  return left ? { dragFt, left } : { dragFt };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
