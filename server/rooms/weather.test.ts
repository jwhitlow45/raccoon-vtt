import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, room, scene } from "#shared/testutil.ts";
import type { SceneWeather } from "#shared/weather.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";
import { describeOp } from "./undoLabels.ts";
import { UndoTable } from "./undoTesting.ts";

/** A scene's weather in stored state, a backup's import and the undo stack (docs/design/design-v1-weather.md 9, lane WX-A). */
describe("a scene's weather, stored, imported and undone", () => {
  const road = (weather?: SceneWeather) => room({ scenes: { s1: scene("s1", { name: "Forest road", ...(weather ? { weather } : {}) }) } });

  test("a room with weather loads as it was, a backup from before it has none, and an impossible one is refused", () => {
    const parsed = parseRoomState(road({ kind: "sand", heavy: true, wind: "strong", toward: 270, rules: false }));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.scenes.s1!.weather, { kind: "sand", heavy: true, wind: "strong", toward: 270, rules: false });
    const old = parseRoomState(road());
    assert.ok(old.ok);
    assert.ok(!("weather" in old.state.scenes.s1!));
    for (const bad of [{ kind: "fog", wind: "strong" }, { kind: "sand", heavy: true, wind: "moderate" }, { kind: "clear" }, { kind: "rain", wind: "strong", toward: 10 }, { kind: "hail" }, null]) {
      const s = road();
      (s.scenes.s1 as unknown as Record<string, unknown>).weather = bad;
      assert.equal(parseRoomState(s).ok, false, JSON.stringify(bad));
    }
  });

  test("an import stores each scene's weather in its one form", () => {
    const longhand = road({ kind: "rain", wind: "moderate", toward: 135 });
    longhand.scenes.s1!.weather = { kind: "rain", wind: "moderate", toward: 135 };
    const out = remapState(longhand, { assets: new Map() });
    const [imported] = Object.values(out.scenes);
    assert.deepEqual(imported!.weather, { kind: "rain", wind: "moderate" });
    const calm = remapState(road({ kind: "snow", toward: 90 } as SceneWeather), { assets: new Map() });
    assert.deepEqual(Object.values(calm.scenes)[0]!.weather, { kind: "snow" }, "no toward without a wind");
    assert.ok(!("weather" in Object.values(remapState(road(), { assets: new Map() }).scenes)[0]!), "none stays none");
  });

  test("its undo step is named, and only when the patch holds nothing else", () => {
    const state = road();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { weather: { kind: "rain", heavy: true } } }, state), "changing the weather of the scene Forest road");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { weather: null } }, state), "changing the weather of the scene Forest road");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { weather: null, name: "Muddy road" } }, state), "changing the scene Forest road");
  });

  test("undo puts the old weather back and redo the new, on the Play history", () => {
    const table = new UndoTable(road({ kind: "snow" }));
    assert.equal(table.play(DM, { t: "scene.update", sceneId: "s1", patch: { weather: { kind: "rain", heavy: true, wind: "strong" } } }), "ok");
    assert.deepEqual(table.state.scenes.s1!.weather, { kind: "rain", heavy: true, wind: "strong" });
    assert.equal(table.undo(DM), "ok");
    assert.deepEqual(table.state.scenes.s1!.weather, { kind: "snow" });
    assert.equal(table.redo(DM), "ok");
    assert.deepEqual(table.state.scenes.s1!.weather, { kind: "rain", heavy: true, wind: "strong" });
    assert.equal(table.play(DM, { t: "scene.update", sceneId: "s1", patch: { weather: null } }), "ok");
    assert.ok(!("weather" in table.state.scenes.s1!));
    assert.equal(table.undo(DM), "ok");
    assert.deepEqual(table.state.scenes.s1!.weather, { kind: "rain", heavy: true, wind: "strong" }, "restored");
  });
});
