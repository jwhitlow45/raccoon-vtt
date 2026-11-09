import { createStore, type StoreApi } from "zustand/vanilla";
import type { FloorLink, RoomState, Token, Viewer } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { ownEntry } from "#shared/records.ts";
import { onHolder } from "#shared/rules/attach.ts";
import { LINK_WORDS, linkDir, linksOn, standsOn, type LinkEnd, type Stand } from "#shared/rules/floorLinks.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { OnAnswer, PendingOp } from "../../state/types.ts";
import { dragsToken } from "../attach/rights.ts";
import { climbOffReason, notOnStairs } from "./linkWords.ts";

/*
 * Go up and Go down (docs/design/design-v1-floors.md phase 2, 6): which
 * end a creature may climb on the viewer's own copy, and the one wait a
 * climb sent from this page holds, which the bar's button, the strip's
 * icon and the keys share. Plain functions, so node --test runs them.
 */

type Dir = "up" | "down";

/** The parts of a copy a climb's offer reads: the server's state, a DM's copy or a player's cut. */
export type ClimbView = Pick<RoomState, "scenes" | "tokens" | "characters" | "meta" | "encounter" | "buildChunks" | "floorLinks">;

/**
 * What the bar offers a creature standing on an end (6.1): the end, the way
 * it leads, its kind, the far floor's name where the viewer holds that
 * floor, and why it is off, or null where it may be taken now.
 */
export type ClimbOffer = { link: LinkEnd; dir: Dir; kind: FloorLink["kind"]; floor: string | null; off: Exclude<Stand, "on"> | "locked" | null };

/**
 * The offer for one creature on the viewer's copy, or null where Go up and
 * Go down show nothing: a creature the viewer may not move (rights.ts
 * dragsToken, the server's namedMoveCheck with no destination), one a
 * holder the viewer receives carries (that holder takes the stairs), or
 * one partly on the squares or in the air over them (standsOn). A holder
 * the viewer does not receive is not in their copy, so a creature riding
 * it climbs alone, as the server lets it (D-261109-018). An end whose way
 * the copy cannot tell is no offer.
 */
export function climbOffer(view: ClimbView, viewer: Viewer, token: Token): ClimbOffer | null {
  if (!dragsToken(view, viewer, token)) return null;
  if (carriedBy(view, token) !== null) return null;
  return endUnder(view, viewer, token);
}

/** The end a creature stands on, as standsOn reads it, preferring one it fits: a Large creature may overlap two small ends at once. */
function endUnder(view: ClimbView, viewer: Viewer, token: Token): ClimbOffer | null {
  let found: ClimbOffer | null = null;
  for (const link of linksOn(view, token.sceneId)) {
    const stand = standsOn(view as RoomState, viewer, token, link);
    const dir = stand === null ? null : linkDir(view, link);
    if (stand === null || dir === null) continue;
    const offer: ClimbOffer = { link, dir, kind: link.kind, floor: farFloor(view, link), off: link.locked === true ? "locked" : stand === "on" ? null : stand };
    if (stand === "on") return offer;
    found ??= offer;
  }
  return found;
}

/** The far floor's name, where the copy holds that floor: a player's end names `to` only then (4). */
function farFloor(view: Pick<RoomState, "scenes">, link: LinkEnd): string | null {
  if (link.to === undefined) return null;
  return ownEntry(view.scenes, link.to)?.floor?.name ?? null;
}

/** The holder that carries a creature in the viewer's copy (a ride, a perch or a carry), or null. A drag is no seat. */
function carriedBy(view: Pick<RoomState, "tokens">, token: Token): Token | null {
  const link = token.attached;
  if (!link || !onHolder(link.kind)) return null;
  return ownEntry(view.tokens, link.to) ?? null;
}

/**
 * What `}` or `{` does with one creature selected (6.2): climb that way
 * where the bar would offer it, else say why in the bar's or the server's
 * words. A creature on an end the other way says it is on none this way,
 * since "isn't on stairs" would not be true there (D-261109-138).
 */
export type ClimbKey = { climb: ClimbOffer } | { say: string };

export function climbKey(view: ClimbView, viewer: Viewer, token: Token, dir: Dir, name: string): ClimbKey {
  const holder = carriedBy(view, token);
  if (holder !== null) {
    // The holder's stairs, as the server's refusal names them for a hand-made climb (6.3).
    const under = endUnder(view, viewer, holder);
    return { say: under ? LINK_WORDS.carried(name, under.kind) : notOnStairs(name) };
  }
  const offer = dragsToken(view, viewer, token) ? endUnder(view, viewer, token) : null;
  if (offer === null) return { say: notOnStairs(name) };
  if (offer.dir !== dir) return { say: notOnStairsThatWay(name, dir) };
  if (offer.off !== null) return { say: climbOffReason(offer.off, offer.kind) };
  return { climb: offer };
}

/** "Thorn isn't on stairs or a ladder going up.": `}` on an end that leads down, or `{` on one that leads up. */
export function notOnStairsThatWay(name: string, dir: Dir): string {
  return `${name} isn't on stairs or a ladder going ${dir}.`;
}

// ------------------------------------------------------------ the one wait

/**
 * The climb this page sent that the server has not answered (6.4), one for
 * the Room: a player's climb waits for the server, since players get no
 * heights to price it (D-261109-102), and the DM's waits too, though it
 * shows at once, so two quick presses or keys never send two climbs. The
 * bar's button, the strip's icon and the keys share it.
 */
export type ClimbWait = { n: number | null; tokenId: string | null };

export const climbWaitSlot = scopeSlot<StoreApi<ClimbWait>>(() => createStore<ClimbWait>(() => ({ n: null, tokenId: null })));

/** Whether the wait's climb is still out: it is among the page's pending ops. */
export function climbWaiting(wait: ClimbWait, pending: readonly Pick<PendingOp, "n">[]): boolean {
  return wait.n !== null && pending.some((p) => p.n === wait.n);
}

/**
 * Sends a climb through the Room's one wait, or nothing while one is still
 * out. Returns whether it sent. A refusal is the room's toast in the
 * server's words (6.3), so the op is not quiet.
 */
export function sendClimb(
  input: { wait: StoreApi<ClimbWait>; pending: readonly Pick<PendingOp, "n">[]; dispatch(op: ClientOp, opts?: { onAnswer?: OnAnswer }): number | null },
  tokenId: string,
  linkId: string,
): boolean {
  if (climbWaiting(input.wait.getState(), input.pending)) return false;
  const n = input.dispatch(
    { t: "token.climb", tokenId, linkId },
    {
      // Only this climb's answer clears the wait: a press since has a wait of its own.
      onAnswer: () => input.wait.setState((s) => (s.n === n ? { n: null, tokenId: null } : s)),
    },
  );
  if (n === null) return false;
  input.wait.setState({ n, tokenId });
  return true;
}
