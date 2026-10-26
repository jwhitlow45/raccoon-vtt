import { CHUNK_CELLS, type BuildChunk, type FogTile, type RoomState } from "#shared/model.ts";
import { chunkHeights, encodeHeights } from "#shared/rules/heights.ts";
import type { GroundSource } from "../../features/builder/heights/ground.ts";
import { dropLanding, dropView, type DropToken, type Point, type Role } from "../../features/movement/drop.ts";
import { FogView } from "./fogView.ts";

type Chunks = Readonly<Record<string, BuildChunk>>;

/*
 * Kept per chunk set, fog and scene, each of which the store replaces on
 * every change, so a fog reveal or a height change makes a new set and
 * anything else reads the one already made.
 */
const cache = new WeakMap<Chunks, WeakMap<object, Map<string, Chunks>>>();

/**
 * The build as `seenGround` reads it (features/builder/heights/ground.ts):
 * this scene's chunks with each height this viewer may not read set to 0,
 * a fully fogged cell's or one past the scene's edge. Rules that take
 * chunks, such as a shadow's lift or a drop's landing, then read only the
 * ground the viewer has seen. A viewer who sees all the ground gets the
 * chunks themselves.
 */
export function seenChunks(src: GroundSource): Chunks {
  if (!src.fog) return src.chunks;
  let byFog = cache.get(src.chunks);
  if (!byFog) cache.set(src.chunks, (byFog = new WeakMap()));
  let byScene = byFog.get(src.fog);
  if (!byScene) byFog.set(src.fog, (byScene = new Map()));
  const key = `${src.sceneId}|${src.bounds.w}|${src.bounds.h}`;
  let seen = byScene.get(key);
  if (!seen) byScene.set(key, (seen = masked(src.chunks, src.fog, src.sceneId, src.bounds)));
  return seen;
}

function masked(chunks: Chunks, tiles: Readonly<Record<string, FogTile | undefined>>, sceneId: string, bounds: { w: number; h: number }): Chunks {
  const fog = new FogView(tiles, sceneId, bounds);
  const out: Record<string, BuildChunk> = {};
  for (const [key, chunk] of Object.entries(chunks)) {
    const heights = chunk.sceneId === sceneId ? chunkHeights(chunk) : null;
    if (!heights) {
      out[key] = chunk;
      continue;
    }
    let changed: Int16Array | null = null;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] === 0) continue;
      const x = chunk.cx * CHUNK_CELLS + (i % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(i / CHUNK_CELLS);
      if (fog.cellSeen(x, y)) continue;
      changed ??= Int16Array.from(heights);
      changed[i] = 0;
    }
    out[key] = changed ? { ...chunk, heights: encodeHeights(changed) } : chunk;
  }
  return out;
}

/**
 * The elevation a drag's preview shows at a spot, in feet, this device's
 * or another member's: the drop's landing (movement/drop.ts dropLanding),
 * a kept seat at its holder's height, read on the ground this viewer has
 * seen (`seen`, from seenChunks), so a fogged platform never lifts it
 * (docs/design-v1-isometric-view.md 4.3). A shadow and a standing ghost
 * both read this one landing.
 */
export function previewLanding(view: RoomState, role: Role, seen: Chunks, token: DropToken, at: Point): number {
  return dropLanding({ ...dropView(view, role), buildChunks: seen }, token, at);
}
