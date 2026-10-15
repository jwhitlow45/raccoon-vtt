import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { moveWarning } from "./moveWarning.ts";

const scene = (over: { vision?: { on: boolean; light: "bright" | "dim" | "dark" }; fogEnabled?: boolean } = {}) => ({ id: "s1", fogEnabled: true, ...over });
const dark = { on: true, light: "dark" as const };

describe("moving players to a scene", () => {
  test("a scene without vision warns only when its fog is off, as before", () => {
    assert.equal(moveWarning({ scene: scene(), viewing: false, sight: {} }), null);
    assert.equal(moveWarning({ scene: scene({ fogEnabled: false }), viewing: true, sight: {} }), "Fog is off here, so players will see the whole scene.");
    assert.equal(moveWarning({ scene: scene({ vision: { on: false, light: "dark" } }), viewing: true, sight: {} }), null);
  });

  test("a vision scene the DM is looking at warns when the party sees nothing there", () => {
    assert.equal(
      moveWarning({ scene: scene({ vision: dark }), viewing: true, sight: {} }),
      "No party creature on this scene can see. Players will see only what they explored before.",
    );
    // Sight of another scene is not this one's.
    assert.match(moveWarning({ scene: scene({ vision: dark }), viewing: true, sight: { "s2:0,0": { f: 3 } } }) ?? "", /^No party creature/);
    assert.equal(moveWarning({ scene: scene({ vision: dark }), viewing: true, sight: { "s1:0,0": { f: 1 } } }), null);
    assert.match(moveWarning({ scene: scene({ vision: dark, fogEnabled: false }), viewing: true, sight: { "s1:0,0": { f: 1 } } }) ?? "", /dimmed outside the party's sight/);
  });

  test("a vision scene the DM is not looking at says what players will see, since its sight is not in the DM's view", () => {
    assert.match(moveWarning({ scene: scene({ vision: dark }), viewing: false, sight: undefined }) ?? "", /only what their characters on this scene see/);
  });
});
