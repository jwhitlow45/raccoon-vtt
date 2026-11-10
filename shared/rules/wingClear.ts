import type { AutoWalls, EdgeFeature, WallFeature } from "../model.ts";

/*
 * What a wing's asks carry for the server to check (docs/design: dungeon
 * generator phase 3, 3.6, D-261110-172, 232 and 234): the join as the DM
 * tapped it, and the margin the wing keeps from everything else. The
 * generator writes these shapes into its plan and the ask carries them.
 * `joinChanged` and `wingClash` land here with the landing lane.
 */

/**
 * The wall a wing joins as it stood when planned. On squares its grid
 * edges, each with its feature (null for an automatic wall) and the ground
 * of its inside cell. On hexes its one-side free walls by chunk, id, ends
 * and feature, and the ground of the hexes inside it.
 */
export type JoinExpect =
  | { grid: "squares"; edges: { key: string; feature: EdgeFeature | null; ground: number }[] }
  | { grid: "hex"; walls: { cx: number; cy: number; id: string; a: [number, number]; b: [number, number]; f: WallFeature }[]; ground: number };

/**
 * A wing ask's check: the margin in cells (3 on Wide), the join, the
 * scene's automatic-wall rule, and on hexes the wing's whole floor as row
 * runs, carried on the last part only. A run `[y, x0, x1]` is the scene
 * keys "x0,y" to "x1,y". `inside` names the hexes inside a hex join by
 * their keys, since a free wall's ends do not say which side is the room:
 * the server reads their ground there, and a hex join without them reads
 * as changed. Squares find the inside from the paint.
 */
export type WingClear = { margin: 2 | 3; join: JoinExpect; autoWalls: AutoWalls; floor?: [row: number, from: number, to: number][]; inside?: string[] };
