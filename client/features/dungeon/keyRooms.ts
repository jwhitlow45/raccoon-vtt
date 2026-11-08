import type { Board } from "./layout.ts";

/*
 * The DM key's rooms (phase 2, 5.6): each room's pin square, its number,
 * and what the key's line for it says. Pin squares are chosen whatever DM
 * key says, before lights and dressing, so the switch never moves a prop
 * (D-261107-268).
 */

/**
 * A room's pin square: its floor square nearest its middle, ties by reading
 * order. `floor` says which squares are free floor: painted, and not water,
 * a pit, a pillar or a dais. A room always has its doorway lines, which
 * reach its middle dry, so one is found. The middle itself when none is.
 */
export function pinSquare(board: Board, room: number, floor: (k: number) => boolean): number {
  const r = board.rooms[room]!;
  const mx = 2 * r.x + r.w;
  const my = 2 * r.y + r.h;
  let best = -1;
  let bestD = Infinity;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = board.cell(x, y);
      if (!floor(k)) continue;
      const dx = 2 * x + 1 - mx;
      const dy = 2 * y + 1 - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        best = k;
        bestD = d;
      }
    }
  }
  return best >= 0 ? best : board.cell(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
}
