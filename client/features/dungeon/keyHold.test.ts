import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLimits, LIMITS } from "#shared/limits.ts";
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

test("a stocked key is measured with its fights: at the journal's byte boundary the stocked page holds the key and the bare page would not (STOCK-ASTRA-03)", async () => {
  const { dressedRooms, handKey, HAND_SETTINGS } = await import("./handPlans.ts");
  const { keyOverfills } = await import("./keyHold.ts");
  const plan = dressedRooms();
  plan.key = plan.key!.map((k) => ({ ...k, monsters: { lines: [["Goblin Boss", 1], ["Goblin Warrior", 3]], xp: 350, budget: 900 } }));
  const stock = { choices: { monsters: 50, difficulty: "moderate" as const }, party: [{ count: 4, level: 3 }] };
  const input = handKey();
  // Filler pages of plain text, n characters in all, which the search takes as close to the journal's 1 MiB as the bare key allows.
  const filled = (n: number) => {
    const room = scratchRoom();
    const journal: Record<string, JournalPage> = {};
    for (let p = 0, left = n; left > 0; p++) {
      const blocks = [];
      // Seven blocks of 4,000 characters keep each page under its own 32 KiB.
      for (let b = 0; b < 7 && left > 0; b++) {
        const take = Math.min(LIMITS.journalBlockChars, left);
        blocks.push({ id: `b${String(b).padStart(11, "0")}`, text: "x".repeat(take) });
        left -= take;
      }
      journal[`f${p}`] = { id: `f${p}`, rev: 1, title: `f${p}`, access: "dm", blocks };
    }
    return { ...room, journal };
  };
  // The most filler the room holds by itself, then the most the bare key fits beside.
  let lo = 0;
  let hi = LIMITS.journalBytes;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (checkLimits(filled(mid)).ok) lo = mid;
    else hi = mid - 1;
  }
  assert.equal(keyOverfills(filled(lo), plan, HAND_SETTINGS, input, null, "scratch-dm"), true, "a full journal holds the bare key too");
  hi = lo;
  lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keyOverfills(filled(mid), plan, HAND_SETTINGS, input, null, "scratch-dm")) hi = mid - 1;
    else lo = mid;
  }
  const room = filled(lo);
  assert.equal(keyOverfills(room, plan, HAND_SETTINGS, input, null, "scratch-dm"), false, "the bare key fits");
  assert.equal(keyOverfills(room, plan, HAND_SETTINGS, input, stock, "scratch-dm"), true, "the stocked key, as Make sends it, does not");
  assert.equal(keyOverfills(filled(lo + 1), plan, HAND_SETTINGS, input, null, "scratch-dm"), true, "the boundary is exact");
});

test("the dialog's journal check reads the stock its preview was drawn with", async () => {
  const { readFileSync } = await import("node:fs");
  const dialog = readFileSync(new URL("./GenerateDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /keyOverfills\(room, plan, settings, \{ name: keyName, color: myColor, feetPerCell \}, keyStock, /);
  assert.match(dialog, /const keyStock = stock && \{ choices: stock\.choices, party: stock\.party \};/);
});
