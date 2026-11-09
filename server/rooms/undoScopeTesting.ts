import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { actor as creature, character, member, token } from "#shared/testutil.ts";
import { historyMessageSchema, type HistoryDirection, type HistoryMessage, type HistoryScope } from "#shared/undoContract.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";

type Wire = ServerMessage | HistoryMessage;
type Event = Extract<ServerMessage, { t: "ev" }>;

/** The real actor and fanout run against these rows, without a socket or database. */
export class UndoScopeDb {
  readonly state: RoomState;
  readonly stored: Op[] = [];
  assetLookups = 0;
  durableMax = 0;
  beforeCommit?: () => Promise<void>;
  beforeAssets?: () => Promise<void>;
  assetRows: object[] = [];
  #staged: number[] = [];

  constructor(state: RoomState) {
    this.state = state;
  }

  pool(): Pool {
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state: this.state, schema_version: SNAPSHOT_VERSION }] };
      if (sql.includes("max(seq)")) return { rows: [{ max: String(this.durableMax) }] };
      if (sql.includes("from grants")) return { rows: Object.values(this.state.members).filter((m) => m.kind === "dm").map((m) => ({ member_id: m.id })) };
      if (sql.includes("from assets")) {
        this.assetLookups++;
        await this.beforeAssets?.();
        return { rows: this.assetRows };
      }
      if (sql.startsWith("insert into room_ops")) {
        this.#staged = params[1] as number[];
        this.stored.push(...(params[5] as string[]).map((op) => JSON.parse(op) as Op));
      }
      if (sql.trim() === "commit") {
        await this.beforeCommit?.();
        this.durableMax = Math.max(this.durableMax, ...this.#staged);
        this.#staged = [];
      }
      return { rows: [], rowCount: 0 };
    };
    return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  }
}

/** One stored op row as `room_ops` holds it. `pub` is null on a row from before the room count (counted.ts). */
export type StoredRow = { seq: number; at: string; actorMemberId: string; actorRole: "dm" | "player"; op: unknown; opVersion: number; pub: number | null };

/** One receipt row as `roll_receipts` holds it. */
export type StoredReceipt = { memberId: string; tag: string; part: number; state: string; seq: number | null; code: string | null; message: string | null; at: string };

/**
 * A room as Postgres keeps it across actors, for tests that restart the
 * room: its op rows with their `pub`, its snapshot row, its watermarks, its
 * receipts and `rooms.pub`. It answers the statements loadRoom and the actor
 * run, so a restart is RoomActor.load replaying what was stored
 * (storedActor, restartStored). A commit's writes wait in its transaction
 * and land at COMMIT, after `beforeCommit`, which a test holds to queue ops
 * behind a commit, or throws to fail one, whose answer is then lost and
 * read back. A snapshot written by the actor prunes every row it covers,
 * whatever its age, so a reload never meets a covered row's number.
 */
export class StoredRoomDb extends UndoScopeDb {
  rows: StoredRow[] = [];
  snapshot: { seq: number; state: unknown; version: number };
  /** `rooms.pub`: the room count at the last commit that held ops or watermarks, null before any. */
  pub: number | null;
  readonly watermarks = new Map<string, number>();
  readonly receipts = new Map<string, StoredReceipt>();
  /** How many snapshot rows the actor wrote, in a commit or on its own. */
  snapshotWrites = 0;
  /** Awaited before a snapshot written on its own (outside a commit) lands, so a test can hold it or make it fail. */
  beforeSnapshot?: () => Promise<void>;

  constructor(state: RoomState, opts: { seq?: number; version?: number; rows?: StoredRow[]; pub?: number | null } = {}) {
    super(state);
    this.snapshot = { seq: opts.seq ?? 0, state, version: opts.version ?? SNAPSHOT_VERSION };
    this.rows = [...(opts.rows ?? [])];
    this.pub = opts.pub ?? null;
    this.durableMax = Math.max(this.snapshot.seq, ...this.rows.map((r) => r.seq));
  }

  override pool(): Pool {
    const read = (sql: string, params: unknown[]) => this.#read(sql.trim(), params);
    const connect = async () => {
      let writes: (() => void)[] = [];
      const query = async (text: string, params: unknown[] = []) => {
        const sql = text.trim();
        if (sql === "begin" || sql === "rollback") {
          writes = [];
          return { rows: [], rowCount: 0 };
        }
        if (sql === "commit") {
          await this.beforeCommit?.();
          for (const w of writes.splice(0)) w();
          return { rows: [], rowCount: 0 };
        }
        const write = this.#write(sql, params);
        if (write) {
          writes.push(write);
          return { rows: [], rowCount: 0 };
        }
        return read(sql, params);
      };
      return { query, release: () => undefined };
    };
    const query = async (text: string, params: unknown[] = []) => {
      const sql = text.trim();
      const write = this.#write(sql, params);
      if (write) {
        if (sql.startsWith("insert into room_snapshots")) await this.beforeSnapshot?.();
        write();
        return { rows: [], rowCount: 0 };
      }
      return read(sql, params);
    };
    return { query, connect } as unknown as Pool;
  }

  async #read(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> {
    if (sql.includes("from room_snapshots")) {
      return { rows: [{ seq: String(this.snapshot.seq), state: structuredClone(this.snapshot.state), schema_version: this.snapshot.version, imported_seq: null, pub: this.pub === null ? null : String(this.pub) }] };
    }
    if (sql.includes("from room_log")) return { rows: [{ held: true, incomplete: false }] };
    if (sql.includes("max(seq)")) return { rows: [{ max: String(this.durableMax) }] };
    if (sql.includes("from room_ops")) {
      const after = Number(params[1]);
      return {
        rows: this.rows
          .filter((r) => r.seq > after)
          .sort((a, b) => a.seq - b.seq)
          .map((r) => ({ seq: String(r.seq), at: new Date(r.at), actor_member_id: r.actorMemberId, actor_role: r.actorRole, op: structuredClone(r.op), op_version: r.opVersion, pub: r.pub === null ? null : String(r.pub) })),
      };
    }
    if (sql.includes("from roll_receipts")) {
      const since = Date.parse(params[1] as string);
      const rows = [...this.receipts.values()].filter((r) => Date.parse(r.at) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { rows: rows.map((r) => ({ member_id: r.memberId, tag: r.tag, part: r.part, state: r.state, seq: r.seq === null ? null : String(r.seq), code: r.code, message: r.message, at: new Date(r.at) })) };
    }
    if (sql.includes("from client_watermarks")) {
      if (sql.includes("any(")) {
        const sessions = params[1] as string[];
        const clients = params[2] as string[];
        const rows = [...this.watermarks].filter(([key]) => sessions.some((s, i) => key === `${s}|${clients[i]}`)).map(([key, n]) => ({ session_id: key.split("|")[0], client_id: key.split("|")[1], n: String(n) }));
        return { rows };
      }
      const n = this.watermarks.get(`${params[1]}|${params[2]}`);
      return { rows: n === undefined ? [] : [{ n: String(n) }] };
    }
    if (sql.includes("from grants")) return { rows: Object.values(this.state.members).filter((m) => m.kind === "dm").map((m) => ({ member_id: m.id })) };
    if (sql.includes("from assets")) {
      this.assetLookups++;
      await this.beforeAssets?.();
      return { rows: this.assetRows };
    }
    return { rows: [], rowCount: 0 };
  }

  /** What a write statement does once it lands, or null for a statement that writes nothing kept here. */
  #write(sql: string, params: unknown[]): (() => void) | null {
    if (sql.startsWith("insert into room_ops")) {
      const [, seqs, ats, members, roles, ops, version, pubs] = params as [string, number[], string[], string[], string[], string[], number, number[]];
      this.stored.push(...ops.map((op) => JSON.parse(op) as Op));
      return () => {
        for (const [i, seq] of seqs.entries()) {
          assert.ok(!this.rows.some((r) => r.seq === seq), `room_ops ${seq} is written once`);
          this.rows.push({ seq, at: ats[i]!, actorMemberId: members[i]!, actorRole: roles[i] as "dm" | "player", op: JSON.parse(ops[i]!), opVersion: version, pub: pubs[i] ?? null });
        }
        this.durableMax = Math.max(this.durableMax, ...seqs);
      };
    }
    if (sql.startsWith("update rooms") && sql.includes("pub")) {
      const pub = (sql.includes("name = $2") ? params[2] : params[1]) as number | null;
      return () => {
        if (pub !== null) this.pub = pub;
      };
    }
    if (sql.startsWith("insert into room_snapshots")) {
      const [, seq, json, version] = params as [string, number, string, number];
      return () => {
        this.snapshot = { seq, state: JSON.parse(json), version };
        this.snapshotWrites++;
      };
    }
    if (sql.startsWith("delete from room_ops")) {
      const seq = Number(params[1]);
      return () => {
        this.rows = this.rows.filter((r) => r.seq > seq);
      };
    }
    if (sql.startsWith("insert into roll_receipts")) {
      const [, m, t, p, st, q, c, g, a] = params as [string, string[], string[], number[], string[], (number | null)[], (string | null)[], (string | null)[], string[]];
      return () => {
        for (let i = 0; i < m.length; i++) this.receipts.set(JSON.stringify([m[i], t[i], p[i]]), { memberId: m[i]!, tag: t[i]!, part: p[i]!, state: st[i]!, seq: q[i] ?? null, code: c[i] ?? null, message: g[i] ?? null, at: a[i]! });
      };
    }
    if (sql.startsWith("insert into client_watermarks")) {
      const [, sessions, clients, ns] = params as [string, string[], string[], number[]];
      return () => {
        for (let i = 0; i < sessions.length; i++) {
          const key = `${sessions[i]}|${clients[i]}`;
          this.watermarks.set(key, Math.max(this.watermarks.get(key) ?? 0, Number(ns[i])));
        }
      };
    }
    // The archive, the session stamp and the quota flag: nothing a load reads back here.
    if (/^(with src as|insert into room_log|update sessions|update rooms)/.test(sql)) return () => undefined;
    return null;
  }
}

export function scopeFixture() {
  const dm = member(uuidv7(), "dm");
  const otherDm = member(uuidv7(), "dm");
  const player = member(uuidv7());
  const unrelated = member(uuidv7());
  const state = createInitialState({ roomName: "Scoped history", dm });
  for (const m of [otherDm, player, unrelated]) state.members[m.id] = m;
  const sceneId = state.meta.playerSceneId!;
  const goblin = uuidv7();
  const bree = uuidv7();
  const pc = uuidv7();
  state.tokens[goblin] = token(goblin, { sceneId, name: "Goblin 2", actor: { inline: creature({ dmNotes: "" }) } });
  state.characters[bree] = character(bree, { name: "Bree", ownerIds: [player.id], actor: creature({ dmNotes: "" }) });
  state.tokens[pc] = token(pc, { sceneId, kind: "pc", name: "Bree", x: 8, actor: { ref: bree } });
  return { state, dm, otherDm, player, unrelated, goblin, bree, pc, sceneId };
}

export async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = get();
    if (value !== undefined) return value;
    await delay(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

export async function scopeActor(t: TestContext, state: RoomState, options: ActorDeps["options"] = {}) {
  const db = new UndoScopeDb(state);
  const info: ActorDeps["info"] = { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false };
  const actor = await RoomActor.load({
    pool: db.pool(), info,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    budget: new SnapshotBudget(), gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, ...options },
  });
  assert.ok(actor);
  t.after(async () => {
    db.beforeCommit = undefined;
    db.beforeAssets = undefined;
    await actor.shutdown({ code: 1012, snapshot: false });
  });
  return { actor, db, info, connect: (who: Member, role: "dm" | "player" = who.kind === "dm" ? "dm" : "player", now?: () => number, ackDetails?: true) => ScopeClient.open(actor, who, role, now, ackDetails) };
}

/**
 * An actor on a stored room (StoredRoomDb), shut down when the test ends.
 * restartStored stops it as a deploy or a crash would and loads the room
 * again from what was stored.
 */
export async function storedActor(t: TestContext, db: StoredRoomDb, options: ActorDeps["options"] = {}, log: ActorDeps["log"] = { info() {}, warn() {}, error() {}, debug() {} }) {
  const info: ActorDeps["info"] = { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false };
  const actor = await RoomActor.load({
    pool: db.pool(), info,
    log,
    budget: new SnapshotBudget(), gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, ...options },
  });
  assert.ok(actor);
  t.after(() => actor.shutdown({ code: 1012, snapshot: false }));
  return { actor, db, info, connect: (who: Member, role: "dm" | "player" = who.kind === "dm" ? "dm" : "player", now?: () => number, ackDetails?: true) => ScopeClient.open(actor, who, role, now, ackDetails) };
}

/**
 * Stops a stored room's actor and loads it again. `snapshot` writes the
 * committed state as the snapshot on the way down, as a deploy does, and
 * `flush: false` drops the batch still gathering, as a crash would.
 */
export async function restartStored(t: TestContext, old: { actor: RoomActor; db: StoredRoomDb }, opts: { snapshot: boolean; flush?: boolean }, options: ActorDeps["options"] = {}, log?: ActorDeps["log"]) {
  old.db.beforeCommit = undefined;
  await old.actor.shutdown({ code: 1012, snapshot: opts.snapshot, ...(opts.flush === undefined ? {} : { flush: opts.flush }) });
  return storedActor(t, old.db, options, log);
}

export async function scopeObserver(actor: RoomActor, grant: Pick<ConstructorParameters<typeof Connection>[1], "memberId" | "role" | "display" | "previewOf">, ackDetails?: true) {
  const sent: Wire[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
  const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", ...grant }, "203.0.113.12");
  actor.attach(conn);
  await actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1, ackDetails });
  await until(() => sent.find((m) => m.t === "snapshot"), "observer snapshot");
  return { conn, sent };
}

export class ScopeClient {
  readonly actor: RoomActor;
  readonly conn: Connection;
  readonly sent: Wire[] = [];
  readonly clientId = uuidv7();
  n = 0;

  private constructor(actor: RoomActor, who: Member, role: "dm" | "player", now?: () => number) {
    this.actor = actor;
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => this.sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
    this.conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: who.id, role }, "203.0.113.9", { now });
    actor.attach(this.conn);
  }

  static async open(actor: RoomActor, who: Member, role: "dm" | "player", now?: () => number, ackDetails?: true): Promise<ScopeClient> {
    const client = new ScopeClient(actor, who, role, now);
    await actor.hello(client.conn, { clientId: client.clientId, resumeFrom: 1, ackDetails });
    await until(() => client.sent.find((m) => m.t === "snapshot"), "snapshot");
    return client;
  }

  history(): HistoryMessage {
    const message = this.sent.findLast((m) => m.t === "history");
    assert.ok(message, "a committed snapshot/event must be followed by private history");
    return historyMessageSchema.parse(message);
  }

  head(scope: HistoryScope = "play", direction: HistoryDirection = "undo") {
    const stack = this.history()[scope]?.[direction];
    assert.ok(stack?.head, `expected ${scope} ${direction} head`);
    return stack.head;
  }

  async send(op: unknown, group?: string, groupScope?: "setup"): Promise<Event> {
    const n = ++this.n;
    const dispatch: (conn: Connection, n: number, op: unknown, group?: string, groupScope?: "setup") => Promise<void> = this.actor.op.bind(this.actor);
    await dispatch(this.conn, n, op, group, groupScope);
    return until(() => this.sent.find((m): m is Event => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))), `terminal event ${n}`);
  }

  async apply(op: unknown, group?: string, groupScope?: "setup"): Promise<Event> {
    const event = await this.send(op, group, groupScope);
    assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
    assert.ok(event.acks?.includes(this.n), "accepted command has a terminal ack");
    return event;
  }

  async restore(scope: HistoryScope = "play", direction: HistoryDirection = "undo"): Promise<Event> {
    return this.apply({ t: direction, scope, head: this.head(scope, direction).id });
  }
}
