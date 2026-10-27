import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";

/*
 * Players see where a scene is made (docs/design-v1-map-discovery.md 8.1
 * and 8.2): the new scene form's and the Universal VTT dialog's group, and
 * the copy's button at the end of a scene's group.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { NewScenePlayersSee } = await import("./PlayersSee.tsx");
const { CopySettingsButton } = await import("./CopySettings.tsx");

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

describe("the copy's button", () => {
  function render(view: RoomState): string {
    const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(CopySettingsButton, { scene: view.scenes.s1! }),
      }),
    );
  }

  test("shows in a room with another scene, and not in a room of one", () => {
    assert.match(render(room()), />Use these settings on other scenes…</);
    const alone = room();
    delete alone.scenes.s2;
    assert.equal(render(alone), "");
  });
});
