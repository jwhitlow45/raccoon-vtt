import type { Point, UvttPortal } from "./schema.ts";

/**
 * Arkenforge draws each door as its outline: four portals joined end to
 * end, the leaf on the wall line and three short sides off it, and it
 * writes each portal's size in `position`, where Dungeondraft and Dungeon
 * Alchemist write its midpoint. Taken as they stand, the four portals are
 * four doors, three of them slivers off the wall. Real Dungeondraft and
 * Dungeon Alchemist files also join real doors end to end, around a room's
 * corner and in long runs of windows, so the shape alone cannot tell an
 * outline from doors. Only a file in Arkenforge's form has its turning
 * groups collapsed, each to its longest portal, which is the leaf.
 */

/** Ends this close are one point, and a `position` this close to the midpoint is at it, in squares. */
const JOIN_SQUARES = 0.01;
/**
 * How far off the line of a group's longest portal an end may lie while
 * the group still runs straight, in squares. Dungeon Alchemist's rotation
 * noise is thousandths of a square, and the nearest side of a door's
 * outline in Arkenforge's own sample map is 0.14 off its wall.
 */
const LINE_SQUARES = 0.05;

function near(a: Point, b: Point, within: number): boolean {
  return Math.abs(a.x - b.x) <= within && Math.abs(a.y - b.y) <= within;
}

function length(d: UvttPortal): number {
  return Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
}

/**
 * Whether the file writes `position` as Arkenforge does. Decided for the
 * whole file, not per group or per portal: what `position` holds is the
 * exporter's choice, and one exporter writes a whole file, so the file's
 * every portal is evidence. It takes every portal to have a `position` off
 * its midpoint. A file that leaves `position` out, or one portal anywhere
 * with it at its midpoint, keeps every portal. That errs toward keeping
 * doors: an outline kept is a few extra doors the DM sees and can erase,
 * while real doors collapsed would be missing with nothing to show it.
 */
function arkenforgeForm(portals: readonly UvttPortal[]): boolean {
  if (portals.length === 0) return false;
  return portals.every((d) => d.position !== null && !near(d.position, { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }, JOIN_SQUARES));
}

/** Portals joined end to end, as lists of indexes into `portals`. Pairwise: at the file's cap of 2,000 portals that takes about 10 ms, in the worker. */
function joinedGroups(portals: readonly UvttPortal[]): number[][] {
  const parent = portals.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (let i = 0; i < portals.length; i++) {
    const d = portals[i]!;
    for (let j = i + 1; j < portals.length; j++) {
      const e = portals[j]!;
      const joined = near(d.a, e.a, JOIN_SQUARES) || near(d.a, e.b, JOIN_SQUARES) || near(d.b, e.a, JOIN_SQUARES) || near(d.b, e.b, JOIN_SQUARES);
      if (joined) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, number[]>();
  portals.forEach((_, i) => {
    const r = root(i);
    const group = groups.get(r);
    if (group) group.push(i);
    else groups.set(r, [i]);
  });
  return [...groups.values()];
}

/** Whether every end in the group lies on the line of `leaf`, so the group is a straight run such as a double door. */
function straight(group: readonly UvttPortal[], leaf: UvttPortal): boolean {
  const len = length(leaf);
  if (len === 0) return true;
  const off = (q: Point) => Math.abs((leaf.b.x - leaf.a.x) * (q.y - leaf.a.y) - (leaf.b.y - leaf.a.y) * (q.x - leaf.a.x)) / len;
  return group.every((d) => off(d.a) <= LINE_SQUARES && off(d.b) <= LINE_SQUARES);
}

/** The portals that are doors and windows, in the file's order: in Arkenforge's form, each outline's leaf in place of the outline. */
export function doorsOf(portals: readonly UvttPortal[]): UvttPortal[] {
  if (!arkenforgeForm(portals)) return [...portals];
  const dropped = new Set<number>();
  for (const indexes of joinedGroups(portals)) {
    if (indexes.length < 2) continue;
    const group = indexes.map((i) => portals[i]!);
    let leaf = indexes[0]!;
    for (const i of indexes) if (length(portals[i]!) > length(portals[leaf]!)) leaf = i;
    if (straight(group, portals[leaf]!)) continue;
    for (const i of indexes) if (i !== leaf) dropped.add(i);
  }
  return portals.filter((_, i) => !dropped.has(i));
}
