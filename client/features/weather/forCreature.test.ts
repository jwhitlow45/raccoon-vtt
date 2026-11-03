import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { actor, character, room, scene, token } from "#shared/testutil.ts";
import type { SceneWeather } from "#shared/weather.ts";
import { weatherFor } from "./forCreature.ts";

/** Which creatures a scene's weather bears on (docs/design/design-v1-weather.md 2). */

const RAIN: SceneWeather = { kind: "rain", heavy: true };
const SNOW: SceneWeather = { kind: "snow", heavy: true };

function table(): RoomState {
  const s = room({
    characters: { pat: character("pat", { name: "Pat", ownerIds: ["p1"] }), lone: character("lone", { name: "Lone", ownerIds: ["p1"] }) },
    tokens: {
      patTok: token("patTok", { sceneId: "forest", kind: "pc", actor: { ref: "pat" } }),
      goblin: token("goblin", { sceneId: "cellar", kind: "monster", actor: { inline: actor() } }),
    },
  });
  s.scenes.forest = scene("forest", { weather: RAIN });
  s.scenes.cellar = scene("cellar", { weather: SNOW });
  s.scenes.camp = scene("camp");
  s.meta.playerSceneId = "forest";
  return s;
}

describe("weatherFor", () => {
  test("a token is in the weather of its own scene, whichever scene the viewer is on", () => {
    const view = table();
    assert.deepEqual(weatherFor({ view }, { tokenId: "goblin" }, "forest"), SNOW);
    assert.deepEqual(weatherFor({ view }, { tokenId: "patTok" }, "cellar"), RAIN);
  });

  test("a character is in the weather of its token on the players' scene", () => {
    assert.deepEqual(weatherFor({ view: table() }, { characterId: "pat" }, "cellar"), RAIN);
  });

  test("a character with no token on the players' scene takes the viewer's scene, if its token is there", () => {
    const view = table();
    view.meta.playerSceneId = "camp";
    view.tokens.patTok!.sceneId = "cellar";
    assert.deepEqual(weatherFor({ view }, { characterId: "pat" }, "cellar"), SNOW);
    assert.equal(weatherFor({ view }, { characterId: "pat" }, "forest"), undefined, "its token is not on the viewer's scene");
    assert.equal(weatherFor({ view }, { characterId: "pat" }, null), undefined);
  });

  test("a creature with no token there gets nothing", () => {
    assert.equal(weatherFor({ view: table() }, { characterId: "lone" }, "forest"), undefined);
    assert.equal(weatherFor({ view: table() }, { tokenId: "gone" }, "forest"), undefined);
  });

  test("a scene without weather gives none, and a room without any answers at once", () => {
    const view = table();
    delete view.scenes.forest!.weather;
    assert.equal(weatherFor({ view }, { tokenId: "patTok" }, "forest"), undefined);
    delete view.scenes.cellar!.weather;
    assert.equal(weatherFor({ view }, { characterId: "pat" }, "forest"), undefined);
  });
});
