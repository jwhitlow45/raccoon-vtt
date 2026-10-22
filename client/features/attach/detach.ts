import type { RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { carriedGroup, getOffSpot, holderOf, isCreature, overlaps } from "#shared/rules/attach.ts";
import { verticalExtentFt } from "#shared/rules/footprint.ts";
import { legStop } from "#shared/rules/movement.ts";
import { displayName } from "../../lib/scene.ts";
import { landedElevation, walkersStop } from "../movement/drop.ts";
import { detachAllowed, offersAttach, type AttachViewer, type RightsView } from "./rights.ts";
import { walkersFor } from "./walk.ts";

/**
 * Getting off and letting go (docs/design-v1-attach.md 4.3), as plain
 * functions for node --test. A creature on anything gets off beside its
 * holder, an object is put down where it is, and a dragged creature is let
 * go where it stands.
 */

export type DetachChoice = "getOff" | "putDown" | "letGo";

/** What undoes this token's link in its own bar, or null when its copy holds no link. */
export function detachChoice(tokens: RoomState["tokens"], token: Token): DetachChoice | null {
  if (!token.attached || !holderOf(tokens, token)) return null;
  if (token.attached.kind === "drag") return "letGo";
  return isCreature(token) ? "getOff" : "putDown";
}

/**
 * What the bar's attach slots hold for this token (docs/design-v1-attach.md
 * 4.1 and 4.3): Get off, Put down or Let go on a carried token whose link
 * the viewer may undo, and Attach for whoever may attach it, beside the
 * first on a carried creature, so a rider can still take up a torch or
 * drag a grappled foe. A carried object attaches nothing.
 */
export function barSlots(view: RightsView, viewer: AttachViewer, token: Token): ("detach" | "attach")[] {
  const carried = detachChoice(view.tokens, token) !== null;
  const out: ("detach" | "attach")[] = [];
  if (carried && detachAllowed(view, viewer, token)) out.push("detach");
  if ((!carried || isCreature(token)) && offersAttach(view, viewer, token)) out.push("attach");
  return out;
}

/** The carried token's own button. */
export const DETACH_WORDS: Record<DetachChoice, string> = { getOff: "Get off", putDown: "Put down", letGo: "Let go" };

export const NO_ROOM_TO_GET_OFF = "No room to get off.";

/**
 * What a holder's group line offers beside a token it holds (4.3): Let go
 * of a creature it drags or carries, Put down of an object, and nothing for
 * a rider or a familiar, which gets off from its own bar.
 */
export function holderAction(token: Token): { words: string; choice: "letGo" | "putDown" } | null {
  const link = token.attached;
  if (!link) return null;
  const name = displayName(token);
  if (!isCreature(token)) return { words: `Put down ${name}`, choice: "putDown" };
  if (link.kind === "drag" || link.kind === "carry") return { words: `Let go of ${name}`, choice: "letGo" };
  return null;
}

/**
 * Where a creature gets off (4.3): the first spot beside its holder, in the
 * order new companions spread (getOffSpot), inside the scene, within reach
 * and clear of the holder, on no creature this viewer sees, and for a
 * player on a scene whose walls stop moves, with a clear leg from the seat
 * for it and for each creature it drags, which follows that leg (4.2).
 * The server checks the same place but for the creatures, whose check would
 * tell a player where a hidden one stands. It lands as any walk lands: on
 * the ground there, or at its height when it flies. Null when there is no
 * such spot.
 */
export function getOffPlace(view: RoomState, viewer: AttachViewer, carried: Token): { x: number; y: number; elevation: number } | null {
  const holder = holderOf(view.tokens, carried) as Token | undefined;
  const scene = view.scenes[carried.sceneId];
  if (!holder || !scene) return null;
  const fpc = view.meta.settings.feetPerCell;
  // What it carries gets off with it, so none of those stands in its way.
  const own = new Set(carriedGroup(view.tokens, carried.id));
  const creatures = Object.values(view.tokens).filter((t): t is Token => t !== undefined && t.sceneId === carried.sceneId && !own.has(t.id) && t.id !== holder.id && isCreature(t));
  const walls = viewer.role === "player" && scene.blockMovement === true;
  const walkers = walls ? walkersFor(view, carried.id, "player") : [];
  const seat = { x: carried.x, y: carried.y, elevation: carried.elevation };
  const spot = getOffSpot(view.meta.settings, scene.bounds, carried, holder, (at) => {
    const elevation = landedElevation(view.buildChunks, carried, at);
    const placed: Token = { ...carried, x: at.x, y: at.y, elevation };
    delete placed.squeeze;
    const { lo, hi } = verticalExtentFt(placed, fpc);
    for (const c of creatures) {
      const other = verticalExtentFt(c, fpc);
      if (overlaps(placed, c) && lo < other.hi && hi > other.lo) return false;
    }
    if (!walls) return true;
    const to = { x: at.x, y: at.y, elevation };
    return legStop(view, carried, to) === null && walkersStop(view, carried, [seat, to], walkers) === null;
  });
  return spot ? { x: spot.x, y: spot.y, elevation: landedElevation(view.buildChunks, carried, spot) } : null;
}

/** The op: Get off with its place, Put down and Let go where it stands. */
export function detachOp(tokenId: string, place: { x: number; y: number; elevation: number } | null): ClientOp {
  return place ? { t: "token.detach", tokenId, x: place.x, y: place.y, elevation: place.elevation } : { t: "token.detach", tokenId };
}
