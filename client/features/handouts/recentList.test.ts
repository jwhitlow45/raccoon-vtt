import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Handout, HandoutDoc, HandoutPage, Member } from "#shared/model.ts";
import { showHandoutOp } from "./handouts.ts";
import { offerable, recordShow, reshowInput, type RecentHandout } from "./recent.ts";
import { entryKey, recentRoomOf, recentRowWords, reshowProblem, shownOf } from "./recentList.ts";

/*
 * Handouts' Recent list (docs/design/design-v1-qol.md 3, Q11): a showing taken,
 * then offered again to the same players as the room is now.
 */

const page = (assetId: string): HandoutPage => ({ assetId, width: 800, height: 1000 });
const member = (name: string, kind: Member["kind"] = "player") => ({ id: name.toLowerCase(), name, kind }) as Member;
const MEMBERS: Record<string, Member | undefined> = { dm: member("Dee", "dm"), pat: member("Pat"), ana: member("Ana"), lee: member("Lee") };
const doc = (pages: HandoutPage[]) => ({ id: "letter", title: "Belak's letter", pages }) as unknown as HandoutDoc;

/** The show the form or a recent row sends, through the one op builder. */
function showOp(input: Parameters<typeof showHandoutOp>[0]) {
  const result = showHandoutOp(input);
  assert.ok(result.ok);
  return result.op;
}

type ShowOp = ReturnType<typeof showOp>;
const pagesOf = (op: ShowOp | undefined) => (op && "pages" in op.handout ? op.handout.pages.map((p) => p.assetId) : null);
const assetOf = (op: ShowOp | undefined) => (op && "assetId" in op.handout ? op.handout.assetId : null);

/** What a re-show of `entry` sends in `view`, or null where it is not offered. */
function reshown(entry: RecentHandout, view: Parameters<typeof recentRoomOf>[0], library: Parameters<typeof recentRoomOf>[1] = null) {
  const room = recentRoomOf(view, library);
  const offered = offerable([entry], room)[0];
  if (!offered) return null;
  const input = reshowInput(offered, room, "h2");
  return input ? { offered, op: showOp(input) } : null;
}

describe("a showing remembered, then shown again", () => {
  test("a three page document shown to Pat and Ana goes again to them, with its pages as they are now", () => {
    const pages = [page("l1"), page("l2"), page("l3")];
    const sent = showOp({ id: "h1", title: " Belak's letter ", audience: ["pat", "ana"], pages });
    const [entry] = recordShow([], shownOf(sent, { kind: "doc", docId: "letter" }), 1);
    assert.deepEqual(entry, { kind: "doc", docId: "letter", title: "Belak's letter", to: ["pat", "ana"], at: 1 }, "a whole document, never a page");
    const view = { members: MEMBERS, handoutDocs: { letter: doc(pages) }, handouts: {} };
    assert.deepEqual(pagesOf(reshown(entry!, view)?.op), ["l1", "l2", "l3"]);
    // A page moved and one deleted since: the document as it is now.
    const changed = { ...view, handoutDocs: { letter: doc([page("l3"), page("l1")]) } };
    const again = reshown(entry!, changed);
    assert.deepEqual(pagesOf(again?.op), ["l3", "l1"]);
    assert.deepEqual(again?.op.handout.to, ["pat", "ana"]);
    assert.equal(again?.op.handout.title, "Belak's letter");
    assert.deepEqual(recentRowWords(again!.offered, MEMBERS), { detail: "Document", button: "Show to Pat and Ana", label: "Show Belak's letter to Pat and Ana" });
    // Ana left: Pat alone. Both left: not offered, never widened to everyone.
    const { ana: _ana, ...noAna } = MEMBERS;
    assert.deepEqual(reshown(entry!, { ...changed, members: noAna })?.op.handout.to, ["pat"]);
    const { pat: _pat, ...nobody } = noAna;
    assert.equal(reshown(entry!, { ...changed, members: nobody }), null);
    assert.equal(reshown(entry!, { ...changed, handoutDocs: {} }), null, "a deleted document leaves the list");
    // Showing now: Showing above holds it with Hide.
    const showing = { h9: { id: "h9", title: "Belak's letter", to: "all", pages: [page("l3"), page("l1")], assetId: "l3" } as unknown as Handout };
    assert.equal(reshown(entry!, { ...changed, handouts: showing }), null);
  });

  test("an image to everyone reads so, and the library decides once listed", () => {
    const sent = showOp({ id: "h1", title: "Cragmaw map", audience: "all", assetId: "map" });
    const [entry] = recordShow([], shownOf(sent, { kind: "image", assetId: "map" }), 1);
    const view = { members: MEMBERS, handoutDocs: {}, handouts: {} };
    const before = reshown(entry!, view, null);
    assert.equal(assetOf(before?.op), "map", "offered before the library is listed: the server's check decides");
    assert.deepEqual(recentRowWords(before!.offered, MEMBERS), { detail: null, button: "Show to everyone", label: "Show Cragmaw map to everyone" });
    assert.equal(reshown(entry!, view, [{ id: "map", kind: "handout" }])?.op.handout.to, "all");
    assert.equal(reshown(entry!, view, [{ id: "other", kind: "handout" }]), null, "deleted from the library: not offered");
    assert.equal(reshown(entry!, view, [{ id: "map", kind: "map" }]), null, "only handout images count");
  });

  test("three or more players are each named, and a key tells an image from a document", () => {
    const entry: RecentHandout = { kind: "image", assetId: "seal", title: "Seal", to: ["pat", "ana", "lee"], at: 1 };
    assert.equal(recentRowWords(entry, MEMBERS).button, "Show to Pat, Ana and Lee");
    assert.notEqual(entryKey({ kind: "image", assetId: "x" }), entryKey({ kind: "doc", docId: "x" }));
  });

  test("a refused or unsure re-show says so in its row", () => {
    assert.equal(reshowProblem("refused", { text: "That image is gone.", message: "gone" }), "That image is gone.");
    assert.equal(reshowProblem("refused", { message: "invalid" }), "invalid");
    assert.equal(reshowProblem("refused"), "That handout could not be shown.");
    assert.equal(reshowProblem("unknown"), "It may not have shown. Try again.");
  });
});
