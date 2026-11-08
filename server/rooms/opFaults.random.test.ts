import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serverDraw } from "#shared/dice/roll.ts";
import { createInitialState } from "#shared/initial.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { Member } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { memoryGrowth } from "./remember.ts";
import type { Pool } from "./persistence.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";

/**
 * THROW-REFUSE over random sequences. Ops that throw before staging, after
 * staging and inside an ask's read are mixed with plain ops, reconnects and
 * resends, against a stand-in for the database and a clock the test moves.
 *
 * Invariants: each op number is answered at most once on a socket, no op is
 * applied twice, a socket closes only for a throw after staging or for the
 * third fault refusal within 60 s of one session (a fresh client id keeps the count), an op that threw before staging is
 * refused with the server's words, and nothing is left staged at the end.
 */

const FAULT_WORDS = "That change could not be made: something went wrong on the server.";
const ROOM = "FAULTR00M";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The rows a room keeps, answered the way persistence.ts asks for them. */
class FakeDb {
  durableMax = 0;
  readonly snapshot: { state: unknown; seq: number };
  #staged: number[] = [];
  readonly dmId: string;
  constructor(state: unknown, dmId: string) {
    this.dmId = dmId;
    this.snapshot = { state, seq: 0 };
  }
  pool(): Pool {
    const run = (sql: string, params: unknown[] = []) => Promise.resolve().then(() => this.#answer(sql.trim(), params));
    return { query: run, connect: () => Promise.resolve({ query: run, release: () => undefined }) } as unknown as Pool;
  }
  #answer(sql: string, params: unknown[]): { rows: unknown[]; rowCount?: number } {
    if (sql.includes("from room_snapshots")) return { rows: [{ seq: String(this.snapshot.seq), state: this.snapshot.state, schema_version: SNAPSHOT_VERSION }] };
    if (sql.includes("max(seq)")) return { rows: [{ max: String(this.durableMax) }] };
    if (sql.includes("from room_ops")) return { rows: [] };
    if (sql.includes("from grants")) return { rows: [{ member_id: this.dmId }] };
    if (sql.startsWith("insert into room_ops")) {
      this.#staged = params[1] as number[];
      return { rows: [] };
    }
    if (sql === "commit") {
      this.durableMax = Math.max(this.durableMax, ...this.#staged);
      this.#staged = [];
    }
    return { rows: [], rowCount: 0 };
  }
}

function member(name: string, kind: Member["kind"]): Member {
  return { id: uuidv7(), rev: 0, name, color: "#336699", kind, createdAt: new Date().toISOString() };
}

/** A small seeded generator, so a failing sequence replays. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Action = "chat" | "beforeStaging" | "afterStaging" | "askRead" | "reconnect" | "newId" | "resend" | "wait";
const ACTIONS: Action[] = ["chat", "chat", "beforeStaging", "beforeStaging", "afterStaging", "askRead", "reconnect", "newId", "resend", "wait"];

type Device = {
  who: Member;
  clientId: string;
  sessionId: string;
  conn: Connection;
  sent: ServerMessage[];
  nextN: number;
  /** Op numbers the device never heard answered, with what to send again. */
  unheard: Map<number, { raw: unknown; text: string | null }>;
  /** Fault refusals the model expects the server to have counted, by time. */
  faultTimes: number[];
  /** When its client id last changed, for counting the throttles a fresh id would have reset. */
  idChangedAt: number;
  /** Every socket it has had, with what the model expects of it. */
  sockets: Array<{ conn: Connection; sent: ServerMessage[]; mayClose: boolean }>;
};

/** What the sequences reached, so a generator that stops reaching a case fails. */
const reached = { refusals: 0, throttled: 0, afterStaging: 0, newIds: 0, throttledAcrossIds: 0 };

/** The room being run, so a failed sequence still stops its timers. */
let live: RoomActor | null = null;

async function run(seed: number, steps: number, script?: readonly Action[]): Promise<void> {
  const rand = seeded(seed);
  const dm = member("DM", "dm");
  const pc = member("Pip", "player");
  const state = createInitialState({ roomName: "Faults", dm });
  state.members[pc.id] = pc;
  const sceneId = state.meta.playerSceneId!;
  const db = new FakeDb(state, dm.id);
  const clock = { t: 1_700_000_000_000 };
  const armed = { draw: false, staged: false, growth: false };
  const deps: ActorDeps = {
    pool: db.pool(),
    info: { roomId: ROOM, pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    options: {
      batchMs: 1,
      retryBaseMs: 5,
      retryMaxMs: 20,
      snapshotIdleMs: 60_000,
      grantRecheckMs: 60_000,
      now: () => {
        // #reduce reads the clock only after an op is staged.
        if (armed.staged && /\bat (?:\w+\.)?#reduce \(/.test(new Error().stack ?? "")) {
          armed.staged = false;
          throw new Error("scripted staged fault");
        }
        return clock.t;
      },
      draw: (sides: number) => {
        if (armed.draw) {
          armed.draw = false;
          throw new Error("scripted draw fault");
        }
        return serverDraw(sides);
      },
      memoryGrowth: (...args: Parameters<typeof memoryGrowth>) => {
        if (armed.growth) {
          armed.growth = false;
          throw new Error("scripted scan fault");
        }
        return memoryGrowth(...args);
      },
    },
  };
  const actor = await RoomActor.load(deps);
  assert.ok(actor);
  live = actor;
  const devices: Device[] = [];

  async function open(device: Device, resumeFrom: number): Promise<void> {
    const sent: ServerMessage[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
    const conn = new Connection(socket as never, { sessionId: device.sessionId, roomId: ROOM, memberId: device.who.id, role: device.who.kind === "dm" ? "dm" : "player" }, "203.0.113.9", { now: () => clock.t });
    actor!.attach(conn);
    device.conn = conn;
    device.sent = sent;
    device.sockets.push({ conn, sent, mayClose: false });
    await actor!.hello(conn, { clientId: device.clientId, resumeFrom });
  }

  async function device(who: Member): Promise<Device> {
    const d: Device = { who, clientId: uuidv7(), sessionId: uuidv7(), conn: null as never, sent: [], nextN: 1, unheard: new Map(), faultTimes: [], idChangedAt: 0, sockets: [] };
    await open(d, 1);
    devices.push(d);
    return d;
  }

  /** Until the queue is empty and no commit has landed for a few turns. */
  const settle = async () => {
    let still = 0;
    let seen = -1;
    for (let i = 0; i < 1000 && still < 8; i++) {
      await new Promise((r) => setTimeout(r, 2));
      still = actor!.queueLength === 0 && db.durableMax === seen ? still + 1 : 0;
      seen = db.durableMax;
    }
  };
  const answers = (d: Device, n: number) => d.sockets.flatMap((s) => s.sent).filter((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev").filter((m) => (m.acks ?? []).includes(n) || (m.rejects ?? []).some((r) => r.n === n));

  /** Until the op was answered or its socket closed, since a refusal alone writes no row for the stand-in to show. */
  const answered = async (d: Device, n: number) => {
    for (let i = 0; i < 1000 && answers(d, n).length === 0 && !d.conn.closed; i++) await new Promise((r) => setTimeout(r, 2));
  };

  const pip = await device(pc);
  const desk = await device(dm);
  const texts = new Map<string, number>();

  async function send(d: Device, raw: unknown, text: string | null, group?: string): Promise<number> {
    const n = d.nextN++;
    d.unheard.set(n, { raw, text });
    await actor!.op(d.conn, n, raw, group);
    await answered(d, n);
    return n;
  }

  /** The model of the throttle: the third fault refusal within a minute closes the socket. */
  function refusedForFault(d: Device): boolean {
    d.faultTimes = d.faultTimes.filter((at) => clock.t - at < 60_000);
    d.faultTimes.push(clock.t);
    const closes = d.faultTimes.length >= 3;
    reached.refusals++;
    if (closes) reached.throttled++;
    if (closes && d.faultTimes.some((at) => at < d.idChangedAt)) reached.throttledAcrossIds++;
    if (closes) d.sockets[d.sockets.length - 1]!.mayClose = true;
    return closes;
  }

  for (let step = 0; step < steps; step++) {
    clock.t += 300 + Math.floor(rand() * 20_000);
    const action = script ? script[step % script.length]! : ACTIONS[Math.floor(rand() * ACTIONS.length)]!;
    const d = action === "askRead" ? desk : pip;
    if (d.conn.closed && action !== "reconnect") {
      const first = [...d.unheard.keys()][0] ?? d.nextN;
      await open(d, first);
    }
    switch (action) {
      case "chat": {
        const text = `chat ${step} ${uuidv7()}`;
        texts.set(text, 1);
        await send(d, { t: "log.chat", text }, text);
        break;
      }
      case "beforeStaging": {
        armed.draw = true;
        const n = await send(d, { t: "dice.roll", tag: uuidv7(), to: "all", rolls: [{ formula: "1d20" }] }, null);
        await settle();
        armed.draw = false;
        // The refusal that closes the socket reaches the device with its next snapshot, not on this socket.
        if (!refusedForFault(d)) {
          const refusal = answers(d, n).flatMap((m) => m.rejects ?? []).find((r) => r.n === n);
          assert.deepEqual([refusal?.code, refusal?.message], ["invalid", FAULT_WORDS], `seed ${seed} step ${step}: a throw before staging is refused`);
        }
        break;
      }
      case "afterStaging": {
        const text = `staged ${step} ${uuidv7()}`;
        texts.set(text, 1);
        armed.staged = true;
        await send(d, { t: "log.chat", text }, text);
        await settle();
        if (!armed.staged) {
          d.sockets[d.sockets.length - 1]!.mayClose = true;
          reached.afterStaging++;
        }
        armed.staged = false;
        break;
      }
      case "askRead": {
        armed.growth = true;
        const n = await send(d, { t: "build.ask", sceneId, ops: [{ t: "build.paint", sceneId, terrain: "wood", cells: ["1,1"] }], part: 0 }, null, uuidv7());
        await settle();
        const spent = !armed.growth;
        armed.growth = false;
        if (spent && !refusedForFault(d)) {
          const refusal = answers(d, n).flatMap((m) => m.rejects ?? []).find((r) => r.n === n);
          assert.deepEqual([refusal?.code, refusal?.message], ["invalid", FAULT_WORDS], `seed ${seed} step ${step}: an ask read that threw is refused`);
        }
        break;
      }
      case "reconnect": {
        const first = [...d.unheard.keys()][0] ?? d.nextN;
        await open(d, first);
        break;
      }
      case "newId": {
        // A client picks its own id, so a fresh one must not buy a fresh throttle. Only with nothing unheard, which a new id's watermark could not resume.
        if (d.unheard.size === 0) {
          d.clientId = uuidv7();
          d.idChangedAt = clock.t;
          reached.newIds++;
        }
        const first = [...d.unheard.keys()][0] ?? d.nextN;
        await open(d, first);
        break;
      }
      case "resend": {
        for (const [n, entry] of d.unheard) await actor.op(d.conn, n, entry.raw);
        break;
      }
      case "wait":
        clock.t += 61_000;
        break;
    }
    await settle();
    for (const [n] of d.unheard) if (answers(d, n).length > 0) d.unheard.delete(n);
  }

  // Everything unheard is resent on a fresh socket, as a device does after a reconnect.
  for (const d of devices) {
    const first = [...d.unheard.keys()][0] ?? d.nextN;
    await open(d, first);
    for (const [n, entry] of d.unheard) {
      await actor.op(d.conn, n, entry.raw);
    }
    await settle();
  }
  await settle();

  for (const d of devices) {
    for (const s of d.sockets) {
      const answered = new Map<number, number>();
      for (const m of s.sent) {
        if (m.t !== "ev") continue;
        for (const n of m.acks ?? []) answered.set(n, (answered.get(n) ?? 0) + 1);
        for (const r of m.rejects ?? []) answered.set(r.n, (answered.get(r.n) ?? 0) + 1);
      }
      for (const [n, times] of answered) assert.ok(times <= 1, `seed ${seed}: op ${n} answered ${times} times on one socket`);
      if (s.conn.closedWith !== null && s.conn.closedWith !== 1012) assert.ok(s.mayClose && s.conn.closedWith === 1011, `seed ${seed}: a socket closed with ${s.conn.closedWith} for no fault past staging or the third refusal`);
      if (s.mayClose) assert.equal(s.conn.closedWith, 1011, `seed ${seed}: the socket that earned a close was closed`);
    }
  }
  const log = JSON.stringify(actor.committed.state);
  for (const text of texts.keys()) assert.ok(log.split(text).length - 1 <= 1, `seed ${seed}: "${text}" applied twice`);
  assert.equal(actor.queueLength, 0);
  assert.equal(db.durableMax, actor.committed.seq, `seed ${seed}: nothing left staged`);
  await actor.shutdown({ code: 1012, snapshot: false });
}

describe("ops that throw", () => {
  test("random sequences of plain ops, throws before and after staging, ask reads, reconnects and resends keep the rules", async () => {
    try {
      for (let seed = 1; seed <= 8; seed++) await run(seed, 30);
      // Faults with a fresh client id between them, so the third has to count across ids.
      for (let seed = 101; seed <= 108; seed++) await run(seed, 30, ["beforeStaging", "newId", "beforeStaging", "newId", "beforeStaging", "newId"]);
      assert.ok(reached.refusals > 0 && reached.throttled > 0 && reached.afterStaging > 0 && reached.newIds > 0 && reached.throttledAcrossIds > 0, `the sequences reached ${JSON.stringify(reached)}`);
    } finally {
      await live?.shutdown({ code: 1012, snapshot: false });
    }
  });
});
