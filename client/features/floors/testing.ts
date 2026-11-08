import type { RoomState, Scene, SceneId } from "#shared/model.ts";
import { character, room, scene, token } from "#shared/testutil.ts";

/*
 * A tower of three floors for the floors tests (docs/design/design-v1-floors.md):
 * Ground floor (the main floor, `tower`), Upper floor and Attic, each a scene
 * record named Tower, with the players on Ground and a plain scene, Cave,
 * beside it. Thorn is p1's character and Bree p2's, both on Ground.
 */

export const TOWER = "tower";
export const UPPER = "upper";
export const ATTIC = "attic";
export const CAVE = "cave";

function floorOf(id: SceneId, level: number, name: string): Scene {
  return scene(id, { name: "Tower", floor: { of: TOWER, level, name, height: 10 } });
}

/** The DM's state of the tower, before any projection: every floor with its `of` and height. */
export function tower(overrides: Partial<RoomState> = {}): RoomState {
  const base = room();
  return {
    ...base,
    meta: { ...base.meta, playerSceneId: TOWER },
    scenes: { [TOWER]: floorOf(TOWER, 0, "Ground floor"), [UPPER]: floorOf(UPPER, 1, "Upper floor"), [ATTIC]: floorOf(ATTIC, 2, "Attic"), [CAVE]: scene(CAVE, { name: "Cave", order: 1 }) },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }), bree: character("bree", { name: "Bree", ownerIds: ["p2"] }) },
    tokens: {
      thorn: token("thorn", { sceneId: TOWER, kind: "pc", name: "Thorn", disposition: "ally", actor: { ref: "thorn" } }),
      bree: token("bree", { sceneId: TOWER, kind: "pc", name: "Bree", disposition: "ally", actor: { ref: "bree" } }),
    },
    openFloors: {},
    ...overrides,
  };
}

/**
 * A player's copy of `state` holding `held`, as the projection delivers it
 * (8, D-261102-492): only those floors, each `floor` cut to `{ level, name }`
 * renumbered among them, and none at all while one is held, with only the
 * tokens on them. Enough of a projection for the client's rules, which read
 * nothing else of it.
 */
export function playerCopy(state: RoomState, held: readonly SceneId[]): RoomState {
  const floors = held.map((id) => state.scenes[id]!).sort((a, b) => (a.floor?.level ?? 0) - (b.floor?.level ?? 0));
  const scenes: Record<SceneId, Scene> = {};
  floors.forEach((s, level) => {
    const { floor, ...rest } = s;
    scenes[s.id] = floors.length > 1 && floor ? { ...rest, floor: { level, name: floor.name } } : rest;
  });
  const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([, t]) => held.includes(t.sceneId)));
  const { openFloors: _marks, ...rest } = state;
  return { ...rest, scenes, tokens, sight: {} } as RoomState;
}
