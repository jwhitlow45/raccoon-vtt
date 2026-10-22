import type { AttachKind, Effect, MemberId, RoomState, Token } from "#shared/model.ts";
import { carriedIndex, holderOf, isCreature, withinReach } from "#shared/rules/attach.ts";
import { ownsToken } from "../tokens/access.ts";
import { movesOthers } from "../../canvas/dragRights.ts";

/**
 * Who may attach, detach, drag and direct what (docs/design-v1-attach.md
 * 6), read from this member's own copy of the room, so the bar and the map
 * offer only what the server takes. The server's rule is in
 * shared/permissions.ts, and rights.test.ts compares the two, as
 * canvas/dragRights.test.ts does for a plain move.
 *
 * A player's copy holds only what they see: a missing `ownerIds` means not
 * theirs, a missing `visibility` means visible, and an effect hidden from
 * players is not there at all. The DM's copy holds everything, so every
 * player-facing rule that reads "as every player sees it" checks the
 * effect's own mark there too.
 */

export type AttachViewer = { role: "dm" | "player"; memberId: MemberId | null };

/** The parts of a copy these rules read. */
export type RightsView = Pick<RoomState, "tokens" | "characters" | "meta" | "encounter">;

/** The plain right to move a token (shared/permissions.ts moveCheck): the DM always, a player on an unlocked token they own or the room lets them move. */
export function movesToken(view: RightsView, viewer: AttachViewer, token: Token): boolean {
  if (viewer.role === "dm") return true;
  if (token.locked) return false;
  return ownsToken(view, viewer.memberId, token) || movesOthers(token, view.meta.settings, viewer.memberId);
}

/**
 * Whether a token stands where other players see it, as far as this copy
 * tells: not hidden by the DM. The server also asks whether it stands in
 * their sight (shared/permissions.ts seenByAll), which a player's copy of
 * their own token in the dark cannot answer, so there it offers what the
 * server then refuses with its reason.
 */
function shown(token: Token): boolean {
  return (token.visibility ?? "all") !== "dm";
}

/**
 * Whether the player directs this mount (6), lock or not: a shown token
 * that carries a shown creature of theirs by a controlled ride, which
 * "moves on your turn as you direct it". The DM marking the ride
 * controlled is what lets them.
 */
function directs(view: RightsView, viewer: AttachViewer, mount: Token): boolean {
  if (!shown(mount)) return false;
  for (const id of carriedIndex(view.tokens).get(mount.id) ?? []) {
    const rider = view.tokens[id];
    if (rider?.attached?.kind !== "ride" || rider.attached.steer !== true || !isCreature(rider)) continue;
    if (ownsToken(view, viewer.memberId, rider) && shown(rider)) return true;
  }
  return false;
}

/** Directing a controlled mount by a drag (6): one the player directs, and a lock stops it, as it stops every token's own drag. */
export function steers(view: RightsView, viewer: AttachViewer, mount: Token): boolean {
  if (viewer.role === "dm") return true;
  return !mount.locked && directs(view, viewer, mount);
}

/** Whether a player may move a token by a drag at all: by its own right, or as the mount they direct. */
export function dragsToken(view: RightsView, viewer: AttachViewer, token: Token): boolean {
  return movesToken(view, viewer, token) || steers(view, viewer, token);
}

/**
 * A new seat (6): an unlocked token carried by one this player may move or
 * directs may be moved by them, so long as the move keeps the link. Both
 * must be shown, as a refusal reads neither. Whether the move keeps the
 * link is the drop's to say, so this answers only whether the press may
 * start. A directed mount's lock stops its own drag, not a new seat on it.
 */
export function reseats(view: RightsView, viewer: AttachViewer, carried: Token): boolean {
  const holder = holderOf(view.tokens, carried) as Token | undefined;
  if (!holder) return false;
  if (viewer.role === "dm") return true;
  if (carried.locked || !shown(carried) || !shown(holder)) return false;
  return movesToken(view, viewer, holder) || directs(view, viewer, holder);
}

/** Whether the viewer sees the creature Grappled as every player does: an effect players are not kept from. */
export function grappledPublicly(view: RightsView, token: Token): boolean {
  return effectsOf(view, token).some((e) => e.key === "grappled" && e.hiddenFromPlayers !== true);
}

/** Whether the viewer sees the creature Grappled at all, which the DM's list reads to offer a carry. */
export function grappledSeen(view: RightsView, token: Token): boolean {
  return effectsOf(view, token).some((e) => e.key === "grappled");
}

function effectsOf(view: RightsView, token: Token): readonly Effect[] {
  const actor = "inline" in token.actor ? token.actor.inline : view.characters[token.actor.ref]?.actor;
  return actor?.effects ?? [];
}

/**
 * Whether a turn is under way in this copy and it is not the rider's (6):
 * "You can get on a mount on your own turn." The acting row is the rider's
 * by its token, or by its character on a row with no token. A player's
 * copy says a turn has begun by `started` even while a row they cannot see
 * acts, which reads as someone else's.
 */
export function notRidersTurn(view: RightsView, riderId: string): boolean {
  const encounter = view.encounter;
  if (!encounter) return false;
  const running = encounter.activeEntryId !== null || encounter.started === true;
  if (!running) return false;
  const active = encounter.entries.find((e) => e.id === encounter.activeEntryId);
  if (!active) return true;
  const rider = view.tokens[riderId];
  const ref = rider && "ref" in rider.actor ? rider.actor.ref : undefined;
  return !(active.tokenId === riderId || (active.tokenId === undefined && ref !== undefined && active.characterId === ref));
}

export const NOT_YOUR_TURN = "You can get on a mount on your own turn.";

/** Whether the link holds a creature as a grapple does (6): a drag, or a creature carried by a creature. */
export function grapples(kind: AttachKind, carried: Token, holder: Token): boolean {
  return kind === "drag" || (kind === "carry" && isCreature(carried) && isCreature(holder));
}

/**
 * Whether the viewer may join the two by this kind of link (6), leaving out
 * the seat's leg test, which needs the seat (attach/list.ts). The DM may
 * attach anything the fit, reach and limit rules allow, which the list
 * checks apart. A player needs the right to move what the kind moves:
 *
 * - Ride, Perch, or Carry of an object or onto one: both tokens, within
 *   reach, and a Ride in a fight only on the rider's own turn.
 * - Drag: the holder, within reach, and the creature too unless it is
 *   Grappled as players see it, which is the DM's consent.
 * - Carry of a creature by a creature: the holder, within reach, and the
 *   creature Grappled as players see it, whoever's it is.
 * - A rider gets off first: nothing else may hold it, only the same ride
 *   again, as Controlled toggles.
 */
export function attachAllowed(view: RightsView, viewer: AttachViewer, kind: AttachKind, carried: Token, holder: Token): boolean {
  if (viewer.role === "dm") return true;
  if (!withinReach(view.meta.settings, carried, holder)) return false;
  const mount = carried.attached?.kind === "ride" ? holderOf(view.tokens, carried) : undefined;
  if (mount && !(kind === "ride" && mount.id === holder.id)) return false;
  if (grapples(kind, carried, holder)) {
    if (!movesToken(view, viewer, holder)) return false;
    return kind === "carry" ? grappledPublicly(view, carried) : movesToken(view, viewer, carried) || grappledPublicly(view, carried);
  }
  if (!movesToken(view, viewer, carried) || !movesToken(view, viewer, holder)) return false;
  return kind !== "ride" || !notRidersTurn(view, carried.id);
}

/**
 * Whether the viewer may undo a link (6): Get off, Put down or Let go. The
 * DM always. A player whose copy holds the link, who may move the carried
 * token or its holder, or owns the carried token, so the carried
 * creature's player can always get off.
 */
export function detachAllowed(view: RightsView, viewer: AttachViewer, carried: Token): boolean {
  const holder = holderOf(view.tokens, carried) as Token | undefined;
  if (!holder) return false;
  if (viewer.role === "dm") return true;
  return movesToken(view, viewer, carried) || movesToken(view, viewer, holder) || ownsToken(view, viewer.memberId, carried);
}

/** Whether the selected token's bar offers Attach (4.1): to whoever may attach it to anything, the DM, or a player who may move it. */
export function offersAttach(view: RightsView, viewer: AttachViewer, token: Token): boolean {
  return viewer.role === "dm" || movesToken(view, viewer, token);
}
