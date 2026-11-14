import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ID_TIME_REFUSED, idTime } from "#shared/ids.ts";
import { ID_RETRY_FAILED } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { ClientMessage, ClientOp, ServerMessage } from "#shared/protocol.ts";
import { actor, DM, room, token } from "#shared/testutil.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomActions } from "./actions.ts";
import { CLOCK_WAIT_MS, createRoomStore, IDS_AGAIN_MS, IDS_SETTLE_MS, type RoomStore } from "./store.ts";
import { applyTestHistory, FakeClock, FakeOutbox } from "./testing.ts";
import type { OpAnswer, OpRefusal, UnknownCause } from "./types.ts";

/** The server's clock at the start of each test, in ms. */
const T0 = Date.UTC(2026, 10, 13, 12);
const MINUTE = 60_000;

type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
type IdsAsk = Extract<ClientMessage, { t: "ids" }>;

function setup(state: RoomState, viewer: Viewer = DM) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), viewer, "s1");
  const room = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  const actions = createRoomActions(room, { sendEph() {}, switchScene() {} });
  /** The server's clock frame, then its snapshot, as a reconnect brings them. `settled` is a watermark the server reached without the store's ops, as when it refused them and the answers were lost. */
  const connect = (settled?: number, edit?: (snap: Snapshot) => Snapshot) => {
    room.receiveClock(new Date(T0 + clock.elapsed()).toISOString());
    const hello = room.prepareHello();
    room.setConnection("open");
    const snap = server.hello({ resumeFrom: Math.max(hello.resumeFrom, (settled ?? 0) + 1), sceneId: "s1" });
    room.applySnapshot(edit ? edit(snap) : snap);
    applyTestHistory(room, snap.watermark);
  };
  /** The ops sent since the last call, to the server, with its answers back. */
  const deliver = (lose = false) => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    const answers = server.batch(ops);
    if (lose) return;
    for (const msg of answers) if (msg.t === "ev") room.applyEv(msg);
  };
  const sentOps = () => outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
  const asks = () => outbox.sent.filter((m): m is IdsAsk => m.t === "ids");
  return { clock, outbox, server, room, actions, connect, deliver, sentOps, asks, state: () => room.store.getState() };
}

function made(id: string, x = 2): ClientOp {
  const { rev: _rev, fogExemptAuto: _auto, ...input } = token(id, { sceneId: "s1", name: "Goblin", x, y: 2 });
  return { t: "token.create", token: input } as ClientOp;
}

function answers() {
  const heard: { answer: OpAnswer; refusal?: OpRefusal; unknown?: UnknownCause }[] = [];
  const remints: Map<string, string>[] = [];
  return {
    heard,
    remints,
    opts: {
      onAnswer: (answer: OpAnswer, refusal?: OpRefusal, unknown?: UnknownCause) => heard.push({ answer, ...(refusal ? { refusal } : {}), ...(unknown ? { unknown } : {}) }),
      onRemint: (ids: ReadonlyMap<string, string>) => remints.push(new Map(ids)),
    },
  };
}

function refuse(room: RoomStore, n: number, message: string, seq: number): void {
  room.applyEv({ t: "ev", seq, changes: [], rejects: [{ n, code: "invalid", message }] });
}

describe("ids are made by the room's clock, as they are sent (docs/design/design-v1-player-limits.md 3.4)", () => {
  test("a new id carries the server's time as the room reckons it, whatever the device's own clock says", () => {
    const s = setup(room());
    s.connect();
    s.clock.jump(-40 * MINUTE);
    assert.equal(idTime(s.actions.newId()), T0);
    s.clock.advance(1_500);
    assert.equal(idTime(s.actions.newId()), T0 + 1_500);
  });

  test("a create and a move of it made 40 minutes offline go under fresh ids, the move naming the new one, and land once", () => {
    const s = setup(room());
    s.connect();
    s.room.suspend();
    const old = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(old), heard.opts);
    s.room.dispatch({ t: "token.move", tokenId: old, x: 5, y: 5 });
    s.room.ui.select(old);
    assert.deepEqual(s.sentOps(), [], "nothing goes offline");
    s.clock.advance(40 * MINUTE);
    s.connect();
    const sent = s.sentOps();
    assert.deepEqual(sent.map((m) => m.n), [1, 2], "the same numbers, in order");
    const create = sent[0]!.op as Extract<ClientOp, { t: "token.create" }>;
    const fresh = create.token.id;
    assert.notEqual(fresh, old);
    assert.ok(Math.abs(idTime(fresh)! - (T0 + 40 * MINUTE)) < 1_000, "dated now by the server's clock");
    assert.deepEqual(sent[1]!.op, { t: "token.move", tokenId: fresh, x: 5, y: 5 });
    assert.deepEqual(heard.remints, [new Map([[old, fresh]])]);
    assert.equal(s.state().local.selectedId, fresh, "the selection follows the new id");
    s.outbox.sent = sent.map((m) => ({ t: "op", n: m.n, op: m.op }));
    s.deliver();
    assert.deepEqual(Object.keys(s.server.state.tokens), [fresh], "one token, under its new id");
    assert.equal(s.server.state.tokens[fresh]?.x, 5);
    assert.deepEqual(heard.heard, [{ answer: "taken" }]);
  });

  test("a create made a minute before a short drop keeps its id", () => {
    const s = setup(room());
    s.connect();
    s.room.suspend();
    const old = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(old), heard.opts);
    s.clock.advance(MINUTE);
    s.connect();
    assert.equal((s.sentOps()[0]!.op as Extract<ClientOp, { t: "token.create" }>).token.id, old);
    assert.deepEqual(heard.remints, []);
  });

  test("a create sent with no answer keeps its id while it could still land, and goes under a fresh one once it never can", () => {
    for (const [away, kept] of [[10 * MINUTE, true], [40 * MINUTE, false]] as const) {
      const s = setup(room());
      s.connect();
      const old = s.actions.newId();
      s.room.dispatch(made(old));
      assert.equal(s.sentOps().length, 1, "it went out");
      s.outbox.sent = [];
      s.room.suspend();
      s.clock.advance(away);
      // The server never saw it: the watermark stays below it.
      s.connect();
      const again = s.sentOps();
      assert.deepEqual(again.map((m) => m.n), [1], "sent again under its number");
      const id = (again[0]!.op as Extract<ClientOp, { t: "token.create" }>).token.id;
      assert.equal(id === old, kept, `${away / MINUTE} minutes away`);
    }
  });
});

describe("a create whose answer a reconnect lost is settled by the room's record of ids (3.4)", () => {
  test("one the room recorded is never sent again, at once or after 6 hours", () => {
    for (const away of [0, 6 * 60 * MINUTE]) {
      const s = setup(room());
      s.connect();
      const id = s.actions.newId();
      const heard = answers();
      s.room.dispatch(made(id), heard.opts);
      s.deliver(true);
      s.room.suspend();
      s.clock.advance(away);
      s.connect();
      assert.deepEqual(s.sentOps(), [], "not sent again while it settles");
      const [ask] = s.asks();
      assert.deepEqual(ask?.ids, [id]);
      assert.deepEqual(heard.heard, [], "told nothing yet");
      s.room.receiveIds({ t: "ids", k: ask!.k, held: [id], notHeld: [], pending: [] });
      assert.deepEqual(heard.heard, [{ answer: "unknown", unknown: "snapshot" }]);
      s.outbox.sent = [];
      s.clock.advance(IDS_SETTLE_MS);
      assert.deepEqual(s.outbox.sent, [], "nothing more goes");
      assert.equal(Object.keys(s.server.state.tokens).length, 1, "one token");
    }
  });

  test("one the room never recorded goes again under a fresh id, after what was queued, and lands", () => {
    const s = setup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.outbox.sent = [];
    s.room.suspend();
    s.clock.advance(40 * MINUTE);
    // Refused, its refusal lost with the socket: the watermark covers it.
    s.connect(1);
    const [ask] = s.asks();
    assert.deepEqual(ask?.ids, [id]);
    s.outbox.sent = [];
    s.room.receiveIds({ t: "ids", k: ask!.k, held: [], notHeld: [id], pending: [] });
    const [again] = s.sentOps();
    assert.equal(again?.n, 2);
    const fresh = (again!.op as Extract<ClientOp, { t: "token.create" }>).token.id;
    assert.notEqual(fresh, id);
    assert.deepEqual(heard.remints, [new Map([[id, fresh]])]);
    s.deliver();
    assert.deepEqual(Object.keys(s.server.state.tokens), [fresh]);
    assert.deepEqual(heard.heard, [{ answer: "taken" }]);
  });

  test("while an id is pending the device asks again, and settles on the final answer", () => {
    const s = setup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.deliver(true);
    s.room.suspend();
    s.connect();
    const [first] = s.asks();
    s.outbox.sent = [];
    s.room.receiveIds({ t: "ids", k: first!.k, held: [], notHeld: [], pending: [id] });
    assert.deepEqual(s.asks(), [], "not at once");
    s.clock.advance(IDS_AGAIN_MS);
    const [second] = s.asks();
    assert.deepEqual(second?.ids, [id]);
    assert.notEqual(second!.k, first!.k);
    // An answer to an ask already answered changes nothing.
    s.room.receiveIds({ t: "ids", k: first!.k, held: [], notHeld: [id], pending: [] });
    assert.deepEqual(s.sentOps(), []);
    s.room.receiveIds({ t: "ids", k: second!.k, held: [id], notHeld: [], pending: [] });
    assert.deepEqual(heard.heard, [{ answer: "unknown", unknown: "snapshot" }]);
    assert.deepEqual(s.sentOps(), []);
  });

  test("with no final answer in 2 minutes it is unknown, as before, and never sent again", () => {
    const s = setup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.deliver(true);
    s.room.suspend();
    s.connect();
    s.clock.advance(IDS_SETTLE_MS);
    assert.deepEqual(heard.heard, [{ answer: "unknown", unknown: "snapshot" }]);
    s.outbox.sent = [];
    s.clock.advance(IDS_SETTLE_MS);
    assert.deepEqual(s.asks(), []);
    assert.deepEqual(s.sentOps(), []);
  });

  test("an op with no new things is settled by the snapshot at once, as before", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const heard = answers();
    s.room.dispatch({ t: "token.move", tokenId: "g1", x: 4, y: 4 }, heard.opts);
    s.deliver(true);
    s.room.suspend();
    s.connect();
    assert.deepEqual(s.asks(), []);
    assert.deepEqual(heard.heard, [{ answer: "unknown", unknown: "snapshot" }]);
  });
});

describe("a create refused for its ids' time goes once more (3.4)", () => {
  test("it waits unsent for the server's time, takes fresh ids, and a second refusal says so in the toast after Not saved.", () => {
    const s = setup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.room.dispatch({ t: "token.move", tokenId: id, x: 7, y: 7 });
    s.outbox.sent = [];
    refuse(s.room, 1, ID_TIME_REFUSED, s.state().seq);
    assert.equal(heard.heard.length, 0, "the first refusal is not told");
    assert.deepEqual(s.state().toasts, [], "nor shown");
    assert.ok(s.state().view?.tokens[id], "and the token stays in view");
    assert.ok(s.outbox.sent.some((m) => m.t === "time"), "the device reads the server's time");
    assert.deepEqual(s.sentOps(), [], "and sends nothing before it comes");
    s.room.dispatch({ t: "token.move", tokenId: id, x: 8, y: 8 });
    assert.deepEqual(s.sentOps(), [], "nor anything queued after it");
    s.room.receiveTime(T0 + 30_000);
    const [again, after] = s.sentOps();
    assert.equal(again?.n, 3);
    assert.equal(after?.n, 4);
    const fresh = (again!.op as Extract<ClientOp, { t: "token.create" }>).token.id;
    assert.notEqual(fresh, id);
    assert.ok(idTime(fresh)! >= T0 + 30_000, "dated by the new reading");
    assert.deepEqual(heard.remints, [new Map([[id, fresh]])]);
    assert.deepEqual(after!.op, { t: "token.move", tokenId: fresh, x: 8, y: 8 }, "the op queued after it names the fresh id");
    refuse(s.room, 3, ID_TIME_REFUSED, s.state().seq);
    assert.equal(heard.heard.length, 1);
    assert.equal(heard.heard[0]?.answer, "refused");
    assert.equal(heard.heard[0]?.refusal?.message, ID_RETRY_FAILED);
    assert.equal(heard.heard[0]?.refusal?.text, `Not saved. ${ID_RETRY_FAILED}`);
    assert.deepEqual(s.state().toasts.map((t) => t.text), [`Not saved. ${ID_RETRY_FAILED}`]);
  });

  test("without an answer to its time frame it goes anyway after the wait", () => {
    const s = setup(room());
    s.connect();
    s.room.dispatch(made(s.actions.newId()));
    s.outbox.sent = [];
    refuse(s.room, 1, ID_TIME_REFUSED, s.state().seq);
    s.clock.advance(CLOCK_WAIT_MS - 1);
    assert.deepEqual(s.sentOps(), []);
    s.clock.advance(1);
    assert.deepEqual(s.sentOps().map((m) => m.n), [2]);
  });

  test("a refusal kept ahead of a snapshot goes once more at once, the clock frame being the reading", () => {
    const s = setup(room());
    s.connect();
    const id = s.actions.newId();
    s.room.dispatch(made(id));
    s.outbox.sent = [];
    s.room.suspend();
    s.room.keepRefusals([{ n: 1, code: "invalid", message: ID_TIME_REFUSED }]);
    s.connect(1);
    const [again] = s.sentOps();
    assert.equal(again?.n, 2);
    assert.notEqual((again!.op as Extract<ClientOp, { t: "token.create" }>).token.id, id);
    assert.deepEqual(s.asks(), [], "a refusal that came is not asked about");
  });

  test("any other refusal of a create is told as it stands", () => {
    const s = setup(room());
    s.connect();
    const heard = answers();
    s.room.dispatch(made(s.actions.newId()), heard.opts);
    s.outbox.sent = [];
    s.room.applyEv({ t: "ev", seq: s.state().seq, changes: [], rejects: [{ n: 1, code: "quota", message: "You can have 33 tokens of your own on this map. Remove a companion first." }] });
    assert.equal(heard.heard[0]?.answer, "refused");
    assert.deepEqual(s.sentOps(), []);
    assert.deepEqual(s.state().toasts.map((t) => t.text), ["Not saved. You can have 33 tokens of your own on this map. Remove a companion first."]);
  });
});

describe("the automatic Unconscious, hidden or edited, goes on under a fresh id (6.1)", () => {
  test("an edit of it carries a new id dated by the room's clock, and an edit of any other condition carries none", () => {
    const effects = [{ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" as const }, { id: "bless-1", key: "blessed" as const }];
    const s = setup(room({ tokens: { g1: token("g1", { actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, effects }) } }) } }));
    s.connect();
    s.room.dispatch({ t: "actor.effect.update", target: { tokenId: "g1" }, effectId: ZERO_HP_UNCONSCIOUS_ID, patch: { hiddenFromPlayers: true } });
    s.room.dispatch({ t: "actor.effect.update", target: { tokenId: "g1" }, effectId: "bless-1", patch: { hiddenFromPlayers: true } });
    const [edit, other] = s.sentOps().map((m) => m.op as Extract<ClientOp, { t: "actor.effect.update" }>);
    assert.equal(idTime(edit!.as ?? ""), T0);
    assert.equal(other!.as, undefined);
  });
});
