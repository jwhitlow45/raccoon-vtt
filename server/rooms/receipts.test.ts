import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { PLAYER_ROLLED_TOO_MUCH, PLAYERS_ROLLED_TOO_MUCH, ROLLING_TOO_FAST, ROOM_ROLLED_TOO_MUCH } from "#shared/limits.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { ClientOp, OpOf, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";
import { DAY_MS, ReceiptBook, admissionCost, tagOf, type Receipt } from "./receipts.ts";

/**
 * Receipts and admission (docs/design-v1-dice.md 1.2 and 4.4): the book's
 * rules on their own, then the actor's pipeline driven by many random
 * sequences of new tags, the same tags sent again from other devices,
 * resends, floods past the budget and the caps, refusals after admission,
 * failed commits, crashes and restarts, against a database stand-in that
 * keeps what a commit wrote.
 */

const ADMISSION = new Set([ROLLING_TOO_FAST, ROOM_ROLLED_TOO_MUCH, PLAYER_ROLLED_TOO_MUCH, PLAYERS_ROLLED_TOO_MUCH]);

function receipt(memberId: string, tag: string, at: number, extra: Partial<Receipt> = {}): Receipt {
  return { memberId, tag, part: 0, state: "committed", seq: 1, at, player: true, ...extra };
}

describe("the receipt book", () => {
  test("the room's cap counts held and staged receipts, and a player's share and the players' together keep the DMs' floor", () => {
    let now = 1_000_000;
    const book = new ReceiptBook(() => now, { perDay: 10, perPlayer: 3, dmFloor: 4 });
    for (let i = 0; i < 3; i++) book.stage(receipt("p1", `a${i}`, now));
    assert.equal(book.refusal("p1", true), PLAYER_ROLLED_TOO_MUCH);
    assert.equal(book.refusal("p2", true), null);
    for (let i = 0; i < 3; i++) book.stage(receipt("p2", `b${i}`, now));
    assert.equal(book.refusal("p3", true), PLAYERS_ROLLED_TOO_MUCH, "players together stop at 10 less the floor of 4");
    assert.equal(book.refusal("dm1", false), null, "the DMs' floor stays free");
    for (let i = 0; i < 4; i++) book.stage(receipt("dm1", `c${i}`, now, { player: false }));
    assert.equal(book.refusal("dm1", false), ROOM_ROLLED_TOO_MUCH);
    assert.equal(book.size, 10);
    now += 1;
    assert.equal(book.refusal("dm1", false), ROOM_ROLLED_TOO_MUCH, "the cap never evicts");
  });

  test("a failed batch gives its slots back, a committed one keeps them, and a staged receipt answers duplicates", () => {
    const now = 5_000;
    const book = new ReceiptBook(() => now, { perDay: 2 });
    const a = receipt("p1", "a", now);
    const b = receipt("p1", "b", now);
    book.stage(a);
    book.stage(b);
    assert.equal(book.find("p1", "a", 0), a);
    assert.equal(book.find("p2", "a", 0), undefined, "another member's tag never meets it");
    assert.equal(book.refusal("p1", true), ROOM_ROLLED_TOO_MUCH);
    book.abandoned([b]);
    assert.equal(book.size, 1);
    assert.equal(book.find("p1", "b", 0), undefined);
    book.committed([a]);
    assert.equal(book.size, 1);
    assert.equal(book.staged, 0);
    assert.equal(book.find("p1", "a", 0), a);
    book.stage(receipt("p1", "c", now));
    assert.throws(() => book.stage(receipt("p1", "c", now)), /twice/);
  });

  test("a receipt counts and answers for exactly 24 hours, a load keeps only the young, and a tag used again after its day replaces it", () => {
    let now = DAY_MS * 3;
    const book = new ReceiptBook(() => now);
    book.load([receipt("p1", "old", now - DAY_MS), receipt("p1", "young", now - DAY_MS + 1), receipt("p1", "new", now)]);
    assert.equal(book.size, 2);
    assert.equal(book.find("p1", "old", 0), undefined);
    assert.ok(book.find("p1", "young", 0));
    now += 1;
    assert.equal(book.find("p1", "young", 0), undefined);
    assert.equal(book.countOf("p1"), 1);
    now += DAY_MS;
    assert.equal(book.find("p1", "new", 0), undefined);
    const again = receipt("p1", "new", now, { seq: 9 });
    book.stage(again);
    book.committed([again]);
    assert.equal(book.find("p1", "new", 0)?.seq, 9);
    assert.equal(book.countOf("p1"), 1);
  });

  test("every op that carries a tag is keyed by it and its part, and a free roll costs a token a roll", () => {
    const roll: OpOf<"dice.roll"> = { t: "dice.roll", tag: "t1", part: 3, to: "all", rolls: [{ formula: "1d20" }, { formula: "2d6" }] };
    assert.deepEqual(tagOf(roll), { tag: "t1", part: 3 });
    assert.deepEqual(tagOf({ ...roll, part: undefined } as OpOf<"dice.roll">), { tag: "t1", part: 0 });
    assert.equal(tagOf({ t: "log.chat", text: "hi" }), null);
    assert.equal(admissionCost(roll), 2);
    assert.equal(admissionCost({ t: "log.chat", text: "hi" }), 1);
  });
});

// ------------------------------------------------------------------ the actor, randomized

type Row = { seq: number; at: Date; actor_member_id: string; actor_role: string; op: unknown; op_version: number };
type StoredReceipt = { member_id: string; tag: string; part: number; state: string; seq: string | null; code: string | null; message: string | null; at: Date };

/**
 * What Postgres keeps of one room, for the statements the actor runs. A
 * commit buffers its writes and applies them at COMMIT, and a test can make
 * the next commits fail before or after they apply, as a dropped
 * connection would.
 */
class Store {
  readonly state: RoomState;
  ops: Row[] = [];
  receipts = new Map<string, StoredReceipt>();
  watermarks = new Map<string, number>();
  dmGrants: string[];
  /** Commits to fail cleanly, before anything applies. */
  failNext = 0;

  constructor(state: RoomState, dmGrants: string[]) {
    this.state = state;
    this.dmGrants = dmGrants;
  }

  pool(): Pool {
    const query = (sql: string, params: unknown[] = []) => Promise.resolve().then(() => this.#read(sql.trim(), params));
    const connect = () =>
      Promise.resolve({
        writes: [] as (() => void)[],
        query(this: { writes: (() => void)[] }, sql: string, params: unknown[] = []) {
          return Promise.resolve().then(() => store.#write(this.writes, sql.trim(), params));
        },
        release: () => undefined,
      });
    const store = this;
    return { query, connect } as unknown as Pool;
  }

  #read(sql: string, params: unknown[]): { rows: unknown[]; rowCount?: number } {
    if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state: this.state, schema_version: SNAPSHOT_VERSION }] };
    if (sql.includes("max(seq)")) return { rows: [{ max: String(this.ops.at(-1)?.seq ?? 0) }] };
    if (sql.includes("from room_ops")) return { rows: this.ops.map((r) => ({ ...r, seq: String(r.seq) })) };
    if (sql.includes("from roll_receipts")) {
      const since = new Date(params[1] as string).getTime();
      return { rows: [...this.receipts.values()].filter((r) => r.at.getTime() > since).sort((a, b) => a.at.getTime() - b.at.getTime()) };
    }
    if (sql.includes("from client_watermarks")) {
      const n = this.watermarks.get(`${params[1]}|${params[2]}`);
      return { rows: n === undefined ? [] : [{ n: String(n) }] };
    }
    if (sql.includes("from grants")) return { rows: this.dmGrants.map((member_id) => ({ member_id })) };
    return { rows: [], rowCount: 0 };
  }

  #write(writes: (() => void)[], sql: string, params: unknown[]): { rows: unknown[] } {
    if (sql === "begin") writes.length = 0;
    else if (sql === "rollback") writes.length = 0;
    else if (sql === "commit") {
      if (this.failNext > 0) {
        this.failNext--;
        writes.length = 0;
        // Before COMMIT ran: a clean failure, which the actor retries.
        throw new Error("could not write");
      }
      for (const w of writes.splice(0)) w();
    } else if (sql.startsWith("insert into room_ops")) {
      const [, seqs, ats, members, roles, ops, version] = params as [string, number[], string[], string[], string[], string[], number];
      writes.push(() => {
        for (const [i, seq] of seqs.entries()) {
          assert.ok(!this.ops.some((r) => r.seq === seq), `seq ${seq} is written once`);
          this.ops.push({ seq, at: new Date(ats[i]!), actor_member_id: members[i]!, actor_role: roles[i]!, op: JSON.parse(ops[i]!), op_version: version });
        }
      });
    } else if (sql.startsWith("insert into roll_receipts")) {
      const [, m, t, p, s, q, c, g, a] = params as [string, string[], string[], number[], string[], (number | null)[], (string | null)[], (string | null)[], string[]];
      writes.push(() => {
        for (let i = 0; i < m.length; i++) {
          this.receipts.set(JSON.stringify([m[i], t[i], p[i]]), { member_id: m[i]!, tag: t[i]!, part: p[i]!, state: s[i]!, seq: q[i] === null ? null : String(q[i]), code: c[i]!, message: g[i]!, at: new Date(a[i]!) });
        }
      });
    } else if (sql.startsWith("insert into client_watermarks")) {
      const [, sessions, clients, ns] = params as [string, string[], string[], number[]];
      writes.push(() => {
        for (let i = 0; i < sessions.length; i++) {
          const key = `${sessions[i]}|${clients[i]}`;
          this.watermarks.set(key, Math.max(this.watermarks.get(key) ?? 0, ns[i]!));
        }
      });
    }
    return { rows: [] };
  }
}

type Answer = { kind: "ack" } | { kind: "refused"; code: string; message: string } | { kind: "unknown" };

/** One device of one member: a session, a client id, its op numbers and what it has not heard back about. */
type Device = {
  member: Member;
  role: "dm" | "player";
  sessionId: string;
  clientId: string;
  nextN: number;
  pending: Map<number, { op: ClientOp; key: string }>;
  conn: Connection | null;
  sent: ServerMessage[];
  heard: number;
};

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe("receipts and admission in the actor, randomized (docs/design-v1-dice.md 1.2)", () => {
  test("every tag applies once, admission refusals leave no receipt, the caps hold, and a settled tag answers as it settled", async () => {
    const CAPS = { perDay: 40, perPlayer: 12, dmFloor: 10 };
    /** What the runs did, so the test fails if the sequences stop reaching a path it claims to cover. */
    const seen = new Map<string, number>();
    const saw = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const dm: Member = { id: uuidv7(), rev: 0, name: "DM", color: "#336699", kind: "dm", createdAt: new Date().toISOString() };
      let state = createInitialState({ roomName: "Receipts", dm });
      const players: Member[] = ["Ana", "Bo", "Cy"].map((name) => ({ id: uuidv7(), rev: 0, name, color: "#336699", kind: "player", createdAt: new Date().toISOString() }));
      const env = { seq: 1, at: new Date().toISOString() };
      for (const p of players) {
        const joined = applyOp(state, { t: "sys.memberJoin", member: { id: p.id, name: p.name, color: p.color, kind: "player", createdAt: p.createdAt } }, { memberId: "server", role: "dm" }, env);
        assert.ok(joined.ok);
        state = joined.state;
      }
      const thorn = uuidv7();
      const placed = applyOp(state, { t: "token.create", token: { id: thorn, sceneId: state.meta.playerSceneId!, kind: "pc", name: "Thorn", size: "medium", x: 1, y: 1, ownerIds: [players[0]!.id], actor: { inline: { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } } }, { memberId: dm.id, role: "dm" }, env);
      assert.ok(placed.ok);
      const store = new Store(placed.state, [dm.id]);
      let clock = Date.now();
      let draws = 0;
      // The sockets' own rate never limits here: it reads a clock a second ahead at every look.
      let socketClock = 0;
      const options: ActorDeps["options"] = {
        batchMs: 1,
        retryBaseMs: 1,
        retryMaxMs: 4,
        snapshotIdleMs: 3_600_000,
        grantRecheckMs: 3_600_000,
        roomOpsPerSec: 1_000_000,
        now: () => clock,
        receiptCaps: CAPS,
        draw: (sides) => {
          draws++;
          return 1 + (draws % sides);
        },
      };
      const load = async () => {
        const actor = await RoomActor.load({ pool: store.pool(), info: { roomId: "RECEIPTS", pinned: false, createdIp: null, readOnly: false }, log: quiet, budget: new SnapshotBudget(), gateway: {} as RoomGateway, options });
        assert.ok(actor);
        return actor;
      };
      let actor = await load();
      const devices: Device[] = [];
      const deviceOf = (member: Member, role: "dm" | "player"): Device => ({ member, role, sessionId: uuidv7(), clientId: uuidv7(), nextN: 1, pending: new Map(), conn: null, sent: [], heard: 0 });
      for (const m of [dm, ...players]) {
        devices.push(deviceOf(m, m.kind === "dm" ? "dm" : "player"));
        devices.push(deviceOf(m, m.kind === "dm" ? "dm" : "player"));
      }

      /** What each tag key's first settled answer was, and every answer heard, by key. */
      const settledBy = new Map<string, Answer>();
      const answers: { key: string; answer: Answer; admittedFresh: boolean }[] = [];
      const tags: { key: string; op: ClientOp; member: Member }[] = [];
      /** Per op number of a device: whether its processing staged a new receipt, and drew. */
      const effects = new Map<string, { receiptsBefore: number; receiptsAfter: number; drew: boolean }>();

      const connect = async (d: Device) => {
        const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => d.sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
        d.sent = [];
        d.heard = 0;
        d.conn = new Connection(socket as never, { sessionId: d.sessionId, roomId: "RECEIPTS", memberId: d.member.id, role: d.role }, "203.0.113.9", { now: () => (socketClock += 1_000) });
        actor.attach(d.conn);
        const resumeFrom = Math.min(d.nextN, ...d.pending.keys());
        await actor.hello(d.conn, { clientId: d.clientId, resumeFrom });
      };

      /**
       * Sends one op and waits until the actor has handled it: an op that
       * arrives while a commit is in flight waits in the queue. Nothing else
       * is sent meanwhile, and a commit moves no count, so the change in the
       * receipt count and the draws are this op's alone.
       */
      const send = async (d: Device, n: number, op: ClientOp) => {
        const before = actor.receiptCounts().room;
        const drawsBefore = draws;
        await actor.op(d.conn!, n, op);
        for (let i = 0; i < 500 && actor.queueLength > 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
        effects.set(`${d.clientId}:${n}`, { receiptsBefore: before, receiptsAfter: actor.receiptCounts().room, drew: draws > drawsBefore });
      };
      const admittedFresh = (d: Device, n: number) => {
        const effect = effects.get(`${d.clientId}:${n}`);
        return effect !== undefined && effect.receiptsAfter === effect.receiptsBefore + 1;
      };

      /** Reads every message a device has not read, settling its pending ops. */
      const hear = (d: Device) => {
        for (; d.heard < d.sent.length; d.heard++) {
          const msg = d.sent[d.heard]!;
          if (msg.t === "snapshot") {
            for (const [n, p] of [...d.pending]) {
              if (n > msg.watermark) continue;
              d.pending.delete(n);
              saw("settled by a snapshot");
              answers.push({ key: p.key, answer: { kind: "unknown" }, admittedFresh: admittedFresh(d, n) });
            }
            d.nextN = Math.max(d.nextN, msg.watermark + 1);
          }
          if (msg.t !== "ev") continue;
          for (const n of msg.acks ?? []) {
            const p = d.pending.get(n);
            if (!p) continue;
            d.pending.delete(n);
            record(d, n, p.key, { kind: "ack" });
          }
          for (const rej of msg.rejects ?? []) {
            const p = d.pending.get(rej.n);
            if (!p) continue;
            d.pending.delete(rej.n);
            record(d, rej.n, p.key, { kind: "refused", code: rej.code, message: rej.message });
          }
        }
      };

      const record = (d: Device, n: number, key: string, answer: Answer) => {
        const effect = effects.get(`${d.clientId}:${n}`);
        const fresh = admittedFresh(d, n);
        answers.push({ key, answer, admittedFresh: fresh });
        if (effect) {
          const admissionRefusal = answer.kind === "refused" && ADMISSION.has(answer.message);
          if (admissionRefusal) assert.equal(effect.receiptsAfter, effect.receiptsBefore, `seed ${seed}: an admission refusal leaves the receipt count as it was`);
          if (answer.kind === "refused") assert.equal(effect.drew, false, `seed ${seed}: a refused op draws nothing`);
        }
        if (answer.kind === "ack") saw(fresh ? "applied" : "duplicate answered with its ack");
        else if (answer.kind === "refused") saw(ADMISSION.has(answer.message) ? `admission: ${answer.message}` : fresh ? "refused after admission" : "duplicate answered with its refusal");
        const first = settledBy.get(key);
        if (fresh) {
          settledBy.set(key, answer);
        } else if (first && answer.kind !== "unknown" && !(answer.kind === "refused" && ADMISSION.has(answer.message))) {
          assert.deepEqual(answer, first, `seed ${seed}: a settled tag answers as it settled`);
        }
      };

      const settle = async () => {
        for (let i = 0; i < 200; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          for (const d of devices) hear(d);
          if (devices.every((d) => d.pending.size === 0) || actor.closed) break;
        }
      };

      const checkCaps = () => {
        const counts = actor.receiptCounts();
        assert.ok(counts.room <= CAPS.perDay, `seed ${seed}: the room holds ${counts.room}`);
        assert.ok(counts.players <= CAPS.perDay - CAPS.dmFloor, `seed ${seed}: players hold ${counts.players}`);
        for (const p of players) assert.ok(actor.receiptCounts(p.id).member <= CAPS.perPlayer, `seed ${seed}: a player holds ${actor.receiptCounts(p.id).member}`);
      };

      for (const d of devices) await connect(d);
      await settle();

      for (let step = 0; step < 120; step++) {
        const d = pick(r, devices);
        const roll = chance(r, 0.15) ? "theft" : "free";
        if (chance(r, 0.55) || tags.length === 0) {
          // A new tag, sometimes a flood of them.
          const count = chance(r, 0.15) ? int(r, 5, 25) : 1;
          for (let i = 0; i < count; i++) {
            const tag = uuidv7();
            const rolls = Array.from({ length: int(r, 1, 4) }, () => ({ formula: pick(r, ["1d20+2", "2d6", "1d8+1d4"]), ...(roll === "theft" ? { creature: { tokenId: thorn } } : {}) }));
            const op: ClientOp = { t: "dice.roll", tag, to: pick(r, ["all", "dm"] as const), rolls };
            const key = JSON.stringify([d.member.id, tag, 0]);
            tags.push({ key, op, member: d.member });
            const n = d.nextN++;
            d.pending.set(n, { op, key });
            await send(d, n, op);
          }
        } else {
          // A tag sent again, from this member's other device, by a new op number.
          const mine = tags.filter((t) => t.member.id === d.member.id);
          if (mine.length > 0) {
            const again = pick(r, mine);
            const n = d.nextN++;
            d.pending.set(n, { op: again.op, key: again.key });
            await send(d, n, again.op);
          }
        }
        checkCaps();
        if (chance(r, 0.3)) clock += int(r, 0, 4_000);
        if (chance(r, 0.05)) clock += 10 * 60_000;
        if (chance(r, 0.1)) {
          store.failNext = int(r, 1, 2);
          saw("failed commit");
        }
        if (chance(r, 0.4)) await settle();
        if (chance(r, 0.06)) {
          // A restart: a deploy commits what it holds, a crash loses the batch being built.
          const crash = chance(r, 0.5);
          saw(crash ? "crash" : "restart");
          await settle();
          await actor.shutdown({ code: 1012, snapshot: false, flush: !crash });
          actor = await load();
          for (const dev of devices) {
            await connect(dev);
            await settle();
            for (const [n, p] of [...dev.pending].sort((a, b) => a[0] - b[0])) await send(dev, n, p.op);
          }
          await settle();
          checkCaps();
        }
      }
      await settle();
      for (const d of devices) assert.equal(d.pending.size, 0, `seed ${seed}: every op was answered`);

      // Each tag applied at most once: one stored roll per member, tag and part.
      const applied = new Map<string, number>();
      for (const row of store.ops) {
        const op = row.op as { t: string; asked?: { tag: string; part?: number } };
        if (op.t !== "sys.dice" || !op.asked) continue;
        const key = JSON.stringify([row.actor_member_id, op.asked.tag, op.asked.part ?? 0]);
        applied.set(key, (applied.get(key) ?? 0) + 1);
      }
      for (const [key, times] of applied) assert.equal(times, 1, `seed ${seed}: ${key} applied ${times} times`);
      // Every stored roll has its committed receipt, and every committed receipt names a stored roll of its own tag.
      for (const [key] of applied) assert.equal(store.receipts.get(key)?.state, "committed", `seed ${seed}: ${key} has its receipt`);
      for (const [key, rec] of store.receipts) {
        if (rec.state !== "committed") continue;
        const row = store.ops.find((o) => String(o.seq) === rec.seq);
        const asked = (row?.op as { asked?: { tag: string } } | undefined)?.asked;
        assert.equal(asked?.tag, rec.tag, `seed ${seed}: ${key}'s seq names its own roll`);
        assert.equal(row?.actor_member_id, rec.member_id);
      }
      // A receipt is written only for what was admitted: every admission refusal heard has none unless a later send was admitted.
      for (const a of answers) {
        if (a.answer.kind === "refused" && ADMISSION.has(a.answer.message) && !answers.some((b) => b.key === a.key && b.admittedFresh)) {
          assert.equal(store.receipts.has(a.key), false, `seed ${seed}: a refusal at admission left a receipt`);
        }
      }
      // Something of each kind happened, so the run tested what it says.
      assert.ok(answers.some((a) => a.answer.kind === "ack"), `seed ${seed}: some rolls landed`);
      await actor.shutdown({ code: 1012, snapshot: false });
    }
    for (const what of [
      "applied",
      "duplicate answered with its ack",
      "duplicate answered with its refusal",
      "refused after admission",
      `admission: ${ROLLING_TOO_FAST}`,
      `admission: ${ROOM_ROLLED_TOO_MUCH}`,
      `admission: ${PLAYER_ROLLED_TOO_MUCH}`,
      "crash",
      "restart",
      "failed commit",
    ]) {
      assert.ok((seen.get(what) ?? 0) > 0, `the runs never reached: ${what}`);
    }
  });
});
