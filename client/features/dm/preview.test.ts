import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { createFixtureState, FIXTURE_IDS } from "../../dev/fixture.ts";
import { EMPTY_EPHEMERAL, INITIAL_LOCAL, type RoomView } from "../../state/types.ts";
import { createPreview, playerPreview } from "./preview.ts";

const { dm, thorn, vex, cave, crypt } = FIXTURE_IDS;

function dmView(sceneId: string): RoomState {
  const state = createFixtureState({ fog: "normal", blackout: false });
  state.log.push({ id: "9:0", at: "", kind: "whisper", from: dm, to: [vex], text: "Vex only" });
  return projectState(state, { memberId: dm, role: "dm" }, { sceneId }) as unknown as RoomState;
}

function source(sceneId: string) {
  return createStore<RoomView>()(() => ({
    roomId: "DEVR00M0",
    you: { memberId: dm, role: "dm" },
    view: dmView(sceneId),
    sceneId,
    connection: "open",
    online: [dm, thorn],
    accessVersion: 0,
    ephemeral: EMPTY_EPHEMERAL,
    busy: {},
    toasts: [],
    ended: null,
    local: INITIAL_LOCAL,
    pending: [],
  }));
}

const byName = (view: RoomState, name: string) => Object.values(view.tokens).find((t) => t.name === name);

describe("view as a player", () => {
  test("is the player's projection of the DM's view", () => {
    const dmState = dmView(cave);
    const view = playerPreview(dmState, cave, thorn);
    assert.ok(view);
    assert.equal(Object.values(view.tokens).some((t) => t.visibility === "dm"), false, "no hidden token");
    assert.ok(byName(dmState, "Goblin") && Object.values(dmState.tokens).some((t) => t.visibility === "dm"));
    assert.ok(byName(view, "Huge figure"), "a hidden name becomes the public name");
    assert.equal(byName(view, "Stone giant"), undefined);
    const own = view.characters[FIXTURE_IDS.thornChar];
    assert.equal(own?.actor.dmNotes, undefined, "DM notes never reach the owner");
    assert.equal(view.log.some((e) => e.id === "9:0"), false, "someone else's whisper is gone");
    assert.deepEqual(view.encounterHistory, []);
  });

  test("needs the DM to be looking at the players' scene", () => {
    assert.equal(playerPreview(dmView(crypt), crypt, thorn), null);
  });

  test("follows the DM's store and stays read-only", () => {
    const src = source(cave);
    const preview = createPreview(src, thorn, { name: "Thorn" });
    try {
      const first = preview.store.getState();
      assert.deepEqual(first.you, { memberId: thorn, role: "player" });
      assert.equal(first.sceneId, cave);
      assert.ok(first.view);

      // A change in the DM's view shows up in the preview, and what did not change keeps its identity.
      const before = first.view;
      const goblin = byName(src.getState().view!, "Goblin")!;
      const moved = { ...goblin, x: goblin.x + 1 };
      const view = src.getState().view!;
      src.setState({ view: { ...view, tokens: { ...view.tokens, [goblin.id]: moved } } });
      const after = preview.store.getState().view!;
      assert.equal(after.tokens[goblin.id]?.x, goblin.x + 1);
      assert.equal(after.characters, before.characters);

      // Every action is refused locally, with one toast.
      assert.equal(preview.actions.dispatch({ t: "log.chat", text: "hi" }), null);
      preview.actions.undo();
      assert.equal(preview.store.getState().toasts.length, 1);
      assert.match(preview.store.getState().toasts[0]!.text, /viewing as Thorn/);
      assert.equal(src.getState().toasts.length, 0);

      // Its own panels and selection, apart from the DM's.
      preview.ui.openPanel("log");
      assert.equal(preview.store.getState().local.panel, "log");
      assert.equal(src.getState().local.panel, null);

      // The DM moving to another scene blanks the preview instead of showing the wrong one.
      src.setState({ sceneId: crypt, view: dmView(crypt) });
      assert.equal(preview.store.getState().view, null);
      assert.equal(preview.store.getState().sceneId, cave);
    } finally {
      preview.dispose();
    }
  });

  test("a dropped token snaps back, and the banner hears about it", async () => {
    const src = source(cave);
    let refused = 0;
    const preview = createPreview(src, thorn, { onRefuse: () => refused++ });
    try {
      const thornToken = byName(preview.store.getState().view!, "Thorn")!;
      preview.actions.moveToken(thornToken.id, thornToken.x + 3, thornToken.y);
      assert.equal(preview.store.getState().view!.tokens[thornToken.id]?.x, thornToken.x + 3);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(preview.store.getState().view!.tokens[thornToken.id]?.x, thornToken.x);
      assert.equal(src.getState().view!.tokens[thornToken.id]?.x, thornToken.x, "the DM's view never moved");
      assert.equal(refused, 1);
      assert.equal(preview.store.getState().toasts.length, 0);
    } finally {
      preview.dispose();
    }
  });
});
