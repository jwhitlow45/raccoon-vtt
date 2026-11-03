import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { RoomActions } from "../../state/types.ts";

/*
 * Make the scene (docs/design/design-v1-dungeon-generator.md 4.4 and 5.5):
 * every op in one task and one Setup group, and the outcome the import's
 * mirrors. Contract stub: lane DG-B builds the bodies.
 */

export type DungeonOutcome = { k: "complete"; checked: boolean } | { k: "none"; lost: boolean } | { k: "partial" } | { k: "unconfirmed" };

export async function sendDungeon(made: { ops: ClientOp[]; sceneId: string; room: RoomState }, actions: RoomActions, onAnswered: (n: number, of: number) => void): Promise<DungeonOutcome> {
  throw new Error("not built");
}
