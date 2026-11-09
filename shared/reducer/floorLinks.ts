import { keys } from "../keys.ts";
import type { FloorLink, RoomState, Token } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { ownEntry } from "../records.ts";
import { climbCost, climbKeepsSqueeze, LINK_WORDS, linkProblem, rectGround, standsOn } from "../rules/floorLinks.ts";
import { onHolder } from "../rules/attach.ts";
import { sameScene } from "../rules/floors.ts";
import { sceneGrid, shapeOfGrid } from "../rules/grid.ts";
import { areasFollow, carriedAlong, judgedIn, placeCarried, withPath } from "./tokens.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/*
 * Stairs and ladders between floors (docs/design/design-v1-floors.md phase
 * 2, 3): placing, changing and removing a pair, a creature's climb, and the
 * pairs that go with their floors. Each op writes both ends, so the two
 * keep one rev, and floorProblem holds them whole after every op.
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

/** `floorLink.update`: both ends' kind or lock, each end's rev moving on together. */
export function floorLinkUpdate(tx: Tx, op: OpOf<"floorLink.update">): void {
  for (const link of byId(pairOf(tx, op.linkId))) {
    const next: FloorLink = { ...link };
    if (op.patch.kind !== undefined) next.kind = op.patch.kind;
    if (op.patch.locked === true) next.locked = true;
    else if (op.patch.locked === false) delete next.locked;
    tx.write(keys.floorLink(link.id), next);
  }
}

/** `floorLink.delete`: both ends. */
export function floorLinkDelete(tx: Tx, op: OpOf<"floorLink.delete">): void {
  for (const link of byId(pairOf(tx, op.linkId))) tx.remove(keys.floorLink(link.id));
}

/** A creature's name in the DM's words. */
function nameOf(token: Pick<Token, "name" | "number">): string {
  return token.number !== undefined ? `${token.name} ${token.number}` : token.name;
}

/**
 * Go up or Go down (`token.climb`, 3): the creature takes the end on its
 * floor to the same squares of the other floor, on the ground its far end
 * keeps, with what sits on it and their areas. A squeezed climber keeps its
 * squeeze only where its full space would leave the squares, and its
 * placement between squares goes. Its path folds the turn's legs and adds
 * the climb as a leg of its own (withPath). What it drags stays, and the
 * link pass lets it go, as at a teleport.
 *
 * Every refusal reads the end on its floor and the creature alone, never
 * the far floor, so it answers alike whatever the far floor holds (4). A
 * holder the requester receives takes the stairs instead. The DM receives
 * every holder, and a player's own is refused before here (permissions.ts
 * climbCheck), so one the player does not receive counts as absent: the
 * creature climbs alone and the link pass lets that link go. A creature
 * dragged stands on its own feet, so it climbs, and its drag lets go.
 */
export function tokenClimb(tx: Tx, op: OpOf<"token.climb">): void {
  const token = tx.token(op.tokenId);
  const link = ownEntry(tx.state.floorLinks, op.linkId);
  const far = link && ownEntry(tx.state.floorLinks, link.pair);
  if (!link || !far || link.sceneId !== token.sceneId) throw invalid(LINK_WORDS.noStairs);
  if (token.attached !== undefined && onHolder(token.attached.kind) && tx.actor.role === "dm") throw invalid(LINK_WORDS.carried(nameOf(token), link.kind));
  if (link.locked === true) throw invalid(LINK_WORDS.locked);
  const stand = standsOn(tx.state, tx.actor, token, link);
  if (stand === "squeeze") throw invalid(LINK_WORDS.tooBigSqueeze(link.kind));
  if (stand === "tooBig") throw invalid(LINK_WORDS.tooBig(link.kind));
  if (stand !== "on") throw invalid(LINK_WORDS.noStairs);
  tx.scene(link.to);
  // Planned before anything is written: what sits on it follows where it stood (docs/design/design-v1-attach.md 8.2).
  const along = carriedAlong(tx, op);
  const next: Token = { ...token, sceneId: link.to, elevation: far.ground };
  if (!climbKeepsSqueeze(tx.state, token, link)) delete next.squeeze;
  delete next.nudge;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  tx.write(keys.token(token.id), withPath(tx, token, next, judged, false, undefined, undefined, undefined, climbCost(tx.state, token, link)));
  placeCarried(tx, along, judged);
  areasFollow(tx, token.id, link.to);
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
