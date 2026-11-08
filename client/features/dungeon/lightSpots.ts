import type { Board } from "./layout.ts";
import type { PlanLight, PlanStamp } from "./plan.ts";
import { stampSize } from "./props.ts";
import type { Stream } from "./random.ts";
import type { ThemeSpec } from "./themes.ts";

/*
 * Lit rooms (phase 2, 5.5, D-261107-200): each lit room's theme light, its
 * picture centered on a free square against the room's edge, nearest a
 * corner first, and its SRD light at the picture's middle, half a square
 * from the wall and on the free wall lattice, so it casts shadows from the
 * walls as a placed light does.
 */

export type LitRoom = { room: number; light: PlanLight; stamp: PlanStamp; square: number };

/**
 * Lights `count` rooms (5.5): the kept rooms in an order drawn from the
 * lights lane, the entrance among them, each lit at a spot drawn among its
 * free squares touching the room's edge that lie nearest a corner. A room
 * with no such square is passed over for the next. `own` says which
 * squares are the room's painted floor, so a cave's eroded edge counts as
 * its edge; `free` which of them a stamp may take.
 */
export function placeLights(rng: Stream, board: Board, rooms: readonly number[], count: number, own: (room: number, k: number) => boolean, free: (room: number, k: number) => boolean, theme: ThemeSpec): LitRoom[] {
  const out: LitRoom[] = [];
  if (count <= 0) return out;
  const size = stampSize(theme.light.stamp) ?? { w: 1, h: 1 };
  for (const i of rng.shuffle([...rooms])) {
    if (out.length >= count) break;
    const r = board.rooms[i]!;
    const corners: [number, number][] = [
      [r.x, r.y],
      [r.x + r.w - 1, r.y],
      [r.x, r.y + r.h - 1],
      [r.x + r.w - 1, r.y + r.h - 1],
    ];
    let best: number[] = [];
    let bestD = Infinity;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const k = board.cell(x, y);
        if (!free(i, k)) continue;
        // Rooms keep inside the map's margin, so each neighbor is on the map.
        if (![k - 1, k + 1, k - board.W, k + board.W].some((n) => !own(i, n))) continue;
        const d = Math.min(...corners.map(([cx, cy]) => Math.max(Math.abs(x - cx), Math.abs(y - cy))));
        if (d < bestD) {
          best = [k];
          bestD = d;
        } else if (d === bestD) best.push(k);
      }
    }
    if (best.length === 0) continue;
    const k = rng.pick(best);
    const x = (k % board.W) + 0.5;
    const y = Math.floor(k / board.W) + 0.5;
    out.push({
      room: i,
      square: k,
      light: { x, y, preset: theme.light.preset, label: theme.light.label, stamp: theme.light.stamp },
      stamp: { key: theme.light.stamp, x, y, w: size.w, h: size.h, rotation: 0 },
    });
  }
  return out;
}
