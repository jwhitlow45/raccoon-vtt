import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { serverDraw } from "#shared/dice/roll.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { Op, ServerMessage, ServerOnlyOp } from "#shared/protocol.ts";
import { Connection } from "./connection.ts";
import { mapStepOps, memoryGrowth } from "./remember.ts";
import { failCommits, startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";
import { UndoStacks } from "./undo.ts";

/**
 * A fault while the room engine works, on the real server and Postgres:
 * an op that throws after waiting behind a commit or behind an ask read in
 * turns, or after it was staged, an ask whose reading throws, a delayed
 * snapshot that throws, and the steps around a commit (the map step, the
 * undo summaries, publishing, the snapshots and resyncs a commit owed). An
 * op or a snapshot that throws costs the socket it came from alone, which
 * closes with 1011, and a server command is refused. An op staged before
 * it threw is stored once, and what a throw left staged still commits. A
 * batch that cannot be published is kept, and its room's sockets close to
 * take it afresh. The room's queue goes on, other rooms never notice, and
 * nothing reaches the process.
 *
 * The faults are scripted through the actor's test seams and the socket's
 * send, so each test keeps throwing where it means to whatever the rules
 * come to accept or refuse.
 */

/** The scripted faults. Each but the slow scan is cleared once it fires. */
const faults: {
  draw: boolean;
  /** `unreadable` names a layer the estimate cannot read, so it throws after its batch is begun. */
  growth: "none" | "slow" | "throw" | "unreadable";
  mapStep: boolean;
  staged: boolean;
  summaries: boolean;
  send: ((conn: Connection, msg: ServerMessage) => boolean) | null;
} = { draw: false, growth: "none", mapStep: false, staged: false, summaries: false, send: null };

/** The sockets' clock, which their frame budgets read, held where a test steps it. */
let wsClock: number | null = null;

/** Whatever reached the process: an uncaught exception or an unhandled rejection. */
const escaped: unknown[] = [];
const record = (err: unknown) => escaped.push(err);
const realSend = Connection.prototype.send;
const realSummaries = UndoStacks.prototype.summaries;

function scriptedFault(what: string): Error {
  return new Error(`scripted ${what} fault`);
}

const actorOptions = {
  batchMs: 10,
  retryBaseMs: 20,
  retryMaxMs: 40,
  draw: (sides: number) => {
    if (faults.draw) {
      faults.draw = false;
      throw scriptedFault("draw");
    }
    return serverDraw(sides);
  },
  memoryGrowth: (...args: Parameters<typeof memoryGrowth>) => {
    if (faults.growth === "throw") {
      faults.growth = "none";
      throw scriptedFault("scan");
    }
    if (faults.growth === "unreadable") {
      faults.growth = "none";
      return new Map([["not a layer", 1]]);
    }
    // Slower than a turn of an ask's reading, so a long ask is read over many turns.
    if (faults.growth === "slow") for (const until = performance.now() + 40; performance.now() < until; );
    return memoryGrowth(...args);
  },
  mapStep: (input: Parameters<typeof mapStepOps>[0]) => {
    if (!faults.mapStep) return mapStepOps(input);
    faults.mapStep = false;
    // A result the step cannot read, which fails past the step's own catch.
    return null as unknown as ReturnType<typeof mapStepOps>;
  },
  now: () => {
    // The actor's #reduce reads the clock only once it has staged an op, so this throws past staging.
    if (faults.staged && /\bat (?:\w+\.)?#reduce \(/.test(new Error().stack ?? "")) {
      faults.staged = false;
      throw scriptedFault("staged op");
    }
    return Date.now();
  },
};

before(() => {
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  Connection.prototype.send = function (this: Connection, msg: ServerMessage): number {
    if (faults.send?.(this, msg)) {
      faults.send = null;
      throw scriptedFault("send");
    }
    return realSend.call(this, msg);
  };
  UndoStacks.prototype.summaries = function (this: UndoStacks) {
    if (faults.summaries) {
      faults.summaries = false;
      throw scriptedFault("summaries");
    }
    return realSummaries.call(this);
  };
});

after(() => {
  process.off("uncaughtException", record);
  process.off("unhandledRejection", record);
  Connection.prototype.send = realSend;
  UndoStacks.prototype.summaries = realSummaries;
});

beforeEach(() => {
  faults.draw = false;
  faults.growth = "none";
  faults.mapStep = false;
  faults.staged = false;
  faults.summaries = false;
  faults.send = null;
  escaped.length = 0;
});

type Room = { roomId: string; sceneId: string; dm: Socket; dmId: string; dmClient: TestClient; player: Socket; playerId: string; playerClient: TestClient };

async function room(t: Engine, name: string): Promise<Room> {
  const dmClient = t.client();
  const { roomId } = await dmClient.createRoom(name);
  const playerClient = t.client();
  const playerId = await playerClient.join(roomId, "Ayla");
  const dm = await t.connect(roomId, dmClient);
  const snap = await dm.snapshot(uuidv7());
  const player = await t.connect(roomId, playerClient);
  await player.snapshot(uuidv7());
  const sceneId = (snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId;
  return { roomId, sceneId, dm, dmId: snap.you.memberId, dmClient, player, playerId, playerClient };
}

function roll(): Op {
  return { t: "dice.roll", tag: uuidv7(), to: "all", rolls: [{ formula: "1d20" }] } as Op;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** `work` settles within five seconds, so a promise left waiting fails the test rather than hanging it. */
function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} never came`)), 5_000);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Every op of `ns` was taken, not refused, whether one batch answered them or several. */
async function taken(socket: Socket, ...ns: number[]): Promise<void> {
  const waiting = new Set(ns);
  while (waiting.size > 0) {
    const answers = (m: Extract<ServerMessage, { t: "ev" }>) => [...(m.acks ?? []), ...(m.rejects ?? []).map((r) => r.n)].filter((n) => waiting.has(n));
    const ev = await socket.next("ev", (m) => answers(m).length > 0);
    for (const n of answers(ev)) waiting.delete(n);
    assert.deepEqual(ev.rejects?.filter((r) => ns.includes(r.n)) ?? [], [], `ops ${ns.join(", ")} are taken`);
  }
}

const FAULT_WORDS = "That change could not be made: something went wrong on the server.";

/** The op `n` was refused for a fault, with the server's words, and its socket stays open. */
async function refusedForFault(socket: Socket, n: number): Promise<void> {
  const ev = await socket.next("ev", (m) => (m.rejects ?? []).some((r) => r.n === n));
  const refusal = ev.rejects?.find((r) => r.n === n);
  assert.deepEqual([refusal?.code, refusal?.message], ["invalid", FAULT_WORDS]);
  assert.equal(socket.closeCode, null, "the socket stays open");
}

/** The room still takes an op from `socket` and shows it to `watcher`. */
async function goesOn(socket: Socket, watcher: Socket, text: string): Promise<void> {
  const n = socket.op({ t: "log.chat", text });
  await taken(socket, n);
  await watcher.next("ev", (m) => m.changes.some((c) => "value" in c && JSON.stringify(c.value).includes(text)));
}

/** How many log lines of the room hold `text`. */
function copies(state: unknown, text: string): number {
  return JSON.stringify(state).split(text).length - 1;
}

/** The room unloads once its sockets close, which it does only with nothing left staged in it. */
async function unloads(t: Engine, r: Room): Promise<void> {
  r.dm.close();
  r.player.close();
  await until(() => t.manager.get(r.roomId) === null, "the room to unload");
}

/** The process heard of no fault, and another room never noticed. */
async function contained(other: Room): Promise<void> {
  await goesOn(other.player, other.dm, `elsewhere ${uuidv7()}`);
  assert.deepEqual(escaped, [], "nothing reached the process");
}

describe("a fault in the room engine", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: actorOptions }, ws: { now: () => wsClock ?? Date.now() } });
  });
  after(() => t.close());

  test("an op that throws after waiting behind a commit is refused with its socket open, and the ops queued after it apply", async () => {
    const r = await room(t, "Behind a commit");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const failing = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    let first: number;
    let later: number;
    let rolled: number;
    try {
      first = r.dm.op({ t: "log.chat", text: "first" });
      await until(() => actor.retrying, "the commit to retry");
      faults.draw = true;
      rolled = r.player.op(roll());
      later = r.dm.op({ t: "log.chat", text: "later" });
      await until(() => actor.queueLength === 2, "both ops to wait behind the commit");
    } finally {
      failing.restore();
    }
    await refusedForFault(r.player, rolled);
    await taken(r.dm, first, later);
    await goesOn(r.player, r.dm, "after the fault");
    await contained(other);
  });

  test("the third fault refusal within a minute reaches its socket, which then closes, counted across a reconnect", async () => {
    const r = await room(t, "Throttled");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const clientId = uuidv7();
    let last = 0;
    const reconnect = async (): Promise<Socket> => {
      const socket = await t.connect(r.roomId, r.playerClient);
      socket.n = last;
      await socket.snapshot(clientId, last + 1);
      return socket;
    };
    let socket = await reconnect();
    faults.draw = true;
    last = socket.op(roll());
    await refusedForFault(socket, last);
    // A new socket of the same device does not start the count again.
    socket.close();
    socket = await reconnect();
    faults.draw = true;
    last = socket.op(roll());
    await refusedForFault(socket, last);
    // The third's batch is held in its commit's retries, so the socket waits on it to close.
    const failing = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    let unread: number;
    try {
      faults.draw = true;
      last = socket.op(roll());
      await until(() => actor.retrying, "the commit to retry");
      // What a closing socket sends is not read, as on a socket closed at once, so its device sends it again.
      unread = socket.op({ t: "log.chat", text: "sent while closing" });
      socket.send({ t: "ping", k: 7 });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      failing.restore();
    }
    const third = await socket.next("ev", (m) => (m.rejects ?? []).some((r) => r.n === last));
    const refusal = third.rejects?.find((r) => r.n === last);
    assert.deepEqual([refusal?.code, refusal?.message], ["invalid", FAULT_WORDS], "the third fault's refusal reaches its socket");
    assert.equal((await socket.waitClosed()).code, 1011, "and then the socket closes");
    assert.equal(await socket.maybe("ev", (m) => [...(m.acks ?? []), ...(m.rejects ?? []).map((x) => x.n)].includes(unread), 0), null, "the op sent while closing is not answered there");
    assert.equal(await socket.maybe("pong", () => true, 0), null, "nor its ping");
    // The commit landed before the device came back, and its resend applies once.
    const back = await reconnect();
    await taken(back, back.op({ t: "log.chat", text: "sent while closing" }));
    assert.equal(back.n, unread, "the resend has the number the closing socket did not read");
    assert.equal(copies(actor.committed.state, "sent while closing"), 1);
    await contained(other);
  });

  test("a socket that waits to close for its third fault still spends its frame budget, so a flood closes it as abuse (RULES-OPUS-9)", async () => {
    const r = await room(t, "Flooding");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const socket = await t.connect(r.roomId, r.playerClient);
    await socket.snapshot(uuidv7(), 1);
    for (let i = 0; i < 2; i++) {
      faults.draw = true;
      await refusedForFault(socket, socket.op(roll()));
    }
    // The third's batch is held in its commit's retries, so the socket waits on it to close.
    const failing = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    try {
      faults.draw = true;
      socket.op(roll());
      await until(() => actor.retrying, "the commit to retry");
      // The socket's clock steps 0.9 s at a time, so each step's frames overrun what its budget refills, and the streak of
      // frames over budget runs past the 10 s that closes a socket as abuse.
      const from = Date.now();
      for (let step = 0; step <= 12 && socket.closeCode === null; step++) {
        wsClock = from + step * 900;
        for (let i = 0; i < 300; i++) socket.send({ t: "ping", k: i });
        await new Promise((done) => setTimeout(done, 100));
      }
      assert.equal((await socket.waitClosed()).code, 4008, "a flood past the frame budget closes it as abuse");
    } finally {
      failing.restore();
      wsClock = null;
    }
    await contained(other);
  });

  test("a server command that throws after waiting behind a commit is refused, and the ops queued after it apply", async () => {
    const r = await room(t, "A server command");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const failing = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    let refused: Promise<void>;
    let later: number;
    try {
      r.dm.op({ t: "log.chat", text: "first" });
      await until(() => actor.retrying, "the commit to retry");
      const op = {
        t: "sys.memberRemove",
        get memberId(): string {
          throw scriptedFault("op");
        },
      } as unknown as ServerOnlyOp;
      refused = actor.sys(op);
      refused.catch(() => undefined);
      later = r.player.op({ t: "log.chat", text: "later" });
      await until(() => actor.queueLength === 2, "both to wait behind the commit");
    } finally {
      failing.restore();
    }
    await assert.rejects(within(refused, "the server command's answer"), /scripted op fault/);
    await taken(r.player, later);
    assert.equal(r.dm.closeCode, null, "no socket pays for a server command");
    await contained(other);
  });

  test("an op that throws after waiting behind an ask read in turns is refused with its socket open, and the ops queued after it apply", async () => {
    const r = await room(t, "Behind an ask");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const paints = Array.from({ length: 16 }, (_, i) => ({ t: "build.paint", sceneId: r.sceneId, terrain: "wood", cells: [`${i % 4},${Math.floor(i / 4)}`] }));
    faults.growth = "slow";
    let ask: number;
    let later: number;
    let rolled: number;
    try {
      ask = r.dm.nextN();
      r.dm.send({ t: "op", n: ask, op: { t: "build.ask", sceneId: r.sceneId, ops: paints, part: 0 }, g: uuidv7() });
      await until(() => actor.askState.reading, "the ask to be read");
      faults.draw = true;
      rolled = r.player.op(roll());
      later = r.dm.op({ t: "log.chat", text: "later" });
      await until(() => actor.queueLength === 2, "both ops to wait behind the ask");
      assert.equal(actor.askState.reading, true, "the ask is still being read");
    } finally {
      faults.growth = "none";
    }
    await refusedForFault(r.player, rolled);
    await taken(r.dm, ask, later);
    await contained(other);
  });

  test("an ask whose reading throws is refused with its socket open, and the room's queue goes on", async () => {
    const r = await room(t, "A failed ask");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    faults.growth = "throw";
    const ask = r.dm.nextN();
    r.dm.send({ t: "op", n: ask, op: { t: "build.ask", sceneId: r.sceneId, ops: [{ t: "build.paint", sceneId: r.sceneId, terrain: "wood", cells: ["1,1"] }], part: 0 }, g: uuidv7() });
    await refusedForFault(r.dm, ask);
    assert.equal(actor.askState.reading, false);
    const n = r.player.op({ t: "log.chat", text: "later" });
    await taken(r.player, n);
    await contained(other);
  });

  test("a snapshot owed at a commit's end that throws closes only its socket, and the room goes on", async () => {
    const r = await room(t, "Owed a snapshot");
    const other = await room(t, "Elsewhere");
    const second = await t.connect(r.roomId, r.playerClient);
    faults.send = (conn, msg) => msg.t === "snapshot" && conn.memberId === r.playerId;
    // A device that says ops below 5 are settled is answered once the next commit makes that durable.
    second.hello(uuidv7(), 5);
    assert.equal((await second.waitClosed()).code, 1011);
    assert.equal(r.player.closeCode, null, "the player's other device stays");
    await goesOn(r.dm, r.player, "later");
    await contained(other);
  });

  test("a batch whose publishing throws is kept, its room's sockets close, and the room goes on", async () => {
    const r = await room(t, "Publishing");
    const other = await room(t, "Elsewhere");
    const actor = t.manager.get(r.roomId)!;
    const seq = actor.committed.seq;
    faults.send = (conn, msg) => msg.t === "ev" && conn.memberId === r.dmId;
    r.dm.op({ t: "log.chat", text: "first" });
    assert.equal((await r.dm.waitClosed()).code, 1011);
    assert.equal((await r.player.waitClosed()).code, 1011);
    assert.ok(actor.committed.seq > seq, "the batch is stored");
    const back = await t.connect(r.roomId, r.playerClient);
    await back.snapshot(uuidv7());
    const n = back.op({ t: "log.chat", text: "later" });
    await taken(back, n);
    await contained(other);
  });

  test("a batch whose map step throws still commits, and the room goes on", async () => {
    const r = await room(t, "Map step");
    const other = await room(t, "Elsewhere");
    faults.mapStep = true;
    await goesOn(r.dm, r.player, "first");
    assert.equal(faults.mapStep, false, "the map step ran");
    await goesOn(r.player, r.dm, "later");
    await contained(other);
  });
  test("an op that throws after it is staged is stored once, and its resend is answered from the watermark, before and after a reload", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Staged");
    const playerClient = t.client();
    await playerClient.join(roomId, "Ayla");
    const dm = await t.connect(roomId, dmClient);
    await dm.snapshot(uuidv7());
    const clientId = uuidv7();
    const player = await t.connect(roomId, playerClient);
    await player.snapshot(clientId);
    const text = `once ${uuidv7()}`;
    faults.staged = true;
    const n = player.op({ t: "log.chat", text });
    assert.equal((await player.waitClosed()).code, 1011);
    assert.equal(faults.staged, false, "the op threw past staging");
    // Committed with no later command to set it off.
    await until(() => copies(t.manager.get(roomId)?.committed.state, text) === 1, "the staged op to commit");
    // The device resends what it never heard answered, as it does on reconnect, and goes on numbering after it.
    const resend = async (): Promise<void> => {
      const socket = await t.connect(roomId, playerClient);
      socket.n = n - 1;
      await socket.snapshot(clientId, n);
      await taken(socket, socket.op({ t: "log.chat", text }));
      await taken(socket, socket.op({ t: "log.chat", text: `after ${uuidv7()}` }));
      assert.equal(copies(t.manager.get(roomId)?.committed.state, text), 1, "the op is stored once");
      socket.close();
    };
    await resend();
    dm.close();
    await t.restart();
    await resend();
    assert.deepEqual(escaped, [], "nothing reached the process");
  });

  test("an op that throws after its batch is begun is refused and leaves nothing else staged, so the room unloads", async () => {
    const r = await room(t, "Begun");
    const other = await room(t, "Elsewhere");
    faults.growth = "unreadable";
    const paint = r.dm.op({ t: "build.paint", sceneId: r.sceneId, terrain: "wood", cells: ["1,1"] });
    await refusedForFault(r.dm, paint);
    assert.equal(faults.growth, "none", "the estimate ran");
    await unloads(t, r);
    await contained(other);
  });

  test("an ask whose reading throws after its batch is begun is refused and leaves nothing else staged, so the room unloads", async () => {
    const r = await room(t, "Ask begun");
    const other = await room(t, "Elsewhere");
    faults.growth = "unreadable";
    const ask = r.dm.nextN();
    r.dm.send({ t: "op", n: ask, op: { t: "build.ask", sceneId: r.sceneId, ops: [{ t: "build.paint", sceneId: r.sceneId, terrain: "wood", cells: ["1,1"] }], part: 0 }, g: uuidv7() });
    await refusedForFault(r.dm, ask);
    assert.equal(faults.growth, "none", "the estimate ran");
    await unloads(t, r);
    await contained(other);
  });

  test("a batch whose undo summaries throw still commits, and the room goes on", async () => {
    const r = await room(t, "Summaries");
    const other = await room(t, "Elsewhere");
    faults.summaries = true;
    await goesOn(r.dm, r.player, "first");
    assert.equal(faults.summaries, false, "the summaries ran");
    await goesOn(r.player, r.dm, "later");
    await contained(other);
  });

  test("a resync owed at a commit's end that throws closes only its socket, and the room goes on", async () => {
    const r = await room(t, "Owed a resync");
    const other = await room(t, "Elsewhere");
    const prep = uuidv7();
    await taken(r.dm, r.dm.op({ t: "scene.create", scene: { id: prep, name: "Prep", bounds: { w: 10, h: 10 } } }));
    const onPrep = await t.connect(r.roomId, r.dmClient);
    await onPrep.snapshot(uuidv7(), undefined, prep);
    faults.send = (conn, msg) => msg.t === "resync" && conn.sceneId === null && conn.role === "dm";
    await taken(r.dm, r.dm.op({ t: "scene.delete", sceneId: prep }));
    assert.equal((await onPrep.waitClosed()).code, 1011);
    assert.equal(faults.send, null, "the resync was sent");
    assert.equal(r.dm.closeCode, null, "the DM's other device stays");
    await goesOn(r.dm, r.player, "later");
    await contained(other);
  });
});

describe("a delayed snapshot that throws", () => {
  let t: Engine;
  before(async () => {
    // One snapshot per session a second, so a second device of the same session waits for its own.
    t = await startEngine({ rooms: { actor: actorOptions, snapshotBudget: { sessionCount: 1, windowMs: 1_000 } } });
  });
  after(() => t.close());

  test("closes only its socket, and the room goes on", async () => {
    const r = await room(t, "Delayed");
    const other = await room(t, "Elsewhere");
    const second = await t.connect(r.roomId, r.playerClient);
    second.hello(uuidv7());
    await second.next("wait");
    faults.send = (conn, msg) => msg.t === "snapshot" && conn.memberId === r.playerId;
    assert.equal((await second.waitClosed()).code, 1011);
    assert.equal(r.player.closeCode, null, "the player's other device stays");
    await goesOn(r.dm, r.player, "later");
    await contained(other);
  });
});
