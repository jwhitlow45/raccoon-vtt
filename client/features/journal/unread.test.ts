import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JournalPage } from "#shared/model.ts";
import { markSeen, pageHash, parseSeen, seenKey, unreadPageIds } from "./unread.ts";

const page = (id: string, text: string, extra: Partial<JournalPage> = {}): JournalPage => ({ id, rev: 0, title: `Page ${id}`, access: "all", blocks: [{ id: "aaaaaaaaaaaa", text }], ...extra });

describe("journal unread dot", () => {
  test("a page never read is unread, and reading it clears it", () => {
    const pages = { a: page("a", "one"), b: page("b", "two") };
    assert.deepEqual([...unreadPageIds(pages, {})].sort(), ["a", "b"]);
    const seen = markSeen({}, pages.a, pages);
    assert.deepEqual([...unreadPageIds(pages, seen)], ["b"]);
  });

  test("a change to what the player reads marks it again, a revealed secret included", () => {
    const before = page("a", "one");
    const seen = markSeen({}, before, { a: before });
    const revealed: JournalPage = { ...before, blocks: [...before.blocks, { id: "bbbbbbbbbbbb", text: "the secret" }] };
    assert.deepEqual([...unreadPageIds({ a: revealed }, seen)], ["a"]);
    const retitled: JournalPage = { ...before, title: "Renamed" };
    assert.deepEqual([...unreadPageIds({ a: retitled }, seen)], ["a"]);
  });

  test("a move to another folder or a change of who reads it is not news", () => {
    const before = page("a", "one");
    const seen = markSeen({}, before, { a: before });
    assert.equal(unreadPageIds({ a: { ...before, folder: "Act two" } }, seen).size, 0);
    assert.equal(unreadPageIds({ a: { ...before, access: { member: "m1" } } }, seen).size, 0);
    const bumped: JournalPage = { ...before, rev: 7 };
    assert.equal(pageHash(before), pageHash(bumped));
  });

  test("the record keeps only pages the player still has", () => {
    const a = page("a", "one");
    const b = page("b", "two");
    const seen = markSeen(markSeen({}, a, { a, b }), b, { a, b });
    assert.deepEqual(Object.keys(markSeen(seen, b, { b })), ["b"]);
  });

  test("a stored record is read back, and anything else reads as nothing seen", () => {
    assert.deepEqual(parseSeen(JSON.stringify({ a: "0011aabb", b: 3 })), { a: "0011aabb" });
    assert.deepEqual(parseSeen("[1]"), {});
    assert.deepEqual(parseSeen("{"), {});
    assert.deepEqual(parseSeen(null), {});
    assert.equal(seenKey("r1", "m1"), "rvtt.journalSeen.r1.m1");
  });
});
