import { FOG_SUBCELLS, type RoomState, type Token } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { decodeTile, getBit, TILE_CELLS } from "#shared/rules/fog.ts";
import { boardSizes } from "../../lib/boardScale.ts";
import { displayName, footprint } from "../../lib/scene.ts";
import { DECOR_MIN_PX } from "../../lib/tokenView.ts";

/**
 * Where a placed area's name sits so it keeps clear of the tokens, their
 * chips and their name labels (features section 9). The board layer draws
 * under the tokens, so an area name over a token or under a token's label
 * is hidden by it. Token labels in turn keep off the name once it is placed
 * (Stage.tsx), so this reads only the tokens, never where labels went.
 * Kept free of Konva so it runs under plain Node tests.
 */

/** A box in world cells. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

export type Point = { x: number; y: number };

/**
 * The screen space a token takes, in world cells, at the board's sizes for
 * the zoom (lib/boardScale.ts): its body, the chip row over its top edge,
 * and the band a label of two lines hangs in under its HP bar, as wide as
 * its measured name. A token too small on screen for marks takes its body.
 */
export function tokenBoxes(tokens: readonly Token[], scale: number, measure: (text: string, px: number) => number): Box[] {
  const sizes = boardSizes(scale);
  const out: Box[] = [];
  for (const t of tokens) {
    const fp = footprint(t);
    out.push({ x0: t.x, y0: t.y, x1: t.x + fp.w, y1: t.y + fp.h });
    if (fp.w * scale < DECOR_MIN_PX) continue;
    const cx = t.x + fp.w / 2;
    const chips = sizes.chipPx / 2 / scale;
    out.push({ x0: t.x, y0: t.y - chips, x1: t.x + fp.w, y1: t.y });
    const widthPx = Math.min(15 * sizes.namePx, Math.max(fp.w * scale, measure(displayName(t), sizes.namePx) + 4));
    const half = widthPx / 2 / scale;
    const top = t.y + fp.h + sizes.gapPx / scale;
    const tall = (2 * sizes.gapPx + sizes.barPx + Math.round(sizes.namePx * 1.17) + Math.round(sizes.hpPx * 1.17)) / scale;
    out.push({ x0: cx - half, y0: top, x1: cx + half, y1: top + tall });
  }
  return out;
}

/**
 * Whether a cell of the scene is fully fogged on a player's screen, read
 * from the fog the player gets, with one decode per tile. A missing or
 * unreadable tile is fog, as the fail-closed gate draws it (design 13.3).
 * Cells off the scene are not: the fog covers the scene alone, and a name
 * above its top edge reads on the plain background.
 */
export function foggedCells(tiles: RoomState["fogTiles"], sceneId: string, bounds: { w: number; h: number }): (cx: number, cy: number) => boolean {
  const decoded = new Map<string, Uint8Array | null>();
  return (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= bounds.w || cy >= bounds.h) return false;
    const tx = Math.floor(cx / TILE_CELLS);
    const ty = Math.floor(cy / TILE_CELLS);
    const key = tileKey(sceneId, tx, ty);
    let bits = decoded.get(key);
    if (bits === undefined) {
      const tile = tiles[key];
      bits = tile ? decodeTile(tile.bits) : null;
      decoded.set(key, bits);
    }
    if (!bits) return true;
    const bx = (cx - tx * TILE_CELLS) * FOG_SUBCELLS;
    const by = (cy - ty * TILE_CELLS) * FOG_SUBCELLS;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (getBit(bits, bx + sx, by + sy)) return false;
    return true;
  };
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export type AreaSpot = Point & { place: "above" | "below"; oneLine: boolean };

/**
 * Where an area's name goes: above the middle of its top edge in open
 * ground, as always, else below the middle of its bottom edge, else slid
 * along either edge (up to `reach` cells each way, following `edge`), so a
 * name keeps clear of a token in melee rather than hide under it. When the
 * whole name has nowhere clear to go, it falls back to one cut line
 * (`oneLineSize`), a smaller pill, at the spot it covers least. A tie stays
 * above the middle, so an area in open ground keeps its name where it
 * always was.
 *
 * On a player's screen, fully fogged cells (`fogged`) count as taken too,
 * since the board draws under the opaque fog and a name over it would be
 * cut off. The DM sees through the fog, so the DM's names stay put.
 */
export function areaLabelSpot(input: {
  top: Point;
  bottom: Point;
  /** How far the name may slide along an edge each way, in cells. */
  reach?: number;
  /** The point on the top or bottom edge `dx` cells along from its middle. */
  edge?: (dx: number, side: "top" | "bottom") => Point;
  size: { width: number; height: number };
  /** The pill cut to one line, when that is smaller. */
  oneLineSize?: { width: number; height: number };
  scale: number;
  avoid: readonly Box[];
  /** On a player's screen, whether a cell is fully fogged (foggedCells). Absent for the DM. */
  fogged?: (cx: number, cy: number) => boolean;
}): AreaSpot {
  const { scale } = input;
  const reach = input.reach ?? 0;
  const at = (dx: number, side: "top" | "bottom"): Point => (dx === 0 ? (side === "top" ? input.top : input.bottom) : (input.edge?.(dx, side) ?? { x: (side === "top" ? input.top : input.bottom).x + dx, y: (side === "top" ? input.top : input.bottom).y }));
  // The middles first, then a quarter of the reach further along each edge at a time, nearest first.
  const spots: { p: Point; side: "top" | "bottom" }[] = [
    { p: at(0, "top"), side: "top" },
    { p: at(0, "bottom"), side: "bottom" },
  ];
  if (reach > 0) {
    for (const f of [0.25, 0.5, 0.75, 1]) {
      for (const side of ["top", "bottom"] as const) for (const dx of [-f * reach, f * reach]) spots.push({ p: at(dx, side), side });
    }
  }
  const cost = (spot: { p: Point; side: "top" | "bottom" }, size: { width: number; height: number }) => {
    const half = size.width / 2 / scale;
    const tall = size.height / scale;
    const box = spot.side === "top" ? { x0: spot.p.x - half, y0: spot.p.y - tall, x1: spot.p.x + half, y1: spot.p.y } : { x0: spot.p.x - half, y0: spot.p.y, x1: spot.p.x + half, y1: spot.p.y + tall };
    let sum = input.avoid.reduce((total, b) => total + overlap(box, b), 0);
    if (input.fogged) {
      for (let cy = Math.floor(box.y0); cy < Math.ceil(box.y1); cy++) {
        for (let cx = Math.floor(box.x0); cx < Math.ceil(box.x1); cx++) if (input.fogged(cx, cy)) sum += overlap(box, { x0: cx, y0: cy, x1: cx + 1, y1: cy + 1 });
      }
    }
    return sum;
  };
  const result = (spot: { p: Point; side: "top" | "bottom" }, oneLine: boolean): AreaSpot => ({ ...spot.p, place: spot.side === "top" ? "above" : "below", oneLine });
  const clear = spots.find((spot) => cost(spot, input.size) === 0);
  if (clear) return result(clear, false);
  const small = input.oneLineSize;
  const size = small ?? input.size;
  let best = spots[0]!;
  let bestCost = cost(best, size);
  for (const spot of spots.slice(1)) {
    const c = cost(spot, size);
    if (c < bestCost) {
      best = spot;
      bestCost = c;
    }
  }
  return result(best, !!small);
}
