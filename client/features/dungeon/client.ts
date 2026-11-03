import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { SceneInput } from "../scenes/create.ts";
import type { DungeonPlan } from "./plan.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings } from "./settings.ts";

/*
 * The page's side of the dungeon worker (docs/design/design-v1-dungeon-generator.md
 * 4.3 and 5.5). Contract stub: lane DG-B builds the bodies.
 */

export type Summary = { rooms: number; asked: number; doors: number; locked: number; traps: number };

export type Preview = { ok: true; plan: DungeonPlan; ops: ClientOp[]; room: RoomState; summary: Summary } | { ok: false; error: "fit" | "bug" };

export async function preview(settings: DungeonSettings, seed: Seed, scene: SceneInput): Promise<Preview> {
  throw new Error("not built");
}
