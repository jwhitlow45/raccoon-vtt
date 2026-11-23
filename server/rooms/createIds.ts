import { ID_TIME_REFUSED, idTime, isUuidv7, sealedTime, type IdKey } from "#shared/ids.ts";
import { ID_BUDGET, ID_PAGE_OLD, ID_SEAL_GRACE_MS, ID_TIME, IDS_TOO_FAST } from "#shared/limits.ts";
import type { RefusalCode } from "#shared/protocol.ts";
import type { Queryable } from "../auth/tx.ts";
import type { Clock } from "./budgets.ts";

/**
 * The ids of new things (shared/protocol.ts mintedIds): every id a device
 * makes for a new thing, row, condition or ask is taken only while it is
 * dated near the server's clock, and only once.
 *
 * 1. A new id is a version 8 id the room reads under the sender's key
 *    (idKeys.ts, shared/ids.ts sealedTime), so its time can be read. A
 *    version 7 id is taken only from a socket that holds no key
 *    (`hello.sealIds`), and only until `server_facts.sealed_since` plus
 *    ID_SEAL_GRACE_MS: from then such a socket is sent ID_PAGE_OLD. Only a
 *    live op is asked this: stored rows replay as they were taken.
 * 2. Its time is at most ID_TIME.aheadMs ahead of the server's clock and at
 *    most ID_TIME.behindMs behind it, and in the window after the gate's
 *    first cutover (`server_facts.ids_since`) never before it.
 * 3. Every id an applied op brought is recorded in `room_ids` in the
 *    batch's own transaction, with its member and when it was taken, held
 *    from the time step 1 read. An op refused after this gate records
 *    nothing. The row is read here until `until`, the last moment step 2
 *    could pass the id again, and answers the device's own question after a
 *    reconnect until `ask_until`.
 * 4. An id with a row answers `gone`, as an id the room holds does
 *    (permissions.ts), whatever became of its thing since.
 * 5. After an op applies, a version 7 id in a field that holds a new
 *    thing's key or an id inside an existing thing (newIdPaths.ts) refuses
 *    the op, from a keyed socket always and from any socket after the
 *    cutover's grace.
 *
 * Each member brings at most ID_BUDGET ids in any window, counted over the
 * rows they were given, whatever became of their things since. The
 * server's own ops have no budget.
 */

/** How long after an id's own time, or its taking when that is later, step 2 could still pass it: how long its row is read here. */
export const ID_HELD_MS = ID_TIME.behindMs + ID_TIME.aheadMs;
/** The words of `gone`, as permissions.ts answers an id the room holds. */
export const ID_TAKEN = "that is not here";
/** The member a row of the server's own ids names, which no budget counts. */
export const SERVER_MEMBER = "server";

export type IdRow = { id: string; memberId: string; acceptedAt: number; until: number; askUntil: number };

/**
 * The latest `until` a row is written with, 9999-12-31T23:59:59Z: a time read
 * under a key by a chance tag match lies anywhere in 48 bits, past what a
 * stored date holds. A row so far out answers as one that never ends.
 */
export const LATEST_UNTIL = Date.UTC(9999, 11, 31, 23, 59, 59);

/** The row an id taken at `acceptedAt` gets, `time` being the id's own as step 1 read it. */
export function idRow(id: string, memberId: string, acceptedAt: number, time: number): IdRow {
  return { id, memberId, acceptedAt, until: Math.min(Math.max(time, acceptedAt) + ID_HELD_MS, LATEST_UNTIL), askUntil: acceptedAt + ID_TIME.askMs };
}

/**
 * The server's row for a version 8 id recorded without the gate
 * (shared/protocol.ts ID_RULES `recorded`): held until the latest time it
 * reads under any of `keys`, every current member's and the server's, or
 * its taking when that is later, plus ID_HELD_MS. So whichever member's
 * key reads it, step 2 passes it only while its row still answers `gone`.
 * A key that matches by chance reads a time uniform over 48 bits, which
 * only holds the row longer.
 */
export function recordedRow(id: string, acceptedAt: number, keys: readonly IdKey[]): IdRow {
  let latest = acceptedAt;
  for (const key of keys) {
    const t = sealedTime(key, id);
    if (t !== null && t > latest) latest = t;
  }
  return idRow(id, SERVER_MEMBER, acceptedAt, latest);
}

/** How often the gate forgets members' ids past the budget's window, beside its own reads of a member's budget. */
const BUDGET_SWEEP_MS = 60_000;

/** Who brings the ids: a member's budget is by their role, and the server has none. */
export type IdSender = { memberId: string; role: "player" | "dm" } | "server";

export type IdVerdict = { ok: true } | { ok: false; code: RefusalCode; message: string };

/** The gate's answer on minted ids: each one's time as step 1 read it, which its row is held from. */
export type MintedVerdict = { ok: true; times: ReadonlyMap<string, number> } | { ok: false; code: RefusalCode; message: string };

/**
 * What the gate reads a sender's ids with: whether their socket holds a key
 * (`hello.sealIds`), and the key their version 8 ids are read under, the
 * member's or, for the server's own, the room's server key.
 */
export type IdSeal = { keyed: boolean; key: IdKey };

const NO_TIMES: ReadonlyMap<string, number> = new Map();

/**
 * The room's gate rows in memory, loaded with the room, and the rows of
 * batches not yet durable, which hold their ids from the moment their op
 * is staged and count against their member's budget at once.
 */
export class IdGate {
  readonly #now: Clock;
  /** Committed rows step 4 still reads, by id, with `until`. */
  #held = new Map<string, number>();
  /** The same rows in the order they came, which expiry walks from the front. */
  #order: IdRow[] = [];
  #start = 0;
  /**
   * Committed rows held past what an id the clock admits is held for, by
   * id, with `until`: an id dated far ahead, as a hash id of an old room's
   * state can be, seeded at its first load. Kept out of `#order`, where
   * one would hold back every row after it for as long.
   */
  #far = new Map<string, number>();
  #farNext = Infinity;
  /** Rows of ops staged in batches not yet durable. */
  #staged = new Map<string, IdRow>();
  /** When each member's rows of the last window were taken, held and staged, oldest first. */
  #byMember = new Map<string, number[]>();
  #sweptAt = -Infinity;
  /** The cutover, or null where it could not be read, as with a test's stand-in pool. */
  readonly since: number | null;
  /**
   * When this server first ran a build that makes version 8 ids
   * (`server_facts.sealed_since`), or null where it could not be read. From
   * ID_SEAL_GRACE_MS after it, no socket's version 7 id of a new thing is
   * taken.
   */
  readonly sealedSince: number | null;

  constructor(now: Clock, since: number | null = null, sealedSince: number | null = null) {
    this.#now = now;
    this.since = since;
    this.sealedSince = sealedSince;
  }

  /** Whether the cutover's grace has passed, so no version 7 id of a new thing is taken. */
  sealedOnly(): boolean {
    return this.sealedSince !== null && this.#now() >= this.sealedSince + ID_SEAL_GRACE_MS;
  }

  /**
   * The refusal of a version 7 id of a new thing, or null where it is taken:
   * a keyed socket's always, in the words its page retries on, and any
   * other's once the cutover's grace has passed, in ID_PAGE_OLD's.
   */
  refusesV7(keyed: boolean): { ok: false; code: RefusalCode; message: string } | null {
    if (keyed) return { ok: false, code: "invalid", message: ID_TIME_REFUSED };
    return this.sealedOnly() ? { ok: false, code: "invalid", message: ID_PAGE_OLD } : null;
  }

  /** The room's gate rows as stored, at load. */
  load(rows: readonly IdRow[]): void {
    for (const row of [...rows].sort((a, b) => a.acceptedAt - b.acceptedAt)) {
      this.#hold(row);
      this.#count(row);
    }
  }

  /** Whether step 4 reads this id as taken: a staged row, or a committed one before its `until`. */
  taken(id: string): boolean {
    this.#expire();
    return this.#staged.has(id) || Math.max(this.#held.get(id) ?? 0, this.#far.get(id) ?? 0) > this.#now();
  }

  /**
   * The gate for the ids one op brings: the shape and the key (a live op's
   * only), the clock, a row, then the budget, each over every id before the
   * next. It reserves nothing: the actor stages the rows once the op
   * applied, each held from the time read here.
   */
  check(ids: readonly string[], sender: IdSender, seal: IdSeal, live = true): MintedVerdict {
    if (ids.length === 0) return { ok: true, times: NO_TIMES };
    const now = this.#now();
    const behind = now - ID_TIME.behindMs;
    const earliest = this.since !== null && this.since > behind ? this.since : behind;
    const times = new Map<string, number>();
    for (const id of ids) {
      let time: number | null;
      if (isUuidv7(id)) {
        const refused = live ? this.refusesV7(seal.keyed) : null;
        if (refused) return refused;
        time = idTime(id);
      } else {
        time = sealedTime(seal.key, id);
      }
      if (time === null) {
        if (live) return { ok: false, code: "invalid", message: ID_TIME_REFUSED };
        continue;
      }
      if (time > now + ID_TIME.aheadMs || time < earliest) return { ok: false, code: "invalid", message: ID_TIME_REFUSED };
      times.set(id, time);
    }
    for (const id of ids) if (this.taken(id)) return { ok: false, code: "gone", message: ID_TAKEN };
    if (sender !== "server" && this.spent(sender.memberId) + new Set(ids).size > ID_BUDGET[sender.role]) return { ok: false, code: "quota", message: IDS_TOO_FAST };
    return { ok: true, times };
  }

  /**
   * The clock's one check on ids recorded without the gate (shared/protocol.ts
   * ID_RULES `recorded`): a version 7 id may be dated any time before now,
   * as a group save's plan applied long after it was made, but no further
   * ahead than a minted id may be, and none is taken once the cutover's
   * grace has passed. A version 8 id is never refused for a time read
   * under any key: its row is held past every time it reads to
   * (recordedRow). Like step 2 it reads no row, since it runs before the
   * sender's permissions: a plan applied again is answered by its receipt
   * before the gate.
   */
  checkRecorded(ids: readonly string[], keyed: boolean): IdVerdict {
    const latest = this.#now() + ID_TIME.aheadMs;
    for (const id of ids) {
      const time = idTime(id);
      if (time === null) continue;
      if (time > latest) return { ok: false, code: "invalid", message: ID_TIME_REFUSED };
      if (this.sealedOnly()) return { ok: false, code: "invalid", message: keyed ? ID_TIME_REFUSED : ID_PAGE_OLD };
    }
    return { ok: true };
  }

  /** The rows of an op that applied, staged with its batch: from now their ids are taken and count against the budget. */
  stage(rows: readonly IdRow[]): void {
    for (const row of rows) {
      if (this.#staged.has(row.id)) continue;
      this.#staged.set(row.id, row);
      this.#count(row);
    }
  }

  /** The batch holding these staged rows is durable. */
  committed(rows: readonly IdRow[]): void {
    for (const row of rows) {
      if (this.#staged.get(row.id) !== row) continue;
      this.#staged.delete(row.id);
      this.#hold(row);
    }
  }

  /** The batch holding these staged rows will never commit: their ids are free again and their budget comes back. */
  abandoned(rows: readonly IdRow[]): void {
    for (const row of rows) {
      if (this.#staged.get(row.id) !== row) continue;
      this.#staged.delete(row.id);
      const times = this.#byMember.get(row.memberId);
      const at = times?.lastIndexOf(row.acceptedAt) ?? -1;
      if (times && at >= 0) times.splice(at, 1);
    }
  }

  /** A member's ids taken in the last window, staged ones included: what their budget has spent. */
  spent(memberId: string): number {
    const times = this.#byMember.get(memberId);
    if (!times) return 0;
    const from = this.#now() - ID_BUDGET.windowMs;
    let old = 0;
    while (old < times.length && times[old]! <= from) old++;
    if (old > 0) times.splice(0, old);
    if (times.length === 0) this.#byMember.delete(memberId);
    return times.length;
  }

  /** Staged rows, for the tests. */
  get stagedCount(): number {
    return this.#staged.size;
  }

  /** Committed rows held in memory, for the tests. */
  get heldCount(): number {
    return this.#held.size + this.#far.size;
  }

  /** Members whose ids of the last window the budget still keeps, for the tests. */
  get budgetMembers(): number {
    return this.#byMember.size;
  }

  #hold(row: IdRow): void {
    if (row.until - row.acceptedAt <= ID_HELD_MS + ID_TIME.aheadMs) {
      this.#held.set(row.id, row.until);
      this.#order.push(row);
      return;
    }
    this.#far.set(row.id, Math.max(row.until, this.#far.get(row.id) ?? 0));
    this.#farNext = Math.min(this.#farNext, row.until);
  }

  #count(row: IdRow): void {
    if (row.memberId === SERVER_MEMBER) return;
    let times = this.#byMember.get(row.memberId);
    if (!times) this.#byMember.set(row.memberId, (times = []));
    // Rows are staged in the order they are taken, and loaded rows sorted, so the list stays oldest first.
    times.push(row.acceptedAt);
  }

  /**
   * Rows past `until` leave memory in the order they came. One a few
   * seconds later than the row after it holds that one back as long, which
   * changes no answer: step 2 refuses an id before step 4 reads its row.
   * A row held far longer waits apart (`#far`), and a member's budget
   * forgets ids past its window, so neither keeps memory for a member who
   * never sends again.
   */
  #expire(): void {
    const now = this.#now();
    while (this.#start < this.#order.length) {
      const row = this.#order[this.#start]!;
      if (row.until > now) break;
      this.#start++;
      if (this.#held.get(row.id) === row.until) this.#held.delete(row.id);
    }
    if (this.#start > 1024 && this.#start * 2 > this.#order.length) {
      this.#order = this.#order.slice(this.#start);
      this.#start = 0;
    }
    if (this.#farNext <= now) {
      this.#farNext = Infinity;
      for (const [id, until] of this.#far) {
        if (until <= now) this.#far.delete(id);
        else this.#farNext = Math.min(this.#farNext, until);
      }
    }
    if (now - this.#sweptAt >= BUDGET_SWEEP_MS) {
      this.#sweptAt = now;
      for (const memberId of [...this.#byMember.keys()]) this.spent(memberId);
    }
  }
}

type StoredIdRow = { id: string; member_id: string; accepted_at: Date; until: Date; ask_until: Date };

function rowOf(r: StoredIdRow): IdRow {
  return { id: r.id, memberId: r.member_id, acceptedAt: r.accepted_at.getTime(), until: r.until.getTime(), askUntil: r.ask_until.getTime() };
}

/** The room's gate rows, those step 4 still reads, at load. Rows past `until` stay in the table for the device's question alone. */
export async function loadIdRows(q: Queryable, roomId: string, now: number): Promise<IdRow[]> {
  const { rows } = await q.query<StoredIdRow>("select id, member_id, accepted_at, until, ask_until from room_ids where room_id = $1 and until > $2", [roomId, new Date(now)]);
  return rows.map(rowOf);
}

/** Writes rows in the caller's transaction. An id recorded already keeps its first row, so no batch can fail on one. */
export async function recordIds(q: Queryable, roomId: string, rows: readonly IdRow[]): Promise<void> {
  if (rows.length === 0) return;
  await q.query(
    `insert into room_ids (room_id, id, member_id, accepted_at, until, ask_until)
     select $1, i, m, a::timestamptz, u::timestamptz, k::timestamptz
     from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as x(i, m, a, u, k)
     on conflict (room_id, id) do nothing`,
    [roomId, rows.map((r) => r.id), rows.map((r) => r.memberId), rows.map((r) => iso(r.acceptedAt)), rows.map((r) => iso(r.until)), rows.map((r) => iso(r.askUntil))],
  );
}

/** Which of these ids the table holds for this member: a device's question after a reconnect, read by the room, member and id index. */
export async function heldIds(q: Queryable, roomId: string, memberId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await q.query<{ id: string }>("select id from room_ids where room_id = $1 and member_id = $2 and id = any($3::text[])", [roomId, memberId, [...ids]]);
  return new Set(rows.map((r) => r.id));
}

/** Deletes the rows past both their times, of one room or of every room. */
export async function pruneIds(q: Queryable, now: number, roomId?: string): Promise<number> {
  const at = new Date(now);
  const result =
    roomId === undefined
      ? await q.query("delete from room_ids where until < $1 and ask_until < $1", [at])
      : await q.query("delete from room_ids where room_id = $2 and until < $1 and ask_until < $1", [at, roomId]);
  return result.rowCount ?? 0;
}

/**
 * The cutovers: `since`, when this server first loaded a room on a build
 * that keeps the table, and `sealedSince`, when it first loaded one on a
 * build that makes version 8 ids, each written once and read by every room
 * after. The insert names `ids_since` alone, as an older build's does, and
 * `sealed_since` is set by its own update, so a row from before it takes
 * the time too. Null where the table answers nothing, as a test's stand-in
 * pool does.
 */
export async function idsSince(q: Queryable, now: number): Promise<{ since: number | null; sealedSince: number | null }> {
  await q.query("insert into server_facts (one, ids_since) values (true, $1) on conflict (one) do nothing", [new Date(now)]);
  await q.query("update server_facts set sealed_since = $1 where sealed_since is null", [new Date(now)]);
  const { rows } = await q.query<{ ids_since: Date; sealed_since: Date | null }>("select ids_since, sealed_since from server_facts where one");
  const at = (value: unknown) => (value instanceof Date ? value.getTime() : null);
  return { since: at(rows[0]?.ids_since), sealedSince: at(rows[0]?.sealed_since) };
}

/**
 * The rows a room's first load on this build gives the ids its state holds
 * that step 2 could still pass: every version 7 id it names, as a key or a
 * value, dated after `now` less ID_TIME.behindMs, each until its own time
 * passes the window. A thing taken just before the update then answers as
 * one taken after it.
 */
export function seedRows(state: unknown, now: number): IdRow[] {
  const from = now - ID_TIME.behindMs;
  const found = new Map<string, number>();
  const see = (value: string) => {
    if (value.length !== 36 || found.has(value)) return;
    const time = idTime(value);
    if (time !== null && time > from) found.set(value, time);
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") see(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        see(key);
        walk(item);
      }
    }
  };
  walk(state);
  return [...found].map(([id, time]) => ({ id, memberId: SERVER_MEMBER, acceptedAt: now, until: time + ID_HELD_MS, askUntil: now + ID_TIME.askMs }));
}

function iso(ms: number): string {
  return new Date(Math.min(ms, LATEST_UNTIL)).toISOString();
}
