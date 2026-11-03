import type { StairDirection, TerrainId, TrapZone } from "#shared/model.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings } from "./settings.ts";

/*
 * The dungeon a seed and the choices make (docs/design/design-v1-dungeon-generator.md
 * 5.3 and 5.4), as plain data the landing lane turns into ops. Pure: the
 * same seed and choices make the same plan on every device of one app
 * version.
 */

/** A kept room: its rectangle, its ground in feet, its floor terrain, and whether it is the entrance. */
export type PlanRoom = { x: number; y: number; w: number; h: number; ground: number; floor: TerrainId; entrance?: true };

export type DungeonPlan = {
  version: number;
  w: number;
  h: number;
  /** Rooms asked for. `rooms.length` is how many fit, read after the drops. */
  asked: number;
  rooms: PlanRoom[];
  /** Every painted cell by terrain, "x,y", each cell under one terrain. */
  paint: Partial<Record<TerrainId, string[]>>;
  /** Door edges ("x,y,n" or "x,y,w"), a Wide doorway's two the same. */
  doors: { edge: string; state: "closed" | "locked" }[];
  /** Ground by value, merged, 0 left out. */
  heights: { ft: number; cells: string[] }[];
  stairs: { up: StairDirection; cells: string[] }[];
  /** SRD preset ids and where each lies. */
  traps: { preset: string; zone: TrapZone }[];
  /** The entrance room's rectangle, which the creating device frames. */
  entrance: { x: number; y: number; w: number; h: number };
};

export function generate(settings: DungeonSettings, seed: Seed, budget?: number): DungeonPlan {
  throw new Error("not built");
}
