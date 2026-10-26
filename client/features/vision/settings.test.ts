import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapPhase, RoomState } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { carriedLightsNote, fogNote, lightOf, lightPatch, phaseWithLight, SIGHT_CHOICES, sightOf, sightPatch, sightShown, sightWorkingText, visionOnHelp, visionPatch, visionPending } from "./settings.ts";

const phase = (id: string, patch: Partial<MapPhase> = {}): MapPhase => ({ id, name: id, assetId: `a-${id}`, widthPx: 800, heightPx: 600, ...patch });

describe("a scene's Vision settings", () => {
  test("turning vision on or off keeps the light level, which starts Bright", () => {
    assert.equal(lightOf({}), "bright");
    assert.deepEqual(visionPatch({}, true), { on: true, light: "bright" });
    assert.deepEqual(visionPatch({ vision: { on: true, light: "dark" } }, false), { on: false, light: "dark" });
  });

  test("the light level changes without turning vision on", () => {
    assert.deepEqual(lightPatch({}, "dim"), { on: false, light: "dim" });
    assert.deepEqual(lightPatch({ vision: { on: true, light: "bright" } }, "dark"), { on: true, light: "dark" });
  });

  test("a phase's light is set or taken off, and the rest of the list is untouched", () => {
    const day = phase("day");
    const night = phase("night", { light: "dark" });
    const list = [day, night];
    const lit = phaseWithLight(list, "day", "bright")!;
    assert.deepEqual(lit[0], { ...day, light: "bright" });
    assert.equal(lit[1], night);
    const off = phaseWithLight(list, "night", null)!;
    assert.equal("light" in off[1]!, false);
    assert.equal(phaseWithLight(list, "night", "dark"), null, "no change, no op");
    assert.equal(phaseWithLight(list, "dusk", "dim"), null);
    assert.equal(phaseWithLight(undefined, "day", "dim"), null);
  });

  test("with fog off, explored ground is not remembered, and the settings say so", () => {
    assert.equal(fogNote({ fogEnabled: false }).warning, true);
    assert.match(fogNote({ fogEnabled: false }).text, /^Explored ground is not remembered while fog is off\./);
    assert.equal(fogNote({ fogEnabled: true }).warning, false);
  });

  test("past 20 lit token lights the DM is told how many light nothing, not counting tokens the DM hid", () => {
    const tokens: RoomState["tokens"] = {};
    const add = (id: string, patch: Parameters<typeof token>[1] = {}) => (tokens[id] = token(id, { light: { bright: 20, dim: 20 }, ...patch }));
    for (let k = 0; k < 20; k++) add(`t${k}`);
    add("hidden", { visibility: "dm" });
    add("elsewhere", { sceneId: "s2" });
    add("unlit", { light: { bright: 0, dim: 0 } });
    assert.equal(carriedLightsNote(tokens, "s1", "dark"), null);
    add("pc", { kind: "pc", ownerIds: ["p1"] });
    assert.equal(carriedLightsNote(tokens, "s1", "dark"), "1 carried light lights nothing for the party: at most 20 do, the party's own first.");
    add("t20");
    add("t21");
    assert.equal(carriedLightsNote(tokens, "s1", "dark"), "3 carried lights light nothing for the party: at most 20 do, the party's own first.");
    assert.equal(carriedLightsNote(tokens, "s1", "dim"), "3 carried lights light nothing for the party: at most 20 do, the party's own first.");
    // In a Bright scene lights change nothing for the party, so the note stays away.
    assert.equal(carriedLightsNote(tokens, "s1", "bright"), null);
  });

  test("the Sight row's patch keeps party vision and the light, and the other two name no perPlayer, so the scene keeps it (docs/design-v1-per-player-vision.md 6.7)", () => {
    const perPlayer = { vision: { on: false, light: "dark" as const, perPlayer: true as const } };
    assert.deepEqual(sightPatch({ vision: { on: true, light: "dim" } }, true), { on: true, light: "dim", perPlayer: true });
    assert.deepEqual(sightPatch(perPlayer, false), { on: false, light: "dark", perPlayer: false });
    assert.equal("perPlayer" in visionPatch(perPlayer, true), false);
    assert.equal("perPlayer" in lightPatch(perPlayer, "dim"), false);
    assert.equal(sightOf(perPlayer), "player");
    assert.equal(sightOf({ vision: { on: true, light: "bright" } }), "party");
    assert.equal(sightOf({}), "party");
  });

  test("the Sight row shows while party vision is on or the scene is per player, and its words (7.1)", () => {
    assert.equal(sightShown({}), false);
    assert.equal(sightShown({ vision: { on: false, light: "dark" } }), false);
    assert.equal(sightShown({ vision: { on: true, light: "dark" } }), true);
    assert.equal(sightShown({ vision: { on: false, light: "dark", perPlayer: true } }), true, "a per-player scene with vision off keeps the row, so the DM can switch it back");
    assert.deepEqual(
      SIGHT_CHOICES.map((c) => [c.label, c.help]),
      [
        ["Whole party", "Every player sees what any party creature sees, and the party shares one map."],
        ["Per player", "Each player sees only what their own creatures see, and creatures that share sight with the party. Each player keeps their own map of where they have been. At most 6 players per scene."],
      ],
    );
    assert.equal(visionOnHelp({ vision: { on: true, light: "dark", perPlayer: true } }), "On: each player sees only what their own creatures see, by their senses and the light around them.");
    assert.equal(visionOnHelp({ vision: { on: true, light: "dark" } }), "On: players see only what their characters see, by their own senses and the light around them.");
    assert.equal(sightWorkingText(true), "Working out what each player sees…");
    assert.equal(sightWorkingText(false), "Working out what the party sees…");
  });

  test("the switch waits only on its own and the Light's changes, the row and the list on theirs, and the last says which way (7.1)", () => {
    const op = (vision: Parameters<typeof sightPatch>[0]["vision"] & object, perPlayer?: boolean) => ({ op: { t: "scene.update" as const, sceneId: "s1", patch: { vision: perPlayer === undefined ? vision : { ...vision, perPlayer } } } });
    const dark = { on: true, light: "dark" as const };
    assert.deepEqual(visionPending([], "s1"), { vision: false, sight: null });
    assert.deepEqual(visionPending([op(dark)], "s1"), { vision: true, sight: null });
    assert.deepEqual(visionPending([op(dark, true)], "s1"), { vision: false, sight: "player" });
    assert.deepEqual(visionPending([op(dark, true), op(dark, false)], "s1"), { vision: false, sight: "party" });
    assert.deepEqual(visionPending([op(dark, false), { op: { t: "vision.holders", sceneId: "s1", on: ["p1"] } }], "s1"), { vision: false, sight: "player" });
    assert.deepEqual(visionPending([op(dark, true), { op: { t: "vision.holders", sceneId: "s2", on: [] } }], "s2"), { vision: false, sight: "player" }, "only the scene's own");
    assert.deepEqual(visionPending([op(dark, true)], "s2"), { vision: false, sight: null });
    assert.deepEqual(visionPending([{ op: { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } } }], "s1"), { vision: false, sight: null });
  });
});
