import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomFacts } from "./edits.ts";
import { overLimitBy, stockKey, stockRequest } from "./stockSource.ts";

/*
 * The creature limit as the dialog and the wing pane check it on every
 * render and at Make (docs/design/design-v1-dungeon-stock.md 4, stocking
 * step 3, D-261127-280 to 285), and what a preview stocks with.
 */

type Room = Pick<RoomFacts, "room" | "share">;
const rooms = (n: number, share: (i: number) => boolean): Room[] => Array.from({ length: n }, (_, i) => ({ room: i, share: share(i) }));

test("DSTOCK-L: within capacity every room may be On, and past it the line counts how far", () => {
  // Medium at Half: 12 kept rooms, 6 in the share, perRoom 3 of 40.
  const medium = rooms(12, (i) => i > 0 && i <= 6);
  assert.equal(overLimitBy(medium, null, 500, 0), 0);
  assert.equal(overLimitBy(medium, { 0: { monsters: true } }, 500, 0), 0, "the entrance On too (D-261127-285)");
  // Large with every room On: 20 rooms at 2 a room is 40.
  const large = rooms(20, () => false);
  const allOn = Object.fromEntries(large.map((r) => [r.room, { monsters: true }]));
  assert.equal(overLimitBy(large, allOn, 500, 0), 0);
  // A scene group near 500: 4 left, two rooms on at 1 a room each.
  const two = rooms(2, (i) => i === 1);
  assert.equal(overLimitBy(two, null, 4, 0), 0);
  assert.equal(overLimitBy(two, { 0: { monsters: true } }, 4, 0), 0, "On A at a capacity of 4");
  assert.equal(overLimitBy(two, { 0: { monsters: true } }, 4, 3), 1, "the stones are reserved first");
  assert.equal(overLimitBy(two, { 1: { monsters: false } }, 4, 3), 0, "Off B frees its claim");
});

test("DSTOCK-L: a capacity that falls under the claims shows the line, and the claims never hang on a draw", () => {
  const four = rooms(4, () => true);
  assert.equal(overLimitBy(four, null, 5, 0), 0);
  assert.equal(overLimitBy(four, null, 3, 0), 1, "every room claims at least one");
  assert.equal(overLimitBy(four, { 2: { monstersDraw: 5 } }, 3, 0), 1, "Other monsters claims as On does");
  assert.equal(overLimitBy(four, { 2: { monsters: false, monstersDraw: 5 } }, 3, 0), 0);
  assert.equal(overLimitBy(four, null, 0, 0), 4);
});

test("DSTOCK-L: a preview stocks only above None with the pool, and its key moves with the choices, party, tokens left and images", () => {
  const pool = [{ srdId: "goblin-warrior" }] as never;
  const party = [{ count: 4, level: 3 }];
  assert.equal(stockRequest({ monsters: 50, difficulty: "moderate" }, 0, party, pool, 500), null, "held, or None");
  assert.equal(stockRequest({ monsters: 50, difficulty: "moderate" }, 50, party, null, 500), null, "before the list");
  assert.deepEqual(stockRequest({ monsters: 50, difficulty: "high" }, 50, party, pool, 480), { choices: { monsters: 50, difficulty: "high" }, party, pool, tokensLeft: 480 });
  const key = (over: Partial<{ share: number; tokens: number; loaded: boolean; rev: number; level: number }> = {}) =>
    stockKey({ monsters: 50, difficulty: "moderate" }, over.share ?? 50, [{ count: 4, level: over.level ?? 3 }], over.tokens ?? 500, "dungeon", over.loaded ?? true, over.rev ?? 0);
  assert.equal(key({ share: 0 }), null);
  const base = key();
  for (const changed of [key({ share: 75 }), key({ tokens: 499 }), key({ loaded: false }), key({ rev: 1 }), key({ level: 4 })]) assert.notEqual(changed, base);
  assert.ok(!base!.includes("goblin"), "the pool is never written out");
});
