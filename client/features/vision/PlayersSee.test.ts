import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import { scene } from "#shared/testutil.ts";

/*
 * Players see where a scene is made (docs/design-v1-map-discovery.md 8.1
 * and 8.2): the new scene form's and the Universal VTT dialog's group.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { NewScenePlayersSee } = await import("./PlayersSee.tsx");

const crypt: Scene = scene("s1", { name: "Crypt", fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true }, blockMovement: true });

function form(props: Partial<Parameters<typeof NewScenePlayersSee>[0]>): string {
  return renderToStaticMarkup(createElement(NewScenePlayersSee, { kind: "map", setting: "explore", value: "reveal", like: crypt, wallless: true, onChange: () => {}, ...props }));
}

const steps = /Under Explore a map image with no walls starts on Reveal by hand, since party vision would show players all of it\./;
const warning = /This map has no walls yet, so party vision shows players all of it at once\./;

describe("Players see in the new scene form", () => {
  test("a map image under an Explore room starts on Reveal by hand and says why, and Explore then warns", () => {
    const html = form({});
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="reveal"/);
    assert.match(html, steps);
    assert.doesNotMatch(html, warning);
    const explore = form({ value: "explore" });
    assert.match(explore, warning);
    assert.doesNotMatch(explore, steps, "the note is for the start it stepped down to");
    assert.doesNotMatch(form({ value: "all" }), steps);
  });

  test("Like names the scene on screen, says what it copies, and warns when that is Explore on a map image", () => {
    const html = form({ value: "like" });
    assert.match(html, /<span id="[^"]+"[^>]*>Like Crypt<\/span>/);
    assert.match(html, />Explore, Dark, Per player, players(&#x27;|') moves blocked</);
    assert.match(html, warning);
    assert.doesNotMatch(form({ value: "like", like: { ...crypt, vision: { on: false, light: "dark" } } }), warning);
    assert.doesNotMatch(form({ like: undefined }), /Like /, "no scene on screen, no Like");
  });

  test("a mat or a builder scene has no art to warn of, and a room from before steps nothing down", () => {
    assert.doesNotMatch(form({ kind: "mat", setting: undefined, value: "explore", wallless: false }), warning);
    assert.doesNotMatch(form({ kind: "map", setting: undefined, value: "reveal" }), steps);
    assert.doesNotMatch(form({ kind: "builder", setting: "explore", value: "explore", wallless: false }), steps);
  });
});
