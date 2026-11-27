import type { DungeonEdits, RoomFacts } from "./edits.ts";
import { MAX_MONSTERS, MAX_ROOM_MONSTERS } from "./settings.ts";

/*
 * Stocking a generated dungeon with monsters (docs/design/design-v1-dungeon-stock.md
 * 4, D-261127-280 to 285). Pure, so the worker, the dialog, the wing pane
 * and the tests share it.
 */

/**
 * Creatures one room may hold: an edit of On or Other monsters claims
 * `perRoom`, Off claims none, and an unedited room claims `perRoom` when
 * the share picked it. A claim reads the choices alone, never a draw, a
 * budget or the pool, so the dialog can check it on every render.
 */
export function roomClaim(room: Pick<RoomFacts, "room" | "share">, edits: DungeonEdits["rooms"] | null, perRoom: number): number {
  const e = edits?.[room.room];
  if (e?.monsters === false) return 0;
  if (e?.monsters === true || e?.monstersDraw !== undefined) return perRoom;
  return room.share ? perRoom : 0;
}

/** Every room's claim, added up: what Make would stock at most, which must stay within `stockCapacity`. */
export function stockClaims(rooms: readonly Pick<RoomFacts, "room" | "share">[], edits: DungeonEdits["rooms"] | null, perRoom: number): number {
  return rooms.reduce((sum, r) => sum + roomClaim(r, edits, perRoom), 0);
}

/** Creatures a dungeon or wing may stock: the scene group's tokens left less the planned Rolling Stones, at most MAX_MONSTERS. */
export function stockCapacity(tokensLeft: number, stones: number): number {
  return Math.max(0, Math.min(MAX_MONSTERS, tokensLeft - stones));
}

/**
 * Creatures one room's fight may hold: the capacity shared by every kept
 * room, the entrance among them, so every room can be On at once within
 * it, at least one and at most MAX_ROOM_MONSTERS (D-261127-285).
 */
export function perRoomCap(capacity: number, keptRooms: number): number {
  return Math.max(1, Math.min(MAX_ROOM_MONSTERS, Math.floor(capacity / Math.max(1, keptRooms))));
}
