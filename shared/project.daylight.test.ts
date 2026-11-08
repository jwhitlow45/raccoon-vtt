import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { Viewer } from "./model.ts";
import { projectEntity, projectState } from "./project.ts";
import { DM, P1, P2, room, scene } from "./testutil.ts";

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

describe("dawn and dusk go with the shown clock (6.4)", () => {
  const daylight = { dawn: 5 * 3_600 + 30 * 60, dusk: 19 * 3_600 };
  const clocked = (shown: boolean, blackout = false) =>
    room({ meta: { ...room().meta, view: { follow: false, blackout } }, clock: { id: "c1", rev: 3, t: 40_000, shown, calendar: { kind: "days" }, daylight } });

  test("players and a table display get them with a shown clock, by snapshot and by key", () => {
    const state = clocked(true);
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).clock?.daylight, daylight);
    for (const who of [P1, P2, DISPLAY]) {
      assert.deepEqual(projectState(state, who, { sceneId: "s1" }).clock, { id: "c1", rev: 0, t: 40_000, calendar: { kind: "days" }, daylight }, who.memberId);
      assert.deepEqual(projectEntity(keys.clock, state, who, { sceneId: "s1" }), projectState(state, who, { sceneId: "s1" }).clock, who.memberId);
    }
  });

  test("a clock with none set sends none, and a hidden clock or a blackout sends nothing", () => {
    const plain = clocked(true);
    delete plain.clock!.daylight;
    assert.ok(!("daylight" in projectState(plain, P1, { sceneId: "s1" }).clock!));
    for (const state of [clocked(false), clocked(true, true)]) {
      for (const who of [P1, DISPLAY]) assert.ok(!("clock" in projectState(state, who, { sceneId: "s1" })), who.memberId);
    }
  });
});
