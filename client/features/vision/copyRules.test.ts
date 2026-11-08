import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import { COPY_BUTTON, COPY_BUTTON_HELP, COPY_UNDO, copiedAll, copiesNothing, copyButtonText, copyLine, copyNotes, copyPatch, copyResult, copyTitle, MAPS_JOIN, MAPS_RESET, PLAYERS_HERE } from "./copyRules.ts";
import { playersSeeOf } from "./playersSeeRules.ts";

/** "Copy to other scenes…" (docs/design/design-v1-map-discovery.md 8.3, decision 18, docs/design/design-v1-scenes-reorg.md 6). */

const crypt = scene("s1", { name: "Crypt", fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true }, blockMovement: true, autoWalls: "floor" });

describe("using a scene's vision settings on others", () => {
  test("the copy sets Players see, the light and Sight, and leaves movement and walls as they are", () => {
    const patch = copyPatch(crypt);
    assert.deepEqual(patch, { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true, byClock: false } });
    const hall = scene("s2", { name: "Hall", fogEnabled: false, blockMovement: false, autoWalls: "off" });
    const op = { t: "scene.update" as const, sceneId: "s2", patch };
    assert.ok(clientOpSchema.safeParse(op).success);
    const after = apply(room({ scenes: { s1: crypt, s2: hall } }), op).scenes.s2!;
    assert.equal(playersSeeOf(after), "explore");
    assert.deepEqual(after.vision, { on: true, light: "dark", perPlayer: true });
    assert.equal(after.blockMovement, false);
    assert.equal(after.autoWalls, "off");
    // A whole-party source folds a per-player scene back, and one from before vision copies as Reveal by hand in Bright.
    assert.deepEqual(copyPatch(scene("s3", { fogEnabled: true })), { fogEnabled: true, vision: { on: false, light: "bright", perPlayer: false, byClock: false } });
  });

  test("a Time of day scene copies the flag, and any other turns it off on the scene it lands on", () => {
    const dusk = scene("s4", { fogEnabled: true, vision: { on: true, light: "dim", byClock: true } });
    const patch = copyPatch(dusk);
    assert.deepEqual(patch.vision, { on: true, light: "dim", perPlayer: false, byClock: true });
    assert.ok(clientOpSchema.safeParse({ t: "scene.update", sceneId: "s2", patch }).success);
    assert.equal(copiesNothing(scene("s2", { fogEnabled: true, vision: { on: true, light: "dim" } }), patch), false, "same level, but not following");
    assert.equal(copiesNothing(scene("s2", { fogEnabled: true, vision: { on: true, light: "dim", byClock: true } }), patch), true);
    assert.equal(copyPatch(scene("s5", { fogEnabled: true, vision: { on: true, light: "dim" } })).vision.byClock, false);
  });

  test("a scene that already has the settings needs nothing sent", () => {
    const patch = copyPatch(crypt);
    assert.equal(copiesNothing(scene("s2", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } }), patch), true);
    assert.equal(copiesNothing(scene("s2", { fogEnabled: true, vision: { on: true, light: "dim", perPlayer: true } }), patch), false);
    assert.equal(copiesNothing(scene("s2", { fogEnabled: true, vision: { on: true, light: "dark" } }), patch), false, "Sight differs");
    assert.equal(copiesNothing(scene("s2", { fogEnabled: false, vision: { on: true, light: "dark", perPlayer: true } }), patch), false);
  });

  test("a scene's line says where the players are, a reset of remembered maps, and per-player maps joining", () => {
    const whole = copyPatch(scene("s0", { fogEnabled: true }));
    const explore = scene("s2", { name: "Hall", fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } });
    assert.deepEqual(copyNotes(explore, whole, "s2"), [PLAYERS_HERE, MAPS_RESET, MAPS_JOIN]);
    assert.deepEqual(copyNotes(explore, whole, "s1"), [MAPS_RESET, MAPS_JOIN]);
    assert.deepEqual(copyNotes(scene("s2", { fogEnabled: true }), copyPatch(crypt), null), [], "Reveal by hand to Explore forgets nothing");
    assert.deepEqual(copyNotes(scene("s2", { fogEnabled: true }), whole, "s2"), [], "a scene the copy leaves as it is says nothing, the players' scene included");
    // Explore to Custom drops memory too, since fog goes off.
    assert.deepEqual(copyNotes(scene("s2", { fogEnabled: true, vision: { on: true, light: "bright" } }), copyPatch(scene("s0", { fogEnabled: false, vision: { on: true, light: "bright" } })), null), [MAPS_RESET]);
    assert.equal(copyLine(explore, whole, "s2"), `Explore. ${PLAYERS_HERE} ${MAPS_RESET} ${MAPS_JOIN}`);
    assert.equal(copyLine(scene("s2", { fogEnabled: false }), whole, null), "Everything.");
  });

  test("the button's and the sheet's words", () => {
    assert.equal(COPY_BUTTON, "Copy to other scenes…");
    assert.equal(COPY_BUTTON_HELP, "Copies Players see, Light and Sight.");
    assert.equal(copyTitle("Crypt"), "Copy Crypt's settings to…");
    assert.equal(copyButtonText(1), "Copy to 1 scene");
    assert.equal(copyButtonText(3), "Copy to 3 scenes");
    assert.equal(copyResult([{ name: "A", answer: "taken" }, { name: "B", answer: "taken" }, { name: "C", answer: "taken" }]), "Copied to 3 scenes.");
    assert.equal(copyResult([{ name: "A", answer: "taken" }]), "Copied to 1 scene.");
    // Only a full copy clears the ticks (MS1-F-8): a refusal keeps them, to try again.
    assert.equal(copiedAll([{ name: "A", answer: "taken" }, { name: "B", answer: "taken" }]), true);
    assert.equal(copiedAll([{ name: "A", answer: "taken" }, { name: "B", answer: "refused" }]), false);
    assert.equal(copiedAll([{ name: "A", answer: "unknown" }]), false);
    const full = { message: "The room is too full to keep players' maps of this scene. Delete unused scenes to free space.", text: "Not saved. The room is too full…" };
    assert.equal(
      copyResult([{ name: "A", answer: "taken" }, { name: "Hall", answer: "refused", refusal: full }, { name: "C", answer: "taken" }]),
      "Copied to 2 of 3 scenes. Hall: The room is too full to keep players' maps of this scene. Delete unused scenes to free space.",
    );
    assert.equal(copyResult([{ name: "Hall", answer: "refused", refusal: { message: "per player is full", text: "x" } }]), "Copied to 0 of 1 scene. Hall: Per player is full.");
    assert.equal(copyResult([{ name: "A", answer: "taken" }, { name: "Hall", answer: "unknown" }]), "Copied to 1 of 2 scenes. Hall: The connection dropped before the server answered.");
    assert.equal(copyResult([{ name: "Hall", answer: "refused" }]), "Copied to 0 of 1 scene. Hall: That could not be done.");
  });
});

test("copied scene settings name their Setup undo control", () => {
  assert.equal(COPY_UNDO, "Undo setup in Setup history puts the settings back. Players' remembered maps stay changed.");
});
