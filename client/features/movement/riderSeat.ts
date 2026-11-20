import { carriedGroup, onHolder, overlaps, seatedAt, seatSpot } from "#shared/rules/attach.ts";
import { footprintSize } from "#shared/rules/footprint.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { snapPosition } from "../../lib/scene.ts";
import type { Aim, DropToken, DropView, Landed, Point } from "./drop.ts";

/** Where a token sitting on the moved one was dropped, as `token.move` carries it (protocol.ts `seat`). */
export type DroppedSeat = NonNullable<Landed["seat"]>;

/**
 * The `seat` a lone drag pressed on a token sitting on its lead sends with
 * the lead's move (LP40-HEX-SEAT, shared/rules/moveLeg.ts DroppedSeat): that
 * token's box snapped where it was dropped (Aim `seat` and `seated`), where
 * the lead's walk ends full size at `at`, that place is a seat of the lead's
 * stand there, and the token's own place would not carry it there. The
 * server seats it there by the same rule, so the board, the walking ruler
 * and the move all land it under the finger, on the hex beside the rock
 * where only one full stand of a warhorse covers a corridor's mouth.
 *
 * None where something hangs from it by a drag, as its copy shows: what it
 * drags walks by its place beside it, so a seat moved across the mount
 * would take that creature onto the mount's hexes or across a wall the
 * drop never read. None where another token this copy sees on the lead
 * ends on that seat. Only a token sitting on the lead itself takes one.
 */
export function riderSeat(state: DropView, lead: DropToken, raw: Aim, at: Point & { squeeze: boolean }): DroppedSeat | null {
  if (!raw.seat || raw.seated === undefined || at.squeeze) return null;
  const rider = state.tokens[raw.seated];
  const link = rider?.attached;
  if (!rider || !link || link.to !== lead.id || !onHolder(link.kind) || rider.sceneId !== lead.sceneId) return null;
  const scene = state.scenes[lead.sceneId];
  if (!scene) return null;
  const g = sceneGrid(scene);
  const size = footprintSize(rider);
  const place = snapPosition(g, raw.seat.x - size.w / 2, raw.seat.y - size.h / 2, size);
  const { squeeze: _squeeze, ...full } = lead;
  const stand = { ...full, x: at.x, y: at.y };
  const spot = seatSpot(g, { ...rider, x: place.x, y: place.y, squeeze: undefined }, stand);
  if (!spot || Math.abs(spot.x - place.x) > 1e-9 || Math.abs(spot.y - place.y) > 1e-9) return null;
  const own = seatedAt(g, rider, lead, at, false);
  if (Math.abs(own.x - place.x) < 1e-9 && Math.abs(own.y - place.y) < 1e-9) return null;
  if (carriedGroup(state.tokens, rider.id).some((id) => id !== rider.id && state.tokens[id]?.attached?.kind === "drag")) return null;
  const sat = { ...rider, x: place.x, y: place.y, squeeze: undefined };
  for (const other of Object.values(state.tokens)) {
    if (!other || other.id === rider.id || other.attached?.to !== lead.id || !onHolder(other.attached.kind)) continue;
    if (overlaps(g, sat, { ...other, ...seatedAt(g, other, lead, at, false), squeeze: undefined })) return null;
  }
  return { tokenId: rider.id, x: place.x, y: place.y };
}
