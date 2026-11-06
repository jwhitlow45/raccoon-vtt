import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { HandoutPage } from "#shared/model.ts";
import { showHandoutOp } from "./handouts.ts";
import {
  RECENT_HANDOUTS,
  encodeRecent,
  loadRecent,
  offerable,
  parseRecent,
  recentKey,
  recordShow,
  rememberShow,
  rememberedTitle,
  reshowInput,
  type RecentHandout,
  type RecentHandouts,
  type RecentRoom,
  type RecentStorage,
} from "./recent.ts";

const page = (assetId: string): HandoutPage => ({ assetId, width: 800, height: 1000 });
const player = { kind: "player" as const };

/** Pat and Ana play, Belak's letter is a three page document, and two images are in the library. */
function room(over: Partial<RecentRoom> = {}): RecentRoom {
  return {
    members: { dm: { kind: "dm" }, pat: player, ana: player },
    handoutDocs: { letter: { pages: [page("l1"), page("l2"), page("l3")] } },
    handouts: {},
    images: new Set(["map", "seal"]),
    ...over,
  };
}

const image = (assetId: string, to: RecentHandout["to"], at: number, title = `Image ${assetId}`): RecentHandout => ({ kind: "image", assetId, title, to, at });
const letter = (to: RecentHandout["to"], at: number): RecentHandout => ({ kind: "doc", docId: "letter", title: "Belak's letter", to, at });

describe("recording a showing", () => {
  test("puts it first, keeps five, and a second showing of the same image or document replaces the first", () => {
    let list: RecentHandout[] = [];
    for (let i = 0; i < 7; i++) list = recordShow(list, { kind: "image", assetId: `a${i}`, title: ` Map ${i} `, to: "all" }, i);
    assert.equal(list.length, RECENT_HANDOUTS);
    assert.deepEqual(list.map((e) => (e.kind === "image" ? e.assetId : e.docId)), ["a6", "a5", "a4", "a3", "a2"]);
    assert.equal(list[0]!.title, "Map 6", "the title as the show sent it");
    list = recordShow(list, { kind: "image", assetId: "a3", title: "Old map", to: ["pat", "pat"] }, 10);
    assert.deepEqual(list.map((e) => (e.kind === "image" ? e.assetId : e.docId)), ["a3", "a6", "a5", "a4", "a2"]);
    assert.deepEqual([list[0]!.title, list[0]!.to, list[0]!.at], ["Old map", ["pat"], 10]);
  });

  test("an image and a document with the same id are two things shown", () => {
    let list = recordShow([], { kind: "image", assetId: "x", title: "Picture", to: "all" }, 1);
    list = recordShow(list, { kind: "doc", docId: "x", title: "Book", to: "all" }, 2);
    assert.equal(list.length, 2);
    assert.equal(rememberedTitle(list, { kind: "image", assetId: "x" }), "Picture");
    assert.equal(rememberedTitle(list, { kind: "doc", docId: "x" }), "Book");
    assert.equal(rememberedTitle(list, { kind: "image", assetId: "y" }), null);
  });

  test("keeps a document as the whole document: no page is ever stored", () => {
    const [entry] = recordShow([], { kind: "doc", docId: "letter", title: "Belak's letter", to: "all", page: 2 } as never, 1);
    assert.deepEqual(Object.keys(entry!).sort(), ["at", "docId", "kind", "title", "to"]);
  });
});

describe("what is still offered", () => {
  test("newest first, each with its audience, members who left dropped, and none offered once no one is left", () => {
    const list = [image("map", ["pat", "gone"], 3), image("seal", ["gone"], 2), letter("all", 4)];
    const offered = offerable(list, room());
    assert.deepEqual(offered.map((e) => e.title), ["Belak's letter", "Image map"]);
    assert.deepEqual(offered.map((e) => e.to), ["all", ["pat"]], "Pat alone, never widened to everyone");
  });

  test("a player made a DM is no longer a chosen player", () => {
    assert.deepEqual(offerable([image("map", ["pat"], 1)], room({ members: { pat: { kind: "dm" } } })), []);
  });

  test("an image the library no longer lists or a deleted document is not offered, and an image waits for the list to know", () => {
    const list = [image("map", "all", 2), letter("all", 1)];
    assert.deepEqual(offerable(list, room({ images: new Set(), handoutDocs: {} })), []);
    assert.deepEqual(offerable(list, room({ images: null, handoutDocs: {} })).map((e) => e.title), ["Image map"]);
  });

  test("a showing on now is left out, an image by its one page and a document by its pages now", () => {
    const list = [image("map", "all", 2), letter(["ana"], 1)];
    const mapShows = { h1: { assetId: "map" } };
    assert.deepEqual(offerable(list, room({ handouts: mapShows })).map((e) => e.title), ["Belak's letter"]);
    const letterShows = { h2: { assetId: "l1", pages: [page("l1"), page("l2"), page("l3")] } };
    assert.deepEqual(offerable(list, room({ handouts: letterShows })).map((e) => e.title), ["Image map"]);
    // The letter changed since that showing: what shows is no longer the letter as it is, so it is offered again.
    const changed = room({ handouts: letterShows, handoutDocs: { letter: { pages: [page("l3"), page("l1")] } } });
    assert.deepEqual(offerable(list, changed).map((e) => e.title), ["Image map", "Belak's letter"]);
    // A page of the letter shown on its own is not the letter.
    assert.equal(offerable(list, room({ handouts: { h3: { assetId: "l1" } } })).length, 2);
  });
});

describe("a re-show", () => {
  test("of an image sends the image to its audience as the form would, under a new id", () => {
    const input = reshowInput(image("map", ["pat", "gone"], 1, "The old map"), room(), "h9");
    assert.deepEqual(input, { id: "h9", title: "The old map", audience: ["pat"], assetId: "map" });
    const op = showHandoutOp(input!);
    assert.ok(op.ok);
    assert.deepEqual(op.op.handout, { id: "h9", assetId: "map", title: "The old map", to: ["pat"] });
  });

  test("of a multipage document sends its pages as they are now: reordered, then with a page deleted", () => {
    const entry = letter(["ana", "pat"], 1);
    const first = reshowInput(entry, room(), "h1");
    assert.ok(first && "pages" in first);
    assert.deepEqual(first.pages.map((p) => p.assetId), ["l1", "l2", "l3"]);
    const reordered = room({ handoutDocs: { letter: { pages: [page("l3"), page("l1"), page("l2")] } } });
    const second = reshowInput(entry, reordered, "h2");
    assert.ok(second && "pages" in second);
    assert.deepEqual(second.pages.map((p) => p.assetId), ["l3", "l1", "l2"]);
    assert.deepEqual(second.audience, ["ana", "pat"]);
    const trimmed = room({ handoutDocs: { letter: { pages: [page("l3"), page("l2")] } } });
    const third = reshowInput(entry, trimmed, "h3");
    assert.ok(third && "pages" in third);
    assert.deepEqual(third.pages.map((p) => p.assetId), ["l3", "l2"]);
    const op = showHandoutOp(third);
    assert.ok(op.ok && "pages" in op.op.handout);
    assert.deepEqual(op.op.handout.pages.map((p) => p.assetId), ["l3", "l2"]);
    assert.deepEqual(op.op.handout.to, ["ana", "pat"]);
  });

  test("is not built for a deleted document, a gone image or an audience that left", () => {
    assert.equal(reshowInput(letter("all", 1), room({ handoutDocs: {} }), "h"), null);
    assert.equal(reshowInput(image("map", "all", 1), room({ images: new Set(["seal"]) }), "h"), null);
    assert.equal(reshowInput(image("map", ["gone"], 1), room(), "h"), null);
  });

  test("never reads a prototype member as a player or a document", () => {
    assert.equal(reshowInput(image("map", ["constructor", "__proto__"], 1), room(), "h"), null);
    assert.equal(reshowInput({ kind: "doc", docId: "constructor", title: "T", to: "all", at: 1 }, room(), "h"), null);
  });
});

describe("this device's storage", () => {
  test("round-trips the list, and reads only well-formed entries, newest first, once for each image or document", () => {
    const list = [letter(["pat"], 5), image("map", "all", 4, "The old map")];
    assert.deepEqual(parseRecent(encodeRecent(list)), list);
    const raw = JSON.stringify([
      image("map", "all", 1),
      { kind: "image", assetId: "", title: "x", to: "all", at: 2 },
      { kind: "image", assetId: "a", title: "", to: "all", at: 2 },
      { kind: "image", assetId: "a", title: "bad\ntitle", to: "all", at: 2 },
      { kind: "image", assetId: "a", title: "x", to: [], at: 2 },
      { kind: "image", assetId: "a", title: "x", to: "some", at: 2 },
      { kind: "image", assetId: "a", title: "x", to: "all", at: "now" },
      { kind: "page", assetId: "a", title: "x", to: "all", at: 2 },
      null,
      image("map", ["pat"], 3, "Newer"),
      letter("all", 2),
    ]);
    assert.deepEqual(parseRecent(raw), [image("map", ["pat"], 3, "Newer"), letter("all", 2)]);
    for (const junk of [null, "", "{", "{}", "7", JSON.stringify({ length: 2 })]) assert.deepEqual(parseRecent(junk), []);
    const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => image(`a${i}`, "all", i)));
    assert.equal(parseRecent(many).length, RECENT_HANDOUTS);
  });

  test("is kept per room, read once, written with each showing, and blocked storage only loses it at reload", () => {
    const data = new Map<string, string>();
    const storage: RecentStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    data.set(recentKey("r1"), encodeRecent([image("map", "all", 1)]));
    const store = createStore<RecentHandouts>(() => ({ roomId: null, entries: [] }));
    loadRecent(store, "r1", storage);
    assert.equal(store.getState().entries.length, 1);
    rememberShow(store, { kind: "doc", docId: "letter", title: "Belak's letter", to: ["pat"] }, 2, storage);
    assert.deepEqual(parseRecent(data.get(recentKey("r1"))!).map((e) => e.title), ["Belak's letter", "Image map"]);
    assert.equal(data.has(recentKey("r2")), false, "another room's key is untouched");
    data.set(recentKey("r1"), "[]");
    loadRecent(store, "r1", storage);
    assert.equal(store.getState().entries.length, 2, "read once a room, so this page's own showings stay");

    const blocked: RecentStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const other = createStore<RecentHandouts>(() => ({ roomId: null, entries: [] }));
    loadRecent(other, "r2", blocked);
    rememberShow(other, { kind: "image", assetId: "map", title: "Map", to: "all" }, 3, blocked);
    assert.deepEqual(other.getState().entries.map((e) => e.title), ["Map"]);
  });
});
