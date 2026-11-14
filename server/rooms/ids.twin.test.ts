import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { ID_TIME_REFUSED } from "#shared/ids.ts";
import { ID_BUDGET, IDS_TOO_FAST } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { AYLA, BREE, idAt, limitsRoom, OGRE } from "#shared/privTestutil.ts";
import { actor, character, entry, rng, template, token } from "#shared/testutil.ts";
import { PLAYER_LIMITS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { T0 } from "./numberingTesting.ts";
import { bothAnswer, marks, Mint, openTwins, same, sameSince, type Twins } from "./limitsTwinTesting.ts";
import { each, type Room } from "./numberingTesting.ts";
import { until } from "./undoScopeTesting.ts";

/**
 * The ids of new things in rooms P1 cannot tell apart: P1 reuses an id
 * whose thing the DM hid in room A and deleted in room B, and both rooms
 * answer alike, across restarts, as the clock moves on, and when P1's
 * device asks after a reconnect which of its own creates the room took.
 */

const GONE = { code: "gone", message: "that is not here" };
const STALE = { code: "invalid", message: ID_TIME_REFUSED };
const MINUTE = 60_000;

const mint = new Mint();

async function open(t: TestContext, edit: (s: RoomState) => void = () => {}): Promise<Twins> {
  const a = limitsRoom();
  const b = limitsRoom();
  edit(a);
  edit(b);
  return openTwins(t, a, b);
}

function areaOp(id: string): Op {
  const { rev: _rev, ...made } = template(id, { ownerId: "p1", origin: { x: 4.5, y: 4.5, z: 0 }, size: 5 });
  return { t: "template.create", template: made } as Op;
}

/** The DM takes a thing out of P1's copy: hides it in A, deletes it in B. */
async function hideOrDelete(pair: Twins, hide: Op, remove: Op): Promise<void> {
  for (const room of pair) await room.apply("dm", room.name === "A" ? hide : remove);
  same(pair, "the thing leaves P1's copy");
}

/** One id per room, minted alike in both. */
function ids(pair: Twins, aheadMs = 0): [string, string] {
  return [mint.next(pair[0], aheadMs), mint.next(pair[1], aheadMs)];
}

/** P1's op naming each room's own id, and its answer, alike in both. */
async function reuse(pair: Twins, made: [string, string], op: (id: string) => Op, what: string) {
  return bothAnswer(pair, "p1", (room) => op(made[pair.indexOf(room as never)]!), what);
}

describe("an id answers P1 alike whatever became of its thing", () => {
  test("C1: P1's area hidden in A and deleted in B answers its id gone at once and after a restart, and the clock's refusal after 31 minutes, then a fresh id is taken", async (t) => {
    const pair = await open(t);
    const made = ids(pair);
    await each(pair, (room) => room.apply("p1", areaOp(made[pair.indexOf(room as never)]!)));
    for (const room of pair) {
      const id = made[pair.indexOf(room as never)]!;
      await room.apply("dm", room.name === "A" ? ({ t: "template.update", templateId: id, patch: { visibility: "dm" } } as Op) : { t: "template.delete", templateId: id });
    }
    same(pair, "the area leaves P1's copy");
    assert.deepEqual(await reuse(pair, made, areaOp, "at once"), GONE);
    same(pair, "at once");
    await each(pair, (room) => room.restart(false));
    assert.deepEqual(await reuse(pair, made, areaOp, "after a restart"), GONE);
    same(pair, "after a restart");
    for (const room of pair) room.clock.now += 31 * MINUTE;
    assert.deepEqual(await reuse(pair, made, areaOp, "after 31 minutes"), STALE);
    assert.equal(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room)), "the device's one retry"), "taken");
    same(pair, "after 31 minutes");
  });

  test("C2: a row, a condition and an ask of P1's, and P2's companion P1 saw, each hidden in A and deleted in B, answer their ids alike in both", async (t) => {
    const cade = "cade";
    const pair = await open(t, (s) => {
      s.characters[cade] = character(cade, { name: "Cade", ownerIds: ["p1"] });
      s.tokens[cade] = token(cade, { kind: "pc", name: "Cade", disposition: "ally", x: 5, y: 3, actor: { ref: cade } });
      s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("0199f0a0-0000-7000-8000-00000000e001", { tokenId: BREE })] };
    });
    await t.test("a row", async () => {
      const made = ids(pair);
      const add = (id: string): Op => ({ t: "encounter.add", entries: [{ id, tokenId: AYLA }] }) as Op;
      for (const [i, room] of pair.entries()) await room.apply("p1", add(made[i]!));
      for (const [i, room] of pair.entries()) {
        await room.apply("dm", room.name === "A" ? ({ t: "encounter.update", entryId: made[i]!, patch: { hidden: true } } as Op) : { t: "encounter.remove", entryIds: [made[i]!] });
      }
      same(pair, "the row leaves P1's copy");
      assert.deepEqual(await reuse(pair, made, add, "the row's id"), GONE);
      same(pair, "the row's id");
    });
    await t.test("a condition", async () => {
      const made = ids(pair);
      const add = (id: string): Op => ({ t: "actor.effect.add", target: { characterId: AYLA }, effect: { id, key: "blessed" } }) as Op;
      for (const [i, room] of pair.entries()) await room.apply("p1", add(made[i]!));
      for (const [i, room] of pair.entries()) {
        await room.apply(
          "dm",
          room.name === "A"
            ? ({ t: "actor.effect.update", target: { characterId: AYLA }, effectId: made[i]!, patch: { hiddenFromPlayers: true } } as Op)
            : { t: "actor.effect.remove", target: { characterId: AYLA }, effectId: made[i]! },
        );
      }
      // A removal writes its line and a hide none, so the frames are compared from here.
      const since = marks(pair);
      assert.deepEqual(await reuse(pair, made, add, "the condition's id"), GONE);
      sameSince(pair, since, "the condition's id");
    });
    await t.test("an ask", async () => {
      const made = ids(pair);
      const ask = (caster: string) => (id: string): Op => ({ t: "cast.ask", cast: { id, caster, sceneId: "s1", spell: "Hold Person", targets: [OGRE] } }) as Op;
      for (const [i, room] of pair.entries()) await room.apply("p1", ask(AYLA)(made[i]!));
      // Ayla is handed to P2 in both rooms, which leaves the ask out of P1's copy, and B also closes it.
      for (const [i, room] of pair.entries()) {
        await room.apply("dm", { t: "character.update", characterId: AYLA, patch: { ownerIds: ["p2"] } } as Op);
        if (room.name === "B") await room.apply("dm", { t: "cast.close", castId: made[i]!, end: "dismissed" } as Op);
        else room.clock.now += 1_000;
      }
      const since = marks(pair);
      // An ask's id is also its receipt's tag, so the same id again is the same ask sent again, answered by its receipt.
      await reuse(pair, made, ask(cade), "the ask's id");
      for (const room of pair) assert.equal(Object.values(room.state.casts).filter((c) => c.caster === cade).length, 0, `${room.name}: no second ask`);
      sameSince(pair, since, "the ask's id");
    });
    await t.test("another member's companion", async () => {
      const made = ids(pair);
      const wolf = (of: string, x: number) => (id: string): Op =>
        ({ t: "token.create", token: { id, sceneId: "s1", kind: "npc", name: "Wolf", size: "medium", layer: "token", x, y: of === BREE ? 7 : 3, actor: { inline: actor({ dmNotes: "" }) }, companion: { of, turn: "shared" } } }) as Op;
      const seen = marks(pair);
      for (const [i, room] of pair.entries()) await room.apply("p2", wolf(BREE, 4)(made[i]!));
      sameSince(pair, seen, "P1 sees P2's wolf");
      for (const [i, room] of pair.entries()) {
        await room.apply("dm", room.name === "A" ? ({ t: "token.update", tokenId: made[i]!, patch: { visibility: "dm" } } as Op) : { t: "token.delete", tokenId: made[i]! });
      }
      sameSince(pair, seen, "the wolf leaves P1's copy");
      assert.deepEqual(await reuse(pair, made, wolf(cade, 6), "the wolf's id"), GONE);
      sameSince(pair, seen, "the wolf's id");
    });
  });

  test("C2: a condition a group save gave P1's character, hidden in A and removed in B, answers its id gone in both, at once and after a restart", async (t) => {
    const pair = await open(t);
    // The DM's device makes the plan's condition ids when it plans the save, version 7 at the room's clock.
    const made = ids(pair);
    const outcome = (id: string): Op => ({ t: "actor.outcome", plan: mint.next(pair[0]), label: "Hold Person", targets: [{ target: { characterId: AYLA }, effects: [{ id, key: "paralyzed" }] }] }) as Op;
    for (const [i, room] of pair.entries()) await room.apply("dm", outcome(made[i]!));
    same(pair, "P1 sees the condition");
    for (const [i, room] of pair.entries()) {
      await room.apply(
        "dm",
        room.name === "A"
          ? ({ t: "actor.effect.update", target: { characterId: AYLA }, effectId: made[i]!, patch: { hiddenFromPlayers: true } } as Op)
          : { t: "actor.effect.remove", target: { characterId: AYLA }, effectId: made[i]! },
      );
    }
    const add = (id: string): Op => ({ t: "actor.effect.add", target: { characterId: AYLA }, effect: { id, key: "blessed" } }) as Op;
    const since = marks(pair);
    assert.deepEqual(await reuse(pair, made, add, "the condition's id"), GONE);
    sameSince(pair, since, "the condition's id");
    await each(pair, (room) => room.restart(false));
    const after = marks(pair);
    assert.deepEqual(await reuse(pair, made, add, "after a restart"), GONE);
    sameSince(pair, after, "after a restart");
  });

  test("C2: a group save's plan applied three hours after it was made is taken, and its condition's id gets the server's row in both", async (t) => {
    const pair = await open(t);
    const made = ids(pair, -3 * 60 * MINUTE);
    const plans = ids(pair, -3 * 60 * MINUTE);
    const outcome = (room: Room): Op => {
      const i = pair.indexOf(room as never);
      return { t: "actor.outcome", plan: plans[i]!, label: "Hold Person", targets: [{ target: { characterId: AYLA }, effects: [{ id: made[i]!, key: "paralyzed" }] }] } as Op;
    };
    assert.equal(await bothAnswer(pair, "dm", outcome, "the aged plan"), "taken");
    same(pair, "the aged plan");
    for (const [i, table] of pair.ids.entries()) assert.deepEqual(table.rows.filter((r) => r.id === made[i]).map((r) => r.memberId), ["server"], pair[i]!.name);
  });

  test("C2: a group save's plan applied again is answered once by its receipt, its condition given once and its row kept as it was", async (t) => {
    const pair = await open(t);
    const made = ids(pair);
    const plans = ids(pair);
    const outcome = (room: Room): Op => {
      const i = pair.indexOf(room as never);
      return { t: "actor.outcome", plan: plans[i]!, label: "Hold Person", targets: [{ target: { characterId: AYLA }, effects: [{ id: made[i]!, key: "paralyzed" }] }] } as Op;
    };
    assert.equal(await bothAnswer(pair, "dm", outcome, "the plan"), "taken");
    const rows = pair.ids.map((table) => JSON.stringify(table.rows));
    assert.equal(await bothAnswer(pair, "dm", outcome, "the plan again"), "taken");
    same(pair, "the plan again");
    for (const [i, room] of pair.entries()) {
      assert.equal(room.state.characters[AYLA]!.actor.effects.filter((e) => e.id === made[i]).length, 1, `${room.name}: the condition once`);
      assert.equal(JSON.stringify(pair.ids[i]!.rows), rows[i], `${room.name}: the rows as they were`);
    }
  });

  test("C2: a group save whose condition's id is dated ten years ahead is refused in both with the words for an id not made just now, and gets no row", async (t) => {
    const pair = await open(t);
    const outcome = (aheadMs: number) => (room: Room): Op => ({ t: "actor.outcome", plan: mint.next(room), label: "Hold Person", targets: [{ target: { characterId: AYLA }, effects: [{ id: mint.next(room, aheadMs), key: "paralyzed" }] }] }) as Op;
    const rowsBefore = pair.ids.map((table) => table.rows.length);
    assert.deepEqual(await bothAnswer(pair, "dm", outcome(10 * 365 * 24 * 60 * MINUTE), "ten years ahead"), STALE);
    // Made a second before it is sent, as Room.send moves the clock.
    assert.deepEqual(await bothAnswer(pair, "dm", outcome(7_000), "6 seconds ahead"), STALE);
    assert.deepEqual(pair.ids.map((table) => table.rows.length), rowsBefore, "no row");
    for (const room of pair) assert.deepEqual(room.state.characters[AYLA]!.actor.effects, [], `${room.name}: no condition`);
    assert.equal(await bothAnswer(pair, "dm", outcome(5_000), "4 seconds ahead"), "taken");
    same(pair, "ahead of the clock");
  });

  test("C3: an id dated 4 seconds ahead, taken, its area hidden in A and deleted in B, answers gone after a restart a second later, and ids past 5 seconds ahead are refused", async (t) => {
    const pair = await open(t);
    const made = ids(pair, 4_000);
    // Sent at once, so the id is still ahead of the clock when it arrives.
    for (const [i, room] of pair.entries()) await room.apply("p1", areaOp(made[i]!));
    for (const [i, room] of pair.entries()) {
      await room.apply("dm", room.name === "A" ? ({ t: "template.update", templateId: made[i]!, patch: { visibility: "dm" } } as Op) : { t: "template.delete", templateId: made[i]! });
    }
    await each(pair, (room) => room.restart(false));
    assert.deepEqual(await reuse(pair, made, areaOp, "after the restart"), GONE);
    same(pair, "after the restart");
    // One dated past the 5 seconds ahead is refused for its time, the DM's too.
    assert.deepEqual(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room, 7_000)), "7 seconds ahead"), STALE);
    const dmArea = (room: Room): Op => ({ t: "template.create", template: { ...(areaOp(mint.next(room, 60_000)) as Extract<Op, { t: "template.create" }>).template, ownerId: "dm1" } }) as Op;
    assert.deepEqual(await bothAnswer(pair, "dm", dmArea, "the DM's a minute ahead"), STALE);
    same(pair, "ahead of the clock");
  });

  test("C4: in the 30 minutes after this server first started on this build, an id dated before that start is refused in both, and one dated after it taken", async (t) => {
    const pair = await open(t);
    const start = pair[0].clock.now;
    for (const room of pair) room.clock.now += 10 * MINUTE;
    const before = (room: Room) => areaOp(mint.next(room, -(room.clock.now - start) - MINUTE));
    assert.deepEqual(await bothAnswer(pair, "p1", before, "dated a minute before the start"), STALE);
    const after = (room: Room) => areaOp(mint.next(room, -5 * MINUTE));
    assert.equal(await bothAnswer(pair, "p1", after, "dated five minutes ago, after the start"), "taken");
    same(pair, "around the start");
  });

  test("C4: with the stored cutover ahead of a clock set back, an id dated before the cutover is refused in both, one after it taken, and the operator is told once a load", async (t) => {
    const ahead = T0 + 10 * MINUTE;
    const pair = await openTwins(t, limitsRoom(), limitsRoom(), {}, {}, { since: ahead });
    assert.deepEqual(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room)), "made now, before the cutover"), STALE);
    for (const room of pair) room.clock.now = ahead + 1_000;
    assert.equal(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room)), "made once the clock passed it"), "taken");
    same(pair, "around the cutover");
    const told = (room: Room) => room.logged.filter((line) => line.startsWith("the ids cutover is ahead of the server's clock")).length;
    assert.deepEqual(pair.map(told), [1, 1]);
    await each(pair, (room) => room.restart(false));
    assert.deepEqual(pair.map(told), [1, 1], "a load past the cutover tells nothing");
  });

  test("C4: an id an old room holds, dated within the window, gets its row at the room's first load on this build, so it answers gone in both after the DM deletes its thing", async (t) => {
    const old = PLAYER_LIMITS_SNAPSHOT_VERSION - 1;
    const made = idAt(rng(404), T0 - 5 * MINUTE);
    const hidden = (s: RoomState) => {
      s.templates[made] = template(made, { ownerId: "p1", visibility: "dm", origin: { x: 4.5, y: 4.5, z: 0 }, size: 5 });
    };
    const a = limitsRoom();
    const b = limitsRoom();
    hidden(a);
    hidden(b);
    // The server first started on this build an hour before the room's first load here.
    const pair = await openTwins(t, a, b, {}, {}, { version: old, since: T0 - 60 * MINUTE });
    await each(pair, (room) => room.apply("dm", { t: "template.delete", templateId: made }));
    assert.deepEqual(await bothAnswer(pair, "p1", areaOp(made), "the old id"), GONE);
    same(pair, "the old id");
  });

  test("C4: P1's group save naming a hidden condition's id dated ten years ahead, which an old room keeps in A alone and seeds at its first load, answers alike in both, at once and after a restart", async (t) => {
    const old = PLAYER_LIMITS_SNAPSHOT_VERSION - 1;
    const far = idAt(rng(405), T0 + 10 * 365 * 24 * 60 * MINUTE);
    const a = limitsRoom();
    a.characters[AYLA] = { ...a.characters[AYLA]!, actor: { ...a.characters[AYLA]!.actor, effects: [{ id: far, key: "frightened", hiddenFromPlayers: true }] } };
    const pair = await openTwins(t, a, limitsRoom(), { a: [far] }, {}, { version: old, since: T0 - 60 * MINUTE });
    assert.deepEqual(pair.ids.map((table) => table.rows.some((r) => r.id === far)), [true, false], "the seed is A's alone");
    const outcome = (room: Room): Op => ({ t: "actor.outcome", plan: mint.next(room), label: "Hold Person", targets: [{ target: { characterId: AYLA }, effects: [{ id: far, key: "paralyzed" }] }] }) as Op;
    assert.deepEqual(await bothAnswer(pair, "p1", outcome, "at once"), STALE);
    same(pair, "at once");
    await each(pair, (room) => room.restart(false));
    assert.deepEqual(await bothAnswer(pair, "p1", outcome, "after a restart"), STALE);
    same(pair, "after a restart");
  });

  test("C6: P1's 2,001st id in 30 minutes meets the words in both, and the count stays alike after the DM hides half of P1's things in A, deletes them in B, and a restart", async (t) => {
    // Three characters of P1's, so one op can bring 32 conditions for each.
    const heroes = [AYLA, "cade", "dara"];
    const pair = await open(t, (s) => {
      for (const id of heroes.slice(1)) s.characters[id] = character(id, { name: id, ownerIds: ["p1"] });
    });
    // 32 conditions on each of P1's characters in one op bring 96 ids, and their removal makes room for the next.
    const kept = 20;
    let brought = 0;
    while (brought < ID_BUDGET.player - kept) {
      const n = Math.min(32 * heroes.length, ID_BUDGET.player - kept - brought);
      for (const room of pair) {
        const effects = Array.from({ length: n }, (_, i) => ({ target: { characterId: heroes[i % heroes.length]! }, effect: { id: mint.next(room), key: "blessed" } }));
        await room.apply("p1", { t: "actor.effects", add: effects } as Op);
        await room.apply("p1", { t: "actor.effects", remove: effects.map((e) => ({ target: e.target, effectId: e.effect.id })) } as Op);
      }
      brought += n;
    }
    const areas: [string[], string[]] = [[], []];
    while (brought < ID_BUDGET.player) {
      for (const [i, room] of pair.entries()) {
        areas[i]!.push(mint.next(room));
        await room.apply("p1", areaOp(areas[i]!.at(-1)!));
      }
      brought++;
    }
    same(pair, "2,000 ids");
    assert.deepEqual(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room)), "the 2,001st"), { code: "quota", message: IDS_TOO_FAST });
    for (const [i, room] of pair.entries()) {
      for (const id of areas[i]!.slice(0, kept / 2)) {
        await room.apply("dm", room.name === "A" ? ({ t: "template.update", templateId: id, patch: { visibility: "dm" } } as Op) : { t: "template.delete", templateId: id });
      }
    }
    await each(pair, (room) => room.restart(false));
    assert.deepEqual(await bothAnswer(pair, "p1", (room) => areaOp(mint.next(room)), "after the restart"), { code: "quota", message: IDS_TOO_FAST });
    same(pair, "after the restart");
  });

  test("C10: a create whose answer was lost, hidden in A and deleted in B, is held for P1's device at once and 6 hours later, a restart between", async (t) => {
    const pair = await open(t);
    const made = ids(pair);
    for (const [i, room] of pair.entries()) await room.apply("p1", areaOp(made[i]!));
    for (const [i, room] of pair.entries()) {
      await room.apply("dm", room.name === "A" ? ({ t: "template.update", templateId: made[i]!, patch: { visibility: "dm" } } as Op) : { t: "template.delete", templateId: made[i]! });
    }
    for (const later of [0, 6 * 60 * MINUTE]) {
      const answers: unknown[] = [];
      for (const [i, room] of pair.entries()) {
        room.clock.now += later;
        // A restart prunes the rows past both their times, so a row still held answers through it.
        if (later > 0) await room.restart(false);
        await room.reloadP1();
        answers.push(await askIds(room, [made[i]!]));
      }
      assert.deepEqual(answers.map((a) => (a as { held: string[] }).held.length), [1, 1], `${later / MINUTE} minutes on: held in both`);
      same(pair, `${later / MINUTE} minutes on`);
    }
  });
});

/** Each room's own count of its device's asks, as a device numbers them. */
describe("an id the room has not stored answers P1 alike", () => {
  test("C13: an ask while P1's create waits in its batch answers pending, then held once the batch is stored, in both", async (t) => {
    const pair = await open(t);
    const made = ids(pair);
    const answers: unknown[] = [];
    for (const [i, room] of pair.entries()) {
      const id = made[i]!;
      const named = (list: readonly string[]) => list.map((x) => (x === id ? "the id" : x));
      const sent = room.clients.p1.send(areaOp(id));
      const first = await askIds(room, [id]);
      await sent;
      await room.settle();
      const second = await askIds(room, [id]);
      answers.push([first, second].map((a) => ({ held: named(a.held), notHeld: named(a.notHeld), pending: named(a.pending) })));
    }
    assert.deepEqual(answers[0], [{ held: [], notHeld: [], pending: ["the id"] }, { held: ["the id"], notHeld: [], pending: [] }]);
    assert.deepEqual(answers[1], answers[0]);
  });

  test("C13: a create the gate passed and the room refused leaves no row: its id answers not held, and the device's create under it again is taken, in both", async (t) => {
    const pair = await open(t);
    const made = ids(pair);
    const theirs = (id: string): Op => {
      const { rev: _rev, ...area } = template(id, { ownerId: "p2", origin: { x: 4.5, y: 4.5, z: 0 }, size: 5 });
      return { t: "template.create", template: area } as Op;
    };
    const refused = await reuse(pair, made, theirs, "an area of another member's");
    assert.notEqual(refused, "taken", "the room refuses it");
    const asked = await Promise.all(pair.map((room, i) => askIds(room, [made[i]!])));
    assert.deepEqual(asked.map((a) => [a.held.length, a.notHeld.length, a.pending.length]), [[0, 1, 0], [0, 1, 0]], "not held in both");
    assert.equal(await reuse(pair, made, areaOp, "P1's own area under that id"), "taken");
  });
});

const asks = new WeakMap<Room, number>();

/** P1's device asks, on its newest socket, which of these ids of its own creates the room took, and the answer. */
async function askIds(room: Room, list: string[]): Promise<Extract<ServerMessage, { t: "ids" }>> {
  const client = room.clients.p1;
  const k = (asks.get(room) ?? 0) + 1;
  asks.set(room, k);
  room.actor.ids(client.conn, { k, ids: list });
  const answer = await until(() => client.sent.find((m): m is Extract<ServerMessage, { t: "ids" }> => m.t === "ids" && m.k === k), "the ids answer");
  await room.settle();
  return answer;
}
