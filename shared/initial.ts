import { uuidv7 } from "./ids.ts";
import { DEFAULT_SETTINGS, type Member, type RoomState } from "./model.ts";

/**
 * The state of a room the moment it is created: its creator as the only
 * member, and one blank battle mat so the DM lands on something usable.
 *
 * The battle mat starts with fog off, because a blank mat has nothing to hide
 * (design section 13.2). Scenes with a map or a build start fogged instead.
 */
export function createInitialState(input: { roomName: string; dm: Member; now?: string }): RoomState {
  const sceneId = uuidv7();
  return {
    meta: {
      name: input.roomName,
      settings: { ...DEFAULT_SETTINGS },
      playerSceneId: sceneId,
      view: { follow: false, blackout: false },
    },
    members: { [input.dm.id]: input.dm },
    scenes: {
      [sceneId]: {
        id: sceneId,
        rev: 1,
        name: "Battle mat",
        order: 0,
        bounds: { w: 30, h: 20 },
        grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
        background: "#2b2b31",
        fogEnabled: false,
        wallsVersion: 0,
        // Walls stop players' moves on every scene made from wave 4 on (docs/design-v1-maps-vision.md 4.1).
        blockMovement: true,
      },
    },
    buildChunks: {},
    labels: {},
    fogTiles: {},
    fogDrafts: {},
    tokens: {},
    characters: {},
    templates: {},
    drawings: {},
    encounter: null,
    encounterHistory: [],
    handouts: {},
    log: [],
    monsters: {},
    srdImages: {},
    savedEncounters: {},
    stamps: {},
    lights: {},
    exploredTiles: {},
    journal: {},
    pins: {},
    rolls: {},
    handoutDocs: {},
    companionBlocks: {},
  };
}
