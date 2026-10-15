import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JournalPage, Pin } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { editDraft, saveAnswered, saveSent, saveState } from "../journal/pendingSave.ts";
import { dmOnlyPin, PIN_HEIGHT_PX, pinAt, pinAudience, pinCommit, pinDraftOf, pinOutline, pinSaveAnswer, pinTapCounts, pinToolTap, pinUnder, withDmOnly, withPage, withPageGone } from "./rules.ts";

const page = (id: string, title: string, access: JournalPage["access"]): JournalPage => ({ id, rev: 0, title, access, blocks: [] });
const PAGES = { all: page("all", "Tavern", "all"), dm: page("dm", "Villain plans", "dm"), thorn: page("thorn", "Old Map", { member: "m1" }), mira: page("mira", "Letter", { member: "m2" }) };
const MEMBERS = { m1: { name: "Thorn" }, m2: { name: "Mira" } };
const pin = (extra: Partial<Pin> = {}): Pin => ({ id: "p1", rev: 2, sceneId: "s1", x: 4.5, y: 3.25, color: "#f7df00", visibility: "all", ...extra });

describe("map pins", () => {
  test("the marker is 28 px from tip to head, and its tap target is 44 px across", () => {
    const pts = pinOutline();
    const ys = pts.filter((_, i) => i % 2 === 1);
    assert.equal(Math.min(...ys), -PIN_HEIGHT_PX);
    assert.equal(Math.max(...ys), 0);
    const camera = { x: 0, y: 0, scale: 40 };
    const pins = [pin()];
    // The tip is at (180, 130) on screen.
    assert.equal(pinAt(pins, camera, { x: 180, y: 116 })?.id, "p1");
    assert.equal(pinAt(pins, camera, { x: 180 + 21, y: 116 })?.id, "p1");
    assert.equal(pinAt(pins, camera, { x: 180 + 23, y: 116 }), null);
    assert.equal(pinAt(pins, { x: 0, y: 0, scale: 4 }, { x: 18, y: 13 - 14 })?.id, "p1", "one size on screen at any zoom");
  });

  test("the nearer of two overlapping pins takes the tap", () => {
    const pins = [pin({ id: "a", x: 1 }), pin({ id: "b", x: 1.5 })];
    assert.equal(pinAt(pins, { x: 0, y: 0, scale: 40 }, { x: 58, y: 116 })?.id, "b");
  });

  test("a Select tap on a pin is one finger lifted where it landed, and never a hold that pinged", () => {
    const start = { x: 180, y: 116 };
    assert.equal(pinTapCounts({ start, end: { x: 186, y: 120 }, several: false, held: false }), true);
    assert.equal(pinTapCounts({ start, end: { x: 186, y: 120 }, several: false, held: true }), false, "a hold-to-ping on a pin does not open it");
    assert.equal(pinTapCounts({ start, end: { x: 190, y: 116 }, several: false, held: false }), false, "a pan");
    assert.equal(pinTapCounts({ start, end: start, several: true, held: false }), false, "a pinch");
    const view = { pins: { p1: pin(), p2: pin({ id: "p2", sceneId: "s2" }) } };
    const camera = { x: 0, y: 0, scale: 40 };
    assert.equal(pinUnder(view, "s1", camera, start)?.id, "p1");
    assert.equal(pinUnder(view, "s3", camera, start), null, "a pin on another scene");
    assert.equal(pinUnder(null, "s1", camera, start), null);
  });

  test("a tap with the Pin tool: a waiting page places a linked pin, a pin opens, away closes, else a new pin", () => {
    assert.deepEqual(pinToolTap({ placing: { pageId: "pg" }, hit: "p1", paneOpen: true }), { kind: "placeLinked", pageId: "pg" });
    assert.deepEqual(pinToolTap({ placing: null, hit: "p1", paneOpen: false }), { kind: "open", pinId: "p1" });
    assert.deepEqual(pinToolTap({ placing: null, hit: null, paneOpen: true }), { kind: "close" });
    assert.deepEqual(pinToolTap({ placing: null, hit: null, paneOpen: false }), { kind: "place" });
  });

  test("who will see a pin follows the projection's rule", () => {
    assert.equal(pinAudience({ visibility: "dm", pageId: "all" }, PAGES, MEMBERS), "Only the DM");
    assert.equal(pinAudience({ visibility: "all", pageId: null }, PAGES, MEMBERS), "Every player");
    assert.equal(pinAudience({ visibility: "all", pageId: "all" }, PAGES, MEMBERS), "Every player");
    assert.equal(pinAudience({ visibility: "all", pageId: "dm" }, PAGES, MEMBERS), "Only the DM");
    assert.equal(pinAudience({ visibility: "all", pageId: "thorn" }, PAGES, MEMBERS), "Players who can read Old Map: Thorn");
  });

  test("dropping or changing the link of a pin on a restricted page turns DM only on in the same save", () => {
    for (const from of ["dm", "thorn"]) {
      const stored = pin({ pageId: from });
      for (const to of [null, "all", "mira", "dm", "thorn"].filter((p) => p !== from)) {
        const next = withPage(stored, pinDraftOf(stored), to, PAGES);
        assert.equal(next.dmOnly, true, `${from} to ${to}`);
        assert.equal(next.autoDmOnly, "restricted");
        const commit = pinCommit(stored, next);
        assert.ok(commit.kind === "put" && commit.pin.visibility === "dm");
      }
    }
  });

  test("the DM may turn DM only off again before saving, and the line says who will see it then", () => {
    const stored = pin({ pageId: "thorn" });
    const moved = withPage(stored, pinDraftOf(stored), "mira", PAGES);
    const off = withDmOnly(moved, false);
    assert.equal(off.dmOnly, false);
    assert.equal(pinAudience({ visibility: "all", pageId: off.pageId }, PAGES, MEMBERS), "Players who can read Letter: Mira");
    const commit = pinCommit(stored, off);
    assert.ok(commit.kind === "put" && commit.pin.visibility === "all" && commit.pin.pageId === "mira");
  });

  test("a pin from a page for everyone, or with no page, changes its link freely, and going back undoes the switch", () => {
    for (const from of [undefined, "all"]) {
      const stored = pin(from ? { pageId: from } : {});
      const next = withPage(stored, pinDraftOf(stored), "thorn", PAGES);
      assert.equal(next.dmOnly, false);
    }
    const stored = pin({ pageId: "dm" });
    const away = withPage(stored, pinDraftOf(stored), null, PAGES);
    const back = withPage(stored, away, "dm", PAGES);
    assert.deepEqual(back, pinDraftOf(stored));
  });

  test("Done sends one valid pin.put, or nothing when nothing changed", () => {
    const stored = pin({ label: "Door", pageId: "all" });
    assert.deepEqual(pinCommit(stored, pinDraftOf(stored)), { kind: "unchanged" });
    const commit = pinCommit(stored, { ...pinDraftOf(stored), label: "  Secret\tdoor " , pageId: null });
    assert.deepEqual(commit, { kind: "put", pin: { id: "p1", sceneId: "s1", x: 4.5, y: 3.25, color: "#f7df00", visibility: "all", label: "Secret door" } });
    assert.ok(commit.kind === "put" && clientOpSchema.safeParse({ t: "pin.put", pin: commit.pin }).success);
    assert.deepEqual(pinCommit(stored, { ...pinDraftOf(stored), label: "x".repeat(81) }), { kind: "tooLong" });
  });

  test("the DM's map fades a pin no player can receive", () => {
    assert.equal(dmOnlyPin({ visibility: "dm" }, PAGES), true);
    assert.equal(dmOnlyPin({ visibility: "all", pageId: "dm" }, PAGES), true);
    assert.equal(dmOnlyPin({ visibility: "all", pageId: "thorn" }, PAGES), false);
    assert.equal(dmOnlyPin({ visibility: "all" }, PAGES), false);
  });

  test("the pane closes only once the server took the pin, and keeps the draft with the reason otherwise", () => {
    assert.deepEqual(pinSaveAnswer("taken"), { kind: "closed" });
    const full = pinSaveAnswer("refused", { code: "quota", message: "this scene already has 200 pins", text: "Not saved. This scene already has 200 pins." });
    assert.deepEqual(full, { kind: "kept", problem: "Not saved. This scene already has 200 pins." });
    const gone = pinSaveAnswer("refused", { code: "gone", message: "page", text: "Not saved. Page." });
    assert.ok(gone.kind === "kept" && /page it links to was deleted/.test(gone.problem));
    const unknown = pinSaveAnswer("unknown");
    assert.ok(unknown.kind === "kept" && /may not be saved/.test(unknown.problem));
  });

  // W5-DATA-03: a change made after Done, before the acknowledgment, was lost when the acknowledgment closed the pane.
  test("a change while Done is pending is refused, and the acknowledgment closes with the pin as sent", () => {
    const stored = pin({ label: "Door" });
    let state = saveState(withDmOnly({ ...pinDraftOf(stored), label: "Secret door" }, true));
    const sent = pinCommit(stored, state.draft);
    assert.ok(sent.kind === "put");
    state = saveSent(state);
    assert.equal(editDraft(state, (d) => ({ ...d, label: "Trapdoor" })), state, "the change is refused while Done is pending");
    assert.equal(editDraft(state, (d) => withDmOnly(d, false)), state);
    const answered = saveAnswered(state, pinSaveAnswer("taken"));
    assert.equal(answered.close, true);
    assert.deepEqual(pinCommit(stored, answered.state.draft), sent, "what closes is what was sent");
    const refused = saveAnswered(state, pinSaveAnswer("refused", { code: "quota", message: "x", text: "Not saved. This scene already has 200 pins." }));
    assert.equal(refused.close, false);
    assert.equal(editDraft(refused.state, (d) => ({ ...d, label: "Trapdoor" })).draft.label, "Trapdoor", "editable again after a refusal");
  });

  // LP5-NOTES-1: the pane kept naming a page deleted on another DM device, so Done was refused, and a save made by
  // picking around it published a pin the deletion had made DM only.
  test("a linked page deleted while the pane is open leaves the draft with no page and DM only on, as the deletion left the pin", () => {
    const stored = pin({ pageId: "thorn", label: "Old well" });
    const typed = { ...pinDraftOf(stored), label: "Older well", color: "#3b82f6" };
    const { thorn: _deleted, ...left } = PAGES;
    const next = withPageGone(typed, left);
    assert.deepEqual(next, { label: "Older well", color: "#3b82f6", pageId: null, dmOnly: true, autoDmOnly: "deleted" });
    assert.equal(pinAudience({ visibility: "dm", pageId: next.pageId }, left, MEMBERS), "Only the DM");

    // The server unlinked the pin and made it DM only (shared/reducer/journal.ts), so nothing typed means nothing to send.
    const afterDelete = pin({ label: "Old well", visibility: "dm" });
    assert.deepEqual(pinCommit(afterDelete, withPageGone(pinDraftOf(stored), left)), { kind: "unchanged" });
    const commit = pinCommit(afterDelete, next);
    assert.ok(commit.kind === "put" && commit.pin.visibility === "dm" && commit.pin.pageId === undefined && commit.pin.label === "Older well");

    // Picking "No page" again keeps DM only on, and only the DM's own switch turns it off.
    assert.equal(withPage(afterDelete, next, null, left).dmOnly, true);
    assert.equal(withDmOnly(next, false).dmOnly, false);
  });

  // POSTW5-OPUS-1: the hint said the page was not for every player, though a deletion hides the pin whatever its page's access.
  test("a deleted page names the deletion as the reason, whatever its access, and a pin already DM only names none", () => {
    const { all: _deleted, ...left } = PAGES;
    const gone = withPageGone(pinDraftOf(pin({ pageId: "all" })), left);
    assert.equal(gone.dmOnly, true);
    assert.equal(gone.autoDmOnly, "deleted");

    // Linking another page keeps the reason, since the deletion is still what turned DM only on.
    const afterDelete = pin({ visibility: "dm" });
    for (const to of ["dm", "thorn", "mira"]) assert.equal(withPage(afterDelete, gone, to, left).autoDmOnly, "deleted", to);

    // DM only turned on by leaving a restricted page takes the deletion as its reason once the new page goes.
    const onOldMap = pin({ pageId: "thorn" });
    const movedToTavern = withPage(onOldMap, pinDraftOf(onOldMap), "all", PAGES);
    assert.equal(movedToTavern.autoDmOnly, "restricted");
    assert.equal(withPageGone(movedToTavern, left).autoDmOnly, "deleted");

    assert.equal(withPageGone(pinDraftOf(pin({ pageId: "all", visibility: "dm" })), left).autoDmOnly, false);
  });

  test("a draft whose page still exists, or that links none, is left as it is", () => {
    const linked = pinDraftOf(pin({ pageId: "thorn" }));
    assert.equal(withPageGone(linked, PAGES), linked);
    const none = pinDraftOf(pin());
    assert.equal(withPageGone(none, {}), none);
  });
});
