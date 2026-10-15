import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mapFailureText,
  SCENE_LOAD_IDLE,
  sceneLoadFailureText,
  sceneLoadView,
  stepSceneLoad,
  type MapProgress,
  type SceneLoad,
  type SceneLoadEvent,
} from "./sceneLoad.ts";

function run(events: SceneLoadEvent[], from: SceneLoad = SCENE_LOAD_IDLE) {
  let load = from;
  const failures = [];
  for (const e of events) {
    const step = stepSceneLoad(load, e);
    load = step.load;
    if (step.failed) failures.push(step.failed);
  }
  return { load, failures };
}

const names: Record<string, string> = { a: "Crypt", b: "Big dungeon", c: "Caves" };
const nameOf = (id: string) => names[id];

describe("stepSceneLoad: what starts, updates and clears a switch", () => {
  test("a pick starts it and the snapshot for that scene clears it", () => {
    const started = run([{ t: "request", sceneId: "b" }]);
    assert.deepEqual(started.load, { requested: "b", slow: false });
    const done = run([{ t: "snapshot", sceneId: "b", next: null }], started.load);
    assert.equal(done.load, SCENE_LOAD_IDLE);
    assert.deepEqual(done.failures, []);
  });

  test("the hello after the resync asks for the same scene and keeps the load as it is", () => {
    const { load } = run([{ t: "request", sceneId: "b" }, { t: "slow" }, { t: "request", sceneId: "b" }]);
    assert.deepEqual(load, { requested: "b", slow: true });
  });

  test("a wait or a scene retry marks it slow, and a new pick starts fresh", () => {
    assert.deepEqual(run([{ t: "request", sceneId: "b" }, { t: "slow" }]).load, { requested: "b", slow: true });
    assert.deepEqual(run([{ t: "request", sceneId: "b" }, { t: "slow" }, { t: "request", sceneId: "c" }]).load, { requested: "c", slow: false });
  });

  test("a wait with nothing requested changes nothing", () => {
    assert.equal(run([{ t: "slow" }]).load, SCENE_LOAD_IDLE);
  });

  test("going back to the scene on screen cancels it", () => {
    assert.equal(run([{ t: "request", sceneId: "b" }, { t: "cancel" }]).load, SCENE_LOAD_IDLE);
  });

  test("a later pick sent after the snapshot keeps loading, then clears with its own snapshot", () => {
    const mid = run([
      { t: "request", sceneId: "b" },
      { t: "request", sceneId: "a" },
      { t: "snapshot", sceneId: "b", next: "a" },
    ]);
    assert.deepEqual(mid.load, { requested: "a", slow: false });
    assert.deepEqual(mid.failures, []);
    assert.equal(run([{ t: "snapshot", sceneId: "a", next: null }], mid.load).load, SCENE_LOAD_IDLE);
  });

  test("a timeout clears it and reports the scene", () => {
    const { load, failures } = run([{ t: "request", sceneId: "b" }, { t: "timeout" }]);
    assert.equal(load, SCENE_LOAD_IDLE);
    assert.deepEqual(failures, [{ sceneId: "b", reason: "timeout" }]);
  });

  test("a timeout with nothing requested, such as a first connect, reports nothing", () => {
    assert.deepEqual(run([{ t: "timeout" }]).failures, []);
  });

  test("a snapshot for another scene than the one asked for clears it as refused", () => {
    const { load, failures } = run([{ t: "request", sceneId: "b" }, { t: "snapshot", sceneId: "a", next: null }]);
    assert.equal(load, SCENE_LOAD_IDLE);
    assert.deepEqual(failures, [{ sceneId: "b", reason: "refused" }]);
  });

  test("a snapshot with nothing requested, such as a reconnect, changes nothing", () => {
    assert.equal(run([{ t: "snapshot", sceneId: "a", next: null }]).load, SCENE_LOAD_IDLE);
  });
});

describe("sceneLoadView: what the map says", () => {
  const shownA = { id: "a", name: "Crypt", mapAssetId: "m1" };
  const drawn: MapProgress = { assetId: "m1", state: "drawn" };

  test("nothing at rest", () => {
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: shownA, map: drawn, nameOf }), null);
    assert.equal(sceneLoadView({ load: undefined, shown: { ...shownA, mapAssetId: null }, map: null, nameOf }), null);
  });

  test("a requested scene names that scene, over the one still on screen", () => {
    assert.deepEqual(sceneLoadView({ load: { requested: "b", slow: false }, shown: shownA, map: drawn, nameOf }), {
      sceneId: "b",
      text: "Loading Big dungeon…",
      detail: null,
    });
  });

  test("a slow request says it is still loading", () => {
    assert.equal(sceneLoadView({ load: { requested: "b", slow: true }, shown: shownA, map: drawn, nameOf })?.detail, "Still loading…");
  });

  test("once the contents are in, it stays up until the scene's own map has drawn", () => {
    const shownC = { id: "c", name: "Caves", mapAssetId: "m3" };
    // The canvas still reports the previous scene's map.
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: shownC, map: drawn, nameOf })?.text, "Loading Caves…");
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: shownC, map: { assetId: "m3", state: "loading" }, nameOf })?.sceneId, "c");
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: shownC, map: { assetId: "m3", state: "drawn" }, nameOf }), null);
  });

  test("a new image under the scene on screen, such as a map phase, says the map is changing", () => {
    const night = { ...shownA, mapAssetId: "m2" };
    assert.deepEqual(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: night, map: { assetId: "m2", state: "loading", swap: true }, nameOf }), {
      sceneId: "a",
      text: "Changing the map…",
      detail: null,
    });
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: night, map: { assetId: "m2", state: "drawn", swap: true }, nameOf }), null);
    // A scene the DM asked for still names that scene first.
    assert.equal(
      sceneLoadView({ load: { requested: "b", slow: false }, shown: night, map: { assetId: "m2", state: "loading", swap: true }, nameOf })?.text,
      "Loading Big dungeon…",
    );
  });

  test("a map that failed ends it, since a toast says so instead", () => {
    assert.equal(sceneLoadView({ load: SCENE_LOAD_IDLE, shown: shownA, map: { assetId: "m1", state: "failed" }, nameOf }), null);
  });

  test("the first load and a player moved to a scene wait for its map the same way", () => {
    assert.equal(sceneLoadView({ load: undefined, shown: shownA, map: null, nameOf })?.text, "Loading Crypt…");
  });

  test("a scene without a name still reads as a sentence", () => {
    assert.equal(sceneLoadView({ load: { requested: "x", slow: false }, shown: null, map: null, nameOf })?.text, "Loading the scene…");
  });
});

describe("failure sentences", () => {
  test("a timeout says the client tries again, a refusal says why it may have failed", () => {
    assert.equal(sceneLoadFailureText({ sceneId: "b", reason: "timeout" }, "Big dungeon"), "Big dungeon did not load in time. Reconnecting to try again.");
    assert.equal(sceneLoadFailureText({ sceneId: "b", reason: "refused" }, undefined), "The scene could not be opened. It may have been deleted.");
  });

  test("a map that failed names its scene", () => {
    assert.equal(mapFailureText("Crypt"), "The map image for Crypt did not load. Check your connection.");
    assert.equal(mapFailureText(" "), "The map image did not load. Check your connection.");
  });
});
