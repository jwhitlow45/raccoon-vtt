/**
 * How a menu's tiles break into rows (components/Menu.tsx), from each
 * tile's own width, the gap between them and the room the box gives
 * them, all in one unit as measured. Every tile stands in one row where
 * they fit. Where they do not, the tiles flow left to right under a
 * width cap, and the cap is chosen for the fewest rows, then for a last
 * row that does not hold one tile alone under a full one (Line up grid
 * under the other four setup tools, on a 390 px phone), then for the
 * narrowest rows, which shares the tiles out most evenly. `width` is
 * that cap, the widest row it lets through, or null for one row.
 */
export function tileRows(widths: readonly number[], gap: number, room: number): { rows: number[][]; width: number | null } {
  const all = flow(widths, gap, Infinity);
  if (widths.length <= 1 || all.width <= room + EPSILON) return { rows: all.rows, width: null };
  let best: Flow | null = null;
  for (let i = 0; i < widths.length; i++) {
    let run = -gap;
    for (let j = i; j < widths.length; j++) {
      run += gap + (widths[j] ?? 0);
      if (run > room + EPSILON) break;
      const next = flow(widths, gap, run);
      if (!best || better(next, best)) best = next;
    }
  }
  // A tile wider than the room stands in a row of its own, as the browser would set it.
  best ??= flow(widths, gap, 0);
  return { rows: best.rows, width: best.width };
}

/**
 * A hundredth of a pixel, so a row whose measured widths add up a hair past
 * its room by floating point still fits. The headroom for the browser's own
 * rounding goes on the cap Menu.tsx writes, never here: a row counted as
 * fitting while wider than the menu gets no cap, and the browser would wrap
 * its last tile alone.
 */
const EPSILON = 0.01;

type Flow = { rows: number[][]; width: number };

/** The tiles' rows flowing left to right, each tile starting a new row where it would take its row past `cap`, and the widest row. */
function flow(widths: readonly number[], gap: number, cap: number): Flow {
  const rows: number[][] = [];
  let row: number[] = [];
  let line = 0;
  let width = 0;
  widths.forEach((w, i) => {
    if (row.length > 0 && line + gap + w > cap + EPSILON) {
      rows.push(row);
      row = [];
    }
    line = row.length > 0 ? line + gap + w : w;
    row.push(i);
    width = Math.max(width, line);
  });
  if (row.length > 0) rows.push(row);
  return { rows, width };
}

/** Fewer rows, then no tile alone in the last row, then narrower. */
function better(a: Flow, b: Flow): boolean {
  if (a.rows.length !== b.rows.length) return a.rows.length < b.rows.length;
  const lone = (f: Flow) => f.rows.length > 1 && f.rows[f.rows.length - 1]!.length === 1;
  if (lone(a) !== lone(b)) return !lone(a);
  return a.width < b.width - EPSILON;
}
