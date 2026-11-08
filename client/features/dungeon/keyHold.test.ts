import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { JournalPage } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { journalFull } from "./keyHold.ts";
import { scratchRoom } from "./scratch.ts";

const page = (id: string): JournalPage => ({ id, rev: 1, title: id, access: "dm", blocks: [] });
const keyPage: ClientOp = { t: "journal.create", page: { id: "key", title: "Crypt key", folder: "Dungeon keys", access: "dm", blocks: [] } };

function roomWith(pages: number) {
  const room = scratchRoom();
  const journal: Record<string, JournalPage> = {};
  for (let i = 0; i < pages; i++) journal[`p${i}`] = page(`p${i}`);
  return { ...room, journal };
}

test("the key is held only when the journal fits without it and not with it", () => {
  assert.equal(journalFull(roomWith(LIMITS.journalPagesPerRoom - 1), [keyPage], "scratch-dm"), false, "one page of room left");
  assert.equal(journalFull(roomWith(LIMITS.journalPagesPerRoom), [keyPage], "scratch-dm"), true, "the 201st page does not fit");
});

test("another cap the room is already over never blames the journal", () => {
  const over = { ...roomWith(LIMITS.journalPagesPerRoom), handouts: Object.fromEntries(Array.from({ length: LIMITS.handoutsPerRoom + 1 }, (_, i) => [`h${i}`, {} as never])) };
  assert.equal(journalFull(over, [keyPage], "scratch-dm"), false);
});

test("no key page in the ops holds nothing", () => {
  assert.equal(journalFull(roomWith(LIMITS.journalPagesPerRoom), [], "scratch-dm"), false);
});
