import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { room } from "#shared/testutil.ts";
import { scenesFoldsSlot } from "../../lib/folds.ts";
import { RoomScope } from "../../state/scope.ts";
import type { PanelHow, RoomView } from "../../state/types.ts";
import { SCENES_PANEL } from "./ids.ts";
import { openSceneSettings, SCENE_TARGET_GROUPS, sceneInView } from "./request.ts";

/*
 * What is left of the way into a scene's settings from elsewhere
 * (docs/design/design-v1-scenes-reorg.md 7, docs/design/design-v1-sound-layout.md 6.2):
 * Scenes opens with the target's group revealed and never written, and with
 * no scene in view nothing but the opening (D-261102-934). The request that
 * scrolled to the group and focused it is gone, so nothing waits for the
 * settings to take.
 */

/** This device's storage, empty, for every Room page in this file, counting writes: a reveal must never write. */
const stored = new Map<string, string>();
let writes = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes++;
    stored.set(key, value);
  },
};

/** What openSceneSettings asks of the room's UI, recorded in order. */
function recorder() {
  const calls: string[] = [];
  return { calls, ui: { openPanel: (id: string, how?: PanelHow) => calls.push(`openPanel ${id} ${JSON.stringify(how ?? null)}`) } };
}

/** The room's store as openSceneSettings reads it at the press. */
function roomStore(sceneId: string | null, view: RoomView["view"] = { ...room(), meta: room().meta } as RoomView["view"]) {
  return { getState: () => ({ sceneId, view }) as RoomView };
}

const PHONE = 390;
const ROOM = { clock: false, scenes: true };

describe("openSceneSettings with a scene in view", () => {
  test("weather: Light and weather revealed over the DM's own fold and never written, then Scenes opens from the pane the press was in", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    const before = writes;
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).light, true);
    scope.get(scenesFoldsSlot).tap("light", false);
    const tapped = writes;
    openSceneSettings(scope, ui, "weather", { from: "sound", room: roomStore("s1") });
    assert.deepEqual(calls, ['openPanel scenes {"from":"sound"}']);
    assert.equal(SCENES_PANEL, "scenes");
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).light, true, "revealed over the DM's own fold");
    assert.equal(writes, tapped, "the reveal writes nothing");
    assert.equal(tapped, before + 1, "only the DM's tap wrote");
    stored.clear();
  });

  test("sound: Scene sound revealed, its own group", () => {
    const scope = new RoomScope();
    openSceneSettings(scope, recorder().ui, "sound", { from: "sound", room: roomStore("s1") });
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).sound, true, "Scene sound is setup, folded on a phone, so the reveal shows");
    assert.deepEqual(SCENE_TARGET_GROUPS, { weather: "light", sound: "sound" });
  });

  test("with no panel to open from, it opens as any path outside the panels does", () => {
    for (const from of [null, undefined]) {
      const { calls, ui } = recorder();
      openSceneSettings(new RoomScope(), ui, "weather", { from, room: roomStore("s1") });
      assert.deepEqual(calls, ["openPanel scenes null"]);
    }
  });

  test("the reveal ends as Scenes closes, and the fold the DM left shows again", () => {
    const scope = new RoomScope();
    const folds = scope.get(scenesFoldsSlot);
    folds.follow(false, ROOM);
    openSceneSettings(scope, recorder().ui, "sound", { from: "sound", room: roomStore("s1") });
    folds.follow(true, ROOM);
    assert.equal(folds.get(PHONE, ROOM).sound, true);
    folds.follow(false, ROOM);
    assert.equal(folds.get(PHONE, ROOM).sound, false);
  });

  test("a press in one Room page never reaches another's, as a preview's never reaches the DM's", () => {
    const dm = new RoomScope();
    openSceneSettings(new RoomScope(), recorder().ui, "sound", { from: "sound", room: roomStore("s1") });
    assert.equal(dm.get(scenesFoldsSlot).get(PHONE, ROOM).sound, false);
  });
});

describe("openSceneSettings with no scene in view (D-261102-934)", () => {
  const none: [why: string, store: ReturnType<typeof roomStore>][] = [
    ["no scene picked", roomStore(null)],
    ["a scene the room no longer holds", roomStore("gone")],
    ["no snapshot yet", roomStore("s1", null)],
    ["a room with no scene", roomStore(null, { ...room({ scenes: {} }), meta: room().meta } as RoomView["view"])],
  ];

  test("it only opens Scenes: no reveal, so the first scene the DM makes opens as the DM left its folds", () => {
    for (const [why, store] of none) {
      for (const target of ["weather", "sound"] as const) {
        const scope = new RoomScope();
        const { calls, ui } = recorder();
        openSceneSettings(scope, ui, target, { from: "sound", room: store });
        assert.deepEqual(calls, ['openPanel scenes {"from":"sound"}'], why);
        assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).sound, false, `${why}: Scene sound not revealed`);
      }
    }
  });

  test("Light and weather is not revealed either: folded by the DM, it stays folded", () => {
    const scope = new RoomScope();
    const folds = scope.get(scenesFoldsSlot);
    folds.tap("light", false, false);
    openSceneSettings(scope, recorder().ui, "weather", { from: "sound", room: roomStore(null) });
    assert.equal(folds.get(PHONE, ROOM).light, false);
  });

  test("sceneInView: the scene picked is one the room holds", () => {
    assert.equal(sceneInView(roomStore("s1").getState()), true);
    for (const [why, store] of none) assert.equal(sceneInView(store.getState()), false, why);
  });
});
