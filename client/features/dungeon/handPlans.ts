import type { TerrainId } from "#shared/model.ts";
import { builderScene, type SceneInput } from "../scenes/create.ts";
import type { DungeonPlan, PlanRoom } from "./plan.ts";
import { GENERATOR_VERSION } from "./settings.ts";

/*
 * Plans written by hand for the landing tests, so the ops, the scratch room
 * and the send are tested apart from the generator. Not a test file itself:
 * node --test runs only `*.test.ts`.
 */

function rect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

/**
 * Two rooms on a 30 by 30 map: the entrance A (3, 3, 5 by 5, stone) with a
 * stub west to the map's edge through a closed door, and B (15, 3, 6 by 6,
 * wood) raised 5 ft, reached from A's east door by a corridor that ends in
 * B's run: the far landing at (12, 5), a stair at (13, 5) facing east, up
 * the run toward the room, and the near landing at (14, 5) at 5 ft before
 * B's locked door. One rubble square in the corridor, a Hidden Pit in B and
 * a Poisoned Needle on B's locked door.
 */
export function twoRooms(): DungeonPlan {
  const a: PlanRoom = { x: 3, y: 3, w: 5, h: 5, ground: 0, floor: "stone", entrance: true };
  const b: PlanRoom = { x: 15, y: 3, w: 6, h: 6, ground: 5, floor: "wood" };
  const corridor = ["0,5", "1,5", "2,5", "8,5", "9,5", "11,5", "12,5", "13,5", "14,5"];
  const paint: Partial<Record<TerrainId, string[]>> = { stone: [...rect(3, 3, 5, 5), ...corridor], wood: rect(15, 3, 6, 6), rubble: ["10,5"] };
  return {
    version: GENERATOR_VERSION,
    w: 30,
    h: 30,
    asked: 2,
    rooms: [a, b],
    paint,
    doors: [
      { edge: "3,5,w", state: "closed" },
      { edge: "8,5,w", state: "closed" },
      { edge: "15,5,w", state: "locked" },
    ],
    heights: [{ ft: 5, cells: [...rect(15, 3, 6, 6), "14,5"] }],
    stairs: [
      { up: "e", cells: ["13,5"] },
      { up: "w", cells: ["0,5"] },
    ],
    traps: [
      { preset: "hidden-pit", zone: { cells: [{ x: 17, y: 4, w: 2, h: 2 }] } },
      { preset: "poisoned-needle", zone: { door: { edge: "15,5,w" } } },
    ],
    entrance: { x: 3, y: 3, w: 5, h: 5 },
  };
}

/**
 * The largest Wide topology's doors (section 8): 39 tree links and 10 loop
 * links, each with a two-square doorway at both ends, and the entrance's
 * own, 198 door edges in all, laid in rows of rooms 2 squares wide so each
 * doorway's two edges touch end to end.
 */
export function widestDoors(): DungeonPlan {
  const doors: DungeonPlan["doors"] = [];
  for (let i = 0; doors.length < 198; i++) {
    const x = 2 + (i % 24) * 4;
    const y = 2 + Math.floor(i / 24) * 6;
    doors.push({ edge: `${x},${y},n`, state: i % 7 === 0 ? "locked" : "closed" }, { edge: `${x + 1},${y},n`, state: i % 7 === 0 ? "locked" : "closed" });
  }
  const cells = new Set<string>();
  for (const d of doors) {
    const [x, y] = d.edge.split(",").map(Number) as [number, number];
    cells.add(`${x},${y}`).add(`${x},${y - 1}`);
  }
  return {
    version: GENERATOR_VERSION,
    w: 100,
    h: 100,
    asked: 40,
    rooms: [],
    paint: { stone: [...cells] },
    doors,
    heights: [],
    stairs: [],
    traps: [],
    entrance: { x: 0, y: 0, w: 2, h: 2 },
  };
}

/** The scene a dialog sends for a plan: a Builder scene of its size, under fog. */
export function dialogScene(plan: Pick<DungeonPlan, "w" | "h">, id = "chosen-id"): SceneInput {
  return builderScene({ id, name: "Crypt", w: plan.w, h: plan.h });
}
