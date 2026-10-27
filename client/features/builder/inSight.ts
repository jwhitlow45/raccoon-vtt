import { sightOf, tileKey } from "#shared/keys.ts";
import { FOG_SUBCELLS, type RoomState, type Scene } from "#shared/model.ts";
import { TILE_CELLS, TILE_SUB } from "#shared/rules/fog.ts";
import { seenFogBits } from "#shared/rules/vision.ts";
import { rectBetween } from "./cells.ts";
import type { BuilderState } from "./store.ts";

/**
 * The builder's note on the players' scene while the party's sight meets
 * a cell being built (docs/design-v1-map-discovery.md 9, decision 15):
 * players hold ground they see live, so what the DM builds in view shows
 * to them as it is built.
 */
export const BUILD_IN_SIGHT = "The party can see where you are building, so they see it as you build. Build before players come here, or tap Fog all when done.";

/** The cells a builder gesture in progress touches: a stroke's unsent cells, a rectangle, a wall run's cells either side, a shape room's corners' box and a label dragged. */
export function gestureCells(s: Pick<BuilderState, "unsent" | "rect" | "run" | "poly" | "labelMove">): string[] {
  const out = [...s.unsent];
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    // Bounded, as a rectangle is: the note asks only whether any of it is in sight.
    for (let y = Math.max(0, y0); y <= Math.min(y1, y0 + 255); y++) for (let x = Math.max(0, x0); x <= Math.min(x1, x0 + 255); x++) out.push(`${x},${y}`);
  };
  if (s.rect) {
    const r = rectBetween(s.rect.a, s.rect.b);
    box(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1);
  }
  for (const key of s.run) {
    const [x, y, side] = key.split(",");
    out.push(`${x},${y}`, side === "n" ? `${x},${Number(y) - 1}` : `${Number(x) - 1},${y}`);
  }
  if (s.poly.length > 0) {
    const xs = s.poly.map((p) => p.x);
    const ys = s.poly.map((p) => p.y);
    box(Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)) - 1, Math.ceil(Math.max(...ys)) - 1);
  }
  if (s.labelMove) out.push(`${Math.floor(s.labelMove.x)},${Math.floor(s.labelMove.y)}`);
  return out;
}

/**
 * Whether the party sees any of `cells` now: on the players' scene with
 * fog and party vision on and no blackout, any sub-cell in the sight the
 * DM's copy holds (the union of every source's, project.ts unionSightOf).
 * With fog off players hold the whole build anyway, so there is nothing
 * to say.
 */
export function partySeesAny(view: RoomState, scene: Pick<Scene, "id" | "vision" | "fogEnabled">, cells: readonly string[]): boolean {
  if (cells.length === 0 || scene.fogEnabled !== true || scene.vision?.on !== true || view.meta.playerSceneId !== scene.id || view.meta.view?.blackout === true) return false;
  const sight = sightOf(view);
  if (!sight) return false;
  const tiles = new Map<string, Uint8Array | null>();
  for (const key of cells) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    const tx = Math.floor(x / TILE_CELLS);
    const ty = Math.floor(y / TILE_CELLS);
    const at = `${tx},${ty}`;
    let bits = tiles.get(at);
    if (bits === undefined) {
      const tile = sight[tileKey(scene.id, tx, ty)];
      tiles.set(at, (bits = tile ? seenFogBits(tile) : null));
    }
    if (!bits) continue;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < FOG_SUBCELLS; sx++) {
        const i = ((y - ty * TILE_CELLS) * FOG_SUBCELLS + sy) * TILE_SUB + (x - tx * TILE_CELLS) * FOG_SUBCELLS + sx;
        if ((bits[i >> 3]! >> (i & 7)) & 1) return true;
      }
    }
  }
  return false;
}
