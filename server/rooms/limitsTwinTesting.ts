import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op, ServerOnlyOp } from "#shared/protocol.ts";
import { hiddenIn, idAt, type Hidden } from "#shared/privTestutil.ts";
import { FrameReader } from "#shared/seqTestutil.ts";
import { rng } from "#shared/testutil.ts";
import type { ActorOptions } from "./actor.ts";
import type { Pool } from "./persistence.ts";
import { each, Room, same as sameFrames, type Event, type Rooms, type Who } from "./numberingTesting.ts";
import { until } from "./undoScopeTesting.ts";

/**
 * The player limits twins (limits.twin.test.ts, ids.twin.test.ts,
 * limits.random.test.ts) on the creature number tests' rooms
 * (numberingTesting.ts): room A and room B differ only where P1's copy
 * never reaches, take the same members' ops at the same clock times, and
 * give P1 and the display the same frames. Each twin's frames are scanned
 * raw for what only that twin holds before they are compared.
 */

/** An op's answer: "taken", "retry" when the room asked the device to send it again later, or its refusal's code and words. */
export type Answer = "taken" | "retry" | { code: string; message: string };

export type Twins = Rooms & { hidden: [Hidden, Hidden]; ids: [IdTable, IdTable] };

/** Opens room A and room B with P1's first chat taken in each, whose batch explores what the fixture shows. */
/** The stored room's snapshot format, and the cutover the server stored before these rooms first load. */
export type Stored = { version?: number; since?: number };

export async function openTwins(t: TestContext, a: RoomState, b: RoomState, hidden: { a?: string[]; b?: string[] } = {}, options: Partial<ActorOptions> = {}, stored: Stored = {}): Promise<Twins> {
  // The rooms check every new thing's id: each test mints its own at the rooms' clock.
  const opts = { idGate: true, ...options };
  const pair = [new Room(t, "A", a, opts, stored.version), new Room(t, "B", b, opts, stored.version)] as unknown as Twins;
  pair.ids = [new IdTable().attach(pair[0]), new IdTable().attach(pair[1])];
  for (const table of pair.ids) table.since = stored.since ?? null;
  for (const room of pair) await room.load();
  pair.hidden = [{ ids: [...(hidden.a ?? [])], names: [] }, { ids: [...(hidden.b ?? [])], names: [] }];
  await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
  return pair;
}

function answerOf(event: Event, n: number): Answer {
  const refusal = event.rejects?.find((r) => r.n === n);
  return refusal ? { code: refusal.code, message: refusal.message ?? "" } : "taken";
}

/** A member's op, sent as Room.send does, and its answer. */
export async function answer(room: Room, who: Who, op: Op): Promise<Answer> {
  const event = await room.send(who, op);
  return answerOf(event, room.clients[who].n);
}

/**
 * Members' ops sent at once, each without waiting for the one before, so
 * they land in one batch, and each op's answer in order. The clock moves a
 * second first, as Room.send moves it, unless `tick` is false.
 */
export async function together(room: Room, sends: ReadonlyArray<readonly [Who, Op]>, tick = true): Promise<Answer[]> {
  if (tick) room.clock.now += 1_000;
  const ns = sends.map(([who, op]) => {
    const client = room.clients[who];
    const n = ++client.n;
    void room.actor.op(client.conn, n, op);
    return [client, n] as const;
  });
  const answers = await Promise.all(
    ns.map(([client, n]) =>
      until((): Answer | undefined => {
        for (const m of client.sent) {
          if (m.t === "retry" && m.n === n) return "retry";
          if (m.t === "ev" && (m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))) return answerOf(m, n);
        }
        return undefined;
      }, `answer ${n}`),
    ),
  );
  await room.settle();
  return answers;
}

/** Each room's answer to the same op, the same in both, and that answer. */
export async function bothAnswer(pair: Twins, who: Who, op: Op | ((room: Room) => Op), what: string): Promise<Answer> {
  const answers: Answer[] = [];
  for (const room of pair) answers.push(await answer(room, who, typeof op === "function" ? op(room) : op));
  assert.deepEqual(answers[0], answers[1], `${what}: the same answer in both rooms`);
  return answers[0]!;
}

/** P1's and the display's frames, scanned raw for each room's own ids, then compared whole. */
export function same(pair: Twins, what: string): void {
  for (const [i, room] of pair.entries()) {
    const frames = room.pages.flatMap((p) => p.sent);
    assert.deepEqual(hiddenIn(frames, pair.hidden[i]!), [], `${what}: ${room.name}: no frame names what only this room holds`);
  }
  sameFrames(pair, what);
}

/**
 * Members' ids alike in both rooms, as a device mints at send: each room
 * draws from its own source seeded alike, and dates each id by its own
 * clock, which both rooms move alike, so the nth id is the same in both.
 */
export class Mint {
  readonly #sources = new Map<Room, () => number>();
  next(room: Room, aheadMs = 0): string {
    let r = this.#sources.get(room);
    if (!r) this.#sources.set(room, (r = rng(61)));
    return idAt(r, room.clock.now + aheadMs);
  }
}

/** The server's op for a player joining as `name`, as the join over HTTP applies it. */
export function joinOp(id: string, name: string): ServerOnlyOp {
  return { t: "sys.memberJoin", member: { id, name, color: "#3366ff", kind: "player", createdAt: new Date(0).toISOString() } };
}

/** How many frames each of a room's pages holds now, for `sameSince`. */
export type Marks = [number[], number[]];

export function marks(pair: Twins): Marks {
  return [pair[0].pages.map((p) => p.sent.length), pair[1].pages.map((p) => p.sent.length)];
}

/**
 * P1's and the display's frames since the marks, scanned raw for each
 * room's own ids, then compared whole: for a step after one the rooms
 * were meant to answer apart, as a DM's two different ops.
 */
export function sameSince(pair: Twins, since: Marks, what: string): void {
  const texts = pair.map((room, i) => {
    const frames = room.pages.flatMap((p, k) => p.sent.slice(since[i]![k] ?? 0).map((f) => [p.label, f] as const));
    assert.deepEqual(hiddenIn(frames.map(([, f]) => f), pair.hidden[i]!), [], `${what}: ${room.name}: no frame names what only this room holds`);
    const reader = new FrameReader();
    return frames.map(([label, f]) => `${label} ${reader.text(f)}`);
  });
  assert.deepEqual(texts[0], texts[1], `${what}: P1 and the display get the same frames in both rooms`);
}

/** One row of `room_ids` as the stand-in keeps it. */
export type StoredId = { roomId: string; id: string; memberId: string; acceptedAt: number; until: number; askUntil: number };

/**
 * `room_ids` and `server_facts` for a room on the stand-in database
 * (undoScopeTesting.ts StoredRoomDb), which keeps neither: rows land at
 * their batch's commit and outlive restarts, as Postgres keeps them, and
 * `since` is the cutover the server stored on its first start.
 */
export class IdTable {
  rows: StoredId[] = [];
  since: number | null = null;

  /** The rows of the statements createIds.ts runs, or null for any other statement. */
  answer(sql: string, params: unknown[], staged: StoredId[] | null): { rows: unknown[]; rowCount: number } | null {
    if (sql.startsWith("insert into room_ids")) {
      const [roomId, ids, members, accepted, until, ask] = params as [string, string[], string[], string[], string[], string[]];
      const rows = ids.map((id, i) => ({ roomId, id, memberId: members[i]!, acceptedAt: Date.parse(accepted[i]!), until: Date.parse(until[i]!), askUntil: Date.parse(ask[i]!) }));
      if (staged) staged.push(...rows);
      else this.#put(rows);
      return { rows: [], rowCount: rows.length };
    }
    if (sql.startsWith("select id, member_id, accepted_at, until, ask_until from room_ids")) {
      const [roomId, at] = params as [string, Date | undefined];
      // Each condition only where the statement names it, so a statement that drops one is read as written.
      const live = /until > \$2/.test(sql) && at !== undefined;
      const rows = this.rows.filter((r) => r.roomId === roomId && (!live || r.until > at.getTime()));
      return { rows: rows.map((r) => ({ id: r.id, member_id: r.memberId, accepted_at: new Date(r.acceptedAt), until: new Date(r.until), ask_until: new Date(r.askUntil) })), rowCount: rows.length };
    }
    if (sql.startsWith("select id from room_ids")) {
      const [roomId, memberId, ids] = params as [string, string, string[]];
      const rows = this.rows.filter((r) => r.roomId === roomId && r.memberId === memberId && ids.includes(r.id));
      return { rows: rows.map((r) => ({ id: r.id })), rowCount: rows.length };
    }
    if (sql.startsWith("delete from room_ids")) {
      const [at, roomId] = params as [Date, string | undefined];
      const byUntil = /(^|[^_])until < \$1/.test(sql);
      const byAsk = /ask_until < \$1/.test(sql);
      const gone = (r: StoredId) => (!byUntil || r.until < at.getTime()) && (!byAsk || r.askUntil < at.getTime());
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => (roomId !== undefined && r.roomId !== roomId) || !gone(r));
      return { rows: [], rowCount: before - this.rows.length };
    }
    if (sql.startsWith("insert into server_facts")) {
      this.since ??= (params[0] as Date).getTime();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("select ids_since from server_facts")) return { rows: this.since === null ? [] : [{ ids_since: new Date(this.since) }], rowCount: 1 };
    return null;
  }

  #put(rows: StoredId[]): void {
    for (const row of rows) if (!this.rows.some((r) => r.roomId === row.roomId && r.id === row.id)) this.rows.push(row);
  }

  /**
   * Puts the table in front of a room's stand-in database, for every load
   * from now on. A transaction's rows wait for its COMMIT, and a ROLLBACK
   * drops them, as the batch's own transaction does.
   */
  attach(room: Room): this {
    const db = room.db;
    const base = db.pool.bind(db);
    db.pool = (): Pool => {
      const pool = base();
      const query = async (text: string, params: unknown[] = []) => this.answer(text.trim(), params, null) ?? pool.query(text, params);
      const connect = async () => {
        const client = await pool.connect();
        let staged: StoredId[] = [];
        return {
          release: () => client.release(),
          query: async (text: string, params: unknown[] = []) => {
            const sql = text.trim();
            if (sql === "begin" || sql === "rollback") staged = [];
            if (sql === "commit") {
              const result = await client.query(text, params);
              this.#put(staged.splice(0));
              return result;
            }
            return this.answer(sql, params, staged) ?? client.query(text, params);
          },
        };
      };
      return { query, connect } as unknown as Pool;
    };
    return this;
  }
}
