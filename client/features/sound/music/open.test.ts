import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { RoomScope } from "../../../state/scope.ts";
import { panelScrollSlot, type PanelScroll } from "../../panels.ts";
import { closeMaker, endSoundView, MAKER_CLOSED, MAKER_OPENER, makerOpener, makerSlot, openMaker, openSoundNow, setMakerDraft, SOUND_VIEW_START, soundAskSlot, soundRootsSlot, soundViewSlot, type MakerDraft } from "./open.ts";

/*
 * The Sound panel's state that outlives it (docs/design/design-v1-sound-layout.md
 * 4.1 and 4.5): the view and Library's search, what a close resets, Open
 * Sound's request, and the maker's pop-up.
 */

const place = (top: number): PanelScroll => ({ top, left: 0, end: false, page: "library", subject: null });

function recorder() {
  const calls: string[] = [];
  return { calls, ui: { openPanel: (id: string, how?: unknown) => void calls.push(`openPanel ${id}${how === undefined ? "" : ` ${JSON.stringify(how)}`}`) } };
}

const draft = (playlistId: string): MakerDraft => ({ playlistId, name: "Tavern night", sounds: [], shuffle: false, repeat: "all", fade: 5, base: null, tab: "tracks" });

const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe("the Sound panel's view", () => {
  test("starts on Now playing with no search, one store per Room page", () => {
    assert.deepEqual(SOUND_VIEW_START, { view: "now", query: "" });
    assert.ok(Object.isFrozen(SOUND_VIEW_START));
    const a = new RoomScope();
    const b = new RoomScope();
    assert.equal(a.get(soundViewSlot), a.get(soundViewSlot), "both trees of one Room read one store");
    assert.notEqual(a.get(soundViewSlot), b.get(soundViewSlot), "a preview's page has its own");
    assert.deepEqual(a.get(soundViewSlot).getState(), { view: "now", query: "" });
    assert.deepEqual(Object.keys(a.get(soundViewSlot).getState()).sort(), ["query", "view"], "the view and the query, nothing else");
  });

  test("a close resets the view and the search and drops Sound's remembered scroll alone", () => {
    const scope = new RoomScope();
    const view = scope.get(soundViewSlot);
    view.setState({ view: "library", query: "harbor" });
    const kept = scope.get(panelScrollSlot);
    kept.set("sound", place(5800));
    kept.set("monsters", place(300));
    endSoundView(scope);
    assert.deepEqual(view.getState(), { view: "now", query: "" });
    assert.equal(kept.has("sound"), false, "Library's foot is never put back on the next opening");
    assert.deepEqual(kept.get("monsters"), place(300), "another panel keeps its place");
  });
});

describe("Open Sound", () => {
  test("opens Sound on Now playing, keeps the search, and asks for its top once per press", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    scope.get(soundViewSlot).setState({ view: "library", query: "harbor" });
    openSoundNow(scope, ui);
    assert.deepEqual(scope.get(soundViewSlot).getState(), { view: "now", query: "harbor" });
    assert.equal(scope.get(soundAskSlot).getState().seq, 1);
    openSoundNow(scope, ui);
    assert.equal(scope.get(soundAskSlot).getState().seq, 2, "a second press acts again");
    assert.deepEqual(calls, ["openPanel sound", "openPanel sound"], "no pane named, so a Sound already open stays where it is");
  });

  test("blurs a field typed in inside the Sound panel first, so a track's name saves, and leaves focus elsewhere alone", () => {
    const scope = new RoomScope();
    const blurred: string[] = [];
    const field = { name: "name", blur: () => void blurred.push("name") };
    const outside = { name: "chat", blur: () => void blurred.push("chat") };
    scope.get(soundRootsSlot).add({ contains: (node) => node === (field as unknown as Node) });
    (globalThis as { document?: unknown }).document = { activeElement: field };
    openSoundNow(scope, recorder().ui);
    assert.deepEqual(blurred, ["name"]);
    (globalThis as { document?: unknown }).document = { activeElement: outside };
    openSoundNow(scope, recorder().ui);
    assert.deepEqual(blurred, ["name"], "a field outside the panel keeps its focus");
  });
});

describe("the maker's pop-up", () => {
  test("opens on a draft from a marked control, takes the draft's changes, and closes letting both go", () => {
    const store = new RoomScope().get(makerSlot);
    assert.equal(store.getState(), MAKER_CLOSED);
    assert.deepEqual(MAKER_CLOSED, { draft: null, opener: null });
    openMaker(store, draft("p1"), "new-playlist");
    assert.deepEqual(store.getState(), { draft: draft("p1"), opener: "new-playlist" });
    setMakerDraft(store, { ...draft("p1"), name: "Harbor" });
    assert.equal(store.getState().draft?.name, "Harbor");
    assert.equal(store.getState().opener, "new-playlist", "the opener stays");
    closeMaker(store);
    assert.deepEqual(store.getState(), { draft: null, opener: null });
    setMakerDraft(store, draft("p1"));
    assert.equal(store.getState().draft, null, "an answer after the close opens nothing");
  });

  test("focus goes back to the control with the opener's mark, found as the maker closes", () => {
    const rows = [
      { id: "playlist-a", el: { tag: "a" } },
      { id: "new-playlist", el: { tag: "new" } },
    ];
    const selectors: string[] = [];
    (globalThis as { document?: unknown }).document = {
      querySelectorAll(selector: string) {
        selectors.push(selector);
        return rows.map((r) => ({ ...r.el, getAttribute: (name: string) => (name === MAKER_OPENER ? r.id : null) }));
      },
    };
    const back = makerOpener("new-playlist");
    assert.equal(selectors.length, 0, "found at the close, not at the render");
    assert.equal((back.current as unknown as { tag: string }).tag, "new");
    assert.deepEqual(selectors, ["[data-maker-opener]"]);
    assert.equal(makerOpener("gone").current, null);
    assert.equal(makerOpener(null).current, null);
  });
});
