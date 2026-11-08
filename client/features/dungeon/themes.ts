import type { TerrainId } from "#shared/model.ts";
import type { PlanLight } from "./plan.ts";
import type { Theme } from "./settings.ts";

/*
 * What each theme paints and places (phase 2, 5.1): its floors, its doors,
 * its overlays and its light. Every rule that reads a theme reads it here,
 * so a theme is one row rather than a branch in each step.
 */

export type ThemeSpec = {
  /** Every room's floor, or Dungeon's stone with wood in `wood` of its rooms. */
  floor: TerrainId;
  wood: readonly [number, number] | null;
  corridor: TerrainId;
  /** Doors on its doorways. Cave's are bare openings, so Reveal room floods the whole cave. */
  doors: boolean;
  lockedIn100: number;
  /** Rubble in this share of the tunnels, 1 to 3 squares in a row. */
  rubble: readonly [number, number] | null;
  /** Pits in this share of the rooms, of the sizes given: Dungeon's 1 or 2 squares, Mine's 1-square shafts. */
  pits: { chance: readonly [number, number]; most: 1 | 2 } | null;
  pillars: boolean;
  /** Eroded rooms, bulging tunnels and rock columns. */
  cave: boolean;
  /** Water channels in the corridors and cisterns in the rooms. */
  sewer: boolean;
  /** Whether a Fire-Casting Statue may stand in its rooms whose props hold the statue (D-261107-267). */
  statue: boolean;
  light: { stamp: string; preset: PlanLight["preset"]; label: string };
};

export const THEME_SPECS: Readonly<Record<Theme, ThemeSpec>> = {
  dungeon: {
    floor: "stone",
    wood: [1, 5],
    corridor: "stone",
    doors: true,
    lockedIn100: 15,
    rubble: [1, 3],
    pits: { chance: [1, 6], most: 2 },
    pillars: false,
    cave: false,
    sewer: false,
    statue: true,
    light: { stamp: "fire-pit", preset: "Torch", label: "Fire pit" },
  },
  crypt: {
    floor: "stone",
    wood: null,
    corridor: "stone",
    doors: true,
    lockedIn100: 25,
    rubble: null,
    pits: null,
    pillars: true,
    cave: false,
    sewer: false,
    statue: true,
    light: { stamp: "ph-candelabra", preset: "Candle", label: "Candelabra" },
  },
  cave: {
    floor: "cave",
    wood: null,
    corridor: "cave",
    doors: false,
    lockedIn100: 0,
    rubble: [1, 3],
    pits: null,
    pillars: false,
    cave: true,
    sewer: false,
    statue: false,
    light: { stamp: "campfire", preset: "Torch", label: "Campfire" },
  },
  mine: {
    floor: "dirt",
    wood: null,
    corridor: "dirt",
    doors: true,
    lockedIn100: 10,
    rubble: [1, 2],
    pits: { chance: [1, 6], most: 1 },
    pillars: false,
    cave: false,
    sewer: false,
    statue: false,
    light: { stamp: "ph-lantern", preset: "Hooded Lantern", label: "Lantern" },
  },
  sewer: {
    floor: "stone",
    wood: null,
    corridor: "stone",
    doors: true,
    lockedIn100: 20,
    rubble: null,
    pits: null,
    pillars: false,
    cave: false,
    sewer: true,
    statue: false,
    light: { stamp: "ph-lantern", preset: "Hooded Lantern", label: "Lantern" },
  },
};
