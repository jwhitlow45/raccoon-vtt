import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { asJsonb } from "#shared/keyOrderTestutil.ts";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { AT, rng, room } from "#shared/testutil.ts";
import { setupAuth } from "../auth/plugin.ts";
import { loadConfig } from "../config.ts";
import { ReceiptLines } from "../rooms/logHistory.ts";
import { ViewBusyError, type RoomView } from "../rooms/actor.ts";
import { registerReceiptRoutes } from "./receipts.ts";
import { sortedReplies } from "./sortedReplies.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";

// Exercise the real auth and limit services without a database or a listening socket.
/** A committed receipt of P1's at `seq`, the state the room holds, and the op's lines as the archive's jsonb rows give them back. */
type Held = { seq: number; state: RoomState; archived: LogEntry[]; sorted: boolean };

/** When the rig's requests arrive, on the clock the app's hook reads (server/app.ts). */
const ARRIVED = 1_000_007;

async function routeRig(stage = "", opts: { slide?: boolean; stale?: boolean; limited?: boolean; noGrant?: boolean; noSession?: boolean; held?: Held; through?: number; asOf?: (at: number) => Promise<RoomView> } = {}) {
  const app = Fastify();
  if (opts.held?.sorted) sortedReplies(app);
  const arrivals: number[] = [];
  app.decorateRequest("arrivedAt", 0);
  app.addHook("onRequest", (req, _reply, done) => {
    req.arrivedAt = ARRIVED;
    done();
  });
  const stats = { cancels: 0, destroyed: 0, active: 0, unbounded: 0, closed: 0, created: 0, checkouts: 0, reused: 0 };
  const sql: { text: string; bounded: boolean; values?: unknown[] }[] = [];
  const stalled = (text: string) => stage === "grant" ? text.includes("from grants g") : stage === "limit" ? text.includes("from rate_events") : stage === "charge" && text.startsWith("insert into rate_events");
  const answer = (text: string) => {
    if (text.includes("from sessions")) return { rows: opts.noSession ? [] : [{ id: "session", slide: opts.slide ?? false, touch: opts.slide ?? false }] };
    if (text.includes("from grants g")) return { rows: opts.noGrant ? [] : [{ member_id: "p1", role: "player", epoch: 1, player_epoch: opts.stale ? 2 : 1, dm_epoch: 1 }] };
    if (text.includes("from rate_events")) return { rows: [{ n: opts.limited ? 60 : 0, oldest_expires_in: 45 }] };
    if (opts.held && text.includes("from roll_receipts")) return { rows: [{ part: 0, state: "committed", seq: String(opts.held.seq), code: null, message: null, at: new Date(AT) }] };
    if (opts.held && text.includes("from room_log")) return { rows: opts.held.archived.map((entry) => ({ entry })) };
    return { rows: [] };
  };
  const idle: Client[] = [];
  class Client extends EventEmitter {
    pending: ((error: Error) => void) | null = null;
    checkedOut = false;
    async query(config: { text: string; values?: unknown[] }) {
      assert.equal(this.checkedOut, true, "no SQL after cancellation");
      sql.push({ text: config.text, bounded: true, values: config.values });
      if (stalled(config.text)) return new Promise((_resolve, reject) => { this.pending = reject; });
      return answer(config.text);
    }
    release(drop?: boolean) {
      assert.equal(this.checkedOut, true, "release once per checkout");
      this.checkedOut = false;
      stats.active--;
      if (drop) { stats.destroyed++; this.pending?.(new Error("connection terminated")); }
      else idle.push(this);
    }
  }
  const pool = {
    async query(text: string, values?: unknown[]) {
      sql.push({ text, bounded: false, values });
      if (stalled(text)) { stats.unbounded++; await new Promise((r) => setTimeout(r, 300)); }
      return answer(text);
    },
    async connect() {
      stats.checkouts++;
      let client = idle.pop();
      if (client) stats.reused++;
      else { client = new Client(); stats.created++; }
      client.checkedOut = true;
      stats.active++;
      return client;
    },
  };
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://localhost/test" });
  const kit = await setupAuth(app, { config, pool: pool as never, gateway: { closeSockets: () => { stats.closed++; } } as never });
  const lines = new ReceiptLines({ pool: pool as never, cancel: async () => { stats.cancels++; } });
  const view: RoomView = { tick: ARRIVED - (ARRIVED % 20), state: opts.held?.state ?? ({} as never), seq: 0, pub: 0, through: opts.through ?? opts.held?.seq ?? 0 };
  const asOf = (at: number) => {
    arrivals.push(at);
    return opts.asOf?.(at) ?? Promise.resolve(view);
  };
  const manager = { acquire: async () => ({ asOf }), arrivalTick: (at: number) => at - (at % 20) };
  await registerReceiptRoutes(app, kit, { manager: manager as never, options: { lines, deadlineMs: opts.held ? 2_000 : 25 } });
  await app.ready();
  return { app, stats, sql, pool, arrivals, request: (cookie = true) => app.inject({ method: "GET", url: "/api/rooms/ABCDEFGH/receipts/tag", headers: cookie ? { cookie: `rvtt=${"a".repeat(43)}` } : {} }) };
}

for (const stage of ["grant", "limit", "charge"] as const) test(`the receipt deadline cancels the route's ${stage} SQL`, async () => {
  const r = await routeRig(stage);
  try {
    const result = await r.request();
    assert.equal(result.statusCode, 503, result.body);
    assert.deepEqual(result.json(), { error: "busy" });
    assert.equal(result.headers["retry-after"], "1");
    assert.equal(r.stats.unbounded, 0, "route SQL uses the cancellable connection");
    assert.equal(r.stats.cancels, 1);
    assert.equal(r.stats.destroyed, 1);
    assert.equal(r.stats.active, 0);
    assert.deepEqual(await r.pool.query("select 1"), { rows: [] }, "unrelated work still runs");
  } finally { await r.app.close(); }
});

test("bounded admission preserves session renewal, stale-grant cleanup and receipt charging", async () => {
  for (const kind of ["renewal", "stale", "limited"] as const) {
    const r = await routeRig("", { slide: true, stale: kind === "stale", limited: kind === "limited" });
    try {
      const result = await r.request();
      assert.equal(result.statusCode, kind === "stale" ? 403 : kind === "limited" ? 429 : 200, result.body);
      assert.ok(result.headers["set-cookie"], "sliding expiry still renews the cookie");
      assert.equal(r.sql.filter((q) => q.text.startsWith("update sessions") && q.bounded).length, 1);
      const deleted = r.sql.filter((q) => q.text.startsWith("delete from grants"));
      assert.equal(deleted.length, kind === "stale" ? 1 : 0);
      if (kind === "stale") {
        assert.equal(deleted[0]!.bounded, true);
        assert.deepEqual(deleted[0]!.values, ["session", "ABCDEFGH", "player", 1], "stale cleanup still matches the sampled epoch");
        assert.equal(r.stats.closed, 1);
      }
      const charges = r.sql.filter((q) => q.text.startsWith("insert into rate_events"));
      assert.equal(charges.length, kind === "renewal" ? 1 : 0);
      if (charges.length) assert.equal(charges[0]!.bounded, true);
      assert.equal(r.stats.active, 0);
    } finally { await r.app.close(); }
  }
});

for (const refusal of ["missing grant", "stale grant", "rate limit"] as const) test(`a ${refusal} refusal releases a reusable connection without cancellation`, async () => {
  const r = await routeRig("", { noGrant: refusal === "missing grant", stale: refusal === "stale grant", limited: refusal === "rate limit" });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await r.request();
      assert.equal(response.statusCode, refusal === "rate limit" ? 429 : 403, response.body);
      assert.deepEqual(response.json(), { error: refusal === "rate limit" ? "rate_limited" : "no_access" });
      if (refusal === "rate limit") assert.equal(response.headers["retry-after"], "45");
      assert.equal(r.stats.active, 0, "the refusal released its checkout");
      assert.equal(r.stats.cancels, 0, "an expected refusal never cancels a healthy backend");
      assert.equal(r.stats.destroyed, 0, "an expected refusal never destroys a healthy connection");
    }
    assert.equal(r.stats.checkouts, 2);
    assert.equal(r.stats.created, 1, "both refusals use the same healthy connection");
    assert.equal(r.stats.reused, 1);
    assert.equal(r.sql.some((q) => q.text.startsWith("insert into rate_events")), false, "a refused lookup is not charged");
  } finally { await r.app.close(); }
});

for (const cookie of [false, true]) test(`a request without a live session refuses before checkout, cookie=${cookie}`, async () => {
  const r = await routeRig("", { noSession: true });
  try {
    const response = await r.request(cookie);
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(response.json(), { error: "no_access" });
    assert.equal(r.stats.checkouts, 0);
    assert.equal(r.stats.cancels, 0);
    assert.equal(r.stats.destroyed, 0);
    assert.equal(r.sql.filter((q) => q.text.includes("from sessions")).length, cookie ? 1 : 0, "only the request limiter's existing session lookup runs");
  } finally { await r.app.close(); }
});

describe("a lookup as of its arrival", () => {
  const line: LogEntry = { id: "2:0", at: AT, kind: "chat", from: "p1", text: "ready" };

  test("asks the room for its view at the moment the request arrived, and reads the rows after it, before that tick", async () => {
    let give!: (view: RoomView) => void;
    const given = new Promise<RoomView>((resolve) => (give = resolve));
    const held: Held = { seq: 2, state: room({ log: [line] }), archived: [asJsonb(line)], sorted: false };
    const r = await routeRig("", { held, asOf: () => given });
    try {
      const answer = r.request();
      for (let i = 0; i < 50 && r.arrivals.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(r.arrivals, [ARRIVED], "the moment the hook stamped, after the session, grant and limit reads");
      assert.equal(r.sql.some((q) => q.text.includes("from roll_receipts")), false, "no receipt row is read before the view");
      give({ tick: 0, state: held.state, seq: 2, pub: 2, through: 2 });
      const result = await answer;
      assert.equal(result.statusCode, 200, result.body);
      const read = r.sql.find((q) => q.text.includes("from roll_receipts"));
      assert.equal(read?.values?.[3], new Date(ARRIVED - (ARRIVED % 20)).toISOString(), "rows written before the arrival's tick");
      assert.deepEqual(result.json(), { parts: [{ part: 0, state: "committed", seq: 2, lines: [line] }] });
    } finally { await r.app.close(); }
  });

  test("a committed receipt past the view's through answers busy at once, without reading its lines", async () => {
    const r = await routeRig("", { held: { seq: 3, state: room({ log: [] }), archived: [line], sorted: false }, through: 2 });
    try {
      const result = await r.request();
      assert.equal(result.statusCode, 503, result.body);
      assert.deepEqual(result.json(), { error: "busy" });
      assert.equal(result.headers["retry-after"], "1");
      assert.equal(r.sql.some((q) => q.text.includes("from room_log")), false);
      assert.equal(r.stats.active, 0);
    } finally { await r.app.close(); }
  });

  test("a view the room cannot give answers busy", async () => {
    const r = await routeRig("", { held: { seq: 2, state: room({ log: [line] }), archived: [], sorted: false }, asOf: () => Promise.reject(new ViewBusyError("too old")) });
    try {
      const result = await r.request();
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.headers["retry-after"], "1");
      assert.equal(r.sql.some((q) => q.text.includes("from roll_receipts")), false);
    } finally { await r.app.close(); }
  });
});

/*
 * Two rooms alike except that the later one also holds an earlier line at
 * seq 1: P1's line at seq 2 then comes from the archive's jsonb rows in one
 * and from the room's memory in the other, with the same values. The reply's
 * bytes are the same either way.
 */
test("a receipt's reply is the same text whether its lines come from memory or the archive", async () => {
  const line: LogEntry = { id: "2:0", at: AT, kind: "chat", from: "p1", text: "ready" };
  const earlier: LogEntry = { id: "1:0", at: AT, kind: "chat", from: "dm1", text: "welcome" };
  const ask = async (log: LogEntry[], sorted: boolean) => {
    const r = await routeRig("", { held: { seq: 2, state: room({ log }), archived: [asJsonb(line)], sorted } });
    try {
      const result = await r.request();
      assert.equal(result.statusCode, 200, result.body);
      return { body: result.body, archive: r.sql.some((q) => q.text.includes("from room_log")) };
    } finally { await r.app.close(); }
  };
  const [read, held] = [await ask([line], true), await ask([earlier, line], true)];
  assert.deepEqual([read.archive, held.archive], [true, false], "one reads the archive, the other the room's memory");
  assert.equal(read.body, held.body);
  assert.deepEqual(JSON.parse(read.body), { parts: [{ part: 0, state: "committed", seq: 2, lines: [line] }] });
  assert.notEqual((await ask([line], false)).body, (await ask([earlier, line], false)).body, "JSON.stringify's text differs between the two");
});
