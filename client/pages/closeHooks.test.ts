import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { DM, room } from "#shared/testutil.ts";
import type { RoomActions } from "../state/types.ts";

/*
 * Room's part of the folds (docs/design/design-v1-panel-groups.md 6.1): a
 * reveal ends when its panel goes from open to closed in the room's own
 * store, opened and closed as the page does, on a phone and from 900 px
 * up. Server rendering runs no effects, so the hooks' layout effects are
 * caught as they render and run here after each change, as React runs them
 * after a commit.
 */

const captureKey = Symbol.for("room-close-hooks-layout");
let effects: (() => void)[] = [];
(globalThis as Record<symbol, unknown>)[captureKey] = (run: () => void) => {
  effects.push(run);
};
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/lib/folds.ts")) return result;
    // A .ts file comes as bytes, a .tsx one through the test's own hooks as text.
    const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source as Uint8Array);
    const replaced = source.replaceAll("useLayoutEffect(", 'globalThis[Symbol.for("room-close-hooks-layout")](');
    assert.ok(replaced !== source, `${url}: Room's part is a layout effect to catch`);
    return { ...result, source: replaced };
  },
});

/** This device's storage, empty, for every Room page in this file. */
(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {} };

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoomStore } = await import("../state/store.ts");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
const { dmPanelFoldsSlot, scenesFoldsSlot, useEndRevealsOnClose } = await import("../lib/folds.ts");
const { LocalServer } = await import("../dev/localServer.ts");

const LOADED = { clock: false, scenes: true };

/** The DM's page: a room store with the room's snapshot in and a scene in view, and this page's scope. */
function page() {
  const server = new LocalServer(structuredClone(room()), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clientId: "c1" });
  store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "s1" }));
  return { store, scope: new RoomScope() };
}

/** Room's lines as Room.tsx has them, drawn at `wide` with their layout effects run, as after a commit. */
function draw(p: ReturnType<typeof page>, wide: boolean): void {
  function Hooks() {
    useEndRevealsOnClose("dm", dmPanelFoldsSlot, wide);
    useEndRevealsOnClose("scenes", scenesFoldsSlot, wide);
    return null;
  }
  // A render to markup reads a store's initial state (zustand's server snapshot), so the store is handed over reading its state now.
  const store = { getState: p.store.store.getState, getInitialState: p.store.store.getState, subscribe: p.store.store.subscribe };
  effects = [];
  renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: p.scope,
      children: createElement(RoomProvider, { store, actions: {} as RoomActions, ui: p.store.ui, children: createElement(Hooks) }),
    }),
  );
  for (const run of effects) run();
}

describe("Room's close hooks, through the room store", () => {
  for (const wide of [false, true]) {
    const where = wide ? "from 900 px" : "on a phone";

    test(`${where}: a reveal lasts while its panel is open and ends as it closes, and the DM's stored fold shows again`, () => {
      const p = page();
      try {
        const folds = p.scope.get(dmPanelFoldsSlot);
        folds.tap("handouts", false, false);
        draw(p, wide);
        folds.reveal("handouts");
        p.store.ui.openPanel("dm");
        draw(p, wide);
        assert.equal(folds.get(390, LOADED).handouts, true, "revealed while the DM panel is open");
        p.store.ui.openPanel("log");
        draw(p, wide);
        assert.equal(folds.get(390, LOADED).handouts, false, "another panel in its place closes it, and the reveal ends");
      } finally {
        p.store.dispose();
      }
    });

    test(`${where}: a reveal made while its panel is closed waits for it to open`, () => {
      const p = page();
      try {
        const folds = p.scope.get(dmPanelFoldsSlot);
        folds.tap("handouts", false, false);
        draw(p, wide);
        folds.reveal("handouts");
        draw(p, wide);
        assert.equal(folds.get(390, LOADED).handouts, true, "a closed panel staying closed ends nothing");
        p.store.ui.openPanel("dm");
        draw(p, wide);
        p.store.ui.openPanel("log");
        draw(p, wide);
        assert.equal(folds.get(390, LOADED).handouts, false);
      } finally {
        p.store.dispose();
      }
    });

    test(`${where}: a reveal in Scenes ends as Scenes closes`, () => {
      const p = page();
      try {
        draw(p, wide);
        p.scope.get(scenesFoldsSlot).reveal("sound");
        p.store.ui.openPanel("scenes");
        draw(p, wide);
        assert.equal(p.scope.get(scenesFoldsSlot).get(390, LOADED).sound, true, "Scene sound, setup and folded on a phone, shows revealed");
        p.store.ui.openPanel("log");
        draw(p, wide);
        assert.equal(p.scope.get(scenesFoldsSlot).get(390, LOADED).sound, false);
      } finally {
        p.store.dispose();
      }
    });
  }

  test("a phone's sheet closed by its own close ends the reveal too", () => {
    const p = page();
    try {
      const folds = p.scope.get(scenesFoldsSlot);
      draw(p, false);
      folds.reveal("sound");
      p.store.ui.openPanel("scenes");
      draw(p, false);
      assert.equal(folds.get(390, LOADED).sound, true);
      p.store.ui.closeSheets();
      draw(p, false);
      assert.equal(folds.get(390, LOADED).sound, false);
    } finally {
      p.store.dispose();
    }
  });
});

test("Room.tsx calls each close hook with Room's own wide, for the DM panel and Scenes, and none for Ambiance, which went", () => {
  const source = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function RoomPage() {"));
  assert.match(body, /const wide = width >= theme\.layout\.wideMinWidth;/);
  for (const line of [
    'useEndRevealsOnClose("dm", dmPanelFoldsSlot, wide);',
    "useEndRevealsOnClose(SCENES_PANEL, scenesFoldsSlot, wide);",
  ]) {
    assert.ok(body.includes(line), line);
  }
  assert.ok(!body.includes("useEndSceneRequestOnClose"), "the scene request went with Ambiance's rows (docs/design/design-v1-sound-layout.md 6.2)");
  assert.ok(!/ambiance/i.test(body), "no Ambiance wiring is left in Room (docs/design/design-v1-sound-layout.md 3.3)");
});
