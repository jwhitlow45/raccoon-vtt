import { keys } from "../keys.ts";
import type { Token } from "../model.ts";
import { inSightOfNonOwners } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { getOffFits, isCreature, kindRefusal, linkHolds, linkLimitRefusal, onHolder, withinReach, type LinkNames } from "../rules/attach.ts";
import { carriedAlong, judgedIn, placeCarried, sortedById, withPath } from "./tokens.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * Attaching and detaching tokens (docs/design-v1-attach.md 5 and 8.2), and
 * the link pass that ends every op's dispatch. A link lives on the carried
 * token, so attaching and detaching write that token alone, and its holder's
 * data never says what it carries.
 */

/** A token's name as the actor knows it: a hidden name reaches a player as the name players see. */
function nameFor(tx: Tx, token: Token): string {
  if (tx.actor.role === "dm" || !token.nameHidden) return token.name;
  return token.publicName ?? "Unknown creature";
}

function namesOf(tx: Tx, carried: Token, holder: Token): LinkNames {
  return { carried: nameFor(tx, carried), holder: nameFor(tx, holder) };
}

export const ONLY_A_RIDE_STEERS = "only a ride is controlled";
export const DRAG_STAYS = "a dragged creature stays where it stands";
export const PUT_DOWN_IN_PLACE = "Put down and Let go leave it where it stands";

/**
 * Attaches a token (8.2): the kind is checked against the two as they
 * stand and stored, never worked out again. What sits on its holder steps
 * onto its seat, a walk carrying what it carries in turn, and a drag leaves
 * the creature where it stands. The limits and loops are judged on the
 * whole graph for the DM and on what every player sees and the two named
 * tokens for a player (8.0), so a player's refusal never reads a hidden
 * link. An attach of a token already attached replaces its link.
 */
export function tokenAttach(tx: Tx, op: OpOf<"token.attach">): void {
  const carried = tx.token(op.tokenId);
  const holder = tx.token(op.to);
  const names = namesOf(tx, carried, holder);
  const settings = tx.state.meta.settings;
  if (carried.id === holder.id) throw invalid(`${names.carried} would carry itself`);
  if (carried.sceneId !== holder.sceneId) throw invalid(`${names.carried} and ${names.holder} are on different scenes`);
  if (op.steer && op.kind !== "ride") throw invalid(ONLY_A_RIDE_STEERS);
  const why = kindRefusal(op.kind, carried, holder, names);
  if (why) throw invalid(why);
  if (onHolder(op.kind)) {
    if (!linkHolds(settings, op.kind, { ...carried, x: op.x, y: op.y, elevation: op.elevation }, holder)) throw invalid(`${names.carried} does not sit on ${names.holder} there`);
  } else {
    if (op.x !== carried.x || op.y !== carried.y || op.elevation !== carried.elevation) throw invalid(DRAG_STAYS);
    if (!withinReach(settings, carried, holder)) throw invalid(`${names.carried} is too far to drag`);
  }
  const named = new Set([carried.id, holder.id]);
  const inGraph = tx.actor.role === "dm" ? () => true : (t: { id: string }) => named.has(t.id) || seenByAll(tx, t.id);
  const limit = linkLimitRefusal(tx.state.tokens, carried.id, holder.id, inGraph, names);
  if (limit) throw invalid(limit);

  const link: Token["attached"] = { to: holder.id, kind: op.kind, ...(op.steer ? { steer: true as const } : {}) };
  if (!onHolder(op.kind)) {
    tx.write(keys.token(carried.id), { ...carried, attached: link });
    return;
  }
  const along = carriedAlong(tx, op);
  const next: Token = { ...carried, x: op.x, y: op.y, elevation: op.elevation, attached: link };
  delete next.squeeze;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  tx.write(keys.token(carried.id), withPath(tx, carried, next, judged));
  placeCarried(tx, along, judged);
}

/**
 * Detaches a token (8.2): Get off, Put down or Let go. Only a creature
 * getting off a ride, a perch or a carry takes a place, which lies inside
 * the scene, within reach of its holder and clear of it, a walk carrying
 * what it carries. Whether the place is free of creatures is the device's
 * to judge, since the server's answer would tell where a hidden one stands.
 */
export function tokenDetach(tx: Tx, op: OpOf<"token.detach">): void {
  const carried = tx.token(op.tokenId);
  const link = carried.attached;
  if (!link) throw invalid(`${nameFor(tx, carried)} is not attached to anything`);
  const { attached: _link, ...loose } = carried;
  if (op.x === undefined || op.y === undefined) {
    tx.write(keys.token(carried.id), loose);
    return;
  }
  if (link.kind === "drag" || !isCreature(carried)) throw invalid(PUT_DOWN_IN_PLACE);
  const holder = tx.token(link.to);
  const scene = tx.scene(carried.sceneId);
  const spot = { x: op.x, y: op.y, elevation: op.elevation ?? carried.elevation };
  if (!getOffFits(tx.state.meta.settings, scene.bounds, carried, holder, spot)) throw invalid(`${nameFor(tx, carried)} can only get off beside ${nameFor(tx, holder)}`);
  const along = carriedAlong(tx, op);
  const next: Token = { ...loose, ...spot };
  delete next.squeeze;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  tx.write(keys.token(carried.id), withPath(tx, carried, next, judged));
  placeCarried(tx, along, judged);
}

function seenByAll(tx: Tx, tokenId: string): boolean {
  const token = tx.state.tokens[tokenId];
  return token !== undefined && inSightOfNonOwners(tx.state, token, tx.env);
}

/**
 * The link pass (5.2, "Links must hold"), the last part of every op's
 * dispatch: each link to or from a token the op wrote, in token id order,
 * that no longer holds is dropped, the token loose where it stands. The
 * holder is gone, the two are on different scenes, what sits on its holder
 * no longer fits it, or a dragged creature is out of reach. One rule
 * covers a deletion, Enlarge ending, a teleport and every move of a
 * carried token alone, so no token is ever carried from afar.
 */
export function linkPass(tx: Tx): void {
  const touched = new Set<string>();
  for (const key of tx.touched()) if (key.startsWith("token:")) touched.add(key.slice("token:".length));
  if (touched.size === 0) return;
  const candidates: Token[] = [];
  for (const token of Object.values(tx.state.tokens)) {
    const link = token.attached;
    if (link && (touched.has(token.id) || touched.has(link.to))) candidates.push(token);
  }
  const settings = tx.state.meta.settings;
  for (const token of sortedById(candidates)) {
    const link = token.attached!;
    const holder = tx.state.tokens[link.to];
    if (holder && holder.id !== token.id && linkHolds(settings, link.kind, token, holder)) continue;
    const { attached: _gone, ...loose } = token;
    tx.write(keys.token(token.id), loose);
  }
}
