import { LIMITS } from "#shared/limits.ts";
import type { DungeonPlan, Planned } from "./plan.ts";
import { MAX_FIT_PLANS, MAX_HEX_WALLS, MIN_ROOMS } from "./settings.ts";

/*
 * The fit (phase 3, 2.5, D-261110-175): every wall on hexes is a free wall,
 * so the split's count and the scene's 4,000 free walls bound a hex
 * dungeon, and a plan over its budget asks the same seed for one room
 * fewer, again, until one fits. Wall counts are not monotonic in rooms, so
 * this finds a count that fits, often the most, and the first that fits
 * wins.
 */

/**
 * What one plan may add to its scene (phase 3, 2.5 and 3.4): free walls,
 * doors and windows, pillar cells, and the scene's room for traps, stamps,
 * lights and pins. A new hex scene's walls stop at MAX_HEX_WALLS. A wing's
 * stop at 90% of each cap less what the scene holds.
 */
export type Allowance = { walls: number; doors: number; pillars: number; traps: number; stamps: number; lights: number; pins: number };

/** A new scene's allowance: the hex wall budget, and the scene's caps whole for the rest. */
export const NEW_SCENE: Readonly<Allowance> = {
  walls: MAX_HEX_WALLS,
  doors: LIMITS.doorsAndWindowsPerScene,
  pillars: LIMITS.pillarsPerScene,
  traps: LIMITS.trapsPerScene,
  stamps: LIMITS.stampsPerScene,
  lights: LIMITS.lightsPerScene,
  pins: LIMITS.pinsPerScene,
};

/** Why a fit gave up: past MAX_FIT_PLANS plans, under two rooms, or with edits, which freeze the count. */
export type FitFailure = "tooMany" | "underTwo" | "edits";

/** A plan's door leaves or door edges, as the scene's door cap counts them. */
export function doorCount(plan: Pick<DungeonPlan, "doors" | "walls">): number {
  return plan.walls ? plan.walls.filter((w) => w.f !== "wall").length : plan.doors.length;
}

/** A plan's pillar cells, which count against the scene's pillar cap only on squares. */
export function pillarCount(plan: Pick<DungeonPlan, "paint">): number {
  return plan.paint.pillar?.length ?? 0;
}

/** Whether a plan's geometry keeps inside an allowance: its free walls, doors and pillars, the caps a smaller room count brings down. */
export function withinAllowance(plan: Pick<DungeonPlan, "doors" | "walls" | "paint">, allowance: Allowance): boolean {
  return (plan.walls?.length ?? 0) <= allowance.walls && doorCount(plan) <= allowance.doors && pillarCount(plan) <= allowance.pillars;
}

/**
 * The first plan that fits (2.5): `make` asked for `asked` rooms, then one
 * fewer at a time, at most MAX_FIT_PLANS plans, while at least MIN_ROOMS
 * are asked. The last plan made comes back with why it failed when none
 * fits.
 */
export function fitRooms(asked: number, make: (rooms: number) => Planned, fits: (planned: Planned) => boolean): { planned: Planned; failed: FitFailure | null } {
  let last: Planned | null = null;
  for (let tries = 0; tries < MAX_FIT_PLANS; tries++) {
    const rooms = asked - tries;
    if (rooms < MIN_ROOMS) return { planned: last ?? make(MIN_ROOMS), failed: "underTwo" };
    last = make(rooms);
    if (fits(last)) return { planned: last, failed: null };
  }
  return { planned: last!, failed: "tooMany" };
}
