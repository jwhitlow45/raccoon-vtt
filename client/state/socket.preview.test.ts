import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientMessage, ServerMessage } from "#shared/protocol.ts";
import { DM, P1, P2, rng, room, token } from "#shared/testutil.ts";
import { CLOSE_DENIED, createRoomSocket, OPEN_TIMEOUT_MS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, previewSocketUrl, SNAPSHOT_DEADLINE_MS, type SocketLike } from "./socket.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock } from "./testing.ts";

/**
 * View as a player's socket (docs/design-v1-per-player-vision.md 7.4,
 * security rule 8), against a stubbed server: read only, refusing any view
 * but the player's, and ending on any close before its first snapshot so
 * the preview can say it could not load.
 */

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: ClientMessage[] = [];
  closedWith: number | null = null;
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: ServerMessage): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const STATE = room({ tokens: { g1: token("g1") } });

function setup(previewOf = "p1") {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const store = createRoomStore({ roomId: "R1", you: { memberId: previewOf, role: "player" }, clock, random: () => 0.5, clientId: "preview" });
  const socket = createRoomSocket({
    url: previewSocketUrl("R1", previewOf, { protocol: "https:", host: "vtt.example" }),
    room: store,
    clock,
    random: () => 0.5,
    previewOf,
    createSocket: (url) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    frame: (cb) => cb(),
  });
  const snapshot = (you: Viewer): ServerMessage => ({ t: "snapshot", seq: 0, state: projectState(STATE, you, { sceneId: "s1" }), you: { ...you, sceneId: "s1" }, watermark: 0 });
  const last = () => sockets.at(-1)!;
  return { clock, sockets, urls, store, socket, snapshot, last, state: () => store.store.getState() };
}

describe("view as a player's socket (7.4)", () => {
  test("asks `as` the player, on the room's socket", () => {
    assert.equal(previewSocketUrl("K7QH2MXA", "m 1", { protocol: "https:", host: "vtt.example" }), "wss://vtt.example/ws?room=K7QH2MXA&as=m%201");
    const s = setup();
    s.socket.start();
    assert.deepEqual(s.urls, ["wss://vtt.example/ws?room=R1&as=p1"]);
  });

  test("is read only: its hello names no scene, and no op, ephemeral event or scene ever leaves it", () => {
    const s = setup();
    s.socket.start();
    s.last().open();
    assert.deepEqual(s.last().sent.map((m) => m.t), ["hello"]);
    assert.equal("sceneId" in s.last().sent[0]!, false);
    s.last().emit(s.snapshot(P1));
    assert.equal(s.state().connection, "open");
    s.store.dispatch({ t: "token.move", tokenId: "g1", x: 3, y: 3 });
    s.socket.sendEph({ k: "ping", x: 1, y: 1 });
    s.socket.switchScene("s2");
    s.clock.advance(PING_INTERVAL_MS);
    assert.deepEqual(s.last().sent.map((m) => m.t), ["hello", "ping"]);
  });

  test("refuses a snapshot for anyone but the player, unread, and ends: a server that ignores `as` never shows the DM's view as theirs", () => {
    for (const you of [DM, P2, { memberId: "p1", role: "dm" as const }]) {
      const s = setup();
      s.socket.start();
      s.last().open();
      s.last().emit(s.snapshot(you));
      assert.equal(s.state().view, null, `${you.memberId} as ${you.role}`);
      assert.deepEqual(s.state().ended, { kind: "denied", code: CLOSE_DENIED });
      assert.notEqual(s.last().closedWith, null);
      s.clock.advance(60_000);
      assert.equal(s.sockets.length, 1, "no retry");
    }
  });

  test("a close, a socket that never opens and a snapshot that never comes each end it before its first view, with no retry", () => {
    const closed = setup();
    closed.socket.start();
    closed.last().open();
    closed.last().drop(1006);
    assert.deepEqual(closed.state().ended, { kind: "denied", code: 1006 }, "a drop any room would retry");
    const never = setup();
    never.socket.start();
    never.clock.advance(OPEN_TIMEOUT_MS);
    assert.equal(never.state().ended?.kind, "denied");
    const late = setup();
    late.socket.start();
    late.last().open();
    late.clock.advance(SNAPSHOT_DEADLINE_MS);
    assert.equal(late.state().ended?.kind, "denied");
    for (const s of [closed, never, late]) {
      s.clock.advance(60_000);
      assert.equal(s.sockets.length, 1);
    }
  });

  test("reports a slow load only for the server's named wait: a refused scene request's retry finds none in flight (review FU36-OPUS-5)", () => {
    const s = setup();
    const slow: string[] = [];
    const trackScene = s.store.trackScene;
    s.store.trackScene = (e) => {
      slow.push(e.t);
      trackScene(e);
    };
    s.socket.start();
    s.last().open();
    s.socket.switchScene("s2");
    s.last().emit({ t: "retry", code: "busy" });
    assert.deepEqual(slow, [], "no scene request left it, so no retry is its own");
    s.last().emit({ t: "wait", ms: 20_000 });
    assert.deepEqual(slow, ["slow"]);
  });

  test("once it has the player's view, a dropped socket comes back as any room's does", () => {
    const s = setup();
    s.socket.start();
    s.last().open();
    s.last().emit(s.snapshot(P1));
    s.last().drop(1006);
    assert.equal(s.state().ended, null);
    s.clock.advance(1_000);
    assert.equal(s.sockets.length, 2);
    s.last().open();
    assert.deepEqual(s.last().sent.map((m) => m.t), ["hello"]);
  });
});

/*
 * Many random sequences of what the server and the clock can do to a
 * preview socket: opens, snapshots for the player and for others, waits,
 * resyncs, closes with any code, pongs that never come, and time. What
 * must hold after every step:
 * - read only: nothing but `hello` and `ping` ever leaves it,
 * - the player's view only: the store holds a view only from a snapshot
 *   for this player as a player,
 * - it ends on any close or give-up before its first view, and once ended
 *   it makes no socket and sends nothing more.
 */
describe("a preview socket under random sequences", () => {
  test("its invariants hold after every step", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const s = setup();
      s.socket.start();
      let everViewed = false;
      let endedAt: number | null = null;
      for (let step = 0; step < 40; step++) {
        const sock = s.last();
        const roll = r();
        if (roll < 0.2) sock.readyState === 0 && sock.open();
        else if (roll < 0.35) sock.emit(s.snapshot(r() < 0.6 ? P1 : r() < 0.5 ? DM : P2));
        else if (roll < 0.45) sock.emit({ t: "wait", ms: 1_000 });
        else if (roll < 0.5) sock.emit({ t: "resync", reason: "scene" });
        else if (roll < 0.6) sock.drop([1006, 1012, 4001, 4003, 4009, 4010, 4011][Math.floor(r() * 7)]!);
        else if (roll < 0.7) s.store.dispatch({ t: "token.move", tokenId: "g1", x: Math.floor(r() * 10), y: 0 });
        else if (roll < 0.75) s.socket.sendEph({ k: "ping", x: 1, y: 1 });
        else s.clock.advance([100, 1_000, PONG_TIMEOUT_MS, PING_INTERVAL_MS, SNAPSHOT_DEADLINE_MS][Math.floor(r() * 5)]!);

        const at = `seed ${seed} step ${step}`;
        for (const k of s.sockets) for (const m of k.sent) assert.ok(m.t === "hello" || m.t === "ping", `${at}: read only, sent ${m.t}`);
        const now = s.state();
        if (now.view !== null) {
          assert.deepEqual(now.you, { memberId: "p1", role: "player" }, `${at}: only the player's view`);
          everViewed = true;
        }
        if (now.ended !== null && endedAt === null) endedAt = s.sockets.length;
        if (endedAt !== null) assert.equal(s.sockets.length, endedAt, `${at}: no socket once ended`);
        if (!everViewed && s.sockets.length > 1) assert.fail(`${at}: retried before its first view`);
      }
      s.socket.dispose();
    }
  });
});

test("View as ignores history even if a DM summary arrives on its socket", () => {
  const s = setup();
  s.socket.start();
  s.last().open();
  s.last().emit(s.snapshot(P1));
  const stack = { head: { id: "00000000-0000-4000-8000-000000000001", label: "private DM step" }, depth: 1 };
  s.last().onmessage?.({ data: JSON.stringify({ t: "history", epoch: "00000000-0000-4000-8000-000000000002", seq: 0, serial: 0, watermark: 0, play: { undo: stack, redo: stack }, setup: { undo: stack, redo: stack } }) });
  assert.equal(s.state().history?.summary, null);
  s.socket.dispose();
  s.store.dispose();
});
