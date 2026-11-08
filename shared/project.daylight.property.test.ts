import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { LightLevel, RoomState, SceneVision, Viewer } from "./model.ts";
import { projectState, stableStringify } from "./project.ts";
import { P1, P2, room, scene } from "./testutil.ts";

/**
 * Twin rooms that differ only in which scenes follow the clock, with equal
 * stored levels, project alike to every player and a table display
 * (docs/design/design-v1-calendar-c2c3.md 6.4, 11): a player never learns a
 * scene is on Time of day, and so that a clock exists. A blackout, a shown
 * or hidden clock and the players' scene change nothing of that.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWERS = [P1, P2, DISPLAY];

const sceneLight = fc.record({ on: fc.boolean(), light: fc.constantFrom<LightLevel>("bright", "dim", "dark"), perPlayer: fc.boolean(), follows: fc.boolean() });
type SceneLight = { on: boolean; light: LightLevel; perPlayer: boolean; follows: boolean };

function vision(s: SceneLight, follows: boolean): SceneVision {
  return { on: s.on, light: s.light, ...(s.perPlayer ? { perPlayer: true as const } : {}), ...(follows ? { byClock: true as const } : {}) };
}

function twin(scenes: SceneLight[], follows: (s: SceneLight) => boolean, shown: boolean, blackout: boolean, playerScene: number): RoomState {
  const state = room({ meta: { ...room().meta, playerSceneId: `s${playerScene % scenes.length}`, view: { follow: false, blackout } } });
  state.scenes = Object.fromEntries(scenes.map((s, i) => [`s${i}`, scene(`s${i}`, { order: i, vision: vision(s, follows(s)) })]));
  state.clock = { id: "c1", rev: 2, t: 40_000, shown, calendar: { kind: "days" } };
  return state;
}

test("whether a scene follows the clock never reaches a player or a display", () => {
  fc.assert(
    fc.property(fc.array(sceneLight, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.boolean(), fc.nat(3), (scenes, shown, blackout, playerScene) => {
      const a = twin(scenes, (s) => s.follows, shown, blackout, playerScene);
      const b = twin(scenes, () => false, shown, blackout, playerScene);
      for (const who of VIEWERS) {
        const sceneId = a.meta.playerSceneId;
        assert.equal(stableStringify(projectState(a, who, { sceneId })), stableStringify(projectState(b, who, { sceneId })), who.memberId);
      }
    }),
    { numRuns: 300 },
  );
});
