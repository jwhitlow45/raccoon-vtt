import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { previewNumbers } from "#shared/numbering.ts";
import { projectState } from "#shared/project.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { chance, DM, env, int, pick, rng } from "#shared/testutil.ts";
import { meetOps } from "./meet.ts";
import { creature, each, inF, inR, make, move, numberingRoom, numbersIn, openRooms, Room, same, viewOf, type Rooms } from "./numberingTesting.ts";

/*
 * The order creatures met together take their numbers in
 * (docs/design/design-v1-creature-numbers-order.md): by place where the
 * party shares its sight, by id where players see for themselves, and in
 * rooms that differ only in creatures P1 is never sent, where they stand
 * and in what order they were made, P1 reads the same numbers.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };
const P1: Viewer = { memberId: "p1", role: "player" };

/** The numbering room with its scene seen by each player for themselves, P1 by Ayla in room R and P2 by Bree, moved to room F. */
function ownSight(s: RoomState): RoomState {
  s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
  s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  s.tokens.b = { ...s.tokens.b!, ...inF(0, 4) };
  return s;
}

const shownAll = (ids: readonly string[]): Op => ({ t: "token.updateMany", tokenIds: [...ids].sort(), patch: { visibility: "all" } }) as Op;

/** What P1's copy reads on each creature it holds, by id: its name and number. */
function p1Reads(room: Room, ids: readonly string[]): Record<string, string> {
  const tokens = room.p1View().tokens as Record<string, Partial<Token>>;
  return Object.fromEntries(ids.map((id) => [id, tokens[id] ? `${tokens[id].name}${tokens[id].number === undefined ? "" : ` ${tokens[id].number}`}` : "-"]));
}

describe("creatures met together", () => {
  test("three Goblins made left to right out of the party's sight read Goblin 1, 2 and 3 left to right once the party sees them together, as the DM's brackets said", async (t) => {
    const room = new Room(t, "A", numberingRoom());
    await room.load();
    // Made left to right, with ids that sort another way.
    for (const [id, i] of [["gq", 0], ["gb", 3], ["gm", 6]] as const) await room.apply("dm", make(id, inF(i, 2)));
    assert.deepEqual(Object.fromEntries(previewNumbers(viewOf(room.clients.dm.sent) as unknown as RoomState, "s1")), { gq: 1, gb: 2, gm: 3 }, "the DM's brackets");
    await room.apply("dm", move("a", inF(3, 4)));
    assert.deepEqual(p1Reads(room, ["gq", "gb", "gm"]), { gq: "Goblin 1", gb: "Goblin 2", gm: "Goblin 3" });
  });

  test("on a scene where players see for themselves, three Goblins P1 alone is sent take their numbers in id order", async (t) => {
    const room = new Room(t, "A", ownSight(numberingRoom()));
    await room.load();
    for (const [id, i] of [["gq", 0], ["gb", 2], ["gm", 4]] as const) await room.apply("dm", make(id, inR(i, 2), { visibility: "dm" }));
    await room.apply("dm", shownAll(["gq", "gb", "gm"]));
    assert.deepEqual(p1Reads(room, ["gq", "gb", "gm"]), { gq: "Goblin 3", gb: "Goblin 1", gm: "Goblin 2" });
    assert.deepEqual(numbersIn(viewOf(room.clients.p2.sent)), {}, "P2 holds none of them");
  });

  test("on a scene where players see for themselves, Goblins only P2 is sent, standing and made otherwise in room B, give P1 the same numbers and frames", async (t) => {
    const pair: Rooms = await openRooms(t, ownSight(numberingRoom()), ownSight(numberingRoom()));
    await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
    // P1's two in room R between rows of P2's three in room F: above them in room A, below in room B, made first in A and last, the other way round, in B.
    const mine: Array<[string, { x: number; y: number }]> = [
      ["g2", inR(0, 2)],
      ["g7", inR(3, 2)],
    ];
    const theirs = (row: number): Array<[string, { x: number; y: number }]> => [
      ["g1", inF(1, row)],
      ["g5", inF(3, row)],
      ["g9", inF(5, row)],
    ];
    const made = [[...theirs(0), ...mine], [...mine, ...theirs(5).reverse()]] as const;
    for (let i = 0; i < made[0].length; i++) {
      await each(pair, (room) => {
        const [id, at] = made[pair.indexOf(room)]![i]!;
        return room.apply("dm", make(id, at, { visibility: "dm" }));
      });
      same(pair, `made ${i}`);
    }
    await each(pair, (room) => room.apply("dm", shownAll(["g1", "g2", "g5", "g7", "g9"])));
    same(pair, "all shown in one batch");
    assert.deepEqual(numbersIn(pair[0].p1View()), { g2: 2, g7: 4 });
    for (const room of pair) assert.deepEqual(Object.keys(numbersIn(viewOf(room.clients.p2.sent))).sort(), ["g1", "g5", "g9"], `${room.name}: P2 reads its three numbered`);
  });
});

/*
 * The random twin: rooms A and B hold the same creatures, those P1's copy
 * holds standing alike, and differ in where the rest stand and in the
 * order every creature was made. Batches reveal them in both, and the
 * meet step numbers them. After every batch:
 * - O1: P1's copy reads the same creatures, places, names and numbers in both.
 * - O2: the numbers a batch gives each name rise along the meeting order:
 *   by place where the party shares its sight, by id where players see for
 *   themselves.
 * - O3: every `sys.meet` the step appends is a valid op, its ids rising.
 * - O4: where the party shares its sight and every creature is in its
 *   sight, the DM's brackets before a batch that meets all are the numbers
 *   it gives.
 * NUMBERING_ORDER_RUNS sets the runs and NUMBERING_ORDER_FIRST the first seed.
 */

const RUNS = Number(process.env.NUMBERING_ORDER_RUNS ?? 40);
const FIRST = Number(process.env.NUMBERING_ORDER_FIRST ?? 1);

type Where = "r" | "f" | "x";
/** A cell where it stands: room R, which Ayla sees, room F, which Bree sees, or rock no one sees into. */
function cellIn(r: () => number, where: Where): { x: number; y: number } {
  if (where === "r") return inR(int(r, -3, 4), int(r, 0, 5));
  if (where === "f") return inF(int(r, -2, 7), int(r, 0, 5));
  return { x: int(r, 38, 46), y: int(r, 14, 30) };
}

function shuffled<T>(r: () => number, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** P1's copy's creatures, by id: where each stands and what it reads. */
function p1Copy(state: RoomState): Record<string, string> {
  const tokens = projectState(state, P1, { sceneId: null }).tokens as Record<string, Partial<Token>>;
  return Object.fromEntries(
    Object.entries(tokens)
      .filter(([, t]) => t.kind === "monster")
      .map(([id, t]): [string, string] => [id, `${t.name} ${t.number ?? "-"} at ${t.x},${t.y}`])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** A batch: the DM's op, then the meet step's ops as the actor appends them. */
function batch(state: RoomState, op: Op, where: string): { state: RoomState; meets: Op[] } {
  const result = applyOp(state, op, DM, env(1));
  assert.ok(result.ok, `${where}: ${op.t} applies: ${result.ok ? "" : result.message}`);
  const meets = meetOps(state, result.state, result.touched as EntityKey[]);
  let out = result.state;
  for (const meet of meets) {
    // O3.
    assert.ok(opSchema.safeParse(meet).success, `${where}: ${JSON.stringify(meet)} is a valid op`);
    const met = applyOp(out, meet, SERVER, env(1));
    assert.ok(met.ok, `${where}: the meeting applies: ${met.ok ? "" : met.message}`);
    out = met.state;
  }
  return { state: out, meets };
}

/** O2: each name's numbers given in a batch rise along the meeting order. */
function o2(before: RoomState, after: RoomState, perPlayer: boolean, where: string): void {
  const given = Object.values(after.tokens).filter((t) => t.number !== undefined && before.tokens[t.id]?.met !== t.met);
  for (const name of new Set(given.map((t) => t.name))) {
    const ranked = given.filter((t) => t.name === name).sort((a, b) => (perPlayer ? 0 : a.y - b.y || a.x - b.x) || (a.id < b.id ? -1 : 1));
    assert.deepEqual(
      ranked.map((t) => t.number),
      [...ranked.map((t) => t.number!)].sort((a, b) => a - b),
      `${where}: ${name}'s numbers rise along the meeting order: ${ranked.map((t) => `${t.id}@${t.x},${t.y}=${t.number}`).join(" ")}`,
    );
  }
}

type Counts = { meets: number; mixed: number; brackets: number };

function twinRun(seed: number, counts: Counts): void {
  const r = rng(seed);
  const perPlayer = chance(r, 0.5);
  const base = perPlayer ? ownSight(numberingRoom()) : numberingRoom();
  if (!perPlayer) base.tokens.b = { ...base.tokens.b!, ...inF(0, 4) };
  // What P1 is never sent: room F where only P2 sees, and rock no one sees into.
  const apart = (where: Where) => where === "x" || (perPlayer && where === "f");
  const made = Array.from({ length: int(r, 1, 10) }, (_, i) => {
    const where = pick(r, ["r", "r", "f", "f", "x"] as const);
    return { id: `c${int(r, 100, 999)}x${i}`, name: pick(r, ["Goblin", "Goblin", "Orc"]), where, a: cellIn(r, where), b: cellIn(r, where) };
  });
  const states = (["a", "b"] as const).map((k) => {
    const s = structuredClone(base);
    // Room B makes every creature in another order, and puts each P1 is never sent elsewhere.
    for (const c of k === "a" ? made : shuffled(r, made)) s.tokens[c.id] = creature(c.id, k === "a" || !apart(c.where) ? c.a : c.b, { name: c.name, visibility: "dm" });
    return s;
  }) as [RoomState, RoomState];
  const first = made.filter(() => chance(r, 0.4)).map((c) => c.id);
  const rest = made.map((c) => c.id).filter((id) => !first.includes(id));
  for (const [step, ids] of [first, rest].entries()) {
    if (ids.length === 0) continue;
    const where = `seed ${seed} (${perPlayer ? "per player" : "whole party"}), batch ${step}`;
    const all = step === 1 && first.length === 0 && !perPlayer && made.every((c) => c.where !== "x");
    const brackets = all ? Object.fromEntries(previewNumbers(states[0], "s1")) : null;
    for (let k = 0; k < 2; k++) {
      const out = batch(states[k]!, shownAll(ids), where);
      o2(states[k]!, out.state, perPlayer, `${where}, room ${k === 0 ? "A" : "B"}`);
      if (k === 0) {
        // A batch that met a creature P1 is never sent together with a namesake P1's copy holds: where an order by place would show P1 where it stands.
        const metNow = Object.values(out.state.tokens).filter((x) => x.met !== undefined && states[0].tokens[x.id]?.met !== x.met);
        const kinds = (name: string) => new Set(metNow.filter((x) => x.name === name).map((x) => apart(made.find((c) => c.id === x.id)!.where)));
        if ([...new Set(metNow.map((x) => x.name))].some((name) => kinds(name).size === 2)) counts.mixed++;
      }
      states[k] = out.state;
      counts.meets += out.meets.length;
    }
    // O1.
    assert.deepEqual(p1Copy(states[0]), p1Copy(states[1]), `${where}: P1's copy reads alike in both rooms`);
    // O4.
    if (brackets) {
      assert.deepEqual(numbersIn(projectState(states[0], P1, { sceneId: null })), brackets, `${where}: the brackets were the numbers given`);
      counts.brackets++;
    }
  }
}

describe("creature numbers' random twin for the meeting order", () => {
  test(`rooms that differ in where creatures P1 is never sent stand, and in the order all were made, give P1 the same numbers (${RUNS} runs from seed ${FIRST})`, (t) => {
    const counts: Counts = { meets: 0, mixed: 0, brackets: 0 };
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) twinRun(seed, counts);
    t.diagnostic(JSON.stringify(counts));
    assert.ok(counts.meets >= RUNS && counts.mixed >= RUNS / 10 && counts.brackets >= RUNS / 40, JSON.stringify(counts));
  });
});
