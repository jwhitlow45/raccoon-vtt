import type { PathStop, RoomState, Token, Viewer } from "#shared/model.ts";
import { holderOf, linkHolds, onHolder } from "#shared/rules/attach.ts";
import { footprintSize, isSqueezed, stopFootprint, tokenHeightFt, type PlacedToken } from "#shared/rules/footprint.ts";
import { byCreature, chunksNeeded, DRAG_WORK, opportunityNoticesOn, reachInput, reachScan, type Chunks, type ReachLeave, type ScanInput } from "#shared/rules/opportunity.ts";
import { placedOnTrace, routePoints, routeWalkers, type RoutePiece, type RoutePoint } from "#shared/rules/route.ts";
import { halvedAt, type PublicWorld } from "#shared/rules/walkWorld.ts";
import { displayName } from "../../lib/scene.ts";
import { areaTitle } from "../areas/labels.ts";
import { dragReading, pathNow, type DragRead, type Speeds } from "../measure/movement.ts";
import { turnMoverId } from "../attach/turns.ts";
import { answersFor } from "../combat/logic.ts";
import { seenIn, towingWord } from "../attach/walk.ts";
import { cutPieces, dropGrid, dropLanding, fallLabel, fallsAt, routeLanding, samePose, walkerOf, walkStart, type DropState, type DropView, type Point, type Pose, type Role, type WalkersCut } from "./drop.ts";
import type { RouteAnswer } from "./routeDrag.ts";
import type { DragRoute, TurnLeaves } from "./store.ts";
import type { Labels } from "../../lib/labels.ts";

/**
 * What a drag's frame tells others besides the token (6.5): the route's
 * corners and the leg's cost, and for a walk cut short the spot it lands
 * on, so their line ends where it will, not at the finger (review
 * ASTRA-11). The board's own token still follows the finger. A straight
 * walk sends an empty `path`, which tells the server it walked no other
 * way. A frame with no `path` at all may have walked any way, so it is
 * judged for each way its last leg may start (server/rooms/ephemeral.ts
 * previewWithheld).
 */
export function frameFields(route: Pick<DragRoute, "to" | "cut" | "corners" | "read">): { x?: number; y?: number; path: number[]; ft?: number } {
  return {
    ...(route.cut ? { x: route.to.x, y: route.to.y } : {}),
    path: route.corners.flatMap((c) => [c.x, c.y]),
    ft: route.read.dragFt,
  };
}

/**
 * How a group drag's dragged token lands, for its label: never squeezed,
 * as `token.moveMany` records it (review ASTRA-18), and at the height the
 * group's drop sends (drop.ts dropLanding): by its holder while it sits on
 * one every player sees, else on the ground there.
 */
export function groupLanding(state: DropState, token: Token, to: Point): { elevation: number } {
  return { elevation: dropLanding(state, token, { x: to.x, y: to.y }) };
}

/**
 * A group drag's reading of one of its named tokens dropped at `to`, for its
 * label and the cost its frames send (review AT-ASTRA-15): landed as the
 * group's drop lands it (`groupLanding`), walked as its walk is
 * (drop.ts walkerOf), and off a ride on its own turn at the half Speed the
 * reducer stores (`dismountOf`), as a lone drag reads it. Where it would
 * fall through an opening there, the label says so (`withFall`).
 */
export function groupReading(view: DropView, token: Token, to: Point, role: Role): DragRead {
  const landing = groupLanding(view, token, to);
  const dismount = dismountOf(view, token, { x: to.x, y: to.y, elevation: landing.elevation }, role);
  return withFall(view, token, to, landing.elevation, dragReading({
    token: walkStart(view, walkerOf(view, token, to)),
    grid: dropGrid(view, token),
    standing: token,
    to,
    landing,
    encounter: view.encounter,
    activeTokenId: turnMover(view, token, role),
    speeds: speedsOf(view, token),
    rules: { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal },
    role,
    ...(dismount ? { dismount, build: view } : {}),
  }));
}

/**
 * A drag's reading with "Falls to Ground floor" where the drop would land
 * wholly over an opening with nothing holding it up (drop.ts fallsAt,
 * docs/design/design-v1-floors.md phase 4, 12, D-261119-009), so the drop
 * never surprises the player. Read from this copy alone.
 */
function withFall(view: DropView, token: Token, to: Point & { squeeze?: boolean }, elevation: number, read: DragRead): DragRead {
  const fall = fallsAt(view, token, to, elevation);
  return fall ? { ...read, falls: fallLabel(fall) } : read;
}

/**
 * The token whose turn a drag's label reads as under way: the turn's mover
 * (attach/turns.ts turnMoverId), or, on a player's copy that holds no acting
 * row, the dragged token when its path this turn came with it, as its owners
 * get it on its own turn when the DM hid its row (measure/movement.ts
 * pathNow, review AT-HIDDENPATH). So the label counts on from the turn's
 * earlier legs, its diagonals too, as the move stores the leg.
 */
function turnMover(view: RoomState, token: Token, role: Role): string | null {
  const mover = turnMoverId(view);
  if (mover !== undefined) return mover;
  return role === "player" && view.encounter?.activeEntryId === null && pathNow(view.encounter, token, role) ? token.id : null;
}

export function speedsOf(view: RoomState, token: Token): Speeds | undefined {
  // Speeds are the actor's, which only the DM and the creature's owners receive.
  return "inline" in token.actor ? token.actor.inline.speeds : view.characters[token.actor.ref]?.actor.speeds;
}

/** The creature whose space the mover would end in at `at`, by the name this viewer sees (3.1): the rules say it can't willingly end its move there. */
export function endsIn(view: RoomState, world: PublicWorld, token: Token, at: RoutePoint, labels: Labels): string | null {
  const { w, h } = footprintSize(token);
  const lo = at.elevation;
  const hi = lo + tokenHeightFt(token, world.input.rules.feetPerCell);
  // A rider or a passenger set down on its own holder keeps its seat there (docs/design/design-v1-attach.md 4.2): sharing that space is riding, not ending a move in it.
  const link = token.attached;
  const holder = link && onHolder(link.kind) ? (holderOf(view.tokens, token) as Token | undefined) : undefined;
  const seat = holder && linkHolds(dropGrid(view, token), view.meta.settings, link!.kind, { ...token, x: at.x, y: at.y }, holder) ? holder.id : null;
  for (const s of world.spaces) {
    if (s.id === seat) continue;
    const overlaps = at.x < s.x1 - 1e-9 && at.x + w > s.x0 + 1e-9 && at.y < s.y1 - 1e-9 && at.y + h > s.y0 + 1e-9 && lo < s.hi && hi > s.lo;
    const other = view.tokens[s.id];
    if (overlaps && other) return displayName(other, labels);
  }
  return null;
}

/**
 * The mount a rider's drop at `at` walks it off, with half its Speed, as
 * the reducer charges it on the rider's own turn (shared/reducer/tokens.ts
 * walkedOwn, mountCost): its ride no longer holds there, and every player
 * sees the mount. The rider may be hidden, since only the DM and its owners
 * read its path. None without the speeds, which only they hold.
 */
export function dismountOf(view: RoomState, token: Token, at: RoutePoint, role: Role): { mount: PlacedToken; halfFt: number } | undefined {
  if (token.attached?.kind !== "ride") return undefined;
  const mount = holderOf(view.tokens, token) as Token | undefined;
  const walk = speedsOf(view, token)?.walk;
  if (!mount || walk === undefined || linkHolds(dropGrid(view, token), view.meta.settings, "ride", { ...token, ...at }, mount)) return undefined;
  if (!seenIn(view, role)(mount)) return undefined;
  return { mount, halfFt: Math.floor(walk / 2) };
}

/**
 * What a lone drag's line reads of the turn's Opportunity Attack notices
 * (docs/design/design-v1-opportunity-attacks.md 1, 4): this viewer, whether
 * the part shows on this device, and what the turn's leg jobs have told the
 * drag (store.ts turnLeavesSlot).
 */
export type DragReach = { viewer: Viewer; shown: boolean; turn: TurnLeaves };

/** A drag's reading of the enemies its walk leaves: the line, and every creature it names, for their rings. */
export type DragLeaves = { leaves: NonNullable<DragRead["leaves"]>; ids: readonly string[] };

const LATER: DragLeaves = { leaves: "over", ids: [] };
const NO_ONE: ReadonlySet<string> = new Set();

/** The last scan a drag ran, kept while nothing it read changed, since the drag reads it again for every quarter cell the finger crosses. */
let lastLeaves: { key: string; reads: readonly unknown[]; out: DragLeaves | null } | null = null;

/**
 * The enemies whose reach a lone drag's walk would leave, read as the drop
 * stores its leg so the line, the card and the toast agree
 * (DRAG-EQUALS-CARD): from where the creature stands to where it lands,
 * through the route's corners, the creature at the size it lands with and
 * its start at the size it has now (shared/reducer/tokens.ts fills a
 * reshape's earlier stops so). Only on the creature's own turn in a fight,
 * on a DM device or the turn's answerer's, with the room's notices and
 * this device's part on (D-261128-051). The scan stops at DRAG_WORK and the
 * line says the drop will check it, as it does while the turn's earlier
 * legs or the SRD data the scan reads are on their way, so the creatures
 * those legs left are always skipped.
 */
export function dragLeaves(input: { view: DropView; token: Token; landed: Token; corners: readonly Point[]; reach: DragReach; labels: Labels; role: Role; /** The work cap, DRAG_WORK but in tests. */ cap?: number }): DragLeaves | null {
  const { view, token, landed, reach, role } = input;
  const encounter = view.encounter;
  if (!reach.shown || !opportunityNoticesOn(view.meta.settings) || !encounter) return null;
  const fighting = encounter.started ?? encounter.activeEntryId !== null;
  if (!fighting || turnMover(view, token, role) !== token.id) return null;
  // The turn's own creature, whose answerer this is: a controlled mount walks for its rider (docs/design/design-v1-attach.md 7.2).
  const creature = encounter.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId ?? token.id;
  if (reach.viewer.role !== "dm" && !answersFor(view, reach.viewer, { tokenId: creature })) return null;
  const path = pathNow(encounter, token, role);
  const mover = reach.turn.movers[token.id];
  const earlier = path !== null && path.stops.length > 1;
  if (earlier && (!mover || mover.turn !== path.turn || !mover.settled)) return LATER;
  const skip = earlier && mover ? mover.skip : NO_ONE;
  const need = chunksNeeded(view, token.id);
  const { rolls, monsters } = reach.turn.chunks;
  if ((need.rolls && rolls === null) || (need.monsters && monsters === null)) return LATER;
  // A chunk the walk does not need is never read, so either word stands for it.
  const chunks: Chunks = { rolls: rolls ?? "failed", monsters: monsters ?? "failed" };
  const from: PathStop = { x: token.x, y: token.y, elevation: token.elevation, ...(isSqueezed(token) !== isSqueezed(landed) ? { footprint: stopFootprint(token) } : {}) };
  const to: PathStop = { x: landed.x, y: landed.y, elevation: landed.elevation, ...(input.corners.length > 0 ? { via: input.corners.flatMap((c) => [c.x, c.y]) } : {}) };
  const cap = input.cap ?? DRAG_WORK;
  const key = JSON.stringify([token.id, from, to, isSqueezed(landed), reach.viewer, role, cap]);
  const reads = [view.tokens, view.encounter, view.buildChunks, view.scenes, view.meta, view.characters, view.monsters, view.companionBlocks, rolls, monsters, skip, input.labels];
  if (lastLeaves && lastLeaves.key === key && lastLeaves.reads.every((r, i) => r === reads[i])) return lastLeaves.out;
  const out = scanDrag(view, token.id, path?.turn ?? 0, from, to, landed, chunks, skip, reach.viewer, input.labels, cap);
  lastLeaves = { key, reads, out };
  return out;
}

function scanDrag(view: DropView, moverId: string, turn: number, from: PathStop, to: PathStop, landed: Token, chunks: Chunks, skip: ReadonlySet<string>, viewer: Viewer, labels: Labels, cap: number): DragLeaves | null {
  const built = reachInput(view, moverId, { turn, stops: [from, to] }, chunks, viewer);
  const leg = built?.legs[built.legs.length - 1];
  if (!built || !leg || !leg.provokes) return null;
  const input: ScanInput = { ...built.input, mover: landed };
  const run = reachScan(input, leg, skip, cap);
  let step = run.next();
  while (!step.done) {
    if (step.value >= cap) return LATER;
    step = run.next();
  }
  if (step.value === "over") return LATER;
  const left: readonly ReachLeave[] = step.value;
  if (left.length === 0) return null;
  // A character shown by two tokens is named once.
  const names = byCreature(view, left).flatMap((l) => {
    const t = view.tokens[l.id];
    return t ? [displayName(t, labels)] : [];
  });
  // Only a player's device lacks blocks, so only its line says the 5 ft it counted (D-261128-055).
  const fiveFt = viewer.role === "player" && left.every((l) => input.reactors.find((r) => r.id === l.id)?.known === false);
  return { leaves: { names, fiveFt }, ids: left.map((l) => l.id) };
}

/**
 * The board's picture of a lone drag's walk (docs/design/design-v1-movement.md
 * 3.1): the line, its corners and the label, for where the drop would land
 * now. The walk is the one the drop lands with (`routeLanding`): a route
 * past 64 pieces is drawn and read to where it is cut, and its frames carry
 * no more corners than that, and one the drop would not take is drawn
 * straight. So reading it walks at most 300 squares. With no route, a walk
 * held at the wall (`held`) is drawn and read to the wall. A straight walk
 * reads what it walks over as the drop counts it (drop.ts planWalk): by
 * `straight`, its own route to where it lands, once that is checked. A
 * holder's walk held where a creature it drags would meet a wall
 * (`walkers`, docs/design/design-v1-attach.md 4.2) is drawn and read to there.
 */
export function walkPreview(input: {
  labels: Labels;
  view: DropView;
  token: Token;
  target: Point & { squeeze?: boolean };
  answer: RouteAnswer;
  held: Pose | null;
  walkers?: WalkersCut | null;
  world: PublicWorld | null;
  role: Role;
  straight?: { to: Pose; pieces: readonly RoutePiece[] } | null;
  /** What the line reads of Opportunity Attacks. Left out, it reads none. */
  reach?: DragReach | null;
}): Pick<DragRoute, "to" | "squeeze" | "cut" | "corners" | "read" | "endsIn"> & { leaving: readonly string[]; lands: number } {
  const { view, token, answer, world, role } = input;
  const fpc = view.meta.settings.feetPerCell;
  const walk = answer.kind === "route" ? routeLanding(view, token, input.target, answer.route.pieces, fpc) : null;
  let to: Point & { squeeze?: boolean } = walk ? walk.at : (input.held ?? input.target);
  const own = !walk && input.held && input.straight && samePose(input.straight.to, input.held) ? routeLanding(view, token, input.held, input.straight.pieces, fpc) : null;
  const along = walk ?? (own && !own.cut ? own : null);
  let pieces = along?.pieces;
  const walkers = input.walkers ?? null;
  if (walkers && along && pieces) {
    const kept = cutPieces(along.points, pieces, walkers);
    pieces = kept.length > 0 ? kept : undefined;
  }
  if (walkers) to = walkers.at;
  // Landed as the drop lands it, by its holder while it sits on one, so the band reads the leg the op sends.
  // And walked as the search and the server walk it (drop.ts walkerOf): on the ground, crossing only the inner ledges of a holder every player sees that stands on the ground.
  const walking = walkerOf(view, token, to);
  const start = walkStart(view, walking);
  const points = pieces
    ? walkers
      ? routePoints(view.buildChunks, walking, pieces, dropLanding(view, token, to))
      : along!.points
    : [
        { x: token.x, y: token.y, elevation: start.elevation },
        { x: to.x, y: to.y, elevation: dropLanding(view, token, to) },
      ];
  const encounter = view.encounter;
  // A controlled mount sharing its rider's turn reads its own path and speeds (docs/design/design-v1-attach.md 7.2).
  const activeTokenId = turnMover(view, token, role);
  const dismount = dismountOf(view, token, points[points.length - 1]!, role);
  const end = points[points.length - 1]!;
  const { squeeze: _squeeze, ...unsqueezed } = token;
  const landed: Token = { ...unsqueezed, x: to.x, y: to.y, elevation: end.elevation, ...(to.squeeze === true ? { squeeze: true as const } : {}) };
  const trace = routeWalkers(view.buildChunks, walking, pieces ?? [[to.x, to.y, 0, 0]], end.elevation);
  const read = dragReading({
    token: start,
    grid: dropGrid(view, token),
    standing: token,
    to,
    encounter,
    activeTokenId,
    speeds: speedsOf(view, token),
    rules: { feetPerCell: view.meta.settings.feetPerCell, diagonal: view.meta.settings.diagonal },
    role,
    // A plain leg reads its landing as the move records it: its height, and its squeeze (review ASTRA-18).
    ...(pieces ? {} : { landing: { elevation: points[points.length - 1]!.elevation, ...(to.squeeze === true ? { squeeze: true as const } : {}) } }),
    ...(dismount ? { dismount } : {}),
    ...(world
      ? {
          walk: {
            route: pieces ? { points, pieces } : null,
            build: view,
            trace,
            // Each spot with the footprint the walk's trace has there, squeezed where it lands as the drop lands it (route.ts onTrace).
            halved: (at: RoutePoint, piece: number, end: boolean) => {
              const area = halvedAt(world, placedOnTrace(trace, piece, end, landed, at));
              return area ? areaTitle(area) : null;
            },
            prone: world.input.prone,
            ...(world.input.drag === 1 ? { towing: towingWord(view, token.id, role) } : {}),
          },
        }
      : {}),
  });
  const corners = pieces ? points.slice(1, -1).map((p) => ({ x: p.x, y: p.y })) : [];
  const fallen = withFall(view, token, to, end.elevation, read);
  // A drop through an opening folds its leg into the floor it leaves, which no notice reads (section 2), so its line names no one.
  const leaves = input.reach && !fallen.falls ? dragLeaves({ view, token, landed, corners, reach: input.reach, labels: input.labels, role }) : null;
  return {
    to: { x: to.x, y: to.y },
    // For what reads the box it lands in mid-drag (state/localDrags.ts, SNAPBUILD-ASTRA-04).
    ...(to.squeeze === true ? { squeeze: true as const } : {}),
    cut: walk?.cut === true,
    corners,
    read: leaves ? { ...fallen, leaves: leaves.leaves } : fallen,
    endsIn: world ? endsIn(view, world, token, points[points.length - 1]!, input.labels) : null,
    leaving: leaves?.ids ?? [],
    // The height it lands at, which the DM's toast matches the drop's own line by (store.ts ShownLeaves).
    lands: end.elevation,
  };
}
