import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { rng } from "#shared/testutil.ts";
import { setupAuth } from "../auth/plugin.ts";
import { loadConfig } from "../config.ts";
import { ReceiptLines } from "../rooms/logHistory.ts";
import { registerReceiptRoutes } from "./receipts.ts";
import { stateThrough } from "./receipts.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";

for (const property of ["closed", "replayFailed"] as const) test(`a behind actor that is ${property} answers busy promptly`, async () => {
  const actor = { committed: { state: {} as never, seq: 1 }, closed: false, replayFailed: false };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    actor[property] = true;
    await assert.rejects(stateThrough(actor, 2, abort.signal), ScanBusyError);
  } finally { clearTimeout(timer); }
});

test("actor closure while waiting answers busy, and cancellation rejects a caught-up state", async () => {
  const actor = { committed: { state: {} as never, seq: 1 }, closed: false, replayFailed: false };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const waiting = stateThrough(actor, 2, abort.signal);
    actor.closed = true;
    await assert.rejects(waiting, ScanBusyError);
    abort.abort();
    await assert.rejects(stateThrough(actor, 1, abort.signal), ScanCancelledError);
  } finally { clearTimeout(timer); }
});

// Exercise the real auth and limit services without a database or a listening socket.
async function routeRig(stage = "", opts: { slide?: boolean; stale?: boolean; limited?: boolean } = {}) {
  const app = Fastify();
  const stats = { cancels: 0, destroyed: 0, active: 0, unbounded: 0, closed: 0 };
  const sql: { text: string; bounded: boolean; values?: unknown[] }[] = [];
  const stalled = (text: string) => stage === "grant" ? text.includes("from grants g") : stage === "limit" ? text.includes("from rate_events") : stage === "charge" && text.startsWith("insert into rate_events");
  const answer = (text: string) => ({ rows: text.includes("from sessions") ? [{ id: "session", slide: opts.slide ?? false, touch: opts.slide ?? false }] : text.includes("from grants g") ? [{ member_id: "p1", role: "player", epoch: 1, player_epoch: opts.stale ? 2 : 1, dm_epoch: 1 }] : text.includes("from rate_events") ? [{ n: opts.limited ? 60 : 0, oldest_expires_in: 45 }] : [] });
  class Client extends EventEmitter {
    pending: ((error: Error) => void) | null = null;
    releases = 0;
    async query(config: { text: string; values?: unknown[] }) {
      assert.equal(this.releases, 0, "no SQL after cancellation");
      sql.push({ text: config.text, bounded: true, values: config.values });
      if (stalled(config.text)) return new Promise((_resolve, reject) => { this.pending = reject; });
      return answer(config.text);
    }
    release(drop?: boolean) {
      assert.equal(++this.releases, 1, "release once");
      stats.active--;
      if (drop) { stats.destroyed++; this.pending?.(new Error("connection terminated")); }
    }
  }
  const pool = {
    async query(text: string, values?: unknown[]) {
      sql.push({ text, bounded: false, values });
      if (stalled(text)) { stats.unbounded++; await new Promise((r) => setTimeout(r, 300)); }
      return answer(text);
    },
    async connect() { stats.active++; return new Client(); },
  };
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://localhost/test" });
  const kit = await setupAuth(app, { config, pool: pool as never, gateway: { closeSockets: () => { stats.closed++; } } as never });
  const lines = new ReceiptLines({ pool: pool as never, cancel: async () => { stats.cancels++; } });
  await registerReceiptRoutes(app, kit, { manager: { acquire: async () => ({ committed: { state: {} as never, seq: 0 } }) } as never, options: { lines, deadlineMs: 25 } });
  await app.ready();
  return { app, stats, sql, pool, request: () => app.inject({ method: "GET", url: "/api/rooms/ABCDEFGH/receipts/tag", headers: { cookie: `rvtt=${"a".repeat(43)}` } }) };
}

for (const stage of ["grant", "limit", "charge"] as const) test(`the receipt deadline cancels the route's ${stage} SQL`, async () => {
  const r = await routeRig(stage);
  try {
    const started = Date.now();
    const result = await r.request();
    assert.equal(result.statusCode, 503, result.body);
    assert.deepEqual(result.json(), { error: "busy" });
    assert.equal(result.headers["retry-after"], "1");
    assert.ok(Date.now() - started < 200, "the configured deadline bounds the stage");
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

describe("a lookup's wait for the room's state", () => {
  test("returns the state once it reaches the newest receipt's seq, and a cancel ends the wait", async () => {
    const actor = { committed: { state: { meta: { name: "five" } } as never, seq: 5 } };
    assert.equal(await stateThrough(actor, 5, new AbortController().signal), actor.committed.state, "a state already there is taken at once");
    const later = stateThrough(actor, 6, new AbortController().signal);
    setTimeout(() => (actor.committed = { state: { meta: { name: "six" } } as never, seq: 6 }), 30);
    assert.equal(((await later) as unknown as { meta: { name: string } }).meta.name, "six");
    const abort = new AbortController();
    const never = stateThrough(actor, 99, abort.signal);
    setTimeout(() => abort.abort(new Error("deadline")), 30);
    await assert.rejects(never, ScanCancelledError);
  });
});



test("random actor capture, close, replay failure, cancellation and late progress never return a behind state", async () => {
  const random = rng(4105);
  const modes = new Set<number>();
  for (let i = 0; i < 80; i++) {
    const actor = { committed: { state: {} as never, seq: 1 }, closed: false, replayFailed: false };
    const abort = new AbortController();
    const mode = Math.floor(random() * 4);
    modes.add(mode);
    const result = stateThrough(actor, 2, AbortSignal.any([abort.signal, AbortSignal.timeout(100)])).then((s) => ({ state: s, error: null }), (e: unknown) => ({ state: null, error: e }));
    if (mode === 0) actor.closed = true;
    if (mode === 1) actor.replayFailed = true;
    if (mode === 2) abort.abort();
    if (mode === 3) actor.committed = { state: {} as never, seq: 2 };
    const found = await result;
    if (mode < 2) assert.ok(found.error instanceof ScanBusyError, `sequence ${i}: terminal actors answer busy`);
    else if (mode === 2) assert.ok(found.error instanceof ScanCancelledError, `sequence ${i}: cancellation rejects`);
    else assert.equal(found.state, actor.committed.state, `sequence ${i}: one caught-up capture`);
    actor.committed = { state: {} as never, seq: 3 };
    if (found.state) assert.notEqual(found.state, actor.committed.state, "late progress cannot replace captured state");
  }
  assert.equal(modes.size, 4);
});
