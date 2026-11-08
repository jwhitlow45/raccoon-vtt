import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DAY_SECONDS, clockNow, lightAt } from "../calendar.ts";
import { chunkKey, keys } from "../keys.ts";
import type { BuildChunk, LightLevel, RoomState, SceneVision } from "../model.ts";
import { opSchema, type Op } from "../protocol.ts";
import type { Applied } from "../reducer.ts";
import { apply, room, scene } from "../testutil.ts";
import { H, fight, restore, run as runAt, withClock } from "./clockTesting.ts";

/**
 * Light that follows the time of day, and dawn and dusk
 * (docs/design/design-v1-calendar-c2c3.md 6 and the reducer rows of section
 * 10). s1 is on Time of day, s2 is lit by hand. The fight's rows are e1
 * (the goblin) and e2 (Bree's token).
 */

const FOLLOWS: SceneVision = { on: false, light: "bright", byClock: true };

let seq = 10;
function run(state: RoomState, op: Op): Applied {
  return runAt(state, op, ++seq);
}

function undo(state: RoomState, applied: Applied, scope: "play" | "setup" = "play"): Applied {
  return restore(state, applied.inverse!, "undo", ++seq, { scope });
}

/** A room whose clock reads `t`, with s1 following it at the level `t` gives and s2 Bright by hand. */
function lit(t: number, state: Partial<RoomState> = {}): RoomState {
  const s = withClock(t, {}, state);
  s.scenes.s1 = scene("s1", { vision: { ...FOLLOWS, light: lightAt(t) } });
  s.scenes.s2 = scene("s2", { order: 1, vision: { on: false, light: "bright" } });
  return s;
}

const light = (state: RoomState, id = "s1"): LightLevel | undefined => state.scenes[id]?.vision?.light;
const wroteScene = (applied: Applied): boolean => applied.touched.some((key) => key.startsWith("scene:"));

describe("the contract (6.1, 6.2)", () => {
  test("a stored vision holds byClock only as true, a patch true or false", () => {
    const create = (vision: object) => opSchema.safeParse({ t: "scene.create", scene: { id: "s9", name: "S", bounds: { w: 10, h: 10 }, vision } });
    assert.ok(create({ on: true, light: "dim", byClock: true }).success);
    assert.ok(!create({ on: true, light: "dim", byClock: false }).success, "a stored vision never holds false");
    const patch = (vision: object) => opSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { vision } });
    assert.ok(patch({ on: true, light: "dim", byClock: true }).success);
    assert.ok(patch({ on: true, light: "dim", byClock: false }).success);
  });

  test("dawn and dusk go on a clock update alone, in whole minutes within their halves of the day", () => {
    const update = (daylight: object) => opSchema.safeParse({ t: "clock.update", daylight });
    for (const daylight of [
      { dawn: 0, dusk: 12 * H },
      { dawn: 11 * H, dusk: 23 * H },
      { dawn: 5 * H + 30 * 60, dusk: 18 * H },
    ]) {
      assert.ok(update(daylight).success, JSON.stringify(daylight));
    }
    for (const daylight of [
      { dawn: 11 * H + 60, dusk: 18 * H },
      { dawn: 6 * H, dusk: 23 * H + 60 },
      { dawn: -60, dusk: 18 * H },
      { dawn: 6 * H, dusk: 12 * H - 60 },
      { dawn: 6 * H + 30, dusk: 18 * H },
      { dawn: 6 * H },
      { dawn: 6 * H, dusk: 18 * H, extra: 1 },
    ]) {
      assert.ok(!update(daylight).success, JSON.stringify(daylight));
    }
  });

  test("a vision patch without byClock keeps it, false clears it, and it is stored only while true", () => {
    const s = room();
    s.scenes.s1 = scene("s1", { vision: { on: true, light: "dim", perPlayer: true, byClock: true } });
    const kept = apply(s, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "dim" } } });
    assert.deepEqual(kept.scenes.s1!.vision, { on: false, light: "dim", perPlayer: true, byClock: true }, "Players see's patches keep it");
    const cleared = apply(kept, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", byClock: false } } });
    assert.deepEqual(cleared.scenes.s1!.vision, { on: false, light: "bright", perPlayer: true });
    const on = apply(cleared, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", perPlayer: false, byClock: true } } });
    assert.deepEqual(on.scenes.s1!.vision, { on: false, light: "bright", byClock: true });
    const created = apply(room(), { t: "scene.create", scene: { id: "s9", name: "S", bounds: { w: 10, h: 10 }, vision: { on: false, light: "dark", byClock: true } } });
    assert.deepEqual(created.scenes.s9!.vision, { on: false, light: "dark", byClock: true });
  });
});

describe("the pass (6.3)", () => {
  test("a step past dusk relights in the same op, as a global change, and its Undo takes it back", () => {
    const state = lit(17 * H + 30 * 60);
    const step = run(state, { t: "clock.advance", by: H });
    assert.equal(light(step.state), "dim");
    assert.equal(light(step.state, "s2"), "bright", "a scene lit by hand keeps its level");
    assert.ok(step.global);
    assert.equal(step.log.filter((line) => line.data?.type !== "clock").length, 0, "no line of its own");
    const back = undo(step.state, step);
    assert.equal(light(back.state), "bright");
    assert.equal(back.state.clock!.t, state.clock!.t);
  });

  test("Set, a Long Rest, Start, a new clock id and a Calendar save that moves the time all relight", () => {
    const state = lit(12 * H);
    assert.equal(light(run(state, { t: "clock.set", at: 22 * H }).state), "dark");
    assert.equal(light(run(state, { t: "clock.advance", by: 18 * H, why: "longRest" }).state), "dim");
    assert.equal(light(run(state, { t: "clock.update", at: 2 * H }).state), "dark");
    const stopped = run(state, { t: "clock.stop" }).state;
    assert.equal(light(stopped), "bright", "a stopped clock leaves the level");
    assert.equal(stopped.scenes.s1!.vision!.byClock, true, "and the flag");
    assert.equal(light(run(stopped, { t: "clock.start", id: "c2", at: 6 * H, shown: true, calendar: { kind: "days" } }).state), "dim");
  });

  test("a step that crosses no part of the day writes no scene", () => {
    const step = run(lit(9 * H), { t: "clock.advance", by: H });
    assert.equal(wroteScene(step), false);
  });

  test("rounds alone never relight: Next and Previous write no scene, and the fight's end darkens the map", () => {
    let state = lit(18 * H - 30, { encounter: fight(1) });
    for (let i = 0; i < 12; i++) {
      const next = run(state, { t: "encounter.next" });
      assert.equal(wroteScene(next), false, `Next ${i}`);
      state = next.state;
    }
    assert.ok(clockNow(state.clock!, state.encounter) >= 18 * H, "the rounds reached dusk");
    assert.equal(light(state), "bright");
    const prev = run(state, { t: "encounter.prev" });
    assert.equal(wroteScene(prev), false);
    const end = run(state, { t: "encounter.end" });
    assert.equal(light(end.state), "dim");
    // Undo of the end moves the clock back, so the level reads the time with the fight's rounds, past dusk.
    const back = undo(end.state, end);
    assert.equal(back.state.encounter!.round, state.encounter!.round);
    assert.equal(light(back.state), "dim");
  });

  test("past dusk by rounds, a door, a paint, another scene's weather and an unrelated Undo relight nothing", () => {
    let state = lit(18 * H - 30, { encounter: fight(1) });
    state.buildChunks[chunkKey("s1", 0, 0)] = doorChunk();
    for (let i = 0; i < 12; i++) state = run(state, { t: "encounter.next" }).state;
    const door = run(state, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open" });
    assert.equal(light(door.state), "bright");
    assert.ok(!door.inverse!.some((entry) => entry.key === keys.scene("s1")), "the door's undo holds no scene");
    const paint = run(state, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    assert.equal(light(paint.state), "bright");
    assert.ok(!paint.inverse!.some((entry) => entry.key === keys.scene("s1")));
    const weather = run(state, { t: "scene.update", sceneId: "s2", patch: { weather: { kind: "rain", heavy: true } } });
    assert.equal(light(weather.state), "bright");
    const move = run(state, { t: "token.move", tokenId: "gob", x: 5, y: 5 });
    const back = undo(move.state, move);
    assert.equal(wroteScene(back), false);
    assert.equal(light(back.state), "bright");
  });

  test("a fight that goes by an Undo of its start relights from the time without its rounds", () => {
    let state = lit(18 * H - 30, { encounter: null });
    const start = run(state, { t: "encounter.start", entries: [{ id: "e1", tokenId: "gob", value: 15 }, { id: "e2", tokenId: "bree-t", value: 5 }] });
    state = start.state;
    for (let i = 0; i < 12; i++) state = run(state, { t: "encounter.next" }).state;
    // A step while the rounds stand past dusk lights the scene by them.
    state = run(state, { t: "clock.advance", by: 1 }).state;
    assert.equal(light(state), "dim");
    // With the fight gone, its rounds leave the current time, which reads before dusk again.
    const gone = restore(state, [{ key: keys.encounter, value: null }, { key: keys.encounterHistory, value: [] }], "undo", ++seq, { scope: "play" });
    assert.equal(gone.state.encounter, null);
    assert.equal(light(gone.state), "bright");
  });

  test("an Undo of a step made before the scene followed the clock relights it from the restored time", () => {
    const state = lit(12 * H);
    state.scenes.s2 = scene("s2", { order: 1, vision: { on: false, light: "bright" } });
    const step = run(state, { t: "clock.advance", by: 10 * H });
    const follows = run(step.state, { t: "scene.update", sceneId: "s2", patch: { vision: { on: false, light: "bright", byClock: true } } });
    assert.equal(light(follows.state, "s2"), "dark", "picking Time of day reads the time then");
    const back = undo(follows.state, step);
    assert.equal(light(back.state, "s2"), "bright");
  });
});

describe("what turns it off and what keeps it (5.1, 6.3)", () => {
  test("Bright, Dim or Dark picked by hand turns it off, and Players see's patch keeps it", () => {
    const state = lit(22 * H);
    const bright = run(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", byClock: false } } }).state;
    assert.deepEqual(bright.scenes.s1!.vision, { on: false, light: "bright" });
    const party = run(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" } } }).state;
    assert.deepEqual(party.scenes.s1!.vision, { on: true, light: "dark", byClock: true });
  });

  test("a phase with its own light turns it off, one that leaves the light keeps it and reads the time", () => {
    const night = { id: "night", name: "Night", assetId: "a-night", widthPx: 1920, heightPx: 1080, light: "dark" as const };
    const day = { id: "day", name: "Day", assetId: "a-day", widthPx: 1920, heightPx: 1080 };
    let state = lit(13 * H);
    state.scenes.s1 = { ...state.scenes.s1!, map: { assetId: "a-day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } } };
    state = run(state, { t: "scene.update", sceneId: "s1", patch: { phases: [day, night] } }).state;
    assert.equal(state.scenes.s1!.vision!.byClock, true);
    const dark = run(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "night" }).state;
    assert.deepEqual(dark.scenes.s1!.vision, { on: false, light: "dark" });
    // A scene left Dim by hand while the time reads Bright, then a phase that leaves the light: the switch reads the time.
    const stale = { ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1!, phaseId: "night", vision: { ...FOLLOWS, light: "dim" as const } } } };
    const leave = run(stale, { t: "scene.setPhase", sceneId: "s1", phaseId: "day" }).state;
    assert.deepEqual(leave.scenes.s1!.vision, { on: false, light: "bright", byClock: true });
  });

  test("Copy to other scenes and Like <scene> follow too, their levels from the clock", () => {
    const state = lit(19 * H + 30 * 60);
    const copied = run(state, { t: "scene.update", sceneId: "s2", patch: { vision: { on: false, light: "bright", byClock: true } } }).state;
    assert.deepEqual(copied.scenes.s2!.vision, { on: false, light: "dark", byClock: true });
    const like = run(state, { t: "scene.create", scene: { id: "s9", name: "Crypt", bounds: { w: 10, h: 10 }, vision: { on: false, light: "bright", byClock: true } } }).state;
    assert.equal(light(like, "s9"), "dark");
  });

  test("a level follows dawn and dusk as the DM set them", () => {
    const state = lit(5 * H + 45 * 60);
    assert.equal(light(state), "dark");
    const early = run(state, { t: "clock.update", daylight: { dawn: 5 * H + 30 * 60, dusk: 18 * H } });
    assert.equal(light(early.state), "dim");
    assert.equal(light(undo(early.state, early, "setup").state), "dark");
    const next = run(early.state, { t: "clock.advance", by: DAY_SECONDS });
    assert.equal(light(next.state), "dim");
  });

  test("dawn and dusk saved alone write the clock and no line, keep the time, and Start keeps none", () => {
    const state = lit(12 * H);
    const saved = run(state, { t: "clock.update", daylight: { dawn: 5 * H, dusk: 20 * H } });
    assert.deepEqual(saved.state.clock!.daylight, { dawn: 5 * H, dusk: 20 * H });
    assert.equal(saved.state.clock!.t, 12 * H);
    assert.equal(saved.log.length, 0);
    const stopped = run(saved.state, { t: "clock.stop" }).state;
    const fresh = run(stopped, { t: "clock.start", id: "c2", at: 12 * H, shown: true, calendar: { kind: "days" } }).state;
    assert.equal(fresh.clock!.daylight, undefined);
  });
});

function doorChunk(): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "9,5,w": { kind: "door", state: "closed", secret: false, discovered: false } } };
}
