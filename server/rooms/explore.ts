import { tileKey } from "#shared/keys.ts";
import { exploringSceneId } from "#shared/limits.ts";
import type { FogTile, RoomState, SightTile } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { decodeTile, encodeTile } from "#shared/rules/fog.ts";
import { seenFogBits } from "#shared/rules/vision.ts";

/**
 * The explore step (docs/design-v1-maps-vision.md 4.3.3): after a batch,
 * what the party sees on the player scene that its explored layer lacks,
 * as the one `sys.explore` the actor appends to the batch. Only the player
 * scene explores, only while its vision and fog are on, and nothing is
 * explored behind a blackout, since players are shown nothing then. The
 * DM's own fog is not read: ground the DM revealed is recorded as explored
 * once the party sees it, so undoing the reveal leaves it to players.
 *
 * Each tile carries its new bits, the explored tile joined with what the
 * party sees there, so the stored op says what the layer became. Tiles go
 * in row order, so the same state always gives the same op.
 */
export function exploreOp(state: RoomState): OpOf<"sys.explore"> | null {
  if (state.meta.view?.blackout === true) return null;
  const sceneId = exploringSceneId(state);
  if (sceneId === null) return null;
  const tiles: { tx: number; ty: number; bits: string }[] = [];
  for (const [at, tile] of visionRules.partySight(state, sceneId).tiles) {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    const bits = explored(tile, state.exploredTiles[tileKey(sceneId, tx, ty)]);
    if (bits !== null) tiles.push({ tx, ty, bits });
  }
  if (tiles.length === 0) return null;
  tiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  return { t: "sys.explore", sceneId, tiles };
}

/*
 * The answer for each pair of tile objects, which are replaced and never
 * changed. A move changes a few sight tiles, so after every batch the rest
 * are a lookup here rather than 4,096 sub-cells read again.
 */
const NONE = {};
const answers = new WeakMap<SightTile, WeakMap<object, string | null>>();

/** The explored tile's bits with what the party sees joined in, or null when it already holds all of it. */
function explored(sight: SightTile, held: FogTile | undefined): string | null {
  let byHeld = answers.get(sight);
  if (!byHeld) answers.set(sight, (byHeld = new WeakMap()));
  const heldKey = held ?? NONE;
  const hit = byHeld.get(heldKey);
  if (hit !== undefined) return hit;
  const seen = seenFogBits(sight);
  // An unreadable held tile counts as empty, as the reducer reads it.
  const was = held ? decodeTile(held.bits) : null;
  let adds = false;
  for (let i = 0; i < seen.length; i++) {
    const old = was ? was[i]! : 0;
    if ((seen[i]! & ~old) !== 0) adds = true;
    seen[i] = seen[i]! | old;
  }
  const answer = adds ? encodeTile(seen) : null;
  byHeld.set(heldKey, answer);
  return answer;
}
