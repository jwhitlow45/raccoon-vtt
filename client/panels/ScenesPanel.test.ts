import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { member, room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../state/scope.ts";

/*
 * The Scenes panel on a scene with floors (docs/design/design-v1-floors.md
 * 7.1, D-261107-225): one row for the scene, by its main floor, and the
 * settings under the list set the floor on screen.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScopeProvider } = await import("../state/scope.ts");
const { default: ScenesPanel } = await import("./ScenesPanel.tsx");

/** Tower (Ground, Upper, Roof) beside a Cave, the players starting on `start`. */
function world(start: string): RoomState {
  const state = room({
    members: { dm1: member("dm1", "dm") },
    scenes: {
      g: scene("g", { name: "Tower", order: 0, floor: { of: "g", level: 0, name: "Ground floor" }, weather: { kind: "rain", heavy: true, wind: "strong" } }),
      u: scene("u", { name: "Tower", order: 0, floor: { of: "g", level: 1, name: "Upper floor", height: 10 } }),
      r: scene("r", { name: "Tower", order: 0, floor: { of: "g", level: 2, name: "Roof", height: 10 }, weather: { kind: "snow", heavy: true } }),
      cave: scene("cave", { name: "Cave", order: 1 }),
    },
  });
  state.meta = { ...state.meta, playerSceneId: start };
  return state;
}

function draw(state: RoomState, shown: string, moved: string[] = []): string {
  const store = createStore(() => ({
    view: state,
    you: { memberId: "dm1", role: "dm" },
    roomId: "r1",
    sceneId: shown,
    projectedSceneId: "g",
    connection: "open",
    pending: moved.map((sceneId, n) => ({ n, op: { t: "room.setPlayerScene", sceneId }, at: 0 })),
    local: { selectedIds: [], multi: false },
  }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: new RoomScope(),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x", switchScene: () => {}, showFloor: () => {} } as never,
        ui: { setTool: () => {}, notify: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(ScenesPanel as never, { close: () => {} }),
      }),
    }),
  );
}

describe("a scene with floors in the Scenes panel", () => {
  test("it is one row by its main floor, saying how many floors it holds, and you are here holds on any floor", () => {
    const html = draw(world("g"), "u");
    assert.equal((html.match(/data-search-page="scene:/g) ?? []).length, 2, "Tower and Cave, never a row a floor");
    assert.match(html, /data-search-page="scene:g"/);
    assert.doesNotMatch(html, /data-search-page="scene:u"|data-search-page="scene:r"/);
    assert.match(html, /3 floors · Grid, 40 × 30, fog off · you are here/);
  });

  test("players here holds for the scene when they start on any of its floors, and Move players stays on the other scene", () => {
    const html = draw(world("r"), "g");
    // The scene's row, by its main floor, though they start on Roof. The Floors group below marks Roof apart.
    const list = html.slice(0, html.indexOf("New scene"));
    assert.equal((list.match(/>Players here</g) ?? []).length, 1);
    assert.equal((html.match(/aria-label="Move players to Cave"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /aria-label="Move players to Tower"/);
  });

  test("the settings under the list set the floor on screen: Upper's weather changes and Ground's stays", () => {
    const onRoof = draw(world("g"), "r");
    const onGround = draw(world("g"), "g");
    const chosen = (html: string) => /<option value="(\w+)" selected="">/.exec(html.slice(html.indexOf('aria-label="Weather"')))?.[1];
    assert.equal(chosen(onRoof), "snow", "Roof's snow in its Light and weather group");
    assert.equal(chosen(onGround), "rain");
    assert.equal(chosen(draw(world("g"), "u")), "clear", "Upper keeps no weather of its own");
    // The page says which floor the groups set.
    assert.match(onRoof, /The groups below set Roof\. Each floor keeps its own\./);
    assert.doesNotMatch(onGround.replace("The groups below set Ground floor", ""), /The groups below set Roof/);
  });

  test("the Floors group lists the floors top first with where the players stand", () => {
    const html = draw(world("g"), "g");
    const order = ["Roof, Not reached yet", "Upper floor, Not reached yet", "Ground floor, Players here, shown"].map((name) => html.indexOf(`aria-label="${name}. Open its page"`));
    assert.ok(order.every((at) => at >= 0), order.join());
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!);
    assert.match(html, /data-floors="group"/);
  });

  test("a scene with one floor shows no list, only the two adds", () => {
    const state = world("cave");
    const html = draw(state, "cave");
    assert.match(html, /Add a floor above/);
    assert.match(html, /Add a floor below/);
    assert.match(html, /Cave has one floor\./);
    assert.doesNotMatch(html, /Open its page/);
  });
});
