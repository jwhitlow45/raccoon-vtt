import type { Point, UvttPortal } from "./schema.ts";

/**
 * Arkenforge draws each door as its outline: four portals one after another
 * in the file, each starting where the one before it ends, the leaf on the
 * wall line and three short sides off it, and it writes each portal's size
 * in `position`, where Dungeondraft and Dungeon Alchemist write its
 * midpoint. Taken as they stand, the four portals are four doors, three of
 * them slivers off the wall. Real Dungeondraft and Dungeon Alchemist files
 * also join real doors end to end, around a room's corner and in long runs
 * of windows, so the shape alone cannot tell an outline from doors. Only a
 * file in Arkenforge's form has its outlines collapsed, each to its longest
 * portal, which is the leaf, and an outline is a chain of exactly four that
 * turns. Chains follow the file's order, not every end that touches, so two
 * outlines that touch, at any angle, stay two doors. A chain of any other
 * length keeps every portal, as does an outline written out of order: two
 * outlines one after another where the second starts at the first's end
 * are a chain of eight, and might hold two leaves or one. Those are extra
 * doors the DM can erase, never a lost one.
 */

/** How many portals Arkenforge draws a door's outline with. */
const OUTLINE_PORTALS = 4;

/** Ends this close are one point, and a `position` this close to the midpoint is at it, in squares. */
const JOIN_SQUARES = 0.01;
/**
 * How far off the line of a chain's longest portal an end may lie while
 * the chain still runs straight, in squares. Dungeon Alchemist's rotation
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
 * whole file, not per chain or per portal: what `position` holds is the
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

/** Runs of consecutive portals, each starting where the one before it ends, as lists of indexes into `portals`. A portal in no run is a run of its own. */
function chains(portals: readonly UvttPortal[]): number[][] {
  const out: number[][] = [];
  portals.forEach((d, i) => {
    const run = out[out.length - 1];
    if (run && near(portals[i - 1]!.b, d.a, JOIN_SQUARES)) run.push(i);
    else out.push([i]);
  });
  return out;
}

/** Whether every end in the chain lies on the line of `leaf`, so the chain is a straight run such as a double door. */
function straight(chain: readonly UvttPortal[], leaf: UvttPortal): boolean {
  const len = length(leaf);
  if (len === 0) return true;
  const off = (q: Point) => Math.abs((leaf.b.x - leaf.a.x) * (q.y - leaf.a.y) - (leaf.b.y - leaf.a.y) * (q.x - leaf.a.x)) / len;
  return chain.every((d) => off(d.a) <= LINE_SQUARES && off(d.b) <= LINE_SQUARES);
}

/** The portals that are doors and windows, in the file's order: in Arkenforge's form, each outline's leaf in place of the outline. */
export function doorsOf(portals: readonly UvttPortal[]): UvttPortal[] {
  if (!arkenforgeForm(portals)) return [...portals];
  const dropped = new Set<number>();
  for (const indexes of chains(portals)) {
    if (indexes.length !== OUTLINE_PORTALS) continue;
    let leaf = indexes[0]!;
    for (const i of indexes) if (length(portals[i]!) > length(portals[leaf]!)) leaf = i;
    if (straight(indexes.map((i) => portals[i]!), portals[leaf]!)) continue;
    for (const i of indexes) if (i !== leaf) dropped.add(i);
  }
  return portals.filter((_, i) => !dropped.has(i));
}
