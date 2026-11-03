import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectState } from "./project.ts";
import { clientOpSchema, type Op } from "./protocol.ts";
import { guardHash } from "./reducer/tx.ts";
import { apply, DM, P1, room, scene } from "./testutil.ts";
import { DEFAULT_TOWARD, WEATHER_KINDS, WEATHER_PROBLEMS, normalWeather, sceneWeatherSchema, weatherName, weatherParts, weatherProblem, type SceneWeather } from "./weather.ts";

/** A scene's weather, its one stored form and who receives it (docs/design/design-v1-weather.md 9, lane WX-A). */

const WINDS = [undefined, "moderate", "strong"] as const;

/** Every kind by strength by wind, the space the picker draws from. */
function everyWeather(): SceneWeather[] {
  const out: SceneWeather[] = [];
  for (const kind of WEATHER_KINDS)
    for (const heavy of [false, true])
      for (const wind of WINDS) {
        const w: SceneWeather = { kind };
        if (heavy) w.heavy = true;
        if (wind) w.wind = wind;
        out.push(w);
      }
  return out;
}

const setWeather = (weather: SceneWeather | null, sceneId = "s1"): Op => ({ t: "scene.update", sceneId, patch: { weather } });

function road(): RoomState {
  return room({ scenes: { s1: scene("s1", { name: "Forest road" }), s2: scene("s2", { name: "Cave" }) } });
}

describe("which weather can be", () => {
  test("fog refuses strong wind, a sandstorm needs it, and clear needs a wind and no strength", () => {
    for (const w of everyWeather()) {
      const expected =
        w.kind === "fog" && w.wind === "strong"
          ? WEATHER_PROBLEMS.fogWind
          : w.kind === "sand" && w.heavy && w.wind !== "strong"
            ? WEATHER_PROBLEMS.sandstorm
            : w.kind === "clear" && w.heavy
              ? WEATHER_PROBLEMS.clearHeavy
              : w.kind === "clear" && !w.wind
                ? WEATHER_PROBLEMS.clearCalm
                : null;
      assert.equal(weatherProblem(w), expected, JSON.stringify(w));
    }
    assert.equal(weatherProblem({ kind: "fog", heavy: true, wind: "moderate" }), null);
    assert.equal(weatherProblem({ kind: "sand", heavy: true, wind: "strong" }), null);
    assert.equal(weatherProblem({ kind: "clear", wind: "strong" }), null, "a windy clear day");
  });

  test("the schema refuses the same weather in the picker's words, and every bad field", () => {
    for (const w of everyWeather()) {
      const parsed = sceneWeatherSchema.safeParse(w);
      const problem = weatherProblem(w);
      assert.equal(parsed.success, problem === null, JSON.stringify(w));
      if (!parsed.success) assert.equal(parsed.error.issues[0]!.message, problem);
    }
    for (const bad of [
      { kind: "hail" },
      { kind: "rain", heavy: false },
      { kind: "rain", wind: "gale" },
      { kind: "rain", wind: "strong", toward: 30 },
      { kind: "rain", wind: "strong", toward: 360 },
      { kind: "rain", wind: "strong", toward: -45 },
      { kind: "rain", rules: true },
      { kind: "rain", extra: 1 },
      {},
    ]) {
      assert.equal(sceneWeatherSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    for (const toward of [0, 45, 90, 135, 180, 225, 270, 315]) assert.ok(sceneWeatherSchema.safeParse({ kind: "rain", wind: "moderate", toward }).success, String(toward));
  });

  test("one stored form: no toward without a wind or at the default, nothing light or on", () => {
    assert.deepEqual(normalWeather({ kind: "rain", toward: 90 }), { kind: "rain" });
    assert.deepEqual(normalWeather({ kind: "rain", wind: "strong", toward: DEFAULT_TOWARD }), { kind: "rain", wind: "strong" });
    assert.deepEqual(normalWeather({ kind: "rain", wind: "strong", toward: 270 }), { kind: "rain", wind: "strong", toward: 270 });
    assert.deepEqual(normalWeather({ kind: "snow", heavy: true, rules: false }), { kind: "snow", heavy: true, rules: false });
    const longhand = { kind: "ash", heavy: undefined, wind: undefined, toward: undefined, rules: undefined } as unknown as SceneWeather;
    assert.deepEqual(Object.keys(normalWeather(longhand)), ["kind"]);
    for (const w of everyWeather()) assert.deepEqual(normalWeather(normalWeather(w)), normalWeather(w), "normalWeather is idempotent");
  });

  test("names for summaries, sources and the status", () => {
    const named: [SceneWeather, string, string[]][] = [
      [{ kind: "rain" }, "Light rain", ["Light rain"]],
      [{ kind: "rain", heavy: true, wind: "strong" }, "Heavy rain", ["Heavy rain", "Strong wind"]],
      [{ kind: "snow" }, "Light snow", ["Light snow"]],
      [{ kind: "snow", heavy: true }, "Heavy snow", ["Heavy snow"]],
      [{ kind: "fog" }, "Patchy fog", ["Patchy fog"]],
      [{ kind: "fog", heavy: true, wind: "moderate" }, "Heavy fog", ["Heavy fog", "Moderate wind"]],
      [{ kind: "leaves" }, "Falling leaves", ["Falling leaves"]],
      [{ kind: "leaves", heavy: true }, "Heavy falling leaves", ["Heavy falling leaves"]],
      [{ kind: "ash" }, "Ash", ["Ash"]],
      [{ kind: "ash", heavy: true }, "Heavy ash", ["Heavy ash"]],
      [{ kind: "sand", wind: "moderate" }, "Blowing sand", ["Blowing sand", "Moderate wind"]],
      [{ kind: "sand", heavy: true, wind: "strong" }, "Sandstorm", ["Sandstorm", "Strong wind"]],
      [{ kind: "clear", wind: "strong" }, "Strong wind", ["Strong wind"]],
      [{ kind: "clear", wind: "moderate" }, "Moderate wind", ["Moderate wind"]],
    ];
    for (const [w, name, parts] of named) {
      assert.equal(weatherName(w), name);
      assert.deepEqual(weatherParts(w), parts);
    }
    assert.deepEqual(weatherParts(undefined), []);
  });
});

describe("a scene's weather in the room", () => {
  test("the op stores its one form, null removes it, and a scene cleared hashes as it did", () => {
    const state = road();
    const hash = guardHash(keys.scene("s1"), state.scenes.s1);
    const rainy = apply(state, setWeather({ kind: "rain", heavy: true, wind: "strong", toward: DEFAULT_TOWARD }));
    assert.deepEqual(rainy.scenes.s1!.weather, { kind: "rain", heavy: true, wind: "strong" });
    assert.equal(rainy.scenes.s2!.weather, undefined, "only its own scene");
    assert.deepEqual(apply(state, setWeather({ kind: "snow", toward: 90 })).scenes.s1!.weather, { kind: "snow" }, "no toward without a wind");
    const cleared = apply(rainy, setWeather(null));
    assert.ok(!("weather" in cleared.scenes.s1!));
    assert.equal(guardHash(keys.scene("s1"), cleared.scenes.s1), hash);
    assert.deepEqual(apply(rainy, { t: "scene.update", sceneId: "s1", patch: { name: "Muddy road" } }).scenes.s1!.weather, rainy.scenes.s1!.weather, "a patch without it keeps it");
  });

  test("the op schema refuses an impossible weather, and a new scene takes none", () => {
    for (const weather of [{ kind: "fog", wind: "strong" }, { kind: "sand", heavy: true }, { kind: "clear" }, { kind: "clear", heavy: true, wind: "strong" }]) {
      const parsed = clientOpSchema.safeParse(setWeather(weather as SceneWeather));
      assert.equal(parsed.success, false, JSON.stringify(weather));
    }
    assert.ok(clientOpSchema.safeParse(setWeather(null)).success);
    assert.ok(clientOpSchema.safeParse(setWeather({ kind: "clear", wind: "strong", toward: 0 })).success);
    assert.equal(clientOpSchema.safeParse({ t: "scene.create", scene: { id: "s9", name: "Mat", bounds: { w: 10, h: 10 }, weather: { kind: "rain" } } }).success, false);
  });

  test("the DM's alone: a player's patch is refused", () => {
    const state = road();
    assert.ok(canApply(setWeather({ kind: "rain" }), DM, state, { canUseAsset: () => true }).ok);
    const refused = canApply(setWeather({ kind: "rain" }), P1, state, { canUseAsset: () => true });
    assert.equal(refused.ok ? "" : refused.code, "forbidden");
  });

  test("a player and a table display receive only the weather of the players' scene", () => {
    let state = apply(road(), setWeather({ kind: "rain", heavy: true }));
    state = apply(state, setWeather({ kind: "fog", heavy: true }, "s2"));
    state.meta = { ...state.meta, playerSceneId: "s1" };
    for (const viewer of [P1, { memberId: "display:abcdefghijkl", role: "player" as const }]) {
      const seen = projectState(state, viewer, { sceneId: "s1" });
      assert.deepEqual(seen.scenes.s1!.weather, { kind: "rain", heavy: true });
      assert.equal(seen.scenes.s2, undefined, "the DM's other scene, its weather with it, never leaves");
      assert.ok(!JSON.stringify(seen).includes("fog\",\"heavy"), "the other scene's weather is nowhere in the copy");
    }
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).scenes.s2!.weather, { kind: "fog", heavy: true });
    assert.ok(!("weather" in projectState(road(), P1, { sceneId: "s1" }).scenes.s1!), "absent stays absent");
  });

  test("a duplicate copies it", () => {
    const state = apply(road(), setWeather({ kind: "leaves", wind: "moderate", toward: 45 }));
    const copy = apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Forest road (copy)", include: { creatures: false, characters: false, fog: false, drawings: false } });
    assert.deepEqual(copy.scenes.s3!.weather, { kind: "leaves", wind: "moderate", toward: 45 });
  });
});
