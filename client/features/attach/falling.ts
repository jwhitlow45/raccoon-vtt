import type { Effect, RoomState, Token } from "#shared/model.ts";
import { holderOf } from "#shared/rules/attach.ts";
import { displayName } from "../../lib/scene.ts";
import { askTarget, type AskFrom } from "../rolls/logic.ts";

/**
 * The falling off reminder (docs/design-v1-attach.md 4.5), as plain
 * functions for node --test: "While mounted, you must make the same save
 * if you're knocked Prone or the mount is." Unconscious brings Prone with
 * it, so it counts too. The app decides nothing: it reminds the DM and
 * offers the save, and no link ends by itself.
 */

/** The conditions that knock a rider or its mount down. */
const FALL_KEYS: ReadonlySet<Effect["key"]> = new Set(["prone", "unconscious"]);

type View = Pick<RoomState, "tokens" | "characters">;

/** A ride whose rider must save: the rider and the mount it rides. */
export type FallRisk = { riderId: string; mountId: string };

function downOn(view: View, token: Token): Set<Effect["key"]> {
  const actor = "inline" in token.actor ? token.actor.inline : view.characters[token.actor.ref]?.actor;
  return new Set((actor?.effects ?? []).map((e) => e.key).filter((k) => FALL_KEYS.has(k)));
}

/** Whether Prone or Unconscious landed on the token between the two copies: a key it had not had before. A token new in `after` has nothing to compare with. */
function landedOn(before: View, after: View, tokenId: string): boolean {
  const was = before.tokens[tokenId];
  const now = after.tokens[tokenId];
  if (!was || !now) return false;
  const had = downOn(before, was);
  for (const key of downOn(after, now)) if (!had.has(key)) return true;
  return false;
}

/**
 * The rides whose rider must save after a change: Prone or Unconscious
 * landed on the rider or on the mount it rides, in a ride both copies hold.
 * A perch, a carry and a drag never fall off (section 10: a familiar's
 * holder going Prone gives no reminder). A condition already there, or one
 * taken off, lands nothing, so each landing reminds once.
 */
export function fallRisks(before: View, after: View): FallRisk[] {
  const out: FallRisk[] = [];
  for (const rider of Object.values(after.tokens)) {
    if (rider?.attached?.kind !== "ride") continue;
    const mount = holderOf(after.tokens, rider);
    if (!mount || before.tokens[rider.id]?.attached?.to !== mount.id) continue;
    if (landedOn(before, after, rider.id) || landedOn(before, after, mount.id)) out.push({ riderId: rider.id, mountId: mount.id });
  }
  return out.sort((a, b) => (a.riderId < b.riderId ? -1 : a.riderId > b.riderId ? 1 : 0));
}

export function fallText(rider: Token, mount: Token): string {
  return `${displayName(rider)} may fall off ${displayName(mount)}: DC 10 Dexterity save.`;
}

/**
 * What "Ask for the save" opens (design 9.11): Request a roll for the
 * rider, a Dexterity save against DC 10. Null when no player plays the
 * rider, whose save the DM rolls at the table.
 */
export function fallAsk(view: Pick<RoomState, "members" | "characters" | "meta">, rider: Token): AskFrom | null {
  if (!askTarget(view, rider)) return null;
  return { kind: "selection", tokenIds: [rider.id], fill: { test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 10 } };
}

/** The store fields the reminder reads (state/types.ts RoomView). */
export type FallWatch = { you?: { role: "dm" | "player" } | null; snapshots?: number; confirmed?: unknown };

/**
 * The toasts one store change brings the DM (4.5). It reads what the
 * server holds (`confirmed`), never the view, so the DM's own Prone shows
 * once, when the server takes it, not again when its prediction settles,
 * and a change the server refused shows nothing. Each change is compared
 * with the one before it, so only a landing reminds. A snapshot, the first
 * or after a reconnect or a scene switch, is history and reminds of
 * nothing.
 */
export function fallReminders(now: FallWatch, prev: FallWatch): { text: string; ask: AskFrom | null }[] {
  if (now.you?.role !== "dm" || now.snapshots !== prev.snapshots) return [];
  const before = prev.confirmed as RoomState | null | undefined;
  const after = now.confirmed as RoomState | null | undefined;
  if (!before || !after || before === after) return [];
  return fallRisks(before, after).flatMap(({ riderId, mountId }) => {
    const rider = after.tokens[riderId];
    const mount = after.tokens[mountId];
    return rider && mount ? [{ text: fallText(rider, mount), ask: fallAsk(after, rider) }] : [];
  });
}
