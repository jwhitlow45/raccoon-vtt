import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import { ID_TIME_REFUSED, idKeyOf, idKeyText, idTime, sealedId, sealedTime, uuidv7 } from "#shared/ids.ts";
import { ID_RETRY_FAILED, ID_TIME } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { ClientMessage, ClientOp, ServerMessage } from "#shared/protocol.ts";
import { actor, character, DM, room, token } from "#shared/testutil.ts";
import { hash12 } from "#shared/rules/pcSync.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomActions } from "./actions.ts";
import { CLOCK_WAIT_MS, createRoomStore, IDS_AGAIN_MS, IDS_SETTLE_MS, type RoomStore } from "./store.ts";
import { sentIdDead, unsentIdStale } from "./ids.ts";
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

// ------------------------------------------------------------ a page with an id key (shared/ids.ts sealedId)

const keyBytes = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());
const KEY = idKeyOf(keyBytes("member key"));
const KEY_TEXT = idKeyText(keyBytes("member key"));
const NEW_KEY = idKeyOf(keyBytes("member key after a new secret"));
const NEW_KEY_TEXT = idKeyText(keyBytes("member key after a new secret"));
/** A snapshot as the room sends a page that asked for its key. */
const withKey = (text = KEY_TEXT) => (snap: Snapshot): Snapshot => ({ ...snap, you: { ...snap.you, idKey: text } });
const v7 = (aheadMs = 0) => uuidv7(T0 + aheadMs);

function keyedSetup(state: RoomState, viewer: Viewer = DM) {
  const s = setup(state, viewer);
  const connect = (settled?: number, text = KEY_TEXT) => s.connect(settled, withKey(text));
  return { ...s, connect };
}

const tokenIdOf = (op: unknown) => (op as Extract<ClientOp, { t: "token.create" }>).token.id;
const roll = (id: string) => ({ id, name: "Longsword", kind: "weapon" as const, ability: "str" as const, dice: [{ formula: "1d8" }] });

describe("a page with an id key makes version 8 ids under it", () => {
  test("a new id is version 8 and reads under the page's key to the server's time as it is made", () => {
    const s = keyedSetup(room());
    s.connect();
    s.clock.jump(-40 * MINUTE);
    const id = s.actions.newId();
    assert.equal(idTime(id), null, "nothing in the clear");
    assert.equal(sealedTime(KEY, id), T0);
    assert.equal(s.room.ownIdTime(id), T0);
    s.clock.advance(1_500);
    assert.equal(sealedTime(KEY, s.actions.newId()), T0 + 1_500);
  });

  test("a clock read in fractions of a millisecond, as a browser's is, makes ids at the whole millisecond under it, new and made again", () => {
    const s = keyedSetup(room());
    s.connect();
    s.clock.advance(0.3);
    assert.equal(sealedTime(KEY, s.actions.newId()), T0);
    s.room.suspend();
    const offline = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(offline), heard.opts);
    s.clock.advance(40 * MINUTE + 0.4);
    s.connect();
    const fresh = tokenIdOf(s.sentOps()[0]!.op);
    assert.notEqual(fresh, offline);
    const at = sealedTime(KEY, fresh)!;
    assert.ok(Number.isInteger(at) && Math.abs(at - (T0 + 40 * MINUTE)) < 1_000, "made again by the server's clock, in whole milliseconds");
  });

  test("a create the room refuses for its id goes once more under a fresh sealed id, and lands", () => {
    const s = keyedSetup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.outbox.sent = [];
    refuse(s.room, 1, ID_TIME_REFUSED, s.state().seq);
    s.room.receiveTime(T0 + 30_000);
    const [again] = s.sentOps();
    const fresh = tokenIdOf(again!.op);
    assert.notEqual(fresh, id);
    assert.ok(sealedTime(KEY, fresh)! >= T0 + 30_000);
    assert.deepEqual(heard.remints, [new Map([[id, fresh]])]);
  });

  test("a create queued before the first key, and one made under a key since changed, go under ids sealed under the new key", () => {
    const s = keyedSetup(room());
    // Before any snapshot the page holds no key, so its ids are version 7, dated by the server's time it read.
    s.room.receiveClock(new Date(T0).toISOString());
    const early = s.actions.newId();
    assert.equal(idTime(early), T0, "in the window: only its version makes it stale");
    const heard = answers();
    s.room.dispatch(made(early), heard.opts);
    s.connect();
    const first = tokenIdOf(s.sentOps()[0]!.op);
    assert.notEqual(first, early);
    assert.equal(sealedTime(KEY, first) !== null, true);
    s.outbox.sent = [];
    // Offline under the first key, back under a new one: the unsent create's id reads nothing under it.
    s.room.suspend();
    const offline = s.actions.newId();
    s.room.dispatch(made(offline, 4), heard.opts);
    s.clock.advance(MINUTE);
    s.connect(1, NEW_KEY_TEXT);
    const sent = s.sentOps().map((m) => tokenIdOf(m.op));
    const second = sent.at(-1)!;
    assert.notEqual(second, offline);
    assert.ok(sealedTime(NEW_KEY, second) !== null, "sealed under the key of the latest snapshot");
    assert.deepEqual(heard.remints.map((m) => [...m.keys()]), [[early], [offline]]);
  });

  test("a committed create whose answer was lost is settled by the room's record of ids, under its sealed id", () => {
    const s = keyedSetup(room());
    s.connect();
    const id = s.actions.newId();
    const heard = answers();
    s.room.dispatch(made(id), heard.opts);
    s.deliver(true);
    s.room.suspend();
    s.connect();
    const [ask] = s.asks();
    assert.deepEqual(ask?.ids, [id]);
    s.room.receiveIds({ t: "ids", k: ask!.k, held: [id], notHeld: [], pending: [] });
    assert.deepEqual(heard.heard, [{ answer: "unknown", unknown: "snapshot" }]);
    assert.deepEqual(s.sentOps(), []);
  });
});

describe("what a keyed page makes again before an op leaves, by the op's new-id fields", () => {
  test("a character update from a draft made before the key: its new roll is resealed, its old rolls kept, and its sync record rekeyed", () => {
    const old = v7(-60 * MINUTE);
    const pending = v7(-30 * MINUTE);
    const c1 = { ...character("c1"), stats: { ...EMPTY_PC_STATS, rolls: [roll(old)] } };
    const s = keyedSetup(room({ characters: { c1 } }));
    s.connect();
    const heard = answers();
    const ddbSync = { from: "123", base: {}, rolls: { [hash12(old)]: { k: "w:aaaaaaaaaaaa", h: "111111111111" }, [hash12(pending)]: { k: "w:bbbbbbbbbbbb", h: "222222222222" } } };
    s.room.dispatch({ t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(old), roll(pending)] }, ddbSync } } as ClientOp, heard.opts);
    const sent = s.sentOps()[0]!.op as Extract<ClientOp, { t: "character.update" }>;
    const [kept, fresh] = sent.patch.stats!.rolls!.map((r) => r.id);
    assert.equal(kept, old, "a roll the character holds keeps its id");
    assert.notEqual(fresh, pending);
    assert.ok(sealedTime(KEY, fresh!) !== null);
    assert.deepEqual(Object.keys(sent.patch.ddbSync!.rolls ?? {}).sort(), [hash12(old), hash12(fresh!)].sort(), "the record names the new id");
    assert.deepEqual(sent.patch.ddbSync!.rolls![hash12(fresh!)], { k: "w:bbbbbbbbbbbb", h: "222222222222" });
    assert.deepEqual(heard.remints, [new Map([[pending, fresh!]])]);
  });

  test("a roll the confirmed character holds is never made again, though a pending update took it out of the view", () => {
    const old = v7(-60 * MINUTE);
    const c1 = { ...character("c1"), stats: { ...EMPTY_PC_STATS, rolls: [roll(old)] } };
    const s = keyedSetup(room({ characters: { c1 } }));
    s.connect();
    s.room.suspend();
    s.room.dispatch({ t: "character.update", characterId: "c1", patch: { stats: { rolls: [] } } } as ClientOp);
    s.room.dispatch({ t: "character.update", characterId: "c1", patch: { stats: { rolls: [roll(old)] } } } as ClientOp);
    assert.equal(s.state().view?.characters.c1?.stats?.rolls.length, 1);
    const sent = s.state().pending[1]!.op as Extract<ClientOp, { t: "character.update" }>;
    assert.equal(sent.patch.stats!.rolls![0]!.id, old);
  });

  test("plan and page ids, dice tags, and a target the DM's view lacks are never touched, and a group save's version 7 conditions are resealed", () => {
    const s = keyedSetup(room({ tokens: { g1: token("g1", { actor: { inline: actor() } }) } }));
    s.connect();
    const plan = v7(-5 * 60 * MINUTE);
    const page = v7(-5 * 60 * MINUTE + 1);
    const condition = v7(-5 * 60 * MINUTE + 2);
    const heard = answers();
    s.room.dispatch({ t: "actor.outcome", plan, page: { id: page, expectRevision: 0 }, label: "Hold Person", targets: [{ target: { tokenId: "g1" }, effects: [{ id: condition, key: "paralyzed" }] }] } as ClientOp, heard.opts);
    const tag = v7(-1_000);
    s.room.dispatch({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as ClientOp);
    // A token on the players' scene the DM's view of another scene lacks, named as a target.
    const elsewhere = v7(-2 * 60 * MINUTE);
    const effect = s.actions.newId();
    s.room.dispatch({ t: "actor.effect.add", target: { tokenId: elsewhere }, effect: { id: effect, key: "blessed" } } as ClientOp);
    const [outcome, dice, add] = s.sentOps().map((m) => m.op);
    const sentOutcome = outcome as Extract<ClientOp, { t: "actor.outcome" }>;
    assert.equal(sentOutcome.plan, plan);
    assert.equal(sentOutcome.page?.id, page);
    const resealed = sentOutcome.targets[0]!.effects![0]!.id;
    assert.notEqual(resealed, condition);
    assert.ok(sealedTime(KEY, resealed) !== null);
    assert.deepEqual(heard.remints, [new Map([[condition, resealed]])]);
    assert.equal((dice as Extract<ClientOp, { t: "dice.roll" }>).tag, tag);
    assert.deepEqual(add, { t: "actor.effect.add", target: { tokenId: elsewhere }, effect: { id: effect, key: "blessed" } });
  });

  test("edits and removals of a pin, stamp, light, label and journal page held under version 7 ids go as they are", () => {
    const old = v7(-2 * 60 * MINUTE);
    const s = keyedSetup(room());
    s.connect();
    const ops = [
      { t: "pin.put", pin: { id: old, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all" } },
      { t: "build.stamps", sceneId: "s1", put: [{ id: old, art: { key: "barrel" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }], forget: true },
      { t: "build.lights", sceneId: "s1", put: [{ id: old, x: 1, y: 1, bright: 10, dim: 10, on: true, walls: true }] },
      { t: "build.label", sceneId: "s1", labelId: old, label: { x: 1, y: 1, text: "Old", size: 1 }, forget: true },
      { t: "journal.update", pageId: old, patch: { title: "Renamed" } },
      { t: "pin.remove", pinId: old },
    ] as ClientOp[];
    for (const op of ops) s.room.dispatch(op);
    assert.deepEqual(s.sentOps().map((m) => m.op), ops, "nothing made again");
  });
});

describe("a keyed page's one retry after the room names new ids", () => {
  test("a refusal naming a new pin's version 7 id is retried once with exactly that id resealed, and a second refusal is told", () => {
    const s = keyedSetup(room());
    s.connect();
    const fresh = v7();
    const heard = answers();
    s.room.dispatch({ t: "pin.put", pin: { id: fresh, sceneId: "s1", x: 1, y: 1, color: "#ff0000", visibility: "all" } } as ClientOp, heard.opts);
    s.outbox.sent = [];
    s.room.applyEv({ t: "ev", seq: s.state().seq, changes: [], rejects: [{ n: 1, code: "invalid", message: ID_TIME_REFUSED, ids: [fresh] }] });
    assert.deepEqual(heard.heard, [], "the first refusal is not told");
    // A move of the pin queued behind its retry, as the page still shows it.
    s.room.dispatch({ t: "pin.put", pin: { id: fresh, sceneId: "s1", x: 2, y: 2, color: "#ff0000", visibility: "all" } } as ClientOp);
    s.room.receiveTime(T0 + 5_000);
    const [again, moved] = s.sentOps();
    const resealed = (again!.op as Extract<ClientOp, { t: "pin.put" }>).pin.id;
    assert.notEqual(resealed, fresh);
    assert.ok(sealedTime(KEY, resealed) !== null);
    assert.equal((moved!.op as Extract<ClientOp, { t: "pin.put" }>).pin.id, resealed, "the op after it names the new id");
    assert.deepEqual(heard.remints, [new Map([[fresh, resealed]])]);
    s.room.applyEv({ t: "ev", seq: s.state().seq, changes: [], rejects: [{ n: again!.n, code: "invalid", message: ID_TIME_REFUSED, ids: [resealed] }] });
    const told: { refusal?: OpRefusal }[] = heard.heard;
    assert.equal(told[0]?.refusal?.message, ID_RETRY_FAILED);
  });

  test("a build that adds one stamp and replaces an old one, refused naming the new one in the refusals ahead of a snapshot, retries with only it resealed", () => {
    const old = v7(-2 * 60 * MINUTE);
    const fresh = v7();
    const s = keyedSetup(room());
    s.connect();
    const stamp = (id: string, x: number) => ({ id, art: { key: "barrel" }, x, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });
    s.room.dispatch({ t: "build.stamps", sceneId: "s1", put: [stamp(old, 4), stamp(fresh, 6)], forget: true } as ClientOp);
    assert.deepEqual((s.sentOps()[0]!.op as Extract<ClientOp, { t: "build.stamps" }>).put!.map((p) => p.id), [old, fresh], "keys go as they are at first");
    s.outbox.sent = [];
    s.room.suspend();
    s.room.keepRefusals([{ n: 1, code: "invalid", message: ID_TIME_REFUSED, ids: [fresh] }]);
    s.connect(1);
    const [again] = s.sentOps();
    const ids = (again!.op as Extract<ClientOp, { t: "build.stamps" }>).put!.map((p) => p.id);
    assert.equal(ids[0], old, "the old stamp keeps its id");
    assert.notEqual(ids[1], fresh);
    assert.ok(sealedTime(KEY, ids[1]!) !== null);
    s.deliver();
    assert.deepEqual(Object.keys(s.server.state.stamps).sort(), [old, ids[1]!].sort(), "two stamps, the old one replaced in place");
  });
});

describe("the store's test hook on ids newId made", () => {
  test("a token made, then moved and deleted, queued and after send, passes: only its first op is read", () => {
    const problems: string[] = [];
    const s = hooked(problems);
    s.room.suspend();
    const id = s.actions.newId();
    s.room.dispatch(made(id));
    s.room.dispatch({ t: "token.move", tokenId: id, x: 5, y: 5 });
    s.connect();
    s.room.dispatch({ t: "token.delete", tokenId: id });
    assert.deepEqual(problems, []);
  });

  test("an id newId made brought first in a field of no new thing is reported", () => {
    const problems: string[] = [];
    const s = hooked(problems);
    s.room.dispatch({ t: "token.move", tokenId: s.actions.newId(), x: 5, y: 5 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^token\.move first brings/);
  });

  test("a roll tag and a group save's plan made by newId are fields it allows", () => {
    const problems: string[] = [];
    const s = hooked(problems, room({ tokens: { g1: token("g1", { actor: { inline: actor() } }) } }));
    s.room.dispatch({ t: "dice.roll", tag: s.actions.newId(), to: "all", rolls: [{ formula: "1d20" }] } as ClientOp);
    s.room.dispatch({ t: "actor.outcome", plan: s.actions.newId(), label: "Hold Person", targets: [{ target: { tokenId: "g1" }, effects: [{ id: s.actions.newId(), key: "paralyzed" }] }] } as ClientOp);
    assert.deepEqual(problems, []);
  });
});

function hooked(problems: string[], state: RoomState = room()) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1", newIdCheck: (p) => problems.push(p) });
  store.setOutbox(outbox);
  const actions = createRoomActions(store, { sendEph() {}, switchScene() {} });
  const connect = () => {
    store.receiveClock(new Date(T0 + clock.elapsed()).toISOString());
    const hello = store.prepareHello();
    store.setConnection("open");
    const snap = server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" });
    store.applySnapshot(withKey()(snap));
    applyTestHistory(store, snap.watermark);
  };
  connect();
  return { room: store, actions, connect };
}

/**
 * A chance tag match on the page's readers (C13, design 4.2): an id sealed
 * under another key whose tag the page's key matches, from a seeded search,
 * reads to a time uniform over 48 bits. An unsent op's id is then stale and
 * made again, and a sent one is dead exactly when the server, reading the
 * same time, can never take it.
 */
describe("a chance tag match on the page's readers (C13)", () => {
  const own = idKeyOf(createHash("sha256").update("page").digest());
  const other = idKeyOf(createHash("sha256").update("another member").digest());
  function chance(): { id: string; read: number } {
    for (let i = 0; ; i++) {
      const n = createHash("sha256").update(`page chance ${i}`).digest().subarray(0, 8);
      n[0]! &= 0x0f;
      const id = sealedId(other, T0, new Uint8Array(n));
      const read = sealedTime(own, id);
      if (read !== null) return { id, read };
    }
  }

  test("unsentIdStale reads the chance time as stale, and sentIdDead answers as the server reads the same time", () => {
    const { id, read } = chance();
    assert.ok(Math.abs(read - T0) > 31 * MINUTE);
    assert.equal(unsentIdStale(id, T0, own), true, "stale, so made again before it goes");
    assert.equal(sentIdDead(id, T0, own), read < T0 - ID_TIME.behindMs - 5_000, "dead only when the time read is past the window");
    assert.equal(unsentIdStale(sealedId(own, T0), T0, own), false, "the page's own id made now goes as it is");
  });
});
