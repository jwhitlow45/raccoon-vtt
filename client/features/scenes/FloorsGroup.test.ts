import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shallow } from "zustand/shallow";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { drawing, member, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { tower, TOWER, UPPER } from "../floors/testing.ts";
import { fileHexReason, floorHexNote, FLOOR_MAP_HELP, playersAt } from "./floorWords.ts";
import { SCENES_FULL } from "./floorSource.ts";

/*
 * The Floors group's rows read only what their marks read (floorWords.ts
 * playersAt), so the group, which stays mounted while folded, draws no row
 * again for an op on anything else.
 */

const { floorRowParts, FloorsGroup } = await import("./FloorsGroup.tsx");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");

/** The group, open, as the DM sees it on `shown`. */
function draw(state: RoomState, shown: string): string {
  const store = createStore(() => ({
    view: { ...state, members: { ...state.members, dm1: member("dm1", "dm") } },
    you: { memberId: "dm1", role: "dm" },
    roomId: "r1",
    sceneId: shown,
    projectedSceneId: TOWER,
    connection: "open",
    pending: [],
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
        children: createElement(FloorsGroup, { scene: state.scenes[shown]!, fold: { open: true, onToggle: () => {} } }),
      }),
    }),
  );
}

/** The opening tag of the button with this search anchor. */
function button(html: string, anchor: string): string {
  const tag = html.match(new RegExp(`<button[^>]*data-search="${anchor.replaceAll(".", "\\.")}"[^>]*>`))?.[0];
  assert.ok(tag, anchor);
  return tag;
}

/** The radio of a Map option, as drawn. */
function radio(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  assert.ok(at > 0, label);
  const start = html.lastIndexOf("<label", at);
  return html.slice(start, at);
}

describe("the Floors group's rows", () => {
  test("an op on what no mark reads leaves the rows' parts as they were, and a creature taken to another floor changes them", () => {
    const before = tower();
    const drawn = { ...before, drawings: { d1: drawing("d1", { sceneId: TOWER }) } };
    assert.ok(shallow(floorRowParts(before), floorRowParts(drawn)));
    const moved = { ...before, tokens: { ...before.tokens, thorn: { ...before.tokens.thorn!, sceneId: UPPER } } };
    assert.ok(!shallow(floorRowParts(before), floorRowParts(moved)));
  });

  test("each floor's mark reads the same from the parts as from the whole view", () => {
    const state = { ...tower(), openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } };
    const parts = floorRowParts(state)!;
    for (const id of Object.keys(state.scenes)) assert.equal(playersAt(parts, { id }), playersAt(state, { id }), id);
    assert.equal(floorRowParts(null), null);
  });
});

/*
 * Map (docs/design/design-v1-floors.md phase 3, 3.5): Blank, VTT file and
 * Dungeon over the adds, the two that bring square walls off on hexes with
 * their reasons, and a room at its scene limit taking no floor whatever the
 * pick.
 */
describe("the Floors group's Map", () => {
  const escaped = (text: string) => text.replaceAll("'", "&#x27;");

  test("on squares it offers all three, Blank chosen, with Blank's help under it, and the adds stay on", () => {
    const html = draw(tower(), TOWER);
    assert.match(html, /data-search="scenes\.floors\.map"/);
    assert.match(radio(html, "Blank"), /checked=""/);
    for (const label of ["VTT file", "Dungeon"]) assert.doesNotMatch(radio(html, label), /disabled=""/, label);
    assert.ok(html.includes(FLOOR_MAP_HELP.blank));
    assert.ok(!html.includes(escaped(fileHexReason("Tower"))));
    for (const add of ["scenes.floors.add-above", "scenes.floors.add-below"]) assert.doesNotMatch(button(html, add), /disabled=""/, add);
    assert.match(html, /data-floor-file=""/);
  });

  test("on hexes VTT file and Dungeon are off, each with its reason on the dim line, and Blank still adds", () => {
    const state = tower();
    for (const id of Object.keys(state.scenes)) if (state.scenes[id]!.name === "Tower") state.scenes[id] = { ...state.scenes[id]!, gridShape: "hexRows" };
    const html = draw(state, TOWER);
    for (const label of ["VTT file", "Dungeon"]) assert.match(radio(html, label), /disabled=""/, label);
    assert.doesNotMatch(radio(html, "Blank"), /disabled=""/);
    assert.ok(html.includes(`${escaped(fileHexReason("Tower"))} ${escaped(floorHexNote("Tower"))}`));
  });

  test("a room of 50 scenes turns both adds off with its reason", () => {
    const state = tower();
    for (let i = Object.keys(state.scenes).length; i < LIMITS.scenesPerRoom; i++) state.scenes[`x${i}`] = scene(`x${i}`, { order: i });
    const html = draw(state, TOWER);
    for (const add of ["scenes.floors.add-above", "scenes.floors.add-below"]) assert.match(button(html, add), /disabled=""/, add);
    assert.ok(html.includes(SCENES_FULL));
    delete state.scenes.x49;
    assert.ok(!draw(state, TOWER).includes(SCENES_FULL));
  });
});
