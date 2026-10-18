import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Handout, Member } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { audienceText, decodeDismissed, encodeDismissed, keepShowing, nextPopup, pageCountText, pageName, popupShows, seenOnLoad, showHandoutOp, showingKey, TITLE_FIELD_MAX, titleFromFileName, titleProblem } from "./handouts.ts";

const handout = (id: string, shownAt: string, to: Handout["to"] = "all"): Handout => ({ id, rev: 0, assetId: "a", title: id, to, shownAt });

describe("handout popups", () => {
  test("a handout that would open while the X-card shows waits until the card is dismissed", () => {
    assert.equal(popupShows({ handout: true, open: false, xcard: false }), true);
    assert.equal(popupShows({ handout: true, open: false, xcard: true }), false, "it would cover the card");
    assert.equal(popupShows({ handout: true, open: true, xcard: true }), true, "one already open stays, under the card");
    assert.equal(popupShows({ handout: false, open: true, xcard: false }), false);
  });

  test("the most recently shown handout pops up first", () => {
    const handouts = { a: handout("a", "2026-10-12T19:00:00.000Z"), b: handout("b", "2026-10-12T19:05:00.000Z") };
    assert.equal(nextPopup(handouts, new Set())?.id, "b");
  });

  test("closing one shows the next, and nothing once all are closed", () => {
    const a = handout("a", "2026-10-12T19:00:00.000Z");
    const b = handout("b", "2026-10-12T19:05:00.000Z");
    assert.equal(nextPopup({ a, b }, new Set([showingKey(b)]))?.id, "a");
    assert.equal(nextPopup({ a, b }, new Set([showingKey(a), showingKey(b)])), null);
  });

  test("one that was showing when the page opened the room waits in the Library, unless it was this tab's open one", () => {
    const a = handout("a", "2026-10-12T19:00:00.000Z");
    const b = handout("b", "2026-10-12T19:05:00.000Z");
    assert.equal(nextPopup({ a, b }, new Set(), null, seenOnLoad({ a, b }, null)), null);
    assert.equal(nextPopup({ a, b }, new Set(), null, seenOnLoad({ a, b }, showingKey(a)))?.id, "a");
    const later = handout("c", "2026-10-12T19:10:00.000Z");
    assert.equal(nextPopup({ a, b, c: later }, new Set(), null, seenOnLoad({ a, b }, null))?.id, "c", "a show after the page opened pops up");
  });

  test("showing a handout again pops it up again", () => {
    const first = handout("a", "2026-10-12T19:00:00.000Z");
    const again = handout("a", "2026-10-12T19:30:00.000Z");
    assert.equal(nextPopup({ a: again }, new Set([showingKey(first)]))?.id, "a");
  });
});

describe("closed handouts on this device", () => {
  test("survive a reload through storage, so open handouts do not all pop up again", () => {
    const a = handout("a", "2026-10-12T19:00:00.000Z");
    const closed = decodeDismissed(encodeDismissed(new Set([showingKey(a)])));
    assert.equal(nextPopup({ a }, closed), null);
  });

  test("keep only handouts still showing", () => {
    const a = handout("a", "2026-10-12T19:00:00.000Z");
    const gone = handout("gone", "2026-10-12T18:00:00.000Z");
    const shownAgain = handout("b", "2026-10-12T19:30:00.000Z");
    const kept = keepShowing(new Set([showingKey(a), showingKey(gone), "b@2026-10-12T19:10:00.000Z"]), { a, b: shownAgain });
    assert.deepEqual([...kept], [showingKey(a)]);
  });

  test("anything unreadable in storage counts as nothing closed", () => {
    assert.equal(decodeDismissed("{not json").size, 0);
    assert.equal(decodeDismissed('{"a":1}').size, 0);
    assert.deepEqual([...decodeDismissed('["x", 3]')], ["x"]);
  });

  test("one opened again from the Library goes first, even if older", () => {
    const a = handout("a", "2026-10-12T19:00:00.000Z");
    const b = handout("b", "2026-10-12T19:05:00.000Z");
    assert.equal(nextPopup({ a, b }, new Set(), "a")?.id, "a");
    // Closed again, the preference no longer holds it up.
    assert.equal(nextPopup({ a, b }, new Set([showingKey(a)]), "a")?.id, "b");
  });
});

describe("showing a handout", () => {
  test("builds a valid op for everyone or for chosen players", () => {
    const all = showHandoutOp({ id: "h1", assetId: "asset", title: "  The letter ", audience: "all" });
    assert.ok(all.ok);
    assert.deepEqual(all.op, { t: "handout.show", handout: { id: "h1", assetId: "asset", title: "The letter", to: "all" } });
    assert.ok(clientOpSchema.safeParse(all.op).success);
    const some = showHandoutOp({ id: "h2", assetId: "asset", title: "Map", audience: ["m-thorn", "m-thorn", "m-vex"] });
    assert.ok(some.ok && some.op.handout.to !== "all" && some.op.handout.to.length === 2);
  });

  test("shows a document's pages in order, as a copy, with a new handout id (docs/design-v1-pdf-handouts.md 8.2)", () => {
    const pages = [
      { assetId: "p1", width: 1584, height: 2048 },
      { assetId: "p2", width: 2048, height: 1584 },
      { assetId: "p1", width: 1584, height: 2048 },
    ];
    const shown = showHandoutOp({ id: "h3", pages, title: "Strange letter", audience: "all" });
    assert.ok(shown.ok);
    assert.deepEqual(shown.op, { t: "handout.show", handout: { id: "h3", pages, title: "Strange letter", to: "all" } });
    assert.notEqual(shown.ok && "pages" in shown.op.handout ? shown.op.handout.pages : null, pages, "the document's own list went into the op");
    assert.ok(clientOpSchema.safeParse(shown.op).success);
  });

  test("needs a title and at least one recipient", () => {
    assert.equal(showHandoutOp({ id: "h", assetId: "a", title: " ", audience: "all" }).ok, false);
    assert.equal(showHandoutOp({ id: "h", assetId: "a", title: "x", audience: [] }).ok, false);
  });

  test("a title counts code points, as the protocol does: a saved document of 41 dragons shows under its own title, and 81 code points do not", () => {
    const pages = [{ assetId: "p1", width: 1583, height: 2048 }];
    const dragons = "\u{1F409}".repeat(41);
    assert.equal(titleProblem(dragons), null, "the upload saves it");
    const shown = showHandoutOp({ id: "h", pages, title: dragons, audience: "all" });
    assert.ok(shown.ok, "Show it takes it");
    assert.ok(shown.ok && clientOpSchema.safeParse(shown.op).success, "and so does the server");
    assert.ok(dragons.length <= TITLE_FIELD_MAX, "the form's field holds it");
    const long = showHandoutOp({ id: "h", pages, title: "\u{1F409}".repeat(81), audience: "all" });
    assert.deepEqual(long, { ok: false, error: "A title is at most 80 characters." });
  });

  test("names the audience", () => {
    const m = (id: string, name: string): Member => ({ id, rev: 1, name, color: "#fff", kind: "player", createdAt: "" });
    const members = { a: m("a", "Thorn"), b: m("b", "Vex"), c: m("c", "Ana") };
    assert.equal(audienceText("all", members), "Everyone");
    assert.equal(audienceText(["a", "b"], members), "Thorn and Vex");
    assert.equal(audienceText(["a", "b", "c"], members), "Thorn, Vex and Ana");
  });

  test("a title from a file name", () => {
    assert.equal(titleFromFileName("old-map_v2.jpg"), "old map v2");
    assert.equal(titleFromFileName("Letter.PNG"), "Letter");
  });
});

describe("a handout's pages", () => {
  test("each page has one name, with its number and the count, and one image is named by its title alone", () => {
    assert.equal(pageName("Strange letter", 1, 5), "Strange letter, page 2 of 5");
    assert.equal(pageName("Strange letter", 0, 1), "Strange letter");
    assert.equal(pageCountText(12), "12 pages");
    assert.equal(pageCountText(1), "1 page");
  });
});
