import { FOG_SUBCELLS, type FogTile, type RoomState } from "#shared/model.ts";
import { TILE_SUB } from "#shared/rules/fog.ts";
import { encodeTileFrom } from "../../lib/fogTiles.ts";

/**
 * The dev fixture's vision scene (`/dev/room?sight=1`), never imported by
 * production code: client/dev/DevRoom.tsx loads it behind
 * import.meta.env.DEV. The fixture's LocalServer projects with the real
 * rules (shared/ruleHooks.ts), so the party's sight here is the server's,
 * walls and all.
 *
 * The cave becomes a dark vision scene: Thorn sees in the dark to 60 ft,
 * Vex carries a torch, the fixture's lights burn, and the party has
 * explored a corridor to the south it cannot see now. The LocalServer has
 * no explore step (the room actor's), so that corridor is written here.
 */
export function visionFixture(state: RoomState, sceneId: string): RoomState {
  const scene = state.scenes[sceneId];
  if (!scene) return state;
  scene.vision = { on: true, light: "dark" };
  for (const c of Object.values(state.characters)) if (c.name === "Thorn") c.actor.senses = "Darkvision 60 ft.";
  for (const t of Object.values(state.tokens)) if (t.name === "Vex") t.light = { bright: 20, dim: 20 };
  const explored: Record<string, FogTile> = {};
  const tiles = Math.ceil(scene.bounds.w / 16);
  for (let tx = 0; tx < tiles; tx++) {
    const bits = encodeTileFrom((sx, sy) => {
      const x = (tx * TILE_SUB + sx) / FOG_SUBCELLS;
      const y = sy / FOG_SUBCELLS;
      return x >= 2 && x < 26 && y >= 13 && y < 16;
    });
    explored[`${sceneId}:${tx},0`] = { sceneId, tx, ty: 0, rev: 1, bits };
  }
  state.exploredTiles = explored;
  return state;
}
