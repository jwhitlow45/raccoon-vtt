import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JournalPage } from "#shared/model.ts";
import { checkLimits, LIMITS, serializedBytes } from "#shared/limits.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, room } from "#shared/testutil.ts";
import { accessText, cleanBlockText, cleanTitle, draftDirty, draftOf, emptyDraft, groupPages, moveBlock, newBlockId, saveAnswer, saveDraft, sizeNote, storedPage, type PageDraft } from "./draft.ts";

const PAGE: JournalPage = {
  id: "pg1",
  rev: 3,
  title: "Old map",
  folder: "Act one",
  access: "all",
  blocks: [
    { id: "aaaaaaaaaaaa", text: "The crypt lies north." },
    { id: "bbbbbbbbbbbb", text: "A trap at the door.", secret: { revealed: true } },
  ],
};

describe("journal drafts", () => {
  test("a block id is 12 characters the protocol takes", () => {
    for (let i = 0; i < 50; i++) assert.match(newBlockId(), /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(newBlockId(), newBlockId());
  });

  test("a new page is DM only with one empty block, and needs a title", () => {
    const draft = emptyDraft(() => "cccccccccccc");
    assert.equal(draft.access, "dm");
    assert.deepEqual(saveDraft(null, draft, "pg2"), { kind: "invalid", problems: ["The page needs a title."] });
  });

  test("a new page is one journal.create, empty blocks left out", () => {
    const draft: PageDraft = { title: "  Notes\tfor\nme ", folder: "", access: "dm", blocks: [{ id: "cccccccccccc", text: "  ", secret: false }, { id: "dddddddddddd", text: "Hidden", secret: true }] };
    assert.deepEqual(saveDraft(null, draft, "pg2"), {
      kind: "op",
      op: { t: "journal.create", page: { id: "pg2", title: "Notes for me", access: "dm", blocks: [{ id: "dddddddddddd", text: "Hidden", secret: true }] } },
    });
  });

  test("an edit sends only what changed, and nothing when nothing did", () => {
    assert.deepEqual(saveDraft(PAGE, draftOf(PAGE), "pg1"), { kind: "unchanged" });
    const retitled = { ...draftOf(PAGE), title: "Older map" };
    assert.deepEqual(saveDraft(PAGE, retitled, "pg1"), { kind: "op", op: { t: "journal.update", pageId: "pg1", patch: { title: "Older map" } } });
    const unfiled = { ...draftOf(PAGE), folder: " " };
    assert.deepEqual(saveDraft(PAGE, unfiled, "pg1"), { kind: "op", op: { t: "journal.update", pageId: "pg1", patch: { folder: null } } });
    const private_ = { ...draftOf(PAGE), access: { member: "m1" } };
    assert.deepEqual(saveDraft(PAGE, private_, "pg1"), { kind: "op", op: { t: "journal.update", pageId: "pg1", patch: { access: { member: "m1" } } } });
  });

  test("a block edit sends the whole list, saying only which blocks are secret, never whether one is revealed", () => {
    const draft = draftOf(PAGE);
    draft.blocks[0] = { ...draft.blocks[0]!, text: "The crypt lies south." };
    const result = saveDraft(PAGE, draft, "pg1");
    assert.deepEqual(result, {
      kind: "op",
      op: {
        t: "journal.update",
        pageId: "pg1",
        patch: {
          blocks: [
            { id: "aaaaaaaaaaaa", text: "The crypt lies south." },
            { id: "bbbbbbbbbbbb", text: "A trap at the door.", secret: true },
          ],
        },
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /revealed/);
  });

  test("moving a block sends the new order, and the ends stay put", () => {
    const draft = draftOf(PAGE);
    assert.equal(moveBlock(draft, 0, -1), draft);
    assert.equal(moveBlock(draft, 1, 1), draft);
    const moved = moveBlock(draft, 1, -1);
    assert.deepEqual(moved.blocks.map((b) => b.id), ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    const result = saveDraft(PAGE, moved, "pg1");
    assert.ok(result.kind === "op" && result.op.t === "journal.update" && result.op.patch.blocks?.[0]?.id === "bbbbbbbbbbbb");
  });

  test("text is cleaned the way the protocol reads it", () => {
    assert.equal(cleanTitle("A\u202Eb\u0000c"), "Ab c");
    assert.equal(cleanBlockText("one\r\ntwo\tthree\u0007\u0085"), "one\ntwo\tthree");
  });

  test("a page over its size is refused before it is sent, with a size note on the way", () => {
    const big = "x".repeat(LIMITS.journalBlockChars);
    const blocks = Array.from({ length: 9 }, (_, i) => ({ id: `block${String(i).padStart(7, "0")}`, text: big, secret: false }));
    const draft: PageDraft = { title: "Long", folder: "", access: "dm", blocks };
    const result = saveDraft(null, draft, "pg3");
    assert.equal(result.kind, "invalid");
    assert.match(result.kind === "invalid" ? result.problems[0]! : "", /over the 32 KiB a page may hold/);
    assert.equal(sizeNote(null, draft, "pg3")?.over, true);
    assert.equal(sizeNote(null, { ...draft, blocks: blocks.slice(0, 7) }, "pg3")?.over, false);
    assert.equal(sizeNote(null, { ...draft, blocks: blocks.slice(0, 2) }, "pg3"), null);
  });

  test("a page for one player must name one", () => {
    const draft: PageDraft = { title: "For Thorn", folder: "", access: { member: "" }, blocks: [] };
    assert.deepEqual(saveDraft(null, draft, "pg4"), { kind: "invalid", problems: ["Pick the player who can read it."] });
  });

  test("dirty ignores an empty block added and left", () => {
    const initial = draftOf(PAGE);
    assert.equal(draftDirty(initial, { ...initial, blocks: [...initial.blocks, { id: "eeeeeeeeeeee", text: "", secret: false }] }), false);
    assert.equal(draftDirty(initial, { ...initial, title: "New" }), true);
  });

  test("who reads a page, in the DM's words", () => {
    const members = { m1: { name: "Thorn" } };
    assert.equal(accessText("dm", members), "Only the DM");
    assert.equal(accessText("all", members), "Everyone");
    assert.equal(accessText({ member: "m1" }, members), "Thorn and the DM");
  });

  test("pages with no folder come first, then folders by name, each by title with numbers in order", () => {
    const pages = [
      { id: "1", title: "Room 10", folder: "Crypt" },
      { id: "2", title: "Room 2", folder: "Crypt" },
      { id: "3", title: "zebra" },
      { id: "4", title: "Apple" },
      { id: "5", title: "Note", folder: "Act one" },
    ];
    assert.deepEqual(
      groupPages(pages).map((g) => [g.folder, g.pages.map((p) => p.title)]),
      [
        [null, ["Apple", "zebra"]],
        ["Act one", ["Note"]],
        ["Crypt", ["Room 2", "Room 10"]],
      ],
    );
  });

  // W5-ASTRA-01: a secret takes more bytes stored than sent, so a page measured as its op could pass the protocol and fail the room's limit.
  test("a page that fits as an op but not as stored is refused before it is sent", () => {
    const id = (i: number) => `secret${String(i).padStart(6, "0")}`;
    const blocks = [...Array.from({ length: 8 }, (_, i) => ({ id: id(i), text: "x".repeat(4_000), secret: true })), { id: id(8), text: "y".repeat(200), secret: true }];
    const draft: PageDraft = { title: "Crypt notes, the long version", folder: "", access: "dm", blocks };
    // The server would take the op itself: it is under 32 KiB and passes the protocol.
    const op = { t: "journal.create" as const, page: { id: "pg9", title: draft.title, access: "dm" as const, blocks: blocks.map((b) => ({ id: b.id, text: b.text, secret: true as const })) } };
    assert.ok(serializedBytes(op) <= LIMITS.journalPageBytes, `the op is ${serializedBytes(op)} bytes`);
    assert.ok(clientOpSchema.safeParse(op).success);
    // But the page the reducer stores is over, and the room's limit refuses it.
    const applied = applyOp(room(), op, DM, { seq: 1, at: "2026-10-15T00:00:00.000Z" });
    assert.ok(applied.ok);
    const stored = applied.state.journal.pg9!;
    assert.ok(serializedBytes(stored) > LIMITS.journalPageBytes, `the stored page is ${serializedBytes(stored)} bytes`);
    assert.equal(checkLimits(applied.state).ok, false);
    // The editor measures that stored page, byte for byte, so it refuses first.
    assert.equal(serializedBytes(storedPage(null, draft, "pg9")), serializedBytes(stored));
    const result = saveDraft(null, draft, "pg9");
    assert.equal(result.kind, "invalid");
    assert.match(result.kind === "invalid" ? result.problems[0]! : "", /^This page is 32\.1 KiB, over the 32 KiB a page may hold/);
    assert.equal(sizeNote(null, draft, "pg9")?.over, true);
  });

  test("the stored page matches the reducer's for an edit that keeps a revealed secret", () => {
    const create = { t: "journal.create" as const, page: { id: "pg1", title: "Old map", access: "all" as const, blocks: [{ id: "aaaaaaaaaaaa", text: "Shown" }, { id: "bbbbbbbbbbbb", text: "Hidden", secret: true as const }] } };
    const env = (seq: number) => ({ seq, at: "2026-10-15T00:00:00.000Z" });
    const created = applyOp(room(), create, DM, env(1));
    assert.ok(created.ok);
    const revealed = applyOp(created.state, { t: "journal.reveal", pageId: "pg1", blockId: "bbbbbbbbbbbb", revealed: true }, DM, env(2));
    assert.ok(revealed.ok);
    const page = revealed.state.journal.pg1!;
    const draft = { ...draftOf(page), folder: "Act one", blocks: [...draftOf(page).blocks, { id: "cccccccccccc", text: "A new secret", secret: true }] };
    const result = saveDraft(page, draft, "pg1");
    assert.ok(result.kind === "op");
    const saved = applyOp(revealed.state, result.op, DM, env(3));
    assert.ok(saved.ok);
    assert.deepEqual(storedPage(page, draft, "pg1"), saved.state.journal.pg1);
  });

  test("the editor closes only once the server took the page, and keeps the draft with the reason otherwise", () => {
    assert.deepEqual(saveAnswer("taken"), { kind: "saved" });
    const refused = saveAnswer("refused", { code: "quota", message: "a journal page is at most 32 KiB", text: "Not saved. A journal page is at most 32 KiB." });
    assert.deepEqual(refused, { kind: "kept", problem: "Not saved. A journal page is at most 32 KiB." });
    const gone = saveAnswer("refused", { code: "gone", message: "page", text: "Not saved. Page." });
    assert.ok(gone.kind === "kept" && /deleted/.test(gone.problem));
    const unknown = saveAnswer("unknown");
    assert.ok(unknown.kind === "kept" && /may not be saved/.test(unknown.problem));
  });
});
