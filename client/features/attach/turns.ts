import type { RoomState } from "#shared/model.ts";
import { holderOf } from "#shared/rules/attach.ts";
import { formatFeet } from "../measure/ruler.ts";
import type { TurnTrail } from "../measure/movement.ts";

/**
 * Whose movement a turn's pill and a drag's band read (docs/design-v1-attach.md
 * 7.2), as plain functions for node --test.
 */

/**
 * The token whose path and speeds the turn under way reads in this copy:
 * the active creature, or, while it rides a controlled mount that shares
 * its turn, that mount. A mount shares the turn while it is on the turn's
 * `mounts` and the chain of controlled rides from the turn's creature
 * reaches it, each holder on the list (shared/reducer/tokens.ts
 * sharesTurn). Up a chain, the lowest such mount walks, so it is the one.
 * A player's copy holds only the mounts they see, and no turn start when
 * they could not see where the turn began, so for them it stays the
 * active creature then.
 */
export function turnMoverId(view: Pick<RoomState, "tokens" | "encounter"> | null | undefined): string | undefined {
  const encounter = view?.encounter;
  if (!view || !encounter || encounter.activeEntryId === null) return undefined;
  const activeId = encounter.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId;
  if (activeId === undefined) return undefined;
  const start = encounter.turnStart;
  const mounts = start?.entryId === encounter.activeEntryId && start.tokenId === activeId ? (start.mounts ?? []) : [];
  let mover = activeId;
  const seen = new Set<string>();
  for (let rider = view.tokens[activeId]; rider && !seen.has(rider.id); ) {
    seen.add(rider.id);
    const link = rider.attached;
    const holder = link?.kind === "ride" && link.steer === true ? holderOf(view.tokens, rider) : undefined;
    if (!holder || !mounts.includes(holder.id)) break;
    mover = holder.id;
    rider = view.tokens[holder.id];
  }
  return mover;
}

/**
 * The pill's second line on a mount (7.2): the rider's own movement this
 * turn, when it is not 0, "Bree: 15 ft", with what it used where that
 * differs, as the pill's first line reads.
 */
export function riderLine(name: string, trail: Pick<TurnTrail, "movedFt" | "usedFt"> | null): string | null {
  if (!trail || (trail.movedFt === 0 && trail.usedFt === 0)) return null;
  const used = trail.usedFt !== trail.movedFt ? `, used ${formatFeet(trail.usedFt)}` : "";
  return `${name}: ${formatFeet(trail.movedFt)}${used}`;
}
