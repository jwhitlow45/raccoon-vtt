import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogTile, RoomState, Scene } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { PLAYERS_SEE_WORDS } from "#shared/playersSee.ts";
import { withPhaseLight } from "#shared/reducer/phases.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import {
  CUSTOM_TEXT,
  exploredHere,
  holdersExploredHere,
  intentPatch,
  intentTo,
  JOIN_MAPS_TEXT,
  LEAVE_EXPLORE_TEXT,
  leaveQuestion,
  leavesExplore,
  likeSummary,
  PLAYERS_SEE,
  playersSeeLabel,
  playersSeeOf,
  presetPatch,
  sightQuestion,
  walllessFile,
  walllessImage,
} from "./playersSeeRules.ts";

/** Players see (docs/design-v1-map-discovery.md 8.1, decisions 10 and 16). */

const MAP = { assetId: "a", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };

describe("Players see's presets", () => {
  test("each pair of switches reads as its preset, and fog off with vision on as Custom", () => {
    assert.equal(playersSeeOf({ fogEnabled: true, vision: { on: true, light: "dark" } }), "explore");
    assert.equal(playersSeeOf({ fogEnabled: true, vision: { on: false, light: "dark" } }), "reveal");
    assert.equal(playersSeeOf({ fogEnabled: true }), "reveal", "a scene from before vision");
    assert.equal(playersSeeOf({ fogEnabled: false }), "all");
    assert.equal(playersSeeOf({ fogEnabled: false, vision: { on: true, light: "bright", perPlayer: true } }), "custom");
    assert.deepEqual(PLAYERS_SEE.map((p) => p.label), ["Explore", "Reveal by hand", "Everything"]);
    assert.equal(playersSeeLabel("custom"), "Custom");
    assert.match(CUSTOM_TEXT, /^Custom: party vision is on and fog is off/);
    // The server's undo names read the same words (shared/playersSee.ts).
    assert.deepEqual(PLAYERS_SEE.map((p) => PLAYERS_SEE_WORDS[p.value]), ["Explore", "Reveal by hand", "Everything"]);
  });

  test("a preset is one scene.update of fog and party vision that keeps the light and Sight, and the scene then reads as it", () => {
    const dark: Scene = scene("s1", { fogEnabled: false, vision: { on: false, light: "dark", perPlayer: true } });
    for (const preset of ["explore", "reveal", "all"] as const) {
      const patch = presetPatch(dark, preset);
      assert.equal("perPlayer" in patch.vision, false, "Sight is not the preset's");
      assert.equal(patch.vision.light, "dark");
      const op = { t: "scene.update" as const, sceneId: "s1", patch };
      assert.ok(clientOpSchema.safeParse(op).success, preset);
      const after = apply(room({ scenes: { s1: dark } }), op).scenes.s1!;
      assert.equal(playersSeeOf(after), preset);
      assert.equal(after.vision?.perPlayer, true, "the scene stays per player");
      assert.equal(after.vision?.light, "dark");
    }
    assert.deepEqual(presetPatch(scene("s1"), "explore"), { fogEnabled: true, vision: { on: true, light: "bright" } });
    assert.deepEqual(presetPatch(scene("s1"), "all"), { fogEnabled: false, vision: { on: false, light: "bright" } });
  });
});

describe("a change built as it goes, from the scene as it is then (MS1-ASTRA-01)", () => {
  const asked = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });

  test("a preset asked on Explore and Dark keeps a light changed while its question was open, by Light or a phase's light", () => {
    assert.equal(intentTo(asked, { preset: "reveal" }), "reveal");
    assert.deepEqual(intentPatch(asked, { preset: "reveal" }), { fogEnabled: true, vision: { on: false, light: "dark" } });
    const bright: Scene = { ...asked, vision: { on: true, light: "bright" } };
    assert.deepEqual(intentPatch(bright, { preset: "reveal" }), { fogEnabled: true, vision: { on: false, light: "bright" } });
    // Switching to a phase with a light, or setting the showing phase's, sets the scene's light.
    const dim = withPhaseLight(asked, { light: "dim" });
    assert.deepEqual(intentPatch(dim, { preset: "all" }), { fogEnabled: false, vision: { on: false, light: "dim" } });
  });

  test("the switches keep the light too, and party vision on turns fog on with it", () => {
    const bright: Scene = { ...asked, vision: { on: true, light: "bright" } };
    assert.equal(intentTo(asked, { partyVision: false }), "reveal");
    assert.deepEqual(intentPatch(bright, { partyVision: false }), { vision: { on: false, light: "bright" } });
    assert.equal(intentTo(asked, { fog: false }), "custom");
    assert.deepEqual(intentPatch(bright, { fog: false }), { fogEnabled: false });
    const everything = scene("s1", { fogEnabled: false, vision: { on: false, light: "dim" } });
    assert.equal(intentTo(everything, { partyVision: true }), "explore", "the reducer turns fog on with party vision");
    assert.deepEqual(intentPatch(everything, { partyVision: true }), { vision: { on: true, light: "dim" } });
  });

  test("a change the scene already made, here or on another device, sends nothing", () => {
    const reveal: Scene = { ...asked, vision: { on: false, light: "dark" } };
    assert.equal(intentPatch(reveal, { preset: "reveal" }), null);
    assert.equal(intentPatch(reveal, { partyVision: false }), null);
    assert.equal(intentPatch(scene("s1", { fogEnabled: false }), { fog: false }), null);
    assert.notEqual(intentPatch(reveal, { preset: "explore" }), null);
  });
});

describe("what a change asks first", () => {
  test("leaving Explore where players explored asks, from the preset or a switch, and nothing else does", () => {
    assert.equal(leaveQuestion("explore", "reveal", true), LEAVE_EXPLORE_TEXT);
    assert.equal(leaveQuestion("explore", "all", true), LEAVE_EXPLORE_TEXT);
    assert.equal(leaveQuestion("explore", "custom", true), LEAVE_EXPLORE_TEXT, "fog off forgets memory too");
    assert.equal(leaveQuestion("explore", "reveal", false), null, "nothing explored, nothing to forget");
    assert.equal(leaveQuestion("reveal", "all", true), null);
    assert.equal(leaveQuestion("custom", "all", true), null, "Custom keeps no memory");
    assert.equal(leaveQuestion("reveal", "explore", true), null);
    assert.equal(leavesExplore("explore", "explore"), false);
  });

  test("Whole party asks only from a per-player scene where some player holds a map of their own", () => {
    const per = { vision: { on: true, light: "bright" as const, perPlayer: true as const } };
    assert.equal(sightQuestion(per, false, true), JOIN_MAPS_TEXT);
    assert.equal(sightQuestion(per, false, false), null);
    assert.equal(sightQuestion(per, true, true), null);
    assert.equal(sightQuestion({ vision: { on: true, light: "bright" } }, false, true), null);
  });

  test("explored ground is read from the party's layer, or any holder's joined, of that scene only", () => {
    const tile = (sceneId: string): FogTile => ({ sceneId, tx: 0, ty: 0, rev: 1, bits: "" });
    const view = room();
    assert.equal(exploredHere(view, "s1"), false);
    assert.equal(exploredHere({ ...view, exploredTiles: { "s2:0,0": tile("s2") } }, "s1"), false);
    assert.equal(exploredHere({ ...view, exploredTiles: { "s1:0,0": tile("s1") } }, "s1"), true);
    const holders = { ...view, exploredAny: { "s1:0,0": tile("s1") } } as RoomState;
    assert.equal(exploredHere(holders, "s1"), true);
    assert.equal(holdersExploredHere(holders, "s1"), true);
    assert.equal(holdersExploredHere({ ...view, exploredTiles: { "s1:0,0": tile("s1") } }, "s1"), false, "the party's layer is not a player's own");
  });
});

describe("the warnings and Like's line", () => {
  test("a map image with nothing that blocks sight is wall-less, and so is a file of windows", () => {
    assert.equal(walllessImage({ map: MAP }, 0), true);
    assert.equal(walllessImage({ map: MAP }, 4), false);
    assert.equal(walllessImage({}, 0), false, "a mat or a builder scene has no art to show");
    assert.equal(walllessFile([]), true);
    assert.equal(walllessFile([{ kind: "window" }]), true);
    assert.equal(walllessFile([{ kind: "window" }, { kind: "door" }]), false);
    assert.equal(walllessFile([{ kind: "wall" }]), false);
  });

  test("Like lists what it copies by each control's own word", () => {
    assert.equal(likeSummary({ fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true }, blockMovement: true }), "Explore, Dark, Per player, players' moves blocked");
    assert.equal(likeSummary({ fogEnabled: false }), "Everything, Bright, Whole party, players' moves not blocked");
  });
});
