import { cornerAt, hexCorners } from "#shared/rules/hex.ts";
import { FREE_WALL_ID_LENGTH } from "#shared/model.ts";
import { hexGridOf, type Lattice } from "./lattice.ts";
import type { PlanWall } from "./plan.ts";

/*
 * The hex wall pass (phase 3, 2.2, D-261110-086). A hex dungeon is wall
 * lines on the dark board: no floor is painted, so every side that bounds
 * a space carries one free wall or one door leaf of its own ends. Rooms,
 * runs and the corridors are spaces. A side is walled between a floor hex
 * and anything else, between two spaces, and toward the scene's outside,
 * except a doorway's sides, sides inside one run, a far landing's sides to
 * the corridors and to another far landing, and the way in's one border
 * side.
 */

/** A cell that is not floor. */
export const NO_SPACE = -2;
/** Every corridor hex, dead end and flattened run is one space. */
export const CORRIDOR_SPACE = -1;
/** A run's space is this plus its doorway's id, apart from every room's index. */
export const RUN_SPACE = 100_000;

/** A doorway as the pass reads it: its inside and outside hexes and its door, "open" on a theme without doors. */
export type WallDoorway = { inside: readonly number[]; outside: readonly number[]; state: "closed" | "locked" | "secret" | "open" };

export type HexWallInput = {
  lattice: Lattice;
  /** Each cell's space: a room's index, RUN_SPACE plus a doorway's id, CORRIDOR_SPACE, or NO_SPACE where it is not floor. */
  space: Int32Array;
  doorways: readonly WallDoorway[];
  /** Far landings, open to the corridor space. */
  far: ReadonlySet<number>;
  /** The way in: the edge hexes whose border side stays open, each with that side's direction. */
  wayIn: readonly { cell: number; dir: number }[];
  /** Ends already holding a wall, by `endsKey`, which the pass leaves alone (a wing against the room it joins). */
  skip?: ReadonlySet<string>;
};

/** The walls, sorted by their ends, and each doorway's leaves as indices into them, the middle leaf first on Wide. */
export type HexWalls = { walls: PlanWall[]; leaves: number[][] };

/** The side of lattice cell `k` toward hex direction `dir`, as its two corners on the 1/64 lattice in the scene, the lesser end first. */
export function hexSide(L: Lattice, k: number, dir: number): [[number, number], [number, number]] {
  if (L.kind === "squares") throw new Error("hexSide reads a hex lattice");
  const g = hexGridOf(L.kind);
  const x = k % L.W;
  const y = (k - x) / L.W;
  const hex = L.kind === "hexRows" ? { col: x, row: y } : { col: y, row: x };
  const corners = hexCorners(g, hex);
  const a = cornerAt(g, corners[(dir + 1) % 6]!);
  const b = cornerAt(g, corners[(dir + 2) % 6]!);
  const p: [number, number] = [a.x, a.y];
  const q: [number, number] = [b.x, b.y];
  return p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
}

/** A wall's ends as one key, the same whichever end comes first. */
export function endsKey(a: readonly [number, number], b: readonly [number, number]): string {
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
  return `${p[0]},${p[1]},${q[0]},${q[1]}`;
}

/** Orders walls by their ends, so a plan's walls and the ops cut from them are the same on every run. */
export function byEnds(p: PlanWall, q: PlanWall): number {
  return p.a[0] - q.a[0] || p.a[1] - q.a[1] || p.b[0] - q.b[0] || p.b[1] - q.b[1];
}

/** The direction from `k` to its neighbor `n`, or -1 when they are not neighbors. */
export function directionTo(L: Lattice, k: number, n: number): number {
  for (let d = 0; d < 6; d++) if (L.step(k, d, 1) === n) return d;
  return -1;
}

/**
 * A wall's id while the dungeon is only a preview, by its place in the
 * plan's walls: as long as a free wall id, so the scratch room takes it and
 * a Poisoned Needle can name its leaf. Make gives every wall a fresh one.
 */
export function wallPlaceholder(i: number): string {
  const tail = i.toString(36);
  return `dgw${"0".repeat(Math.max(0, FREE_WALL_ID_LENGTH - 3 - tail.length))}${tail}`;
}

/**
 * The walls of a hex plan (2.2). Each side is decided once, from the lower
 * of its two cells, or from its floor cell where the other is off the scene
 * or rock.
 */
export function hexWalls(input: HexWallInput): HexWalls {
  const { lattice: L, space } = input;
  const pair = (a: number, b: number) => (a < b ? a * L.W * L.H + b : b * L.W * L.H + a);
  const doorAt = new Map<number, { doorway: number; middle: boolean }>();
  input.doorways.forEach((d, j) => {
    d.inside.forEach((i, li) => {
      d.outside.forEach((o, lo) => {
        if (L.halo(i).includes(o)) doorAt.set(pair(i, o), { doorway: j, middle: d.inside.length > 1 && li !== lo });
      });
    });
  });
  const wayIn = new Set(input.wayIn.map((w) => w.cell * 6 + w.dir));
  const out: { wall: PlanWall; doorway: number; middle: boolean }[] = [];
  const add = (k: number, dir: number, f: PlanWall["f"], doorway = -1, middle = false) => {
    const [a, b] = hexSide(L, k, dir);
    if (input.skip?.has(endsKey(a, b))) return;
    out.push({ wall: { a, b, f }, doorway, middle });
  };
  for (let k = 0; k < space.length; k++) {
    const sk = space[k]!;
    if (sk === NO_SPACE) continue;
    for (let dir = 0; dir < 6; dir++) {
      const n = L.step(k, dir, 1);
      if (n === null) {
        if (!wayIn.has(k * 6 + dir)) add(k, dir, "wall");
        continue;
      }
      const sn = space[n]!;
      const door = doorAt.get(pair(k, n));
      // A wing's join opens onto the room it joins, which is not the wing's floor: its leaf stands on that side all the same.
      if (sn === NO_SPACE && door) {
        const state = input.doorways[door.doorway]!.state;
        if (state !== "open") add(k, dir, state, door.doorway, door.middle);
        continue;
      }
      if (sn === NO_SPACE) {
        add(k, dir, "wall");
        continue;
      }
      if (n < k || sn === sk) continue;
      if (door) {
        const state = input.doorways[door.doorway]!.state;
        if (state !== "open") add(k, dir, state, door.doorway, door.middle);
        continue;
      }
      // A far landing is where its run meets the corridors at 0 ft, so it opens to them and to another run's far landing that a corridor joins.
      if ((input.far.has(k) || sk === CORRIDOR_SPACE) && (input.far.has(n) || sn === CORRIDOR_SPACE)) continue;
      add(k, dir, "wall");
    }
  }
  const order = out.map((_, i) => i).sort((i, j) => byEnds(out[i]!.wall, out[j]!.wall));
  const walls = order.map((i) => out[i]!.wall);
  const leaves: number[][] = input.doorways.map(() => []);
  order.forEach((i, at) => {
    const w = out[i]!;
    if (w.doorway < 0) return;
    if (w.middle) leaves[w.doorway]!.unshift(at);
    else leaves[w.doorway]!.push(at);
  });
  return { walls, leaves };
}
