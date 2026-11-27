import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";

/*
 * The parts gate as components draw it (docs/design/design-v1-features.md 6
 * and 8): `<Module>` draws a shown part marked with `data-part`, on its one
 * DOM child or a contents wrapper, and nothing for a hidden one, the
 * Hidden on this device line lists only hidden parts, and the choices hold
 * only on a known role's own page: never outside a room, in a preview or
 * on a table display, with the role this device last had in a room
 * standing in until the room says who you are.
 */

const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { PreviewContext } = await import("../dm/previewContext.ts");
const { Module, HiddenHere, useModule } = await import("./Gate.tsx");
const { resetAllFeatures, setModuleShown } = await import("./store.ts");

type Viewer = { role: "dm" | "player" } | null;

function inRoom(you: Viewer, child: ReturnType<typeof createElement>, opts: { display?: boolean; preview?: boolean } = {}): string {
  const store = createStore(() => ({ roomId: "K7QH2MXA", you: you ? { memberId: "m1", role: you.role } : null, view: null, local: {} }));
  const room = createElement(RoomProvider, {
    store: store as never,
    actions: {} as never,
    ui: {} as never,
    ...(opts.display ? { display: true } : {}),
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
  });
  return renderToStaticMarkup(opts.preview ? createElement(PreviewContext.Provider, { value: { memberId: "p1", name: "Pat" }, children: room }) : room);
}

function Shown(props: { id: "sound" | "ruler" }) {
  return createElement("span", null, useModule(props.id) ? "shown" : "hidden");
}

describe("the parts gate in components", () => {
  test("a shown part draws marked: on its one DOM child, else in a contents wrapper", () => {
    resetAllFeatures();
    assert.equal(inRoom({ role: "dm" }, createElement(Module, { id: "sound", children: createElement("section", { id: "s" }, "Sound") })), '<section id="s" data-part="sound">Sound</section>');
    assert.equal(
      inRoom({ role: "dm" }, createElement(Module, { id: "sound", children: [createElement("b", { key: 1 }, "a"), createElement("i", { key: 2 }, "b")] })),
      '<div data-part="sound" style="display:contents"><b>a</b><i>b</i></div>',
    );
    assert.equal(inRoom({ role: "dm" }, createElement(Module, { id: "sound", children: "words" })), '<div data-part="sound" style="display:contents">words</div>');
  });

  test("a hidden part draws nothing, and its condition decides where it has one", () => {
    resetAllFeatures();
    setModuleShown("floors", "dm", false);
    const floors = (when?: boolean) => createElement(Module, { id: "floors", ...(when === undefined ? {} : { when }), children: createElement("p", null, "Add a floor") });
    assert.equal(inRoom({ role: "dm" }, floors()), "");
    assert.equal(inRoom({ role: "dm" }, floors(true)), "");
    assert.equal(inRoom({ role: "dm" }, floors(false)), '<p data-part="floors">Add a floor</p>', "a scene with floors still shows them");
    resetAllFeatures();
  });

  test("the choices hold only on a known role's own page", () => {
    resetAllFeatures();
    setModuleShown("sound", "player", false);
    const shown = createElement(Shown, { id: "sound" });
    assert.equal(inRoom({ role: "player" }, shown), "<span>hidden</span>");
    assert.equal(inRoom({ role: "dm" }, shown), "<span>shown</span>", "the DM's choices are not the player's");
    assert.equal(inRoom({ role: "player" }, shown, { preview: true }), "<span>shown</span>", "View as a player shows every part");
    assert.equal(inRoom({ role: "player" }, shown, { display: true }), "<span>shown</span>", "a table display shows every part");
    assert.equal(renderToStaticMarkup(shown), "<span>shown</span>", "outside a room every part shows");
    resetAllFeatures();
  });

  test("before the room says who you are, the role this device last had there stands in", () => {
    resetAllFeatures();
    setModuleShown("ruler", "dm", false);
    const shown = createElement(Shown, { id: "ruler" });
    assert.equal(inRoom(null, shown), "<span>shown</span>", "no known role: every part");
    items.set("rvtt.rooms", JSON.stringify([{ roomId: "K7QH2MXA", name: "Crypt", role: "dm", memberName: "", openedAt: 1 }]));
    assert.equal(inRoom(null, shown), "<span>hidden</span>");
    items.delete("rvtt.rooms");
    resetAllFeatures();
  });

  test("Hidden on this device lists each hidden part with its Show, and nothing while none hides", () => {
    resetAllFeatures();
    assert.equal(inRoom({ role: "dm" }, createElement(HiddenHere, { home: "newScene" })), "");
    setModuleShown("builder", "dm", false);
    const html = inRoom({ role: "dm" }, createElement(Fragment, null, createElement(HiddenHere, { home: "newScene" })));
    assert.match(html, /^<div role="group" aria-label="Hidden on this device" data-hidden-here="newScene"/);
    assert.match(html, /Hidden on this device:<\/span>/);
    assert.deepEqual([...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)/g)].map((m) => m[1]), ["Show Map builder", "Show Dungeon generator and Map builder"]);
    assert.equal(inRoom({ role: "player" }, createElement(HiddenHere, { home: "newScene" })), "", "a player has no such home's parts");
    resetAllFeatures();
  });
});
