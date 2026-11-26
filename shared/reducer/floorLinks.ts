import { keys } from "../keys.ts";
import { fallsOnce } from "../migrate.ts";
import type { CellRect, FloorLink, RoomState, SceneId, Token } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { ownEntry } from "../records.ts";
import { publicLabel } from "../numbering.ts";
import { climbCost, climbKeepsSqueeze, fullLeavesFloor, landingOf, LINK_WORDS, linkProblem, rectGround, standsOn, throughOpening } from "../rules/floorLinks.ts";
import { onHolder } from "../rules/attach.ts";
import { sameScene } from "../rules/floors.ts";
import { sceneGrid, shapeOfGrid } from "../rules/grid.ts";
import { isSqueezed } from "../rules/footprint.ts";
import { footprintGround } from "../rules/heights.ts";
import { withDrop } from "../rules/moveLeg.ts";
import { areasFollow, carriedAlong, judgedIn, placeCarried, withPath } from "./tokens.ts";
import { gone, invalid, type Tx } from "./tx.ts";
import { recordLandings } from "./falls.ts";

/*
 * Stairs, ladders and openings between floors (docs/design/design-v1-floors.md
 * phase 2, 3, phase 4): placing, changing and removing a pair, a creature's
 * climb or flight, the one landing of a climb, a flight and a fall, a
 * trapdoor's drop, and the pairs that go with their floors. Each op writes
 * both ends, so the two keep one rev, and floorProblem holds them whole
 * after every op.
 */

/** The ends sorted by id, so every pass writes in one order on every device and replay. */
function byId(links: Iterable<FloorLink>): FloorLink[] {
  return [...links].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `floorLink.put`: both ends on the same squares, each with the ground it
 * stands on there, fixed while the pair exists (D-261109-106), the op's
 * seq as `made` (ASTRA-14), and the scene's grid shape. Refused in the
 * builder's words while linkProblem finds a rule it breaks (7.3).
 */
export function floorLinkPut(tx: Tx, op: OpOf<"floorLink.put">): void {
  const draft = op.link;
  if (ownEntry(tx.state.floorLinks, draft.id) || ownEntry(tx.state.floorLinks, draft.pairId)) throw invalid("those stairs are already on the map");
  const here = tx.scene(draft.sceneId);
  tx.scene(draft.to);
  const why = linkProblem(tx.state, draft);
  if (why) throw invalid(why);
  const shape = shapeOfGrid(sceneGrid(here));
  const made = tx.env.seq;
  const end = (id: string, sceneId: string, to: string, pair: string): FloorLink => ({
    id,
    rev: 0,
    sceneId,
    to,
    pair,
    rect: { ...draft.rect },
    kind: draft.kind,
    ...(shape ? { grid: shape } : {}),
    // linkProblem found one height there.
    ground: rectGround(tx.state.buildChunks, sceneId, draft.rect)!,
    made,
  });
  tx.write(keys.floorLink(draft.id), end(draft.id, draft.sceneId, draft.to, draft.pairId));
  tx.write(keys.floorLink(draft.pairId), end(draft.pairId, draft.to, draft.sceneId, draft.id));
}

/** The end an op names and its pair, or the refusal of stairs that are not there. */
function pairOf(tx: Tx, linkId: string): [FloorLink, FloorLink] {
  const link = ownEntry(tx.state.floorLinks, linkId);
  const pair = link && ownEntry(tx.state.floorLinks, link.pair);
  if (!link || !pair) throw gone("those stairs");
  return [link, pair];
}

/**
 * `floorLink.update`: both ends' kind, lock or hiding (phase 4, 8.1), or
 * their squares (8.2), each end's rev moving on together. An opening keeps
 * its kind, is never locked or hidden, and keeps one rect on both floors,
 * so `rect` alone moves both its ends. Stairs and ladders on squares may
 * lie on other squares of each floor at one size, and on hexes both ends
 * keep the same hexes. New squares are judged as a new pair's are
 * (linkProblem), each floor's own, and each end takes the ground there.
 */
export function floorLinkUpdate(tx: Tx, op: OpOf<"floorLink.update">): void {
  const [named, pair] = pairOf(tx, op.linkId);
  const { kind, locked, hidden, rect, pairRect } = op.patch;
  if (kind !== undefined && kind !== named.kind && (kind === "opening" || named.kind === "opening")) throw invalid(LINK_WORDS.kindChange(named.kind, kind));
  const nextKind = kind ?? named.kind;
  if (nextKind === "opening" && locked === true) throw invalid(LINK_WORDS.openingLocked);
  if (nextKind === "opening" && hidden === true) throw invalid(LINK_WORDS.openingHidden);
  const rects = rect !== undefined || pairRect !== undefined ? movedRects(tx, named, pair, nextKind, rect, pairRect) : null;
  for (const link of byId([named, pair])) {
    const next: FloorLink = { ...link };
    if (kind !== undefined) next.kind = kind;
    if (locked === true) next.locked = true;
    else if (locked === false) delete next.locked;
    if (hidden === true) next.hidden = true;
    else if (hidden === false) delete next.hidden;
    if (rects) {
      next.rect = { ...rects.get(link.id)! };
      // linkProblem found one height there.
      next.ground = rectGround(tx.state.buildChunks, link.sceneId, next.rect)!;
    }
    tx.write(keys.floorLink(link.id), next);
  }
}

/**
 * Each end's squares after an update that sets them (phase 4, 8.2), by end
 * id, or the refusal in the builder's words: an opening's two ends and
 * both ends on hexes on one rect, stairs and ladders on squares at one
 * size, then linkProblem on the room without this pair, so it meets
 * neither itself nor its own count.
 */
function movedRects(tx: Tx, named: FloorLink, pair: FloorLink, kind: FloorLink["kind"], rect: CellRect | undefined, pairRect: CellRect | undefined): Map<string, CellRect> {
  const here = rect ?? named.rect;
  const there = pairRect ?? (kind === "opening" ? here : pair.rect);
  const same = here.x === there.x && here.y === there.y && here.w === there.w && here.h === there.h;
  if (kind === "opening" || named.grid !== undefined) {
    if (!same) throw invalid(LINK_WORDS.sameSquares(kind));
  } else if (here.w !== there.w || here.h !== there.h) {
    throw invalid(LINK_WORDS.oneSize(kind));
  }
  const { [named.id]: _named, [pair.id]: _pair, ...others } = tx.state.floorLinks ?? {};
  const why = linkProblem({ ...tx.state, floorLinks: others }, { id: named.id, pairId: pair.id, sceneId: named.sceneId, to: named.to, rect: here, kind, ...(same ? {} : { pairRect: there }) });
  if (why) throw invalid(why);
  return new Map([
    [named.id, here],
    [pair.id, there],
  ]);
}

/** `floorLink.delete`: both ends. */
export function floorLinkDelete(tx: Tx, op: OpOf<"floorLink.delete">): void {
  for (const link of byId(pairOf(tx, op.linkId))) tx.remove(keys.floorLink(link.id));
}

/** A creature in a refusal, as players read it, with the table's number: a refusal is stored with its receipt (shared/numbering.ts). */
function nameOf(tx: Tx, token: Token): string {
  return publicLabel(tx.state, token);
}

/**
 * Go up or Go down (`token.climb`, 3): the creature takes the end on its
 * floor to the same squares of the other floor, on the ground its far end
 * keeps, with what sits on it and their areas. A squeezed climber keeps its
 * squeeze only where its full space would leave the end's squares or, from
 * op version 67 on squares, the floor it lands on (climbKeepsSqueeze), and
 * its placement between squares goes. Its path folds the turn's legs and adds
 * the climb as a leg of its own (withPath). What it drags stays, and the
 * link pass lets it go, as at a teleport. Fly up and Fly down take an
 * opening the same way, for a creature in the air under or over it
 * (phase 4, 5), and land 5 ft over the far end's ground (landThrough).
 *
 * Every refusal reads the end on its floor and the creature alone, never
 * the far floor, so it answers alike whatever the far floor holds (4). A
 * holder the requester receives takes the stairs instead. The DM receives
 * every holder, and a player's own is refused before here (permissions.ts
 * climbCheck), so one the player does not receive counts as absent: the
 * creature climbs alone and the link pass lets that link go. A creature
 * dragged stands on its own feet, so it climbs, and its drag lets go.
 * Hidden stairs are no stairs to a player (phase 4, 8.1).
 */
export function tokenClimb(tx: Tx, op: OpOf<"token.climb">): void {
  const token = tx.token(op.tokenId);
  const link = ownEntry(tx.state.floorLinks, op.linkId);
  const far = link && ownEntry(tx.state.floorLinks, link.pair);
  if (!link || !far || link.sceneId !== token.sceneId || (link.hidden === true && tx.actor.role !== "dm")) throw invalid(LINK_WORDS.noStairs);
  if (token.attached !== undefined && onHolder(token.attached.kind) && tx.actor.role === "dm") throw invalid(LINK_WORDS.carried(nameOf(tx, token), link.kind));
  if (link.locked === true) throw invalid(LINK_WORDS.locked);
  const opening = link.kind === "opening";
  const stand = opening ? throughOpening(tx.state, tx.actor, token, link) : standsOn(tx.state, tx.actor, token, link);
  if (stand === "squeeze") throw invalid(LINK_WORDS.tooBigSqueeze(link.kind));
  if (stand === "tooBig") throw invalid(LINK_WORDS.tooBig(link.kind));
  if (stand !== "on") throw invalid(opening && standsOn(tx.state, tx.actor, token, link) !== null ? LINK_WORDS.onlyInAir : LINK_WORDS.noStairs);
  landThrough(tx, token, link, opening ? "flight" : "climb");
}

/**
 * The one landing of a climb, a flight and a fall through an opening
 * (docs/design/design-v1-floors.md phase 4, 4.2): tokenClimb's body, on the
 * far end's ground, 5 ft above it for a flight, shifted by landingShift
 * where the far end lies on other squares (rules/floorLinks.ts landingOf,
 * which the move's plan reads too). What sits on it rides along, planned
 * before anything is written (docs/design/design-v1-attach.md 8.2), and its
 * areas follow. A climb's and a flight's path adds the leg as a leg of its
 * own, and a fall's folds the turn's legs and adds nothing. Each creature
 * that lands joins the op's landings (reducer/falls.ts), which the
 * arrival step, the opened marks and the landing reminders read.
 */
export function landThrough(tx: Tx, token: Token, link: FloorLink, how: "climb" | "flight" | "fall"): void {
  const far = ownEntry(tx.state.floorLinks, link.pair);
  if (!far) throw invalid(LINK_WORDS.noStairs);
  tx.scene(link.to);
  const along = carriedAlong(tx, { t: "token.climb", tokenId: token.id, linkId: link.id });
  const next: Token = { ...token, sceneId: link.to, ...landingOf(tx.state, token, link, far) };
  if (!climbKeepsSqueeze(tx.state, token, link, next, tx.env.opVersion)) delete next.squeeze;
  delete next.nudge;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  const fall = how === "fall";
  tx.write(keys.token(token.id), withPath(tx, token, next, judged, false, undefined, undefined, undefined, fall ? undefined : climbCost(tx.state, token, link), fall ? true : undefined));
  placeCarried(tx, along, judged);
  areasFollow(tx, token.id, link.to);
  recordLandings(tx, [token.id, ...along.map((c) => c.token.id)], link.to, how);
}

/**
 * A trapdoor's drop of one creature (phase 4, 4.6): onto the same squares
 * of the floor below, on the ground under its space there, since a change
 * of floor leaves a squeeze behind (as Move to floor lands it), with what
 * sits on it riding down and their areas following. From op version 67
 * (migrate.ts fallsOnce) a squeezed creature whose full space would leave
 * the floor below keeps its squeeze, as a fall through an opening lands it
 * (rules/floorLinks.ts climbKeepsSqueeze, LP53-FALL-1). What it drags
 * stays, for the link pass. Its path folds the turn's legs and adds
 * nothing, as a fall's.
 */
export function dropThrough(tx: Tx, token: Token, below: SceneId): void {
  const floor = tx.scene(below);
  const { squeeze: _squeeze, nudge: _nudge, ...full } = token;
  const keeps = isSqueezed(token) && fallsOnce(tx.env.opVersion) && fullLeavesFloor(floor, full);
  const landed: Token = keeps ? { ...full, squeeze: true } : full;
  const elevation = footprintGround(tx.state.buildChunks, { ...landed, sceneId: below });
  const along = carriedAlong(tx, withDrop({ t: "token.climb", tokenId: token.id, linkId: token.id }, { sceneId: below, x: token.x, y: token.y, elevation }));
  const next: Token = { ...landed, sceneId: below, elevation };
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  tx.write(keys.token(token.id), withPath(tx, token, next, judged, false, undefined, undefined, undefined, undefined, true));
  placeCarried(tx, along, judged);
  areasFollow(tx, token.id, below);
  recordLandings(tx, [token.id, ...along.map((c) => c.token.id)], below, "drop");
}

/**
 * After every op's dispatch, beside dropFloorAsks, from the stairs'
 * version (3): every end whose floor or far floor is gone, or no longer a
 * floor of one scene with the other, goes as an ordinary write in the op's
 * undo step. So Remove floor and Delete take stairs to a removed floor with
 * them, and their undo brings them back. Only an op that wrote a scene can
 * change that.
 */
export function dropFloorLinks(tx: Tx, _before: RoomState): void {
  const all = tx.state.floorLinks;
  if (all === undefined || Object.keys(all).length === 0) return;
  if (!tx.touched().some((key) => key.startsWith("scene:"))) return;
  for (const link of byId(Object.values(all))) {
    const here = ownEntry(tx.state.scenes, link.sceneId);
    const there = ownEntry(tx.state.scenes, link.to);
    if (here?.floor === undefined || there?.floor === undefined || !sameScene(tx.state, here.id, there.id)) tx.remove(keys.floorLink(link.id));
  }
}
