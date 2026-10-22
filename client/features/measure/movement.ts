import type { PathStop, TokenPath, TurnStart } from "#shared/model.ts";
import type { BuildState } from "#shared/ruleHooks.ts";
import type { DiagonalCounter } from "#shared/rules/distance.ts";
import { footprintRect, snapStep, type PlacedToken } from "#shared/rules/footprint.ts";
import type { Rect } from "#shared/rules/geom.ts";
import { legGeometry, legTaken, pathThisTurn, sameSpot } from "#shared/rules/path.ts";
import { dismountCost } from "#shared/rules/dismount.ts";
import { plainLegCost, routeFeet, routeWalk, spotRect, straightCost, type LegCost, type RoutePiece, type RoutePoint, type SizedSpot } from "#shared/rules/route.ts";
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
 * A spot with the footprint the creature had there, and the feet between
 * two spots of a plain straight leg, are the shared rules' own
 * (shared/rules/route.ts), since the reducer counts a leg by them too.
 */
export type { SizedSpot } from "#shared/rules/route.ts";
export { spotRect, straightFeet as movedFeet } from "#shared/rules/route.ts";

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

/**
 * One leg of a trail: from one spot to the next through the corners it
 * walked, top-left as stops are, whether it counts against speed, and
 * whether its holder carried it there (docs/design-v1-attach.md 7.2), a
 * mark only the DM's copy holds.
 */
export type TrailLeg = { from: Spot; to: Spot; counted: boolean; carried: boolean; via: Point[] };

export type TurnTrail = {
  /** Where the turn began, each stop since, and where the creature stands now, in order. */
  spots: Spot[];
  /** The footprint at each spot, in cells, at the size the creature had there. */
  rects: Rect[];
  /** `legs[i]` joins `spots[i]` and `spots[i + 1]`. */
  legs: TrailLeg[];
  /** The counted legs' feet. */
  movedFt: number;
  /**
   * What the counted legs took off the speed (docs/design-v1-movement.md
   * 3.2): their stored costs for the DM and the creature's owners, whose
   * copies hold them, and their feet for everyone else.
   */
  usedFt: number;
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
  let stops: (SizedSpot & Omit<PathStop, "x" | "y" | "elevation" | "footprint">)[];
  if (path) stops = [...path.stops];
  else if (start && start.entryId === encounter.activeEntryId && start.tokenId === token.id && start.sceneId === token.sceneId) stops = [start];
  else return null;
  const last = stops[stops.length - 1]!;
  if (!sameSpot(last, token)) stops.push({ x: token.x, y: token.y, elevation: token.elevation });
  if (stops.length < 2) return null;
  const spots = stops.map((s): Spot => ({ x: s.x, y: s.y, elevation: s.elevation }));
  const legs = spots.slice(1).map((to, i): TrailLeg => ({ from: spots[i]!, to, counted: stops[i + 1]!.uncounted !== true, carried: stops[i + 1]!.carried === true, via: corners(stops[i + 1]!) }));
  // A leg that does not count takes no diagonals either, so the 5-10-5 count runs on across it, a resize's leg included.
  const diagonals: DiagonalCounter = { h: 0, v: 0 };
  let movedFt = 0;
  let usedFt = 0;
  for (const [i, leg] of legs.entries()) {
    if (!leg.counted) continue;
    const taken = legRead(token, stops[i]!, stops[i + 1]!, input.rules, diagonals);
    movedFt += taken.moved;
    usedFt += taken.cost;
    diagonals.h += taken.diag[0];
    diagonals.v += taken.diag[1];
  }
  const rects = stops.map((stop) => spotRect(token, stop));
  return { spots, rects, legs, movedFt, usedFt, diagonals, from: rects[0]!, to: footprintRect(token) };
}

/** A stop's corners as points. */
function corners(stop: Pick<PathStop, "via">): Point[] {
  const via = stop.via ?? [];
  const out: Point[] = [];
  for (let k = 0; k + 1 < via.length; k += 2) out.push({ x: via[k]!, y: via[k + 1]! });
  return out;
}

/**
 * What one leg took, as this viewer reads it: as stored when walked, where
 * the copy holds it (the DM's and the owners'), else from its stops and
 * corners, never from a total the viewer was not sent.
 */
function legRead(token: PlacedToken, from: PathStop, to: PathStop, rules: DistanceRules, counter: DiagonalCounter): LegCost {
  return to.moved !== undefined || to.cost !== undefined ? legTaken(token, from, to, rules, counter) : legGeometry(token, from, to, rules, counter);
}

/**
 * The lines a trail draws, one per leg: between footprint centers, each
 * stop's footprint at the size the creature had there, through the
 * corners of the route each walked, the first and last cut back to the
 * round edges of the start ring and the token so the line never crosses
 * their art. A resize that kept the middle leaves no line, and neither
 * does a leg its holder carried it (docs/design-v1-attach.md 7.2): the
 * holder's own trail shows the way, so the DM, whose copy marks such legs,
 * sees one line, not two.
 */
export function trailSegments(trail: TurnTrail): { leg: number; points: Point[]; counted: boolean }[] {
  const centers = trail.rects.map(rectCenter);
  const last = centers.length - 1;
  const out: { leg: number; points: Point[]; counted: boolean }[] = [];
  for (const [i, leg] of trail.legs.entries()) {
    if (leg.carried) continue;
    const r = trail.rects[i + 1]!;
    const bends = leg.via.map((p) => ({ x: p.x + r.w / 2, y: p.y + r.h / 2 }));
    const a = i === 0 ? ellipseExit(trail.from, bends[0] ?? centers[1]!) : centers[i]!;
    const b = i + 1 === last ? ellipseExit(trail.to, bends[bends.length - 1] ?? centers[last - 1]!) : centers[i + 1]!;
    // Overlapping footprints, as after a short step or a climb in place, leave no gap to draw a line in.
    if (bends.length === 0 && Math.hypot(b.x - a.x, b.y - a.y) <= 0.05) continue;
    out.push({ leg: i, points: [a, ...bends, b], counted: leg.counted });
  }
  return out;
}

function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
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

/** Every speed halved, rounded down (docs/design-v1-movement.md 4.2): 25 ft halves to 12 ft. */
export function halvedSpeeds(speeds: Speeds | undefined): Speeds | undefined {
  if (!speeds) return undefined;
  const out: Speeds = { ...speeds };
  for (const kind of ["walk", "fly", "swim", "climb", "burrow"] as const) {
    const v = speeds[kind];
    if (v !== undefined) out[kind] = Math.floor(v / 2);
  }
  return out;
}

/**
 * The marker's text: the feet moved, with what it used when the turn's
 * cost differs ("Moved 25 ft, used 35 ft", docs/design-v1-movement.md 3.2),
 * and for a viewer who knows the creature's speeds (the DM and its owners,
 * design 7.3) what is left. "Dash" counts the extra movement a Dash gives,
 * equal to the speed.
 */
export function movementText(movedFt: number, left: readonly SpeedLeft[], usedFt = movedFt): string {
  const moved = `Moved ${formatFeet(movedFt)}${usedFt !== movedFt ? `, used ${formatFeet(usedFt)}` : ""}`;
  const [first, ...rest] = left;
  if (!first) return moved;
  const others = rest.filter((s) => s.band === "walk").map((s) => `${capitalize(s.kind)} ${formatFeet(s.leftFt)}`);
  return `${moved}\n${[leftText(first), ...others].join(" · ")}`;
}

/** "15 ft left", "Fly: 5 ft left with Dash", "10 ft past Dash". */
export function leftText(left: SpeedLeft): string {
  const name = left.kind === "walk" ? "" : `${capitalize(left.kind)}: `;
  const ft = formatFeet(left.leftFt);
  return name + (left.band === "walk" ? `${ft} left` : left.band === "dash" ? `${ft} left with Dash` : `${ft} past Dash`);
}

/** The walk a drag's route search found for it (docs/design-v1-movement.md 3.1), and what the band reads along it. */
export type DragWalk = {
  /** The route, or null for the straight leg. */
  route: { points: readonly RoutePoint[]; pieces: readonly RoutePiece[] } | null;
  /** The map, for the ground under each spot of the walk. */
  build: Pick<BuildState, "buildChunks">;
  /** The name of the Half Speed area the creature would stand in at a spot, or null (4.2). */
  halved(at: RoutePoint): string | null;
  /** Crawling: the creature is Prone as players see it. */
  prone: boolean;
  /** The holder's extra foot for a creature it drags or carries (docs/design-v1-attach.md 7.3), named by how it moves it. */
  towing?: "dragging" | "carrying";
};

/** What a drag reads: the leg's cost, what in it cost extra, the speed its total falls in, and the Half Speed area it would end in. */
export type DragRead = { dragFt: number; left?: SpeedLeft; extra?: { ft: number; words: string }; halfSpeed?: string };

const BAND_ORDER: readonly SpeedLeft["band"][] = ["walk", "dash", "over"];

/** A drag read with no walk has no map: a straight leg's spots then stand at the walk's own heights. */
const NO_BUILD: Pick<BuildState, "buildChunks"> = { buildChunks: {} };

/**
 * How a token drag reads against the creature's speed (features section 4,
 * docs/design-v1-movement.md 3.1 and 4.2): the cost of this leg, along its
 * route when it has one, with what cost extra, and the speed its total
 * falls in. During a fight only the active creature is read, and its total
 * is what its counted legs used so far (turnTrail) plus this leg's cost, so
 * the band counts every leg of the turn that counts, and the 5-10-5 rule's
 * diagonals run on from the path into the drag. Outside a fight any token
 * is read from where the drag began. `left` is absent when there is nothing
 * to read against: another creature during a fight, or no speed this
 * viewer knows (only the DM and owners get speeds, design 7.3).
 *
 * The band is judged at every spot of the leg (4.2): within the Speed the
 * creature has at each, halved inside a Half Speed area that affects it.
 * The cost only grows along the leg, so the worst spot is its end or the
 * last spot inside such an area.
 */
export function dragReading(input: {
  token: MovingToken;
  /** The drop point. */
  to: Point;
  encounter: TurnView | null | undefined;
  /** The token whose turn it is, when this viewer knows. */
  activeTokenId: string | null;
  speeds: Speeds | undefined;
  rules: DistanceRules;
  role: "dm" | "player";
  walk?: DragWalk;
  /** The leg's cost as another device's frame gives it, terrain included, which the corners alone cannot tell: the band and what is left read it. */
  costFt?: number;
  /** How a plain leg lands: its elevation and whether it squeezes there, which its cost reads as the move records it (route.ts `plainLegCost`). */
  landing?: { elevation: number; squeeze?: true };
  /**
   * The mount the drop leaves and half the rider's Speed, when the leg
   * walks the rider off its ride (docs/design-v1-attach.md 7.3): on its own
   * turn the leg then costs as the reducer stores it (rules/dismount.ts).
   */
  dismount?: { mount: PlacedToken; halfFt: number };
}): DragRead {
  const { token, encounter, rules, walk } = input;
  const end: RoutePoint = { x: input.to.x, y: input.to.y, elevation: input.landing?.elevation ?? token.elevation };
  const landed = input.landing ? { ...token, x: end.x, y: end.y, elevation: end.elevation, squeeze: input.landing.squeeze } : null;
  const fighting = encounter ? (encounter.started ?? encounter.activeEntryId !== null) : false;
  const active = fighting && input.activeTokenId === token.id;
  const trail = active ? turnTrail({ encounter, sceneId: token.sceneId, token, rules, role: input.role }) : null;
  const counter = trail ? trail.diagonals : { h: 0, v: 0 };
  const swimSpeed = (input.speeds?.swim ?? 0) > 0;
  const points: readonly RoutePoint[] = walk?.route?.points ?? [{ x: token.x, y: token.y, elevation: token.elevation }, end];
  const pieces = walk?.route?.pieces.map(([, , extra, swim]) => ({ extra, swim })) ?? [];
  const step = snapStep(token);
  const legCost = (upTo: readonly RoutePoint[]) =>
    walk?.route
      ? routeFeet(upTo, pieces.slice(0, upTo.length - 1), rules, counter, { swimSpeed, step })
      : landed && upTo[upTo.length - 1] === end
        ? plainLegCost(token, landed, rules, counter)
        : straightCost(token, upTo[0]!, upTo[upTo.length - 1]!, rules, counter);
  const leg = legCost(points);
  // Walked off its mount on its own turn, the leg costs what getting off costs and then the rest, as the reducer stores it.
  const off = active && input.dismount && input.costFt === undefined ? input.dismount : undefined;
  const taken = off ? dismountCost(walk?.build ?? NO_BUILD, token, off.mount, points, walk?.route?.pieces, rules, counter, off.halfFt, swimSpeed) : leg;
  const surcharge = taken.cost - leg.cost;
  const legFt = input.costFt ?? taken.cost;
  const out: DragRead = { dragFt: legFt };
  const words = walk?.route ? extraWords(walk.route.pieces, walk.prone, swimSpeed, walk.towing) : [];
  if (leg.cost > leg.moved && words.length > 0) out.extra = { ft: leg.cost - leg.moved, words: `+${formatFeet(leg.cost - leg.moved)} for ${joinWords(words)}` };
  if (fighting && !active) return out;
  const before = trail?.usedFt ?? 0;
  const endHalved = walk ? walk.halved(points[points.length - 1]!) : null;
  if (endHalved) out.halfSpeed = endHalved;
  const atEnd = speedsLeft(endHalved ? halvedSpeeds(input.speeds) : input.speeds, token.elevation, before + legFt)[0];
  if (!atEnd) return out;
  let band = atEnd.band;
  // The last spot inside a Half Speed area before the end, if the leg leaves one: its band may be worse than the end's.
  const inside = walk && !endHalved ? lastHalvedSpot(points, token, walk) : null;
  if (inside) {
    const prefix = [...points.slice(0, inside.piece + 1), inside.at];
    const there = speedsLeft(halvedSpeeds(input.speeds), token.elevation, before + legCost(prefix).cost + surcharge).find((s) => s.kind === atEnd.kind);
    if (there && BAND_ORDER.indexOf(there.band) > BAND_ORDER.indexOf(band)) band = there.band;
    // Past Dash in the area but not at the end: how far past is the area's to tell, against its halved Speed, where the end would read less than nothing.
    if (there && band === "over" && atEnd.band !== "over") {
      out.left = there;
      return out;
    }
  }
  const total = before + legFt;
  const leftFt = band === "walk" ? atEnd.speed - total : band === "dash" ? atEnd.speed * 2 - total : total - atEnd.speed * 2;
  out.left = { ...atEnd, band, leftFt };
  return out;
}

/** The walk another device's frame draws, for its band: straight pieces through its corners with nothing extra, as players read a leg from its geometry. Its cost comes with the frame (`costFt`). */
export function remoteWalk(token: MovingToken, to: Point, corners: readonly Point[]): DragWalk {
  const all = [...corners, to];
  return {
    route: { points: [{ x: token.x, y: token.y, elevation: token.elevation }, ...all.map((p) => ({ x: p.x, y: p.y, elevation: token.elevation }))], pieces: all.map((p): RoutePiece => [p.x, p.y, 0, 0]) },
    build: { buildChunks: {} },
    halved: () => null,
    prone: false,
  };
}

/** The last spot of the walk, short of its end, where the creature would stand in a Half Speed area, with the piece it is on. */
function lastHalvedSpot(points: readonly RoutePoint[], token: MovingToken, walk: DragWalk): { piece: number; at: RoutePoint } | null {
  const spots = routeWalk(points, token, walk.build);
  for (let i = spots.length - 2; i > 0; i--) {
    const s = spots[i]!;
    const at = { x: s.x, y: s.y, elevation: s.elevation };
    if (walk.halved(at)) return { piece: s.progress[0], at };
  }
  return null;
}

/**
 * What cost extra along a route, in the order the label names it: the
 * ground's difficult terrain, Plant Growth's overgrowth (4 ft per foot),
 * swimming without a Swim Speed, crawling, and a creature the walker drags
 * or carries (`towing`, docs/design-v1-attach.md 7.3). A piece's extra
 * holds the ground's 1 or 3, 1 for swimming or crawling, never both, and 1
 * more on every piece while it tows.
 */
export function extraWords(pieces: readonly RoutePiece[], prone: boolean, swimSpeed: boolean, towing?: "dragging" | "carrying"): string[] {
  const found = new Set<string>();
  const tow = towing ? 1 : 0;
  for (const [, , extra, swim] of pieces) {
    const moving = swim === 1 || prone ? 1 : 0;
    const ground = extra - moving - tow;
    if (ground === 1) found.add("difficult terrain");
    else if (ground >= 3) found.add("overgrowth");
    if (swim === 1 && !swimSpeed) found.add("swimming");
    else if (swim === 0 && prone && extra - tow >= 1) found.add("crawling");
    if (towing) found.add(towing);
  }
  return ["difficult terrain", "overgrowth", "swimming", "crawling", "dragging", "carrying"].filter((w) => found.has(w));
}

/** The label's lines (docs/design-v1-movement.md 3.1): the leg's cost with the band's words, what cost extra, and the Half Speed area it would end in. */
export function dragLabel(read: DragRead): string {
  const first = read.left ? `${formatFeet(read.dragFt)} · ${leftText(read.left)}` : formatFeet(read.dragFt);
  return [first, read.extra?.words, read.halfSpeed ? `Half Speed in ${read.halfSpeed}` : null].filter((l): l is string => !!l).join("\n");
}

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
