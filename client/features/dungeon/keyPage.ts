import type { ClientOp } from "#shared/protocol.ts";
import type { DungeonPlan } from "./plan.ts";
import type { DungeonSettings } from "./settings.ts";

/*
 * The DM key (phase 2, 5.6 and section 6): a DM-only journal page in
 * "Dungeon keys" describing each room by number, and a DM-only numbered pin
 * in each room linked to it. Contract stub: lane DG2-B builds the bodies.
 */

/** What the key needs of the room and the dialog: the scene's name, the DM's color for the pins, and the feet per square its lengths read in. */
export type KeyInput = { name: string; color: string; feetPerCell: number };

/** The page's title: the name cut to fit " key" inside 80 UTF-16 units, never splitting a surrogate pair (D-261107-266). */
export function keyTitle(name: string): string {
  throw new Error(`not built: ${name}`);
}

/** The key's `journal.create` and one `pin.put` per room, or none with DM key off. */
export function keyOps(plan: DungeonPlan, settings: DungeonSettings, key: KeyInput, sceneId: string): ClientOp[] {
  throw new Error(`not built: ${plan.rooms.length} rooms, key ${settings.key}, ${key.name} on ${sceneId}`);
}
