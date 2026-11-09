import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { entry, scene, token } from "#shared/testutil.ts";
import { tower, UPPER, TOWER } from "../floors/testing.ts";
import { otherFloorName } from "../floors/words.ts";

/*
 * The tracker holds rows on every floor of the scene (docs/design/design-v1-floors.md
 * 7.6): a row off the floor shown carries that floor's name as a tag after
 * its other tags, and none on the floor shown or on a scene of one floor.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { EntryRow } = await import("./Row.tsx");

function fight(): RoomState {
  const state = tower();
  state.tokens.gob = token("gob", { sceneId: UPPER, kind: "monster", name: "Goblin" });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-gob", { tokenId: "gob", value: 12 }), entry("e-thorn", { tokenId: "thorn", value: 15 })] };
  return state;
}

function rowOf(state: RoomState, entryId: string, shown: string): string {
  const store = createStore(() => ({ view: state, floorView: state, sceneId: shown, you: { memberId: "dm1", role: "dm" }, local: { selectedIds: [], multi: false } }));
  const row = createElement(EntryRow, {
    entry: state.encounter!.entries.find((e) => e.id === entryId)!,
    active: false,
    role: "dm",
    mine: false,
    expanded: false,
    picking: false,
    selected: false,
    onExpand() {},
    onShow() {},
    onShowToken() {},
    drag: null,
    rowRef: () => {},
  });
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: {} as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement("ol", null, row) }),
    }),
  );
}

describe("a tracker row on another floor", () => {
  test("names the floor while the DM shows another, and nothing on its own floor", () => {
    const state = fight();
    assert.match(rowOf(state, "e-gob", TOWER), />Upper floor</);
    assert.doesNotMatch(rowOf(state, "e-gob", UPPER), /Upper floor/);
    assert.doesNotMatch(rowOf(state, "e-thorn", TOWER), /Ground floor/);
  });

  test("the name is a floor of the scene shown only, never of another scene", () => {
    const state = fight();
    assert.equal(otherFloorName(state, UPPER, TOWER), "Upper floor");
    assert.equal(otherFloorName(state, UPPER, UPPER), null);
    assert.equal(otherFloorName(state, "cave", TOWER), null, "Cave is a scene of one floor");
    state.scenes.keep = scene("keep", { name: "Keep", floor: { of: "keep", level: 0, name: "Ground floor" } });
    state.scenes.keep2 = scene("keep2", { name: "Keep", floor: { of: "keep", level: 1, name: "Battlements", height: 10 } });
    assert.equal(otherFloorName(state, "keep2", TOWER), null, "a floor of another scene with floors");
    assert.equal(otherFloorName(state, UPPER, null), null);
  });
});
