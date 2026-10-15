import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapPhase, RoomState } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { carriedLightsNote, fogNote, lightOf, lightPatch, phaseWithLight, visionPatch } from "./settings.ts";

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
});
