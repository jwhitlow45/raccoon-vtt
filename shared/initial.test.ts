import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState } from "./initial.ts";
import type { Member } from "./model.ts";

const dm: Member = { id: "dm1", rev: 0, name: "DM", color: "#f38400", kind: "dm", createdAt: "2026-10-26T00:00:00.000Z" };

describe("a new room (docs/design-v1-map-discovery.md 8.2 and 5.5)", () => {
  test("makes new scenes on Explore, while its first mat stays on Everything", () => {
    const state = createInitialState({ roomName: "New", dm });
    assert.equal(state.meta.settings.newScenePlayers, "explore");
    const mat = state.scenes[state.meta.playerSceneId!]!;
    assert.equal(mat.fogEnabled, false);
    assert.equal(mat.vision, undefined);
  });

  test("holds no memory, and its first mat, the players' scene from the start, is marked played", () => {
    const state = createInitialState({ roomName: "New", dm });
    const id = state.meta.playerSceneId!;
    assert.deepEqual(state.memory, {});
    assert.deepEqual(state.memoryBy, {});
    assert.deepEqual(state.memoryShared, {});
    assert.deepEqual(state.playedScenes, { [id]: { sceneId: id, rev: 0 } });
  });
});
