import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { moveWarning } from "./moveWarning.ts";

const MAP = { assetId: "a", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };
const scene = (over: { vision?: { on: boolean; light: "bright" | "dim" | "dark" }; fogEnabled?: boolean; map?: typeof MAP } = {}) => ({ id: "s1", fogEnabled: true, ...over });
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

  test("on a map image the DM is not looking at it adds that a map with no walls yet shows players all of it (docs/design-v1-map-discovery.md 8.1)", () => {
    assert.equal(
      moveWarning({ scene: scene({ vision: dark, map: MAP }), viewing: false, sight: undefined }),
      "Players will see only what their characters on this scene see. If none of them can see, players see only what they explored before. If its map has no walls yet, party vision shows players all of it at once.",
    );
    assert.doesNotMatch(moveWarning({ scene: scene({ vision: dark }), viewing: false, sight: undefined }) ?? "", /no walls yet/, "a mat or a builder scene has no art");
    assert.equal(moveWarning({ scene: scene({ vision: dark, map: MAP }), viewing: true, sight: { "s1:0,0": { f: 1 } } }), null, "the scene on screen counts its walls in its own settings");
    assert.equal(moveWarning({ scene: scene({ map: MAP }), viewing: false, sight: undefined }), null, "Reveal by hand shows only what the DM reveals");
  });
});
