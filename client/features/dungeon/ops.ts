import type { BuildChunk } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import type { SceneInput } from "../scenes/create.ts";
import type { DungeonPlan } from "./plan.ts";

/*
 * A plan as the ops Make sends (docs/design/design-v1-dungeon-generator.md
 * 5.5). Contract stub: lane DG-B builds the bodies.
 */

export function buildOps(plan: DungeonPlan, scene: SceneInput): ClientOp[] {
  throw new Error("not built");
}

export function trapOps(plan: DungeonPlan, chunks: Readonly<Record<string, BuildChunk>>, band: LevelBand, sceneId: string): ClientOp[] {
  throw new Error("not built");
}

export function withIds(ops: ClientOp[], newId: () => string): { ops: ClientOp[]; sceneId: string } {
  throw new Error("not built");
}
