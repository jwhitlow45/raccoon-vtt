import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { Viewer } from "./model.ts";
import { projectEntity, projectState } from "./project.ts";
import { DM, P1, room, scene } from "./testutil.ts";

/** What a Time of day scene and dawn and dusk tell each viewer (docs/design/design-v1-calendar-c2c3.md 6.4). */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

describe("byClock is the DM's alone (6.4)", () => {
  test("players and a table display get the level and no flag, by snapshot and by key", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { vision: { on: true, light: "dim", perPlayer: true, byClock: true } });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).scenes.s1!.vision, { on: true, light: "dim", perPlayer: true, byClock: true });
    for (const who of [P1, DISPLAY]) {
      assert.deepEqual(projectState(state, who, { sceneId: "s1" }).scenes.s1!.vision, { on: true, light: "dim", perPlayer: true }, who.memberId);
      assert.deepEqual((projectEntity(keys.scene("s1"), state, who, { sceneId: "s1" }) as { vision?: unknown }).vision, { on: true, light: "dim", perPlayer: true }, who.memberId);
    }
  });
});
