import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { room } from "#shared/testutil.ts";
import { scenesFoldsSlot } from "../../lib/folds.ts";
import { RoomScope } from "../../state/scope.ts";
import type { PanelHow, RoomView } from "../../state/types.ts";
import { createSceneRequest, openSceneSettings, SCENE_TARGET_GROUPS, SCENES_PANEL, sceneInView, sceneRequestSlot, type SceneTarget } from "./request.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { useSceneRequestSeq } = await import("./request.ts");

/*
 * The way into a scene's settings from Ambiance's Weather and Scene sound
 * rows (docs/design/design-v1-scenes-reorg.md 7, 12): a reveal never written
 * and a target the settings take once, and with no scene in view nothing
 * but the opening (D-261102-934).
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
  test("weather: Light and weather revealed and never written, the target set with a new seq, then Scenes opens from Ambiance", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    const before = writes;
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).light, true);
    scope.get(scenesFoldsSlot).tap("light", false);
    const tapped = writes;
    openSceneSettings(scope, ui, "weather", { from: "ambiance", room: roomStore("s1") });
    assert.deepEqual(calls, ['openPanel scenes {"from":"ambiance"}']);
    assert.equal(SCENES_PANEL, "scenes");
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).light, true, "revealed over the DM's own fold");
    assert.equal(writes, tapped, "the reveal writes nothing");
    assert.equal(tapped, before + 1, "only the DM's tap wrote");
    assert.deepEqual(scope.get(sceneRequestSlot).get(), { target: "weather", seq: 1 });
    stored.clear();
  });

  test("sound: Scene sound revealed, its own target", () => {
    const scope = new RoomScope();
    openSceneSettings(scope, recorder().ui, "sound", { from: "ambiance", room: roomStore("s1") });
    assert.equal(scope.get(scenesFoldsSlot).get(PHONE, ROOM).sound, true, "Scene sound is setup, folded on a phone, so the reveal shows");
    assert.equal(scope.get(sceneRequestSlot).get().target, "sound");
    assert.deepEqual(SCENE_TARGET_GROUPS, { weather: "light", sound: "sound" });
  });

  test("the settings take the target once, and a second press acts again", () => {
    const scope = new RoomScope();
    const request = scope.get(sceneRequestSlot);
    openSceneSettings(scope, recorder().ui, "weather", { from: "ambiance", room: roomStore("s1") });
    assert.equal(request.take(), "weather");
    assert.equal(request.take(), null, "taken, it acts no more");
    assert.equal(request.get().seq, 1, "the take keeps the seq");
    openSceneSettings(scope, recorder().ui, "weather", { from: "ambiance", room: roomStore("s1") });
    assert.deepEqual(request.get(), { target: "weather", seq: 2 });
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
    openSceneSettings(scope, recorder().ui, "sound", { from: "ambiance", room: roomStore("s1") });
    folds.follow(true, ROOM);
    assert.equal(folds.get(PHONE, ROOM).sound, true);
    folds.follow(false, ROOM);
    assert.equal(folds.get(PHONE, ROOM).sound, false);
  });

  test("a request in one Room page never reaches another's, as a preview's never reaches the DM's", () => {
    const dm = new RoomScope();
    openSceneSettings(new RoomScope(), recorder().ui, "sound", { from: "ambiance", room: roomStore("s1") });
    assert.deepEqual(dm.get(sceneRequestSlot).get(), { target: null, seq: 0 });
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

  test("it only opens Scenes: no target and no reveal, so the first scene the DM makes neither scrolls nor takes focus", () => {
    for (const [why, store] of none) {
      for (const target of ["weather", "sound"] as const) {
        const scope = new RoomScope();
        const { calls, ui } = recorder();
        openSceneSettings(scope, ui, target, { from: "ambiance", room: store });
        assert.deepEqual(calls, ['openPanel scenes {"from":"ambiance"}'], why);
        assert.deepEqual(scope.get(sceneRequestSlot).get(), { target: null, seq: 0 }, `${why}: no target`);
        const folds = scope.get(scenesFoldsSlot).get(PHONE, ROOM);
        assert.equal(folds.sound, false, `${why}: Scene sound not revealed`);
        assert.equal(scope.get(sceneRequestSlot).take(), null);
      }
    }
  });

  test("Light and weather is not revealed either: folded by the DM, it stays folded", () => {
    const scope = new RoomScope();
    const folds = scope.get(scenesFoldsSlot);
    folds.tap("light", false, false);
    openSceneSettings(scope, recorder().ui, "weather", { from: "ambiance", room: roomStore(null) });
    assert.equal(folds.get(PHONE, ROOM).light, false);
  });

  test("sceneInView: the scene picked is one the room holds", () => {
    assert.equal(sceneInView(roomStore("s1").getState()), true);
    for (const [why, store] of none) assert.equal(sceneInView(store.getState()), false, why);
  });
});

describe("the request through Scenes' openings and closings (useEndSceneRequestOnClose)", () => {
  test("a target no settings took is cleared as Scenes goes from open to closed", () => {
    const request = createSceneRequest();
    request.follow(false);
    request.ask("weather");
    request.follow(true);
    request.follow(false);
    assert.deepEqual(request.get(), { target: null, seq: 1 });
    request.follow(true);
    assert.equal(request.take(), null, "the next opening finds nothing pending");
  });

  test("a target asked while Scenes is closed waits for the opening it asked for", () => {
    const request = createSceneRequest();
    request.follow(false);
    request.ask("sound");
    request.follow(false);
    assert.equal(request.get().target, "sound", "closed staying closed clears nothing");
    request.follow(true);
    assert.equal(request.take(), "sound");
  });

  test("a page that loads with Scenes open clears nothing until Scenes first closes", () => {
    const request = createSceneRequest();
    request.ask("weather");
    request.follow(true);
    assert.equal(request.get().target, "weather");
  });

  test("every change tells the page, a take with nothing waiting tells nothing, and a listener that stopped hears nothing", () => {
    const request = createSceneRequest();
    let heard = 0;
    const stop = request.subscribe(() => heard++);
    assert.equal(request.take(), null);
    assert.equal(heard, 0);
    request.ask("weather");
    request.take();
    request.ask("sound");
    request.follow(true);
    request.follow(false);
    assert.equal(heard, 4, "two asks, the take and the close's clear");
    stop();
    request.ask("weather");
    assert.equal(heard, 4);
  });

  test("useSceneRequestSeq reads the Room page's request", () => {
    const scope = new RoomScope();
    scope.get(sceneRequestSlot).ask("weather");
    scope.get(sceneRequestSlot).ask("sound");
    let seq = -1;
    function Probe() {
      seq = useSceneRequestSeq();
      return null;
    }
    renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Probe) }));
    assert.equal(seq, 2);
  });

  test("named invariants hold through 1,000 random sequences of asks, takes, openings and closings", () => {
    type Event = { t: "ask"; target: SceneTarget } | { t: "take" } | { t: "open" } | { t: "close" };
    const event: fc.Arbitrary<Event> = fc.oneof(
      fc.constantFrom("weather", "sound").map((target) => ({ t: "ask", target }) as const),
      fc.constant({ t: "take" } as const),
      fc.constant({ t: "open" } as const),
      fc.constant({ t: "close" } as const),
    );
    fc.assert(
      fc.property(fc.boolean(), fc.array(event, { maxLength: 40 }), (startOpen, events) => {
        const request = createSceneRequest();
        let open = startOpen;
        request.follow(open);
        let waiting: SceneTarget | null = null;
        let asks = 0;
        for (const e of events) {
          if (e.t === "ask") {
            request.ask(e.target);
            waiting = e.target;
            asks++;
          }
          if (e.t === "take") {
            assert.equal(request.take(), waiting, "a take finds the last target asked, if no take or close came since");
            waiting = null;
          }
          if (e.t === "open") open = true;
          if (e.t === "close") {
            if (open) waiting = null;
            open = false;
          }
          // Room's effect runs after each change, as useEndSceneRequestOnClose's does.
          request.follow(open);
          assert.equal(request.get().target, waiting, "an untaken target lasts until Scenes goes from open to closed, never longer");
          assert.equal(request.get().seq, asks, "each ask, and only an ask, is a new press");
        }
      }),
      { numRuns: 1000 },
    );
  });
});
