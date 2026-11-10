import type { PlanDoor } from "./plan.ts";
import type { Seed } from "./seed.ts";
import type { Dressing } from "./settings.ts";

/*
 * Per-room edits (phase 3, section 4, D-261110-096, 231, 237 and 238). An
 * edit pins one room's height, doors, trap, dressing or light. Edits never
 * leave the device: the plan they make lands as ordinary ops.
 */

/** A door pin's state. A Secret pin applies whatever Secret doors says, when its door may be secret (4.3). */
export type DoorPin = "closed" | "locked" | "secret";

/**
 * One room's pins, each optional. `ground` is the room's floor in feet,
 * `doors` its doorways' pins keyed by `doorKey`, `trap` a preset id or null
 * for none, `propsDraw` which of the room's own prop streams Other props
 * drew last, and `lit` its light.
 */
export type RoomEdit = { ground?: number; doors?: Record<string, DoorPin>; trap?: string | null; dressing?: Dressing; propsDraw?: number; lit?: boolean };

/**
 * Edits and the layout they were made on (4.2, D-261110-231): the room
 * count the winning plan asked for (`Planned.fitted`), the seed, the
 * choices as JSON and a hash of the wing base's geometry (null for a new
 * scene). With edits the planner asks for exactly `fitted` rooms, so a
 * board index keeps naming the same room. `rooms` is keyed by board index.
 */
export type DungeonEdits = { layout: { fitted: number; seed: Seed; settings: string; base: string | null }; rooms: Readonly<Record<number, RoomEdit>> };

/** A room's doorway as the room panel lists it: its key, side, the room or way it leads to, its door, and why it may not be secret (null when it may). */
export type DoorFacts = { key: string; side: "n" | "e" | "s" | "w"; to: number | "edge" | "join"; state: PlanDoor["state"] | "open"; secretOk: string | null };

/**
 * What the room panel shows for one room: its number as the key numbers
 * it, its board index, its floor, its doorways, the trap presets with a
 * spot in it and the one it holds, its dressing, whether it is lit, and the
 * reports its pins left on this plan.
 */
export type RoomFacts = { n: number; room: number; ground: number; doors: DoorFacts[]; traps: string[]; trap: string | null; dressing: Dressing; lit: boolean; reports: string[] };

/**
 * A doorway's key in a room's door pins: its link's index, or "stub" for
 * the entrance's way in. A link's index names the same doorway on every
 * plan of one frozen layout, through Winding's moves and the retries.
 */
export function doorKey(link: number): string {
  return link < 0 ? "stub" : String(link);
}
