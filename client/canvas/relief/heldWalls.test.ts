import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, heights, lift, paint, remember } from "#shared/discoveryTestutil.ts";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { projectState } from "#shared/project.ts";
import { chunkHeights } from "#shared/rules/heights.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { HIDDEN_DOOR } from "#shared/secretDoorTestutil.ts";
import { P1, token } from "#shared/testutil.ts";
import { FogView } from "./fogView.ts";
import { heldPainted, WALL_RISE, wallItems, type WallItem } from "./pieces.ts";
import { wallPieces } from "./runs.ts";

/**
 * Isometric on a player's device (docs/design/design-v1-maps-vision.md 2.1,
 * D-261107-260): an automatic wall between two squares the device holds
 * painted stands as a drawn wall does, on the higher ground a wall's height
 * tall, since there is no raised side there to be the wall. So a secret door
 * with an automatic cover between a corridor and a raised room still stands.
 * Every automatic wall beside rock or a square the device does not hold
 * stands as before.
 */

const BOUNDS = { w: 32, h: 16 };

/** What a player's device holds of scene s1: its chunks as projected for them. */
function held(state: RoomState): Record<string, BuildChunk> {
  return projectState(state, P1, { sceneId: "s1" }).buildChunks as Record<string, BuildChunk>;
}

/** The standing items of the walls the device's chunks give, read with or without the painted cells. */
function items(chunks: Record<string, BuildChunk>, withPainted = true): WallItem[] {
  const walls = sceneWalls({ id: "s1", bounds: BOUNDS }, chunks);
  const ground = (x: number, y: number) => {
    const chunk = chunks[`s1:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`];
    const feet = chunk ? chunkHeights(chunk) : null;
    return feet && x >= 0 && y >= 0 ? feet[(y % CHUNK_CELLS) * CHUNK_CELLS + (x % CHUNK_CELLS)]! / 5 : 0;
  };
  return wallItems({ ground, ...(withPainted ? { painted: heldPainted(chunks, "s1") } : {}) }, wallPieces(walls, new FogView(null, "s1", BOUNDS)));
}

const itemOn = (list: WallItem[], edge: string) => list.find((w) => w.piece.id.startsWith(`e${edge}@`));

/** A corridor on row 5 from x 2 to 9 at 0 ft, and a room from x 10 to 13 raised 10 ft, its west side on x 10. */
function raised(door: boolean): RoomState {
  const state = fogRoom({ bounds: BOUNDS });
  paint(state, { x: 2, y: 5, w: 8, h: 1 });
  if (door) {
    paint(state, { x: 10, y: 3, w: 4, h: 5 });
    heights(state, { x: 10, y: 3, w: 4, h: 5 }, 10);
    edge(state, "10,5,w", { ...HIDDEN_DOOR, cover: "auto" });
  }
  return state;
}

describe("automatic walls between two painted squares a device holds", () => {
  test("a secret door between squares 0 and 10 ft up, both held, stands as a drawn wall", () => {
    const state = raised(true);
    lift(state, "dm", { x: 8, y: 5, w: 3, h: 1 });
    const chunks = held(state);
    const door = itemOn(items(chunks), "10,5w")!;
    assert.ok(door.piece.auto, "it reaches the device as an automatic wall");
    assert.deepEqual([door.base, door.rise], [2, WALL_RISE]);
    assert.equal(itemOn(items(chunks, false), "10,5w"), undefined, "without the painted cells it stood nothing");
  });

  test("with only the near square held it stands as the rock twin's wall", () => {
    const door = raised(true);
    const rock = raised(false);
    for (const s of [door, rock]) lift(s, "dm", { x: 7, y: 4, w: 3, h: 3 });
    const shown = (s: RoomState) => {
      const w = itemOn(items(held(s)), "10,5w");
      return w && [w.base, w.rise, w.piece.kind, w.piece.auto];
    };
    assert.deepEqual(shown(door), shown(rock));
    assert.deepEqual(shown(door), [0, WALL_RISE, "wall", true]);
  });

  test("an ordinary automatic wall between remembered ground 10 ft up, erased unseen, and live floor at 0 ft stands at a drawn wall's height (DRP-16)", () => {
    withCellVision(() => {
      const state = fogRoom({ vision: true, bounds: BOUNDS });
      paint(state, { x: 2, y: 5, w: 8, h: 1 });
      state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 6, y: 5 });
      // The party saw 10, 5 painted 10 ft up, out of sight now, and the DM erased it since.
      lift(state, "party", { x: 2, y: 4, w: 9, h: 3 });
      remember(state, null, 0, 0, { cells: { "10,5": "stone" }, heights: { "10,5": 10 } });
      const s: RoomState = { ...state, memory: state.memory, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
      const chunks = held(s);
      assert.equal(chunks["s1:0,0"]?.cells["10,5"], "stone", "the device holds the remembered square painted");
      const wall = itemOn(items(chunks), "10,5w")!;
      assert.ok(wall.piece.auto);
      assert.deepEqual([wall.base, wall.rise], [2, WALL_RISE]);
    });
  });

  test("automatic walls beside rock or a square the device does not hold stand as before", () => {
    const state = raised(true);
    // The raised room's north side, beside rock, held: a raised room's side is its own wall (D-261026-27).
    lift(state, "dm", { x: 8, y: 2, w: 6, h: 6 });
    const chunks = held(state);
    const painted = heldPainted(chunks, "s1");
    const stands = (list: WallItem[]) => new Map(list.filter((w) => !(w.piece.beside && painted(w.piece.beside[0], w.piece.beside[1]) && painted(w.piece.beside[2], w.piece.beside[3]))).map((w) => [w.piece.id, [w.base, w.rise]]));
    const before = stands(items(chunks, false));
    assert.ok(before.size >= 4, `${before.size} automatic walls beside rock stand`);
    assert.deepEqual(stands(items(chunks)), before);
    // The near square alone held: the far square reads unpainted, so the door stands as an automatic wall does.
    const near = raised(true);
    lift(near, "dm", { x: 9, y: 5, w: 1, h: 1 });
    const nearChunks = held(near);
    assert.equal(heldPainted(nearChunks, "s1")(10, 5), false);
    const at = (list: WallItem[]) => {
      const w = itemOn(list, "10,5w");
      return w && [w.base, w.rise];
    };
    assert.deepEqual(at(items(nearChunks)), at(items(nearChunks, false)));
  });
});
