import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { partyBudgets } from "../encounters/budget.ts";
import { builderScene } from "../scenes/create.ts";
import { editLayout, REPORTS, type DungeonEdits, type RoomEdit } from "./edits.ts";
import { handKey } from "./handPlans.ts";
import { planFitted, type Fitted } from "./plan.ts";
import { seedStream } from "./random.ts";
import { previewOf } from "./scratch.ts";
import { DEFAULT_CONTEXT, DEFAULT_SETTINGS, MAX_ROOM_MONSTERS, raisedCount, SIZE_SIDES, type DungeonSettings } from "./settings.ts";
import { drawFight, perRoomCap, roomClaim, stockCapacity, stockClaims, stockPlan } from "./stock.ts";
import { stockPool } from "./stockPools.ts";
import type { StockRequest } from "./worker.ts";

/*
 * Stocking (docs/design/design-v1-dungeon-stock.md 4, D-261127-064 and 280
 * to 285): the share's rooms, the claims the dialog checks, each room's
 * fight within its claim and the budget, and the placement on its own
 * standable floor.
 */

const SRD = await loadMonsters();
const SEED = "1K7QH2MXA9F3TWQ5";
const POOL = stockPool(SRD, "dungeon", { srdImages: {} });
const stock = (patch: Partial<StockRequest> = {}): StockRequest => ({ choices: { monsters: 50, difficulty: "moderate" }, party: [{ count: 4, level: 3 }], pool: POOL, tokensLeft: 500, ...patch });
const medium = planFitted(DEFAULT_SETTINGS, SEED, DEFAULT_CONTEXT);
const blocks = new Map(POOL.map((m) => [m.srdId, m]));

/** Each room's creatures, by board index. */
function byRoom(plan: Fitted["plan"]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const m of plan.monsters ?? []) out.set(m.room, [...(out.get(m.room) ?? []), JSON.stringify(m)]);
  return out;
}

test("DSTOCK-S: Half at Moderate for 4 at level 3 picks half the rooms but the entrance, each fight within 900 XP", () => {
  const done = stockPlan(medium, SEED, "dungeon", stock(), null);
  const share = done.facts.filter((f) => f.share);
  assert.equal(share.length, raisedCount(50, medium.kept.length));
  assert.ok(!share.some((f) => f.room === medium.entrance), "never the entrance");
  assert.equal(partyBudgets([{ count: 4, level: 3 }]).moderate, 900);
  const rooms = byRoom(done.plan);
  for (const f of done.facts) {
    if (!f.share) {
      assert.deepEqual(f.monsters, { on: false, lines: [], xp: 0 });
      assert.ok(!rooms.has(f.room));
      continue;
    }
    assert.ok(f.monsters!.on && f.monsters!.xp > 0 && f.monsters!.xp <= 900, `room ${f.n}: ${f.monsters!.xp} XP`);
    const xp = (done.plan.monsters ?? []).filter((m) => m.room === f.room).reduce((sum, m) => sum + blocks.get(m.srdId)!.xp, 0);
    assert.equal(xp, f.monsters!.xp, "the facts count what lands");
    assert.ok((rooms.get(f.room)?.length ?? 0) <= done.perRoom);
  }
  // The key lists each stocked room's fight against its budget.
  const keyed = done.plan.key!.filter((k) => k.monsters);
  assert.equal(keyed.length, share.length);
  for (const k of keyed) assert.equal(k.monsters!.budget, 900);
});

test("DSTOCK-S: at None nothing is stocked and the plan stays the plan", () => {
  const done = stockPlan(medium, SEED, "dungeon", stock({ choices: { monsters: 0, difficulty: "moderate" } }), null);
  assert.deepEqual(done.plan.monsters, []);
  assert.ok(done.facts.every((f) => !f.share && f.monsters?.on === false));
  assert.deepEqual(done.plan.key, medium.plan.key);
});

test("DSTOCK-S: claims read the choices alone: On and Other monsters claim perRoom, Off none, an unedited share room perRoom", () => {
  const rooms = [
    { room: 0, share: false },
    { room: 1, share: true },
    { room: 2, share: true },
    { room: 3, share: false },
  ];
  assert.equal(stockClaims(rooms, null, 3), 6);
  assert.equal(stockClaims(rooms, { 1: { monsters: false } }, 3), 3);
  assert.equal(stockClaims(rooms, { 0: { monsters: true } }, 3), 9);
  assert.equal(stockClaims(rooms, { 3: { monstersDraw: 2 } }, 3), 9);
  assert.equal(roomClaim({ room: 2, share: true }, { 2: { monsters: false, monstersDraw: 4 } }, 3), 0, "Off wins over a draw");
  assert.equal(stockCapacity(500, 2), 40);
  assert.equal(stockCapacity(10, 2), 8);
  assert.equal(stockCapacity(1, 2), 0);
  assert.equal(perRoomCap(40, 12), 3);
  assert.equal(perRoomCap(40, 20), 2);
  assert.equal(perRoomCap(40, 2), MAX_ROOM_MONSTERS);
  assert.equal(perRoomCap(4, 12), 1);
  assert.equal(perRoomCap(12, 4), 3, "shared by every kept room, the entrance among them");
});

test("DSTOCK-S: Medium at Half with the entrance On, and Large with every room On, stay within the limit (D-261127-285)", () => {
  const entranceOn: DungeonEdits["rooms"] = { [medium.entrance]: { monsters: true } };
  const done = stockPlan(medium, SEED, "dungeon", stock(), entranceOn);
  assert.ok(done.claims <= done.capacity, `${done.claims} of ${done.capacity}`);
  assert.ok((done.plan.monsters ?? []).some((m) => m.room === medium.entrance), "the entrance holds a fight once On");
  const largeSettings: DungeonSettings = { ...DEFAULT_SETTINGS, w: SIZE_SIDES.large, h: SIZE_SIDES.large, rooms: 20 };
  const large = planFitted(largeSettings, SEED, DEFAULT_CONTEXT);
  const every = Object.fromEntries(large.kept.map((i) => [i, { monsters: true } satisfies RoomEdit]));
  const all = stockPlan(large, SEED, "dungeon", stock({ choices: { monsters: 100, difficulty: "high" } }), every);
  assert.equal(all.perRoom, 2);
  assert.ok(all.claims <= all.capacity, `${all.claims} of ${all.capacity}`);
  assert.ok((all.plan.monsters ?? []).length <= all.capacity);
});

test("DSTOCK-S: past the capacity nothing is trimmed: the claims show the limit, and every room keeps its fight", () => {
  // Off B, On A, On B at a capacity of 4: the claims move, the draws do not.
  const near = stock({ tokensLeft: 4 + medium.plan.stones.length });
  const base = stockPlan(medium, SEED, "dungeon", near, null);
  assert.equal(base.capacity, 4);
  assert.equal(base.perRoom, 1);
  const [a, b] = medium.kept.filter((i) => i !== medium.entrance && !base.facts.find((f) => f.room === i)!.share);
  const shareRoom = base.facts.find((f) => f.share)!.room;
  const steps: DungeonEdits["rooms"][] = [{ [shareRoom]: { monsters: false } }, { [shareRoom]: { monsters: false }, [a!]: { monsters: true } }, { [shareRoom]: { monsters: false }, [a!]: { monsters: true }, [b!]: { monsters: true } }];
  for (const edits of steps) {
    const done = stockPlan(medium, SEED, "dungeon", near, edits);
    assert.equal(done.claims, stockClaims(done.facts, edits, done.perRoom));
    // Every claiming room holds its fight, within or past the limit.
    for (const f of done.facts) assert.equal(f.monsters!.on, roomClaim(f, edits, done.perRoom) > 0);
  }
  // Capacity 5 to 4 then Bring them back: the same choices make the same claims and the same creatures.
  const five = stockPlan(medium, SEED, "dungeon", stock({ tokensLeft: 5 + medium.plan.stones.length }), null);
  const back = stockPlan(medium, SEED, "dungeon", stock({ tokensLeft: 5 + medium.plan.stones.length }), null);
  assert.deepEqual(back.plan.monsters, five.plan.monsters);
});

test("DSTOCK-S: Low then High with an edit at the cap redraws within the new budget, the claims unchanged", () => {
  const edits: DungeonEdits["rooms"] = { [medium.entrance]: { monsters: true } };
  const low = stockPlan(medium, SEED, "dungeon", stock({ choices: { monsters: 50, difficulty: "low" } }), edits);
  const high = stockPlan(medium, SEED, "dungeon", stock({ choices: { monsters: 50, difficulty: "high" } }), edits);
  assert.equal(low.claims, high.claims);
  const budgets = partyBudgets([{ count: 4, level: 3 }]);
  for (const f of low.facts) assert.ok(f.monsters!.xp <= budgets.low);
  for (const f of high.facts) assert.ok(f.monsters!.xp <= budgets.high);
  assert.ok(high.facts.reduce((s, f) => s + f.monsters!.xp, 0) > low.facts.reduce((s, f) => s + f.monsters!.xp, 0));
});

test("DSTOCK-S: Other monsters redraws only its own room, and an edit in one room never moves another's fight", () => {
  const before = stockPlan(medium, SEED, "dungeon", stock(), null);
  const shareRooms = before.facts.filter((f) => f.share).map((f) => f.room);
  const target = shareRooms[0]!;
  let changed = false;
  for (let draw = 1; draw <= 6; draw++) {
    const after = stockPlan(medium, SEED, "dungeon", stock(), { [target]: { monstersDraw: draw } });
    const was = byRoom(before.plan);
    const now = byRoom(after.plan);
    for (const i of medium.kept) if (i !== target) assert.deepEqual(now.get(i), was.get(i), `room ${i} kept its fight`);
    if (JSON.stringify(now.get(target)) !== JSON.stringify(was.get(target))) changed = true;
  }
  assert.ok(changed, "Other monsters draws another fight");
  const off = stockPlan(medium, SEED, "dungeon", stock(), { [target]: { monsters: false } });
  assert.ok(!byRoom(off.plan).has(target));
  for (const i of shareRooms.slice(1)) assert.deepEqual(byRoom(off.plan).get(i), byRoom(before.plan).get(i));
});

test("DSTOCK-S: a fight spends as much of the budget as it can within its claim, and falls back to one creature", () => {
  for (let lane = 0; lane < 60; lane++) {
    const rng = seedStream(SEED, 9, 2000 + lane);
    const fight = drawFight(rng, POOL, "dungeon", 900, 3);
    const n = fight.reduce((s, p) => s + p.n, 0);
    const xp = fight.reduce((s, p) => s + p.m.xp * p.n, 0);
    assert.ok(n >= 1 && n <= 3 && xp <= 900, `${n} creatures, ${xp} XP`);
  }
  assert.deepEqual(drawFight(seedStream(SEED), POOL, "dungeon", 5, 3), [], "nothing within the budget");
  const one = drawFight(seedStream(SEED), POOL, "dungeon", 900, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.n, 1);
});

test("DSTOCK-S: a room with no spot holds none, and the room panel says so", () => {
  const nowhere: Fitted = { ...medium, standable: () => false };
  const done = stockPlan(nowhere, SEED, "dungeon", stock(), null);
  assert.deepEqual(done.plan.monsters, []);
  for (const f of done.facts.filter((x) => x.share)) assert.ok(f.reports.includes(REPORTS.noMonsterSpot));
  assert.ok(done.plan.key!.every((k) => !k.monsters));
});

test("DSTOCK-S: a stocked preview lands every creature hidden, and the foot counts them and the rooms that hold them", () => {
  const made = previewOf(DEFAULT_SETTINGS, SEED, builderScene({ id: "x", name: "Crypt", w: 50, h: 50 }), DEFAULT_CONTEXT, handKey(), undefined, null, stock());
  assert.ok(made.ok);
  const tokens = Object.values(made.room.tokens).filter((t) => t?.kind === "monster");
  assert.equal(tokens.length, made.plan.monsters!.length);
  assert.ok(tokens.every((t) => t!.visibility === "dm"));
  assert.equal(made.summary.monsters, made.plan.monsters!.length);
  assert.equal(made.summary.stockedRooms, new Set(made.plan.monsters!.map((m) => m.room)).size);
  // Edits made on another layout hold nothing here, so their monster pins are left out as the planner leaves their rooms'.
  const stale: DungeonEdits = { layout: editLayout({ ...DEFAULT_SETTINGS, rooms: 11 }, SEED, 11, null), rooms: { [medium.entrance]: { monsters: true } } };
  const ignored = previewOf(DEFAULT_SETTINGS, SEED, builderScene({ id: "x", name: "Crypt", w: 50, h: 50 }), DEFAULT_CONTEXT, handKey(), undefined, stale, stock());
  assert.ok(ignored.ok);
  assert.deepEqual(ignored.plan.monsters, made.plan.monsters);
});

test("DSTOCK-S: a wing's creatures keep off the scene's tokens", () => {
  const first = stockPlan(medium, SEED, "dungeon", stock(), null);
  const sizes = new Map(POOL.map((m) => [m.srdId, m.size]));
  const taken = (first.plan.monsters ?? []).map((m) => ({ size: sizes.get(m.srdId)!, x: m.x, y: m.y }));
  const again = stockPlan(medium, SEED, "dungeon", stock(), null, taken);
  const at = new Set(taken.map((t) => `${t.x},${t.y}`));
  assert.ok((again.plan.monsters ?? []).length > 0);
  for (const m of again.plan.monsters ?? []) assert.ok(!at.has(`${m.x},${m.y}`), `${m.srdId} at ${m.x},${m.y} on a standing token`);
});

test("DSTOCK-S: each room draws its fight on its own lane, so rooms of one budget do not all draw the same fight", () => {
  const done = stockPlan(medium, SEED, "dungeon", stock({ choices: { monsters: 100, difficulty: "moderate" } }), null);
  const fights = new Set(done.facts.filter((f) => f.monsters?.on).map((f) => JSON.stringify(f.monsters!.lines)));
  assert.ok(fights.size >= 3, `${fights.size} different fights`);
  // Other monsters draws on 16 lanes a room: the 17th draw is the first again.
  const target = done.facts.find((f) => f.share)!.room;
  const lines = (draw: number) => stockPlan(medium, SEED, "dungeon", stock({ choices: { monsters: 100, difficulty: "moderate" } }), { [target]: { monstersDraw: draw } }).facts.find((f) => f.room === target)!.monsters;
  assert.deepEqual(lines(16), lines(0));
});
