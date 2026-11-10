import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp, Op, ServerMessage } from "#shared/protocol.ts";
import { TURN_OPS } from "#shared/reads.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, customMonster, env, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { combatAlerts } from "../features/combat/alerts.ts";
import { answersFor, openRecord, turnParticipants } from "../features/combat/logic.ts";
import { turnOp } from "../features/encounter/logic.ts";
import { resolveLine, srdIndex } from "../features/encounters/draft.ts";
import { dropPlan } from "../features/encounters/drop.ts";
import { companionInput, joinFightOp, NEW_COMPANION, type CompanionDraft } from "../features/tokens/companions.ts";
import { fightOps, shownRowOps } from "../features/tokens/groupEdit.ts";
import { createRoomStore, fightAhead, turnPending, type RoomStore } from "./store.ts";
import { applyTestHistory, FakeClock, FakeOutbox } from "./testing.ts";
import type { OpAnswer } from "./types.ts";

/*
 * The DM's device shows no turn change before the server answers it
 * (shared/reads.ts TURN_OPS): the turn on screen, its cards' keys and the
 * record every action sends are the server's, and while a turn change
 * waits the actions that send a record answer "pending" and send nothing.
 */

const CO_DM: Viewer = { memberId: "dm2", role: "dm" };

/**
 * Dragon 20, Thorn 15 (dying, on a token row or a character-only row),
 * Troll 12 and Goblin 5, the dragon acting in round 1.
 */
function fight(rows: "token" | "character"): RoomState {
  let state = room({
    tokens: {
      dragon: token("dragon", { name: "Dragon" }),
      troll: token("troll", { name: "Troll", x: 4, y: 2, actor: { inline: actor({ hp: { cur: 40, max: 94, temp: 0 } }) } }),
      goblin: token("goblin", { name: "Goblin", x: 6, y: 2 }),
      ...(rows === "token" ? { thorn: token("thorn", { kind: "pc", name: "Thorn", x: 8, y: 2, actor: { ref: "thorn" } }) } : {}),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying", deathSaves: { ok: 1, fail: 0 } }) }) },
  });
  state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false };
  const thorn = rows === "token" ? { tokenId: "thorn" } : { characterId: "thorn" };
  let seq = 0;
  for (const op of [
    { t: "encounter.start", entries: [{ id: "ed", tokenId: "dragon", value: 20 }, { id: "et", ...thorn, value: 15 }, { id: "er", tokenId: "troll", value: 12 }, { id: "eg", tokenId: "goblin", value: 5 }] },
    { t: "encounter.next" },
  ] as Op[]) {
    const result = applyOp(state, op, DM, env(++seq));
    assert.ok(result.ok, op.t);
    state = result.state;
  }
  return state;
}

function setup(state: RoomState) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const room = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  const connect = () => {
    room.suspend();
    const hello = room.prepareHello();
    room.setConnection("open");
    room.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
    applyTestHistory(room, hello.resumeFrom - 1);
  };
  const sent = () => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    return ops;
  };
  /** The ops sent since the last call, as one batch, with its answers back. */
  const deliver = () => {
    for (const msg of server.batch(sent())) receive(room, msg);
  };
  /** Another DM's op, its frame delivered at once. */
  const coDm = (op: Op) => {
    const ev = server.external(op, CO_DM);
    if (ev) receive(room, ev);
  };
  return { server, room, connect, sent, deliver, coDm, state: () => room.store.getState() };
}

function receive(room: RoomStore, msg: ServerMessage): void {
  if (msg.t === "ev") room.applyEv(msg);
  else if (msg.t === "snapshot") room.applySnapshot(msg);
  else if (msg.t === "retry" && msg.n !== undefined) room.retryOps(msg.n);
}

/** Which turn runs: the active row, the turn start's row and number, and each creature's turn record by id. */
function turnIdentity(state: Pick<RoomState, "encounter" | "tokens" | "characters"> | null | undefined): string {
  const encounter = state?.encounter ?? null;
  const records: [string, number][] = [];
  for (const [id, t] of Object.entries(state?.tokens ?? {})) if ("inline" in t.actor && t.actor.inline.turnRecord) records.push([`token:${id}`, t.actor.inline.turnRecord.id]);
  for (const [id, c] of Object.entries(state?.characters ?? {})) if (c.actor.turnRecord) records.push([`character:${id}`, c.actor.turnRecord.id]);
  records.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([encounter?.activeEntryId ?? null, encounter?.turnStart?.entryId ?? null, encounter?.turnStart?.seq ?? null, records]);
}

function thornActor(view: RoomState) {
  return view.characters.thorn?.actor;
}

/** The death save card the DM's device draws for Thorn, by its id, which keys on his record. */
function thornCards(view: RoomState, dismissed: ReadonlySet<string> = new Set()): string[] {
  const you = { role: "dm" as const, memberId: "dm1" };
  const participants = turnParticipants(view).filter((p) => answersFor(view, you, p.target) || p.record?.life === "dying");
  return combatAlerts({ view, you, participants, uses: participants.map(() => []), loading: false, failed: false, dismissed }).deathSaves.map((c) => c.id);
}

for (const rows of ["token", "character"] as const) {
  describe(`a DM's turn change on ${rows} rows waits for its answer`, () => {
    test("Next held: the old turn shows, turn changes and record actions wait, and the answer brings the new turn under its confirmed number", () => {
      const s = setup(fight(rows));
      s.connect();
      const before = s.state().view as unknown as RoomState;
      assert.equal(before.encounter?.activeEntryId, "ed");
      s.room.dispatch(turnOp("encounter.next", s.state()));
      const held = s.state().view as unknown as RoomState;
      assert.equal(turnIdentity(held), turnIdentity(before), "nothing of the turn changed before the answer");
      assert.equal(turnPending(s.state()), true);
      assert.equal(openRecord(held.encounter, thornActor(held), "deathSave", turnPending(s.state())), "pending");
      assert.equal(openRecord(held.encounter, thornActor(held), "regeneration", turnPending(s.state())), "pending");
      s.deliver();
      const after = s.state().view as unknown as RoomState;
      assert.equal(turnPending(s.state()), false);
      assert.equal(after.encounter?.activeEntryId, "et");
      const record = s.server.state.characters.thorn!.actor.turnRecord!;
      assert.equal(openRecord(after.encounter, thornActor(after), "deathSave", turnPending(s.state())), record.id, "the action takes the server's record");
      assert.deepEqual(thornCards(after), [`c:thorn|${record.id}|deathSave`]);
    });

    test("Previous held: the same, back to the dragon's turn", () => {
      const s = setup(fight(rows));
      s.connect();
      s.room.dispatch(turnOp("encounter.next", s.state()));
      s.deliver();
      const thornsTurn = s.state().view as unknown as RoomState;
      s.room.dispatch(turnOp("encounter.prev", s.state()));
      assert.equal(turnIdentity(s.state().view as unknown as RoomState), turnIdentity(thornsTurn));
      assert.equal(turnPending(s.state()), true);
      assert.equal(openRecord(thornsTurn.encounter, thornActor(thornsTurn), "deathSave", turnPending(s.state())), "pending");
      s.deliver();
      assert.equal(s.state().view?.encounter?.activeEntryId, "ed");
      assert.equal(turnPending(s.state()), false);
      assert.equal(turnIdentity(s.state().view as unknown as RoomState), turnIdentity(projectState(s.server.state, DM, { sceneId: "s1" }) as unknown as RoomState));
    });

    test("Previous then Next on the same row and round: each turn's card keys on its confirmed number, and a dismissed card is back", () => {
      const s = setup(fight(rows));
      s.connect();
      s.room.dispatch(turnOp("encounter.next", s.state()));
      s.deliver();
      const first = thornCards(s.state().view as unknown as RoomState);
      assert.equal(first.length, 1);
      const dismissed = new Set(first);
      assert.deepEqual(thornCards(s.state().view as unknown as RoomState, dismissed), []);
      s.room.dispatch(turnOp("encounter.prev", s.state()));
      s.deliver();
      s.room.dispatch(turnOp("encounter.next", s.state()));
      s.deliver();
      const view = s.state().view as unknown as RoomState;
      const record = s.server.state.characters.thorn!.actor.turnRecord!.id;
      assert.deepEqual(thornCards(view), [`c:thorn|${record}|deathSave`]);
      assert.notDeepEqual(thornCards(view), first);
      assert.deepEqual(thornCards(view, dismissed), [`c:thorn|${record}|deathSave`], "the new turn's card is back");
    });
  });
}

describe("turnPending is read from the ops still pending", () => {
  test("a refused turn change ends it", () => {
    const s = setup(fight("token"));
    s.connect();
    // Another DM ends the fight first, so this device's Next is refused.
    s.server.external({ t: "encounter.end" }, CO_DM);
    let heard: OpAnswer | undefined;
    s.room.dispatch({ t: "encounter.next" }, { quiet: true, onAnswer: (a) => (heard = a) });
    assert.equal(turnPending(s.state()), true);
    s.deliver();
    assert.equal(heard, "refused");
    assert.equal(turnPending(s.state()), false);
  });

  test("a Next whose answer is lost is settled by the reconnect's snapshot, which ends it", () => {
    const s = setup(fight("token"));
    s.connect();
    s.room.dispatch(turnOp("encounter.next", s.state()));
    s.server.batch(s.sent());
    assert.equal(turnPending(s.state()), true);
    s.connect();
    assert.deepEqual(s.state().pending, []);
    assert.equal(turnPending(s.state()), false);
    assert.equal(s.state().view?.encounter?.activeEntryId, "et");
  });

  test("each op of TURN_OPS waits in turn, unpredicted, and its answer ends the wait", () => {
    const ops: ClientOp[] = [
      { t: "encounter.next" },
      { t: "encounter.prev" },
      { t: "encounter.remove", entryIds: ["eg"] },
      { t: "token.delete", tokenId: "goblin" },
      { t: "token.deleteMany", tokenIds: ["goblin"] },
      { t: "scene.delete", sceneId: "s2" },
      { t: "character.delete", characterId: "thorn" },
      { t: "token.update", tokenId: "goblin", patch: { companion: { of: "thorn", turn: "shared" } } },
      { t: "encounter.end" },
    ];
    const tried = new Set<string>(["encounter.start", "undo", "redo"]);
    for (const op of ops) {
      const s = setup(fight("token"));
      s.connect();
      const before = JSON.stringify(s.state().view);
      s.room.dispatch(op);
      tried.add(op.t);
      assert.equal(turnPending(s.state()), true, op.t);
      assert.equal(JSON.stringify(s.state().view), before, `${op.t} was predicted`);
      s.deliver();
      assert.equal(turnPending(s.state()), false, op.t);
    }
    // The fight's start, with no fight yet.
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e1", tokenId: "g1", value: 10 }] });
    assert.equal(turnPending(s.state()), true);
    assert.equal(s.state().view?.encounter, null, "a start was predicted");
    s.deliver();
    assert.equal(turnPending(s.state()), false);
    assert.ok(s.state().view?.encounter);
    assert.deepEqual([...TURN_OPS].filter((t) => !tried.has(t)), []);
  });

  test("outside a fight a token delete is predicted and nothing waits", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch({ t: "token.delete", tokenId: "g1" });
    assert.equal(turnPending(s.state()), false);
    assert.equal(s.state().view?.tokens.g1, undefined, "shown at once, as before");
  });
});

describe("other ops stay predicted behind a waiting turn change", () => {
  test("a move, a chat and an HP change show at once on the state without the Next", () => {
    const s = setup(fight("token"));
    s.connect();
    s.room.dispatch(turnOp("encounter.next", s.state()));
    s.room.dispatch({ t: "token.move", tokenId: "goblin", x: 9, y: 9 });
    s.room.dispatch({ t: "log.chat", text: "Watch out" });
    s.room.dispatch({ t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 5 } });
    const view = s.state().view!;
    assert.equal(view.encounter?.activeEntryId, "ed", "the Next is not shown");
    assert.deepEqual([view.tokens.goblin?.x, view.tokens.goblin?.y], [9, 9]);
    assert.ok(view.log.some((e) => e.kind === "chat" && e.text === "Watch out"));
    const troll = view.tokens.troll!;
    assert.equal("inline" in troll.actor ? troll.actor.inline.hp?.cur : null, 35);
    s.deliver();
    assert.equal(s.state().view?.encounter?.activeEntryId, "et");
  });
});

describe("two schedules that leave the same acknowledgements and copies", () => {
  /** In one batch: this device's Next, then another DM's Previous and Next, or that DM's Next and Previous, then this device's Next. */
  for (const order of ["mine first", "mine last"] as const) {
    for (const rows of ["token", "character"] as const) {
      test(`${order}, on ${rows} rows: the cards key on the final confirmed turn and no action carries another number`, () => {
        const s = setup(fight(rows));
        s.connect();
        const mine = turnOp("encounter.next", s.state());
        s.room.dispatch(mine);
        const theirs: Op[] = order === "mine first" ? [{ t: "encounter.prev" }, { t: "encounter.next" }] : [{ t: "encounter.next" }, { t: "encounter.prev" }];
        const frames: ServerMessage[] = [];
        const batch = () => frames.push(...s.server.batch(s.sent()));
        const others = () => {
          for (const op of theirs) {
            const ev = s.server.external(op, CO_DM);
            if (ev) frames.push(ev);
          }
        };
        if (order === "mine first") {
          batch();
          others();
        } else {
          others();
          batch();
        }
        // Until every frame lands, the device keeps showing what it was told, never a turn of its own.
        for (const frame of frames) {
          receive(s.room, frame);
          assert.equal(turnIdentity(s.state().view as unknown as RoomState), turnIdentity(s.state().confirmed as unknown as RoomState));
        }
        const view = s.state().view as unknown as RoomState;
        const server = projectState(s.server.state, DM, { sceneId: "s1" }) as unknown as RoomState;
        assert.equal(turnIdentity(view), turnIdentity(server));
        assert.equal(turnPending(s.state()), false);
        const record = s.server.state.characters.thorn!.actor.turnRecord!.id;
        assert.deepEqual(thornCards(view), [`c:thorn|${record}|deathSave`]);
        assert.equal(openRecord(view.encounter, thornActor(view), "deathSave", turnPending(s.state())), record);
      });
    }
  }
});

describe("an action that adds creatures while a fight's start waits for its answer", () => {
  const hoot: CompanionDraft = { ...NEW_COMPANION, name: "Hoot", hp: 1, ac: 11, turn: "own", turnPicked: true };

  /** Two goblins, Bree's token and a cave lurker among the room's monsters, with no fight on. */
  function noFight(): RoomState {
    const state = room({
      tokens: {
        g1: token("g1", { name: "Goblin 1" }),
        g2: token("g2", { name: "Goblin 2", x: 4, y: 2 }),
        bt: token("bt", { kind: "pc", name: "Bree", x: 8, y: 2, actor: { ref: "bree" } }),
      },
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    });
    state.scenes.s1!.bounds = { w: 30, h: 30 };
    state.monsters.mon1 = customMonster("mon1", { name: "Cave Lurker" });
    return state;
  }

  test("the group bar's button, a saved encounter dropped into the fight and a new companion with its own turn each send an add behind the start, and the server takes them all", () => {
    const s = setup(noFight());
    s.connect();
    let ids = 0;
    const newId = () => `new-${++ids}`;
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-g1", tokenId: "g1" }, { id: "e-bree", tokenId: "bt" }] });
    const view = s.state().view as unknown as RoomState;
    assert.equal(view.encounter, null, "the start shows only once the server takes it");
    assert.deepEqual(fightAhead(s.state())?.entries.map((e) => e.tokenId), ["g1", "bt"]);
    // The group bar on both goblins: the one not in the start, as an add.
    const bar = fightOps([view.tokens.g1!, view.tokens.g2!], fightAhead(s.state()), newId);
    assert.deepEqual(bar, [{ t: "encounter.add", entries: [{ id: "new-1", tokenId: "g2" }] }]);
    for (const op of bar) s.room.dispatch(op);
    // A saved encounter placed with "Add them to the fight" on.
    const drop = dropPlan({
      monsters: [{ monsterId: "mon1", count: 1 }],
      resolve: (m) => resolveLine(m, srdIndex([]), view.monsters),
      state: { ...view, encounter: fightAhead(s.state()) },
      scene: view.scenes.s1!,
      center: { x: 12.5, y: 12.5 },
      options: { hidden: false, addToFight: true },
      newId,
    });
    assert.deepEqual(drop.ops.map((op) => op.t), ["token.create", "encounter.add"]);
    for (const op of drop.ops) s.room.dispatch(op);
    // Bree's new companion with a turn of its own.
    const input = companionInput(hoot, { id: "hoot", sceneId: "s1", x: 9, y: 2, elevation: 0 }, view.characters.bree!);
    const join = joinFightOp({ tokens: view.tokens, encounter: fightAhead(s.state()) }, input, "e-hoot");
    assert.deepEqual(join, { t: "encounter.add", entries: [{ id: "e-hoot", tokenId: "hoot" }] });
    s.room.dispatch({ t: "token.create", token: input });
    s.room.dispatch(join!);
    s.deliver();
    assert.deepEqual(s.state().pending, [], "every op answered");
    assert.deepEqual(s.state().refused, [], "none refused");
    const lurker = drop.ops[0]!.t === "token.create" ? drop.ops[0]!.token.id : "";
    assert.deepEqual(s.server.state.encounter?.entries.map((e) => e.tokenId).sort(), ["bt", "g1", "g2", "hoot", lurker].sort(), "one row each");
  });

  test("with End the fight waiting, the group bar's button starts a new fight behind the end, and the server takes both", () => {
    const s = setup(noFight());
    s.connect();
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-g1", tokenId: "g1" }] });
    s.deliver();
    s.room.dispatch({ t: "encounter.add", entries: [{ id: "e-bree", tokenId: "bt" }] });
    assert.ok((s.state().view as unknown as RoomState).encounter?.entries.some((e) => e.id === "e-bree"), "the add shows before its answer");
    assert.deepEqual(fightAhead(s.state())?.entries.map((e) => e.tokenId).sort(), ["bt", "g1"], "an add the view shows already counts once");
    s.deliver();
    s.room.dispatch({ t: "encounter.end" });
    const view = s.state().view as unknown as RoomState;
    assert.ok(view.encounter, "the end shows only once the server takes it");
    assert.equal(fightAhead(s.state()), null);
    let ids = 0;
    const bar = fightOps([view.tokens.g1!, view.tokens.g2!], fightAhead(s.state()), () => `new-${++ids}`);
    assert.deepEqual(bar, [{ t: "encounter.start", entries: [{ id: "new-1", tokenId: "g1" }, { id: "new-2", tokenId: "g2" }] }]);
    for (const op of bar) s.room.dispatch(op);
    s.deliver();
    assert.deepEqual(s.state().pending, [], "every op answered");
    assert.deepEqual(s.state().refused, [], "none refused");
    assert.deepEqual(s.server.state.encounter?.entries.map((e) => e.tokenId).sort(), ["g1", "g2"], "the new fight's rows");
  });

  test("an end sent after the start leaves no fight on its way", () => {
    const s = setup(noFight());
    s.connect();
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-g1", tokenId: "g1" }] });
    s.room.dispatch({ t: "encounter.add", entries: [{ id: "e-g2", tokenId: "g2" }] });
    assert.deepEqual(fightAhead(s.state())?.entries.map((e) => e.tokenId), ["g1", "g2"]);
    s.room.dispatch({ t: "encounter.end" });
    assert.equal(fightAhead(s.state()), null);
  });
});

describe("Hidden turned off while the fight's start waits for its answer", () => {
  test("the row the start left to its hidden token shows once the server takes the start and the reveal, and a row the start showed gets nothing", () => {
    const s = setup(
      room({
        tokens: {
          g1: token("g1", { name: "Goblin 1", visibility: "dm" }),
          g2: token("g2", { name: "Goblin 2", x: 4, y: 2, visibility: "dm" }),
        },
      }),
    );
    s.connect();
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-g1", tokenId: "g1" }, { id: "e-g2", tokenId: "g2", hidden: false }] });
    assert.equal((s.state().view as unknown as RoomState).encounter, null, "the start shows only once the server takes it");
    const rows = shownRowOps(fightAhead(s.state()), ["g1", "g2"]);
    assert.deepEqual(rows, [{ t: "encounter.update", entryId: "e-g1", patch: { hidden: false } }]);
    s.room.dispatch({ t: "token.updateMany", tokenIds: ["g1", "g2"], patch: { visibility: "all" } });
    for (const op of rows) s.room.dispatch(op);
    s.deliver();
    assert.deepEqual(s.state().pending, [], "every op answered");
    assert.deepEqual(s.state().refused, [], "none refused");
    const entries = (s.state().view as unknown as RoomState).encounter?.entries ?? [];
    assert.deepEqual(Object.fromEntries(entries.map((e) => [e.tokenId, e.hidden])), { g1: false, g2: false });
  });

  test("a hidden goblin added behind End the fight and a new start, then shown, gets its row shown once the server takes them all", () => {
    const s = setup(
      room({
        tokens: {
          dragon: token("dragon", { name: "Dragon" }),
          g2: token("g2", { name: "Goblin 2", x: 4, y: 2, visibility: "dm" }),
        },
      }),
    );
    s.connect();
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-a", tokenId: "dragon" }] });
    s.deliver();
    s.room.dispatch({ t: "encounter.end" });
    s.room.dispatch({ t: "encounter.start", entries: [{ id: "e-b", tokenId: "dragon" }] });
    s.room.dispatch({ t: "encounter.add", entries: [{ id: "e-c", tokenId: "g2" }] });
    const view = s.state().view as unknown as RoomState;
    assert.ok(view.encounter?.entries.some((e) => e.id === "e-c"), "the add shows on the old fight, whose end has no answer yet");
    assert.deepEqual(fightAhead(s.state())?.entries.map((e) => e.id), ["e-b", "e-c"], "the new fight's rows");
    const rows = shownRowOps(fightAhead(s.state()), ["g2"]);
    assert.deepEqual(rows, [{ t: "encounter.update", entryId: "e-c", patch: { hidden: false } }]);
    s.room.dispatch({ t: "token.update", tokenId: "g2", patch: { visibility: "all" } });
    for (const op of rows) s.room.dispatch(op);
    s.deliver();
    assert.deepEqual(s.state().pending, [], "every op answered");
    assert.deepEqual(s.state().refused, [], "none refused");
    const entries = (s.state().view as unknown as RoomState).encounter?.entries ?? [];
    assert.deepEqual(Object.fromEntries(entries.map((e) => [e.id, e.hidden])), { "e-b": false, "e-c": false });
  });
});
