import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fogRoom, lift } from "#shared/discoveryTestutil.ts";
import { tileKey } from "#shared/keys.ts";
import type { RoomState, Scene, SightTile } from "#shared/model.ts";
import { defaultIncludeOrigin, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { TILE_SUB } from "#shared/rules/fog.ts";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { caughtTokens, contextFrom } from "./coverage.ts";
import { liveGroundOf } from "./liveGround.ts";

/*
 * A player's caught lists and target rings by their device's live ground
 * (docs/design-v1-map-discovery.md decision 13, 6 "Areas", section 10):
 * a creature is listed only where every ray the area's inclusion reads to
 * it lies on ground live to the device. The DM's lists read every area
 * whole.
 */

const fireball: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 20, origin: { x: 4, y: 4, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("sphere") };

/** A goblin at (6, 4), inside the fireball, on a scene with fog on and every cell revealed, its device's sight over the cells of `seen`. */
function device(opts: { vision: boolean; seen?: { x0: number; x1: number } }): { view: RoomState; scene: Scene } {
  const state = fogRoom({ vision: opts.vision });
  lift(state, "dm", { x: 0, y: 0, w: 32, h: 16 });
  state.tokens = { goblin: token("goblin", { kind: "monster", name: "Goblin", x: 6, y: 4, sceneId: "s1" }) };
  const sight: Record<string, SightTile> = {};
  if (opts.seen) {
    // Sight as players get it, two bits a sub-cell: dim light on every sub-cell of columns x0 to x1, across the tile.
    const sub = TILE_SUB;
    const packed = new Uint8Array((sub * sub) / 4);
    for (let sy = 0; sy < sub; sy++) {
      for (let sx = opts.seen.x0 * FOG_SUBCELLS; sx < (opts.seen.x1 + 1) * FOG_SUBCELLS; sx++) {
        const i = sy * sub + sx;
        packed[i >> 2] = packed[i >> 2]! | (1 << ((i & 3) << 1));
      }
    }
    sight[tileKey("s1", 0, 0)] = { b: Buffer.from(packed).toString("base64") };
  }
  return { view: { ...state, sight } as RoomState, scene: state.scenes.s1! };
}

function caught(view: RoomState, scene: Scene, role: "dm" | "player"): string[] {
  const live = liveGroundOf({ scene, role, fogTiles: view.fogTiles, sight: (view as RoomState & { sight: Record<string, SightTile> }).sight });
  return caughtTokens(fireball, contextFrom({ tokens: view.tokens, buildChunks: view.buildChunks, settings: view.meta.settings, live }, scene), "s1");
}

describe("a player's caught list reads their live ground", () => {
  test("Reveal by hand: a creature on revealed ground is caught, its ring shown (astra's case, ASTRA-28)", () => {
    const { view, scene } = device({ vision: false });
    assert.deepEqual(caught(view, scene, "player"), ["goblin"]);
  });

  test("Explore: the same creature on ground out of sight is not, though the area covers it", () => {
    const { view, scene } = device({ vision: true });
    assert.deepEqual(caught(view, scene, "player"), []);
    assert.deepEqual(caught(view, scene, "dm"), ["goblin"], "the DM's list reads every area whole");
  });

  test("in sight, the rays from the origin to the creature all live: caught", () => {
    const { view, scene } = device({ vision: true, seen: { x0: 0, x1: 15 } });
    assert.deepEqual(caught(view, scene, "player"), ["goblin"]);
  });

  test("the creature in sight but a ray's ground between out of it: not caught", () => {
    // Sight over columns 6 and 7 only: the goblin stands in it, the origin and the ground between do not.
    const { view, scene } = device({ vision: true, seen: { x0: 6, x1: 7 } });
    assert.deepEqual(caught(view, scene, "player"), []);
  });

  test("the origin in sight, the creature out of it: not caught", () => {
    const { view, scene } = device({ vision: true, seen: { x0: 0, x1: 5 } });
    assert.deepEqual(caught(view, scene, "player"), []);
  });

  test("a ray's end on the side of a cell out of sight counts as on it, so rounding only ever leaves a creature out", () => {
    // The origin (4, 4) lies on the side of column 3, which sight does not reach.
    const { view, scene } = device({ vision: true, seen: { x0: 4, x1: 15 } });
    assert.deepEqual(caught(view, scene, "player"), []);
  });

  test("with fog off every ray is live", () => {
    const { view, scene } = device({ vision: true });
    const off = { ...scene, fogEnabled: false };
    assert.deepEqual(caught({ ...view, scenes: { s1: off } }, off, "player"), ["goblin"]);
  });

  test("the list is kept per live ground: new sight over the same tokens answers again", () => {
    const dark = device({ vision: true });
    assert.deepEqual(caught(dark.view, dark.scene, "player"), []);
    const sight = (device({ vision: true, seen: { x0: 0, x1: 15 } }).view as RoomState & { sight: Record<string, SightTile> }).sight;
    assert.deepEqual(caught({ ...dark.view, sight } as RoomState, dark.scene, "player"), ["goblin"]);
  });
});
