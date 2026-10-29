import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FrameBudget } from "#server/rooms/budgets.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientMessage, ClientOp, ServerMessage } from "#shared/protocol.ts";
import { DM, P1, rng, room, token } from "#shared/testutil.ts";
import {
  createRoomSocket,
  EPH_PER_SECOND,
  OPEN_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  roomSocketUrl,
  SCENE_RETRY_MS,
  SEND_BYTES_BURST,
  SEND_BYTES_PER_SEC,
  SNAPSHOT_DEADLINE_MS,
  STALE_SNAPSHOT_MS,
  UNLOADED_WAIT_MS,
  type ConnectionEnv,
  type SocketLike,
} from "./socket.ts";
import { createRoomStore, OP_ANSWER_MS } from "./store.ts";
import { FakeClock } from "./testing.ts";
import { backoffDelay, BACKOFF_CAP_MS } from "./timing.ts";
import type { You } from "./types.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: ClientMessage[] = [];
  closedWith: number | null = null;
  /** Hears each frame as the server would, raw. */
  onSend: ((data: string) => void) | null = null;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.onSend?.(data);
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  // Server side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  take(t?: ClientMessage["t"]): ClientMessage[] {
    const out = t ? this.sent.filter((m) => m.t === t) : this.sent;
    this.sent = t ? this.sent.filter((m) => m.t !== t) : [];
    return out;
  }
}

class FakeEnv implements ConnectionEnv {
  online = true;
  handlers: { wake(): void; online(): void; offline(): void } | null = null;
  isOnline(): boolean {
    return this.online;
  }
  subscribe(handlers: { wake(): void; online(): void; offline(): void }): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }
}

function setup(opts: { viewer?: Viewer; state?: RoomState; random?: number; recheck?: () => Promise<You | null>; ephPerSecond?: () => number } = {}) {
  const viewer = opts.viewer ?? DM;
  const state = opts.state ?? room({ tokens: { g1: token("g1") } });
  const clock = new FakeClock();
  const env = new FakeEnv();
  const sockets: FakeSocket[] = [];
  const frames: (() => void)[] = [];
  const room_ = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => opts.random ?? 0.5, clientId: "c1" });
  const socket = createRoomSocket({
    url: "ws://test/ws?room=R1",
    room: room_,
    clock,
    random: () => opts.random ?? 0.5,
    env,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    frame: (cb) => frames.push(cb),
    ...(opts.recheck ? { recheck: opts.recheck } : {}),
    ...(opts.ephPerSecond ? { ephPerSecond: opts.ephPerSecond } : {}),
  });
  const last = () => sockets.at(-1)!;
  const snapshot = (sceneId = "s1", watermark = 0): ServerMessage => ({
    t: "snapshot",
    seq: 0,
    state: projectState(state, viewer, { sceneId }),
    you: { ...viewer, sceneId },
    watermark,
  });
  /** Opens the newest socket and answers its hello with a snapshot. */
  const connect = (sceneId = "s1") => {
    last().open();
    last().take("hello");
    last().emit(snapshot(sceneId));
  };
  const runFrames = () => {
    const due = frames.splice(0);
    for (const f of due) f();
  };
  return { clock, env, sockets, last, socket, room: room_, snapshot, connect, runFrames, conn: () => room_.store.getState().connection };
}

describe("backoff", () => {
  test("250 ms doubling to a 5 s cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 12].map((a) => backoffDelay(a, () => 0.5));
    assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  test("jitter stays within plus or minus 30%", () => {
    assert.equal(backoffDelay(0, () => 0), 175);
    assert.equal(backoffDelay(0, () => 0.999999), 325);
    assert.equal(backoffDelay(10, () => 0), BACKOFF_CAP_MS * 0.7);
    assert.equal(backoffDelay(10, () => 0.999999), BACKOFF_CAP_MS * 1.3);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(3, Math.random);
      assert.ok(d >= 1400 && d <= 2600, `${d}`);
    }
  });

  test("failed attempts back off in sequence, and a snapshot resets it", () => {
    const s = setup();
    s.socket.start();
    const at: number[] = [];
    for (let i = 0; i < 7; i++) {
      at.push(s.clock.now());
      s.last().drop(1006);
      s.clock.advance(10_000);
    }
    assert.equal(s.sockets.length, 8);
    assert.equal(s.socket.debug.attempt, 7);
    s.connect();
    assert.equal(s.socket.debug.attempt, 0);
    s.last().drop(1006);
    const before = s.sockets.length;
    s.clock.advance(249);
    assert.equal(s.sockets.length, before);
    s.clock.advance(1);
    assert.equal(s.sockets.length, before + 1);
  });

  test("the URL follows the page's scheme", () => {
    assert.equal(roomSocketUrl("K7QH2MXA", { protocol: "https:", host: "vtt.example" }), "wss://vtt.example/ws?room=K7QH2MXA");
    assert.equal(roomSocketUrl("K7QH2MXA", { protocol: "http:", host: "localhost:5173" }), "ws://localhost:5173/ws?room=K7QH2MXA");
  });
});

describe("states", () => {
  test("open only after the snapshot, with hello always carrying resumeFrom", () => {
    const s = setup();
    s.socket.start();
    assert.equal(s.conn(), "connecting");
    s.last().open();
    const [hello] = s.last().take("hello");
    assert.deepEqual(hello, { t: "hello", clientId: "c1", resumeFrom: 1 });
    assert.equal(s.conn(), "connecting", "an open socket without its snapshot is not connected");
    s.last().emit(s.snapshot());
    assert.equal(s.conn(), "open");
    s.last().drop(1006);
    assert.equal(s.conn(), "reconnecting");
  });

  test("offline when the browser says so, and back on the online event at once", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.env.online = false;
    s.last().drop(1006);
    assert.equal(s.conn(), "offline");
    s.clock.advance(100);
    const count = s.sockets.length;
    s.env.online = true;
    s.env.handlers?.online();
    assert.equal(s.sockets.length, count + 1, "an immediate attempt");
    assert.equal(s.conn(), "reconnecting");
  });

  test("a socket that never opens is abandoned", () => {
    const s = setup();
    s.socket.start();
    s.clock.advance(OPEN_TIMEOUT_MS);
    assert.equal(s.sockets[0]!.closedWith, 4000);
    s.clock.advance(250);
    assert.equal(s.sockets.length, 2);
  });
});

describe("heartbeat", () => {
  test("a ping every 25 s, and no pong within 10 s closes and reconnects", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.clock.advance(PING_INTERVAL_MS - 1);
    assert.deepEqual(s.last().take("ping"), []);
    s.clock.advance(1);
    const [ping] = s.last().take("ping");
    assert.equal(ping?.t, "ping");
    s.last().emit({ t: "pong", k: ping?.t === "ping" ? ping.k : 0 });
    s.clock.advance(PING_INTERVAL_MS);
    assert.equal(s.last().take("ping").length, 1);
    const dead = s.last();
    s.clock.advance(PONG_TIMEOUT_MS - 1);
    assert.equal(dead.closedWith, null);
    s.clock.advance(1);
    assert.equal(dead.closedWith, 4000);
    assert.equal(s.conn(), "reconnecting");
    s.clock.advance(250);
    assert.equal(s.sockets.length, 2);
  });

  test("waking an open page probes the socket at once", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.env.handlers?.wake();
    assert.equal(s.last().take("ping").length, 1);
    s.clock.advance(PONG_TIMEOUT_MS);
    assert.equal(s.sockets[0]!.closedWith, 4000);
  });

  test("waking a page that waits on backoff connects now and resets the backoff", () => {
    const s = setup();
    s.socket.start();
    for (let i = 0; i < 4; i++) {
      s.last().drop(1006);
      s.clock.advance(5_000);
    }
    s.last().drop(1006);
    const count = s.sockets.length;
    s.env.handlers?.wake();
    assert.equal(s.sockets.length, count + 1);
    assert.equal(s.socket.debug.attempt, 0);
  });
});

describe("close codes", () => {
  test("4003 and 4009 end the room for good", () => {
    for (const [code, kind] of [
      [4003, "denied"],
      [4009, "deleted"],
    ] as const) {
      const s = setup();
      s.socket.start();
      s.connect();
      s.last().drop(code);
      s.clock.advance(120_000);
      s.env.handlers?.wake();
      assert.equal(s.sockets.length, 1, `${code}: never reconnects`);
      assert.deepEqual(s.room.store.getState().ended, { kind, code });
      assert.equal(s.conn(), "offline");
    }
  });

  test("4001 ends the room when GET /me finds no grant, and reconnects as the new role when it does", async () => {
    const gone = setup({ recheck: async () => null });
    gone.socket.start();
    gone.connect();
    gone.last().drop(4001);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(gone.room.store.getState().ended, { kind: "revoked", code: 4001 });

    const promoted = setup({ viewer: P1, recheck: async () => ({ memberId: "p1", role: "dm" }) });
    promoted.socket.start();
    promoted.connect();
    promoted.last().drop(4001);
    await Promise.resolve();
    await Promise.resolve();
    promoted.clock.advance(0);
    assert.equal(promoted.sockets.length, 2);
    assert.equal(promoted.room.store.getState().you?.role, "dm");
    assert.equal(promoted.room.store.getState().ended, null);

    const terminal = setup();
    terminal.socket.start();
    terminal.connect();
    terminal.last().drop(4001);
    assert.equal(terminal.room.store.getState().ended?.kind, "revoked", "without a recheck, 4001 is terminal at once");
  });

  test("1012 reconnects at once", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.last().drop(1012);
    s.clock.advance(0);
    assert.equal(s.sockets.length, 2);
  });

  test("4010 waits 30 s plus backoff, and waking the page does not cut it short", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.last().drop(4010);
    s.env.handlers?.wake();
    s.env.handlers?.online();
    s.clock.advance(UNLOADED_WAIT_MS + 249);
    assert.equal(s.sockets.length, 1);
    s.clock.advance(1);
    assert.equal(s.sockets.length, 2);
  });

  test("4011 backs off up to 60 s instead of 5 s", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    let delay = 0;
    for (let i = 0; i < 10; i++) {
      s.last().drop(4011);
      const start = s.clock.now();
      const count = s.sockets.length;
      while (s.sockets.length === count) s.clock.advance(250);
      delay = s.clock.now() - start;
    }
    assert.equal(delay, 60_000);
  });
});

describe("snapshot deadline", () => {
  test("no snapshot within 5 s of hello closes and reconnects with the same clientId", () => {
    const s = setup();
    s.socket.start();
    s.last().open();
    s.clock.advance(SNAPSHOT_DEADLINE_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.clock.advance(1);
    assert.equal(s.sockets[0]!.closedWith, 4000);
    s.clock.advance(250);
    s.last().open();
    const [hello] = s.last().take("hello");
    assert.equal(hello?.t === "hello" ? hello.clientId : null, "c1");
  });

  test("each wait moves the deadline to ms plus 5 s from its arrival", () => {
    const s = setup();
    s.socket.start();
    s.last().open();
    s.clock.advance(3_000);
    s.last().emit({ t: "wait", ms: 8_000 });
    s.clock.advance(8_000 + SNAPSHOT_DEADLINE_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.last().emit({ t: "wait", ms: 2_000 });
    s.clock.advance(2_000 + SNAPSHOT_DEADLINE_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.last().emit(s.snapshot());
    s.clock.advance(SNAPSHOT_DEADLINE_MS * 2);
    assert.equal(s.sockets.length, 1);
    assert.equal(s.conn(), "open");
  });

  test("a scene switch is covered from scene to snapshot, and a slow one shows as reconnecting after 3 s", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    assert.deepEqual(s.last().take("scene"), [{ t: "scene", sceneId: "s2" }]);
    s.clock.advance(1_000);
    s.last().emit({ t: "resync", reason: "scene" });
    const [hello] = s.last().take("hello");
    assert.equal(hello?.t === "hello" ? hello.sceneId : null, "s2");
    assert.equal(s.conn(), "open", "a scene switch does not flash the dot");
    s.clock.advance(STALE_SNAPSHOT_MS - 1);
    assert.equal(s.conn(), "open");
    s.clock.advance(1);
    assert.equal(s.conn(), "reconnecting");
    s.clock.advance(SNAPSHOT_DEADLINE_MS - 1_000 - STALE_SNAPSHOT_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.clock.advance(1);
    assert.equal(s.sockets[0]!.closedWith, 4000, "the deadline started when the scene was sent");
    s.clock.advance(250);
    s.last().open();
    const [again] = s.last().take("hello");
    assert.equal(again?.t === "hello" ? again.sceneId : null, "s2", "the reconnect asks for the scene the DM wants");
  });
});

describe("scene switching", () => {
  test("one scene in flight, and the latest pick wins", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.socket.switchScene("s3");
    s.socket.switchScene("s4");
    assert.deepEqual(s.last().take("scene"), [{ t: "scene", sceneId: "s2" }]);
    s.last().emit({ t: "resync", reason: "scene" });
    const [hello] = s.last().take("hello");
    assert.equal(hello?.t === "hello" ? hello.sceneId : null, "s4", "the hello carries the latest pick");
    s.last().emit(s.snapshot("s4"));
    assert.deepEqual(s.last().take("scene"), []);
    assert.equal(s.room.store.getState().sceneId, "s4");
  });

  test("a pick made after the hello went out is sent once the snapshot lands", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.last().take("scene");
    s.last().emit({ t: "resync", reason: "scene" });
    s.last().take("hello");
    s.socket.switchScene("s1");
    s.last().emit(s.snapshot("s2"));
    assert.deepEqual(s.last().take("scene"), [{ t: "scene", sceneId: "s1" }]);
  });

  test("a scene retry leaves ops alone and resends the latest pick after 2 s", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.last().take("scene");
    s.last().emit({ t: "retry", code: "busy" });
    s.room.dispatch({ t: "token.move", tokenId: "g1", x: 5, y: 5 });
    assert.equal(s.last().take("op").length, 1, "ops keep flowing");
    s.socket.switchScene("s3");
    s.clock.advance(SCENE_RETRY_MS - 1);
    assert.deepEqual(s.last().take("scene"), []);
    s.clock.advance(1);
    assert.deepEqual(s.last().take("scene"), [{ t: "scene", sceneId: "s3" }]);
    // The deadline was stopped by the retry and restarted by this send.
    s.clock.advance(SNAPSHOT_DEADLINE_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.clock.advance(1);
    assert.equal(s.sockets[0]!.closedWith, 4000);
  });

  test("a scene retry with no scene in flight leaves the hello's deadline running", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.last().emit({ t: "resync", reason: "other" });
    s.last().take("hello");
    s.last().emit({ t: "retry", code: "busy" });
    s.clock.advance(SNAPSHOT_DEADLINE_MS - 1);
    assert.equal(s.last().closedWith, null);
    s.clock.advance(1);
    assert.equal(s.sockets[0]!.closedWith, 4000, "the snapshot deadline still fires");
  });

  test("players never send scene", () => {
    const s = setup({ viewer: P1 });
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    assert.deepEqual(s.last().take("scene"), []);
  });

  test("a resync for players sends a fresh hello and holds ops until the snapshot", () => {
    const s = setup({ viewer: P1 });
    s.socket.start();
    s.connect();
    s.last().emit({ t: "resync", reason: "scene" });
    const [hello] = s.last().take("hello");
    assert.equal(hello?.t === "hello" ? hello.sceneId : "none", undefined);
    s.room.dispatch({ t: "member.update", memberId: "p1", name: "Thorn" });
    assert.equal(s.last().take("op").length, 0);
    s.last().emit(s.snapshot());
    assert.equal(s.last().take("op").length, 1);
  });
});

describe("scene loading indicator", () => {
  const load = (s: ReturnType<typeof setup>) => s.room.store.getState().sceneLoad;
  const toasts = (s: ReturnType<typeof setup>) => s.room.store.getState().toasts.map((t) => t.text);

  test("a DM's pick starts it, a wait marks it slow, and the snapshot clears it", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    assert.deepEqual(load(s), { requested: "s2", slow: false });
    s.last().emit({ t: "resync", reason: "scene" });
    s.last().emit({ t: "wait", ms: 4_000 });
    assert.deepEqual(load(s), { requested: "s2", slow: true });
    s.last().emit(s.snapshot("s2"));
    assert.deepEqual(load(s), { requested: null, slow: false });
    assert.deepEqual(toasts(s), []);
  });

  test("picking the scene on screen starts nothing", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s1");
    assert.equal(load(s).requested, null);
  });

  test("the latest pick stays up while the earlier one lands", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.last().emit({ t: "resync", reason: "scene" });
    s.socket.switchScene("s1");
    assert.equal(load(s).requested, "s1");
    s.last().emit(s.snapshot("s2"));
    assert.equal(load(s).requested, "s1", "s1 was sent straight after");
    s.last().emit({ t: "resync", reason: "scene" });
    s.last().emit(s.snapshot("s1"));
    assert.equal(load(s).requested, null);
  });

  test("a refused scene shows as slow, and going back to the scene on screen ends it", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.last().emit({ t: "retry", code: "busy" });
    assert.deepEqual(load(s), { requested: "s2", slow: true });
    s.socket.switchScene("s1");
    s.clock.advance(SCENE_RETRY_MS);
    assert.deepEqual(s.last().take("scene"), [{ t: "scene", sceneId: "s2" }], "only the first pick went out");
    assert.equal(load(s).requested, null);
  });

  test("a timeout clears it and says so, and the reconnect that asks again shows it again", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.clock.advance(SNAPSHOT_DEADLINE_MS);
    assert.equal(load(s).requested, null);
    assert.deepEqual(toasts(s), ["s2 did not load in time. Reconnecting to try again."]);
    s.clock.advance(250);
    s.last().open();
    assert.equal(load(s).requested, "s2");
    s.last().emit(s.snapshot("s2"));
    assert.equal(load(s).requested, null);
  });

  test("a snapshot of another scene, when the one asked for is gone, says it could not be opened", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    s.last().emit({ t: "resync", reason: "scene" });
    s.last().emit(s.snapshot("s1"));
    assert.equal(load(s).requested, null);
    assert.deepEqual(toasts(s), ["s2 could not be opened. It may have been deleted."]);
  });

  test("a reconnect for the scene on screen starts nothing", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.last().drop(1006);
    s.clock.advance(250);
    s.last().open();
    assert.equal(load(s).requested, null);
  });

  test("players never request a scene: their moves come in an ev, and only the map is waited on", () => {
    const s = setup({ viewer: P1 });
    s.socket.start();
    s.connect();
    s.socket.switchScene("s2");
    assert.equal(load(s).requested, null);
  });
});

describe("ephemeral sending", () => {
  test("frames coalesce to one per animation frame, latest wins per preview, ends are never lost", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.sendEph({ k: "dragStart", tokenId: "g1", x: 3, y: 3 });
    s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 3.2, y: 3 });
    s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 3.4, y: 3 });
    s.socket.sendEph({ k: "ping", x: 1, y: 1 });
    s.socket.sendEph({ k: "ping", x: 2, y: 2 });
    s.runFrames();
    assert.deepEqual(
      s.last().take("eph").map((m) => (m.t === "eph" ? m.e : null)),
      [
        { k: "dragMove", tokenId: "g1", x: 3.4, y: 3 },
        { k: "ping", x: 1, y: 1 },
        { k: "ping", x: 2, y: 2 },
      ],
    );
    s.clock.advance(40);
    s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 5, y: 3 });
    s.socket.sendEph({ k: "dragEnd", tokenId: "g1", x: 5, y: 3 });
    s.runFrames();
    assert.deepEqual(
      s.last().take("eph").map((m) => (m.t === "eph" ? [m.sceneId, m.e.k] : null)),
      [["s1", "dragEnd"]],
    );
  });

  test("at most 30 frames a second, however fast the display refreshes", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const times: number[] = [];
    const record = () => {
      for (const _ of s.last().take("eph")) times.push(s.clock.now());
    };
    for (let i = 0; i < 240; i++) {
      s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 3 + i / 100, y: 3 });
      s.runFrames();
      record();
      s.clock.advance(1000 / 120);
      s.runFrames();
      record();
    }
    assert.ok(times.length >= EPH_PER_SECOND * 2 - 4, `${times.length} frames in 2 s`);
    for (let i = EPH_PER_SECOND; i < times.length; i++) {
      assert.ok(times[i]! - times[i - EPH_PER_SECOND]! >= 1000, "never more than 30 within one second");
    }
  });

  test("low power sends at most 15 a second, and the full rate again once it is off", () => {
    let rate = 15;
    const s = setup({ ephPerSecond: () => rate });
    s.socket.start();
    s.connect();
    const times: number[] = [];
    const drive = (ms: number) => {
      const end = s.clock.now() + ms;
      let i = 0;
      while (s.clock.now() < end) {
        s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 3 + i++ / 100, y: 3 });
        s.runFrames();
        for (const _ of s.last().take("eph")) times.push(s.clock.now());
        s.clock.advance(1000 / 120);
        s.runFrames();
        for (const _ of s.last().take("eph")) times.push(s.clock.now());
      }
    };
    drive(2_000);
    assert.ok(times.length >= 15 * 2 - 3 && times.length <= 15 * 2 + 1, `${times.length} frames in 2 s`);
    for (let i = 15; i < times.length; i++) assert.ok(times[i]! - times[i - 15]! >= 1000, "never more than 15 within one second");
    times.length = 0;
    rate = EPH_PER_SECOND;
    s.clock.advance(1_000);
    drive(1_000);
    assert.ok(times.length >= EPH_PER_SECOND - 3, `${times.length} frames in 1 s at the full rate`);
  });

  test("a preview held still is repeated so receivers keep it, and stops once ended", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.sendEph({ k: "ruler", id: "r1", points: [{ x: 1, y: 1 }] });
    s.runFrames();
    assert.equal(s.last().take("eph").length, 1);
    s.clock.advance(1_000);
    s.runFrames();
    assert.equal(s.last().take("eph").length, 1);
    s.socket.sendEph({ k: "rulerEnd", id: "r1" });
    s.clock.advance(40);
    s.runFrames();
    assert.deepEqual(s.last().take("eph").map((m) => (m.t === "eph" ? m.e.k : null)), ["rulerEnd"]);
    s.clock.advance(5_000);
    s.runFrames();
    assert.equal(s.last().take("eph").length, 0);
  });

  test("nothing is sent before the snapshot", () => {
    const s = setup();
    s.socket.start();
    s.last().open();
    s.socket.sendEph({ k: "ping", x: 1, y: 1 });
    s.runFrames();
    assert.equal(s.last().take("eph").length, 0);
  });
});

describe("the outbox's pace (H3-FOG-BURST)", () => {
  const bytesOf = (data: string) => new TextEncoder().encode(data).length;

  /** A fog draft of about `kib` KiB, as a band of a Builder room on a large map is: parts of at most 2,000 cells (MAX_FOG_CELLS) of about 8 bytes each. */
  function fogDraft(k: number, kib: number): ClientOp {
    const cells = Array.from({ length: Math.max(1, Math.round((kib * 1024) / 8)) }, (_, i) => `${i % 40},${Math.floor(i / 40) % 30}`);
    const add = [];
    for (let at = 0; at < cells.length; at += 2_000) add.push({ id: `f${k}.${at}`, mode: "reveal" as const, shape: { kind: "cells" as const, cells: cells.slice(at, at + 2_000) } });
    return { t: "fog.draft", sceneId: "s1", add };
  }

  /** Each socket's frames as the server's own budget reads them, from the moment it opens: a frame it would drop is named. */
  function serverSide(s: ReturnType<typeof setup>) {
    const dropped: string[] = [];
    const frames: { socket: number; at: number; msg: ClientMessage }[] = [];
    const watch = (index: number) => {
      const socket = s.sockets[index]!;
      if (socket.onSend) return;
      const budget = new FrameBudget(() => s.clock.now());
      socket.onSend = (data) => {
        const msg = JSON.parse(data) as ClientMessage;
        frames.push({ socket: index, at: s.clock.now(), msg });
        if (budget.accept(bytesOf(data)) !== "ok") dropped.push(`socket ${index} at ${s.clock.now()} ms: ${msg.t}${msg.t === "op" ? ` ${msg.n}` : ""}, ${bytesOf(data)} bytes`);
      };
    };
    return { dropped, frames, watch: () => s.sockets.forEach((_, i) => watch(i)) };
  }

  test("two Builder rooms' ops at once go as the server's budget refills, each once and in order, the rest waiting as saving, and none waits for the answer timer", () => {
    const s = setup();
    s.socket.start();
    const server = serverSide(s);
    server.watch();
    s.connect();
    // 14 drafts of 60 KiB: 840 KiB, about two rooms' worth on a 200 by 200 scene.
    const ns = Array.from({ length: 14 }, (_, k) => s.room.dispatch(fogDraft(k, 60))!);
    const sentNow = server.frames.filter((f) => f.msg.t === "op").length;
    assert.ok(sentNow > 0 && sentNow < ns.length, `${sentNow} ops went at once`);
    // What waits is still pending, which the room reads as saving (lib/chunkLoad.ts reloadGate).
    assert.equal(s.room.store.getState().pending.length, ns.length);
    const wait = Math.ceil(((14 * 60 * 1024 - SEND_BYTES_BURST) / SEND_BYTES_PER_SEC) * 1000) + 500;
    for (let t = 0; t < wait; t += 50) s.clock.advance(50);
    const ops = server.frames.filter((f) => f.msg.t === "op").map((f) => (f.msg as { n: number }).n);
    assert.deepEqual(ops, ns, "every op once, in order");
    assert.ok(wait < OP_ANSWER_MS, `${wait} ms to send them all`);
    assert.deepEqual(server.dropped, []);
    assert.equal(s.last().closedWith, null);
  });

  test("a ping and a preview go however many frames the ops spent, and a new socket's budget starts full, as the server's does", () => {
    const s = setup();
    s.socket.start();
    const server = serverSide(s);
    server.watch();
    s.connect();
    s.clock.advance(PING_INTERVAL_MS - 10);
    // More small ops than the budget's frames, so the next ones wait on the frame count rather than bytes.
    for (let k = 0; k < 150; k++) s.room.dispatch({ t: "log.chat", text: `line ${k}` });
    assert.ok(s.last().take("op").length < 150, "the ops wait for frames");
    s.socket.sendEph({ k: "laser", x: 1, y: 1, on: true });
    s.runFrames();
    assert.equal(s.last().take("eph").length, 1, "the preview went with ops waiting");
    s.clock.advance(10);
    assert.equal(s.last().take("ping").length, 1, "the heartbeat's ping went with ops waiting");
    s.last().drop(1012);
    s.clock.advance(1);
    server.watch();
    s.connect();
    assert.ok(s.last().take("op").length >= 50, "the new socket sends a burst of the ops at once");
    assert.deepEqual(server.dropped, []);
  });

  test("an op larger than the whole burst goes once the budget is full, and the op after it once the budget has room again", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.room.dispatch(fogDraft(0, 60));
    // Bigger than any op the app sends (the server takes frames of 64 KiB at most), so only this rule moves it.
    const huge = s.room.dispatch(fogDraft(1, 300))!;
    const after = s.room.dispatch({ t: "log.chat", text: "after" })!;
    s.last().take("op");
    s.clock.advance(Math.ceil((60 * 1024 / SEND_BYTES_PER_SEC) * 1000) + 50);
    assert.deepEqual(s.last().take("op").map((m) => (m as { n: number }).n), [huge]);
    // It spent past the budget's floor, so the next op waits for that much to come back.
    s.clock.advance(Math.ceil(((300 - 256) * 1024 / SEND_BYTES_PER_SEC) * 1000) + 50);
    assert.deepEqual(s.last().take("op").map((m) => (m as { n: number }).n), [after]);
  });

  test("random sequences of ops of every size, previews, pings, acks and reconnects: the server never drops a frame, no op goes twice on a socket, and every op lands", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      const s = setup();
      s.socket.start();
      const server = serverSide(s);
      let acked = 0;
      let seq = 0;
      let live = -1;
      const open = () => {
        server.watch();
        live = s.sockets.length - 1;
        seq = 0;
        s.last().open();
        s.last().take("hello");
        s.last().emit(s.snapshot("s1", acked));
      };
      server.watch();
      open();
      let k = 0;
      const serve = () => {
        const socket = s.last();
        if (s.sockets.length - 1 !== live || socket.readyState !== 1) return;
        for (const m of socket.take()) {
          if (m.t === "ping") socket.emit({ t: "pong", k: m.k });
          if (m.t !== "op") continue;
          const n = m.n;
          // Answered after a short while, on the socket it came on only.
          s.clock.setTimeout(() => {
            if (socket !== s.last() || socket.readyState !== 1) return;
            acked = Math.max(acked, n);
            socket.emit({ t: "ev", seq: ++seq, changes: [], acks: [n] });
          }, Math.floor(r() * 300));
        }
      };
      for (let step = 0; step < 80; step++) {
        const roll = r();
        // Now and then a gesture's worth at once, as a Builder room is, past the server's burst.
        if (roll < 0.35) for (let i = 1 + Math.floor(r() ** 3 * 24); i > 0; i--) s.room.dispatch(fogDraft(k++, 0.2 + r() * 62));
        else if (roll < 0.5) s.socket.sendEph({ k: "laser", x: r() * 10, y: r() * 10, on: true });
        else if (roll < 0.53 && s.last().readyState === 1) {
          s.last().drop(1012);
          s.clock.advance(1);
          open();
        }
        s.runFrames();
        serve();
        s.clock.advance(Math.floor(r() * 400));
        serve();
      }
      for (let t = 0; t < 60_000; t += 100) {
        s.runFrames();
        serve();
        s.clock.advance(100);
      }
      serve();
      assert.deepEqual(server.dropped, [], `seed ${seed}: the server dropped a frame`);
      for (let i = 0; i < s.sockets.length; i++) {
        const ns = server.frames.filter((f) => f.socket === i && f.msg.t === "op").map((f) => (f.msg as { n: number }).n);
        assert.ok(ns.every((n, j) => j === 0 || n > ns[j - 1]!), `seed ${seed}: socket ${i} sent ${JSON.stringify(ns)}`);
      }
      assert.deepEqual(s.room.store.getState().pending, [], `seed ${seed}: ops still pending`);
      s.socket.dispose();
      s.room.dispose();
    }
  });
});

describe("teardown", () => {
  test("dispose closes the socket and leaves no timers", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.room.dispatch({ t: "token.move", tokenId: "g1", x: 5, y: 5 });
    s.socket.dispose();
    s.room.dispose();
    assert.equal(s.sockets[0]!.closedWith, 1000);
    assert.equal(s.env.handlers, null);
    s.clock.advance(600_000);
    assert.equal(s.sockets.length, 1);
    assert.equal(s.clock.pendingTimers, 0);
  });
});

describe("the access signal", () => {
  test("each one counts up, so the DM views showing the player link or the devices ask the server again", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const version = () => s.room.store.getState().accessVersion;
    assert.equal(version(), 1, "the first snapshot");
    s.last().emit({ t: "access" });
    s.last().emit({ t: "access" });
    assert.equal(version(), 3);
  });

  test("every X-card the server sends counts once, and names no one", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    assert.equal(s.room.store.getState().xcard, undefined);
    s.last().emit({ t: "xcard", at: "2026-10-14T19:42:00.000Z" });
    assert.deepEqual(s.room.store.getState().xcard, { id: 1, at: "2026-10-14T19:42:00.000Z" });
    s.last().emit({ t: "xcard", at: "2026-10-14T19:43:00.000Z" });
    assert.equal(s.room.store.getState().xcard?.id, 2);
  });

  test("a dismissed X-card stays dismissed on this device, and the next card shows again", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const showing = () => (s.room.store.getState().xcard?.id ?? 0) > (s.room.store.getState().xcardDismissed ?? 0);
    s.last().emit({ t: "xcard", at: "2026-10-14T19:42:00.000Z" });
    assert.equal(showing(), true);
    s.room.ui.dismissXcard(1);
    assert.equal(showing(), false);
    s.room.ui.dismissXcard(0);
    assert.equal(showing(), false, "an older dismissal never brings a card back");
    s.last().emit({ t: "xcard", at: "2026-10-14T19:43:00.000Z" });
    assert.equal(showing(), true);
  });

  test("a signal missed without a snapshot still counts: every snapshot counts as one, the first included", () => {
    const s = setup();
    s.socket.start();
    const version = () => s.room.store.getState().accessVersion;
    assert.equal(version(), 0);
    s.connect();
    // A DM view can fetch the link before the first snapshot, and a password changed meanwhile sends this socket nothing.
    assert.equal(version(), 1, "the first snapshot counts too");
    // The server signals only sockets holding a snapshot, so a password change while this device is offline never reaches it.
    s.last().drop(1006);
    s.clock.advance(10_000);
    s.connect();
    assert.equal(version(), 2);
    // A scene switch goes through a resync, when the socket holds no snapshot either.
    s.socket.switchScene("s2");
    s.last().take("scene");
    s.last().emit({ t: "resync", reason: "scene" });
    s.last().take("hello");
    s.last().emit(s.snapshot("s2"));
    assert.equal(version(), 3);
  });
});
