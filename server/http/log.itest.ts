import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { rng } from "#shared/testutil.ts";
import { cancelRequest, captureView, compareIds, LogHistory, type HistoryView } from "../rooms/logHistory.ts";
import { LogScanBudget, ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";
import { startEngine, TEST_DATABASE_URL, type Engine, type TestClient } from "../rooms/testing.ts";

type Page = { entries: LogEntry[]; nextBefore: string | null; nextAfter: string | null };

describe("GET /api/rooms/:id/log", () => {
  let t: Engine;
  before(async () => {
    // These tests walk many pages quickly. The page bucket has tests of its own below.
    t = await startEngine({ log: { budget: { pageBurst: 100_000, pagePerSec: 100_000 } } });
  });
  after(() => t.close());

  /** Every page a client gets walking back from the newest, as the raw bodies. */
  async function walk(c: TestClient, roomId: string, limit: number, extra = ""): Promise<string[]> {
    const bodies: string[] = [];
    let before: string | null = null;
    do {
      const res = await c.get(`/api/rooms/${roomId}/log?limit=${limit}${before ? `&before=${before}` : ""}${extra}`);
      assert.equal(res.statusCode, 200, res.body);
      bodies.push(res.body);
      before = res.json<Page>().nextBefore;
    } while (before !== null && bodies.length < 10_000);
    return bodies;
  }

  /** Whispers from `from` to `to` at seq 0, indexes `lo` to `hi`, all at one time. */
  async function storeWhispers(roomId: string, from: string, to: string, lo: number, hi: number, at = "2025-01-01T10:30:00.000Z"): Promise<void> {
    await t.pool.query(
      `insert into room_log (room_id, id, at, entry)
       select $1, '0:' || g, $4::timestamptz,
         jsonb_build_object('id', '0:' || g, 'at', $4::text, 'kind', 'whisper', 'from', $5::text, 'to', jsonb_build_array($6::text), 'text', 'psst ' || g)
       from generate_series($2::int, $3::int) g`,
      [roomId, lo, hi, at, from, to],
    );
  }

  async function storeChat(roomId: string, id: string, at: string, from: string, text: string): Promise<void> {
    await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, id, at, JSON.stringify({ id, at, kind: "chat", from, text })]);
  }

  test("every readable line stays reachable, with the same pages and cursors, however long a hidden run lies between", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Hidden runs");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    await quin.join(roomId, "Quin");
    await storeChat(roomId, "0:0", "2025-01-01T10:00:00.000Z", dmId, "first");
    await storeChat(roomId, "0:50000", "2025-01-01T11:00:00.000Z", dmId, "last");
    const base = { two: await walk(quin, roomId, 2), hundred: await walk(quin, roomId, 100) };
    const lines = base.two.flatMap((b) => JSON.parse(b).entries.map((e: LogEntry) => e.text ?? e.data?.type));
    assert.deepEqual(lines.slice(-2), ["first", "last"]);
    // Runs of 999, 1,000, 1,001, 1,100 and 20,000 rows Quin may not read, between the two lines.
    let stored = 0;
    for (const run of [999, 1_000, 1_001, 1_100, 20_000]) {
      await storeWhispers(roomId, dmId, pipId, stored + 1, run);
      stored = run;
      assert.deepEqual(await walk(quin, roomId, 2), base.two, `run of ${run}`);
      assert.deepEqual(await walk(quin, roomId, 100), base.hundred, `run of ${run}`);
    }
    // Pip, the whispers' recipient, reads every one.
    const pipLines = (await walk(pip, roomId, 100)).flatMap((b) => JSON.parse(b).entries as LogEntry[]);
    assert.equal(pipLines.filter((e) => e.kind === "whisper").length, 20_000);
  });

  test("pages before and after an id: exclusive bounds, each end's cursors, and empty pages that end only their own direction", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Seven");
    const dmId = (await dm.me(roomId)).memberId!;
    for (let i = 1; i <= 7; i++) await storeChat(roomId, `0:${i}`, `2025-02-01T10:0${i}:00.000Z`, dmId, `c${i}`);
    const page = async (q: string) => {
      const res = await dm.get(`/api/rooms/${roomId}/log?${q}`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers["cache-control"], "no-store");
      const body = res.json<Page>();
      return { texts: body.entries.map((e) => e.text ?? e.data?.type), nextBefore: body.nextBefore, nextAfter: body.nextAfter };
    };
    // Backward: before 0:5 leaves 0:5 out, and before 0:0005 is the same id.
    assert.deepEqual(await page("before=0:5&limit=3"), { texts: ["c2", "c3", "c4"], nextBefore: "0:2", nextAfter: "0:4" });
    assert.deepEqual(await page("before=0:0005&limit=3"), { texts: ["c2", "c3", "c4"], nextBefore: "0:2", nextAfter: "0:4" });
    assert.deepEqual(await page("before=0:4&limit=3"), { texts: ["c1", "c2", "c3"], nextBefore: "0:1", nextAfter: "0:3" });
    assert.deepEqual(await page("before=0:2&limit=3"), { texts: ["c1"], nextBefore: null, nextAfter: "0:1" });
    assert.deepEqual(await page("before=0:1&limit=3"), { texts: [], nextBefore: null, nextAfter: null });
    // Forward: after 0:3 leaves 0:3 out.
    assert.deepEqual(await page("after=0:3&limit=3"), { texts: ["c4", "c5", "c6"], nextBefore: "0:4", nextAfter: "0:6" });
    assert.deepEqual(await page("after=0:2&limit=3"), { texts: ["c3", "c4", "c5"], nextBefore: "0:3", nextAfter: "0:5" });
    assert.deepEqual(await page("after=0:0&limit=7"), { texts: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"], nextBefore: "0:1", nextAfter: "0:7" });
    // The live rows (the DM's join) come after the stored ones, so the newest end is found from the newest page.
    const newest = (await dm.get(`/api/rooms/${roomId}/log?limit=1`)).json<Page>();
    const top = newest.entries[0]!.id;
    assert.deepEqual(await page(`after=${top}&limit=3`), { texts: [], nextBefore: null, nextAfter: null });
    const second = (await dm.get(`/api/rooms/${roomId}/log?before=${top}&limit=1`)).json<Page>().entries[0]!.id;
    const short = await page(`after=${second}&limit=3`);
    assert.equal(short.texts.length, 1);
    assert.deepEqual([short.nextBefore, short.nextAfter], [top, null]);
    // An id no row has is a boundary like any other.
    assert.deepEqual(await page("before=0:999999&limit=1"), { texts: ["c7"], nextBefore: "0:7", nextAfter: "0:7" });
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?before=0:1&after=0:2`)).statusCode, 400);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?after=x`)).statusCode, 400);
  });

  test("pages older entries newest first, projected for the caller", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Log");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "Pip");
    const p2 = t.client();
    await p2.join(roomId, "Quin");
    const s = await t.connect(roomId, dm);
    await s.snapshot("dm");
    for (let i = 0; i < 5; i++) await s.apply({ t: "log.chat", text: `c${i}` });
    await s.apply({ t: "log.whisper", to: [p1Id], text: "psst" });
    const page = await dm.get(`/api/rooms/${roomId}/log?limit=3`);
    assert.equal(page.statusCode, 200, page.body);
    const body = page.json<{ entries: LogEntry[]; nextBefore: string | null }>();
    assert.deepEqual(body.entries.map((e) => e.text), ["c3", "c4", "psst"]);
    assert.equal(body.nextBefore, body.entries[0]?.id);
    const older = (await dm.get(`/api/rooms/${roomId}/log?limit=3&before=${body.nextBefore}`)).json<{ entries: LogEntry[]; nextBefore: string | null }>();
    assert.deepEqual(older.entries.map((e) => e.text), ["c0", "c1", "c2"]);
    // The join events and chats are under the last page.
    assert.equal(older.nextBefore, older.entries[0]?.id);
    const quin = (await p2.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>();
    assert.ok(!quin.entries.some((e) => e.text === "psst"));
    const pip = (await p1.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>();
    assert.ok(pip.entries.some((e) => e.text === "psst"));
    assert.equal((await t.client().get(`/api/rooms/${roomId}/log`)).statusCode, 403);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?before=nope`)).statusCode, 400);
    s.close();
  });

  test("a page and its cursor name only entries the caller may see, however many hidden rows lie between", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Log secrets");
    const p1 = t.client();
    const pipId = await p1.join(roomId, "Pip");
    const p2 = t.client();
    await p2.join(roomId, "Quin");
    const s = await t.connect(roomId, dm);
    await s.snapshot("dm");
    await s.apply({ t: "log.chat", text: "hello all" });
    for (let i = 0; i < 4; i++) await s.apply({ t: "log.whisper", to: [pipId], text: `psst ${i}` });
    const whispers = (await dm.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>().entries.filter((e) => e.kind === "whisper");
    assert.equal(whispers.length, 4);
    const pages: string[] = [];
    const named: string[] = [];
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const res = await p2.get(`/api/rooms/${roomId}/log?limit=1${before ? `&before=${before}` : ""}`);
      assert.equal(res.statusCode, 200, res.body);
      pages.push(res.body);
      const page = res.json<{ entries: LogEntry[]; nextBefore: string | null }>();
      seen.push(...page.entries.map((e) => e.text ?? e.data?.type ?? ""));
      named.push(...page.entries.map((e) => e.id));
      if (page.nextBefore !== null) named.push(page.nextBefore);
      if (page.nextBefore !== null) assert.equal(page.nextBefore, page.entries[0]?.id);
      before = page.nextBefore;
    } while (before !== null && pages.length < 10);
    // The chat first, then the two joins, one a page, and no whisper between them or in a cursor.
    assert.deepEqual(seen, ["hello all", "member", "member"]);
    // Ids, not a substring of the body: an id such as 6:0 also turns up inside a timestamp.
    for (const w of whispers) assert.ok(!named.includes(w.id), `whisper ${w.id} named in a page`);
    s.close();
  });

  test("how many hidden rows lie between changes no page or cursor a player gets", async () => {
    // Every page Quin gets: its lines, and whether its cursor names its own oldest line, another row or none. The
    // rows' ids follow the room's seq, so they differ from room to room. Pip joins, the DM whispers to Pip `hidden`
    // times, then Quin joins and the DM chats, so Quin's last line, Pip's join, sits under the whispers.
    const pagesWith = async (hidden: number) => {
      const dm = t.client();
      const { roomId } = await dm.createRoom(`Log ${hidden}`);
      const p1 = t.client();
      const pipId = await p1.join(roomId, "Pip");
      const s = await t.connect(roomId, dm);
      await s.snapshot("dm");
      for (let i = 0; i < hidden; i++) {
        await s.apply({ t: "log.whisper", to: [pipId], text: `psst ${i}` });
        // Under the socket's op rate, so no whisper is answered busy.
        await new Promise((r) => setTimeout(r, 40));
      }
      const p2 = t.client();
      await p2.join(roomId, "Quin");
      await s.apply({ t: "log.chat", text: "hello all" });
      s.close();
      const pages: { lines: string[]; next: "its oldest" | "another row" | null }[] = [];
      let before: string | null = null;
      do {
        const res = await p2.get(`/api/rooms/${roomId}/log?limit=1${before ? `&before=${before}` : ""}`);
        assert.equal(res.statusCode, 200, res.body);
        const page = res.json<{ entries: LogEntry[]; nextBefore: string | null }>();
        const next = page.nextBefore === null ? null : page.nextBefore === page.entries[0]?.id ? "its oldest" : "another row";
        pages.push({ lines: page.entries.map((e) => e.text ?? e.data?.type ?? ""), next });
        before = page.nextBefore;
      } while (before !== null && pages.length < 10);
      return pages;
    };
    const none = await pagesWith(0);
    // With 98 the rows under Quin's join fit one 100-row read and with 99 they do not, which once decided whether
    // the page with Pip's join offered another.
    assert.deepEqual(await pagesWith(98), none);
    assert.deepEqual(await pagesWith(99), none);
    // The chat, the two joins, then an empty page that ends it: a full page always offers the next.
    assert.deepEqual(none, [
      { lines: ["hello all"], next: "its oldest" },
      { lines: ["member"], next: "its oldest" },
      { lines: ["member"], next: "its oldest" },
      { lines: [], next: null },
    ]);
  });
});

function goblin(sceneId: string): Extract<Op, { t: "token.create" }> {
  return {
    t: "token.create",
    token: {
      id: uuidv7(),
      sceneId,
      kind: "monster",
      name: "Goblin",
      size: "medium",
      x: 2,
      y: 2,
      actor: {
        inline: {
          hp: { cur: 30, max: 30, temp: 0 },
          life: "alive",
          ac: 15,
          speeds: { walk: 30 },
          initBonus: 2,
          passivePerception: 9,
          senses: "",
          effects: [],
          deathSaves: { ok: 0, fail: 0 },
          notes: "",
          dmNotes: "",
        },
      },
    },
  } as Extract<Op, { t: "token.create" }>;
}

describe("archive reads in turns", () => {
  let t: Engine;
  let gate: { pass: string; reached: () => void; release: Promise<void> } | null = null;
  const onBatch = async ({ pass }: { pass: string }) => {
    const g = gate;
    if (!g || g.pass !== pass) return;
    gate = null;
    g.reached();
    await g.release;
  };
  const budget = new LogScanBudget();
  before(async () => {
    t = await startEngine({ log: { budget, history: { batchRows: 2, onBatch } } });
  });
  after(() => t.close());

  function pause(pass: string): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    gate = { pass, reached, release: new Promise<void>((r) => (release = r)) };
    return { reached: at, release };
  }

  test("a page reads every batch against the state it started with, and the next page sees what changed", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Frozen");
    const pip = t.client();
    await pip.join(roomId, "Pip");
    const s = await t.connect(roomId, dm);
    const snap = await s.snapshot("dm");
    const op = goblin((snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId);
    await s.apply(op);
    for (let i = 0; i < 4; i++) await s.apply({ t: "actor.hp", target: { tokenId: op.token.id }, change: { kind: "damage", amount: 1 } } as Op);
    await s.apply({ t: "log.chat", text: "before" });
    const read = async () => {
      const res = await pip.get(`/api/rooms/${roomId}/log?limit=100`);
      assert.equal(res.statusCode, 200, res.body);
      return res.json<Page>();
    };
    const baseline = await read();
    const goblinLines = (p: Page) => p.entries.filter((e) => e.data?.type === "hp").length;
    assert.equal(goblinLines(baseline), 4, "Pip reads the visible goblin's hits");
    // The page waits in its first batch while the DM hides the goblin and speaks again.
    const paused = pause("page");
    const pending = read();
    await paused.reached;
    await s.apply({ t: "token.update", tokenId: op.token.id, patch: { visibility: "dm" } } as Op);
    await s.apply({ t: "log.chat", text: "after" });
    paused.release();
    assert.deepEqual(await pending, baseline);
    const next = await read();
    assert.equal(goblinLines(next), 0, "a new page rechecks sight");
    assert.ok(next.entries.some((e) => e.text === "after"));
    s.close();
  });

  test("one page at a time per member, whatever the device, and a fixed charge per page", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("One at a time");
    const paused = pause("page");
    const first = dm.get(`/api/rooms/${roomId}/log?limit=5`);
    await paused.reached;
    // The same member on another device is busy at once, without waiting for a turn.
    const same = t.client();
    same.token = dm.token;
    const started = Date.now();
    const busy = await same.get(`/api/rooms/${roomId}/log?limit=5`);
    assert.ok(Date.now() - started < 500);
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.json<{ error: string }>().error, "busy");
    assert.equal(busy.headers["retry-after"], "1");
    paused.release();
    assert.equal((await first).statusCode, 200);
    // Ten a burst, then one a second: the two above and eight more, then a wait.
    for (let i = 0; i < 8; i++) assert.equal((await dm.get(`/api/rooms/${roomId}/log?limit=5`)).statusCode, 200, `page ${i}`);
    const over = await dm.get(`/api/rooms/${roomId}/log?limit=5`);
    assert.equal(over.statusCode, 429);
    assert.equal(over.json<{ error: string }>().error, "rate_limited");
    assert.equal(over.headers["retry-after"], "1");
  });

  test("a read takes no row past the seq it captured, though the row is already stored", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Captured");
    const dmId = (await dm.me(roomId)).memberId!;
    const actor = await t.manager.acquire(roomId);
    const seq = actor.committed.seq;
    for (const id of [`${seq}:7`, `${seq + 1}:0`, `${seq + 5}:0`]) {
      const entry = { id, at: "2025-08-01T19:00:00.000Z", kind: "chat", from: dmId, text: id };
      await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, id, entry.at, JSON.stringify(entry)]);
    }
    const scanPool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 1 });
    const budget = new LogScanBudget();
    try {
      const view = captureView(actor.committed, roomId, { memberId: dmId, role: "dm" });
      const scan = budget.open({ pool: "page", roomId, memberId: dmId });
      const history = new LogHistory({ pool: scanPool });
      const page = await history.page(view, { limit: 100 }, scan);
      assert.ok(page.entries.some((e) => e.id === `${seq}:7`));
      assert.ok(!page.entries.some((e) => e.id === `${seq + 1}:0` || e.id === `${seq + 5}:0`), "rows of later ops wait for a later read");
      const sessions = await history.sessions(view, { limit: 50 }, scan);
      assert.equal(sessions.lines, page.entries.length);
      scan.close();
    } finally {
      budget.close();
      await scanPool.end();
    }
  });

  test("two members flooding one room hold one lease of each pool, a stalled export holds no turn, and another room is served", async () => {
    const scanPool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 4 });
    const budget = new LogScanBudget();
    const history = new LogHistory({ pool: scanPool, batchRows: 2, onBatch });
    try {
      const rooms: { roomId: string; view: HistoryView }[] = [];
      for (const name of ["Flooded", "Next door"]) {
        const dm = t.client();
        const { roomId } = await dm.createRoom(name);
        const dmId = (await dm.me(roomId)).memberId!;
        for (let i = 0; i < 8; i++) {
          const entry = { id: `0:${i}`, at: "2025-07-01T19:00:00.000Z", kind: "chat", from: dmId, text: `line ${i}` };
          await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, entry.id, entry.at, JSON.stringify(entry)]);
        }
        const actor = await t.manager.acquire(roomId);
        rooms.push({ roomId, view: captureView(actor.committed, roomId, { memberId: dmId, role: "dm" }) });
      }
      const [a, b] = rooms as [(typeof rooms)[0], (typeof rooms)[0]];
      // An export in room A whose reader stopped taking its body after one batch.
      const stalled = budget.open({ pool: "export", roomId: a.roomId, memberId: "m1" });
      const reading = history.exportBatches(a.view, {}, stalled)[Symbol.asyncIterator]();
      assert.equal((await reading.next()).done, false);
      assert.deepEqual(budget.usage.turns, { page: 0, export: 0 }, "waiting on its reader holds no turn");
      assert.equal(budget.usage.leases.export, 1);
      // A second export in room A waits its second for room A's lease, then is busy. Room B's export goes ahead.
      const started = Date.now();
      const second = budget.open({ pool: "export", roomId: a.roomId, memberId: "m2" });
      const refused = history.bounds(a.view, {}, second).then(
        () => "served",
        (err: unknown) => (err instanceof ScanBusyError ? "busy" : String(err)),
      );
      const other = budget.open({ pool: "export", roomId: b.roomId, memberId: "m3" });
      assert.ok(await history.bounds(b.view, {}, other));
      other.close();
      assert.ok(Date.now() - started < 900, "room B did not wait on room A");
      assert.equal(await refused, "busy");
      assert.ok(Date.now() - started >= 950, "the lease wait is a full second");
      second.close();
      // Pages: one member of room A holds a turn, the other waits out its second, and room B is served meanwhile.
      const paused = pause("page");
      const m1 = budget.open({ pool: "page", roomId: a.roomId, memberId: "m1" });
      const held = history.page(a.view, { limit: 50 }, m1);
      await paused.reached;
      const m2 = budget.open({ pool: "page", roomId: a.roomId, memberId: "m2" });
      const waiting = history.page(a.view, { limit: 50 }, m2).then(
        () => "served",
        (err: unknown) => (err instanceof ScanBusyError ? "busy" : String(err)),
      );
      const pageB = budget.open({ pool: "page", roomId: b.roomId, memberId: "m3" });
      assert.equal((await history.page(b.view, { limit: 3 }, pageB)).entries.length, 3);
      pageB.close();
      assert.equal(await waiting, "busy");
      m2.close();
      assert.equal(budget.usage.leases.page, 1, "room A holds one page lease, never both");
      // Cancelling the held page ends its query and frees its lease and turn.
      m1.cancel(new Error("client went away"));
      paused.release();
      await assert.rejects(held, ScanCancelledError);
      m1.close();
      await reading.return?.(undefined);
      stalled.close();
      assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
      assert.equal(scanPool.totalCount - scanPool.idleCount, 0, "every connection is back");
    } finally {
      budget.close();
      await scanPool.end();
    }
  });
});

describe("the archive reader against an array", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  type Row = LogEntry;
  type Who = { memberId: string; role: "dm" | "player" };

  /** Who may read a stored chat line, by its audience, written out again here rather than taken from the projector. */
  function readable(row: Row, who: Who): boolean {
    if (row.kind === "whisper") return row.from === who.memberId || (row.to?.includes(who.memberId) ?? false);
    if (row.to !== undefined) return who.role === "player" && row.to[0] === who.memberId;
    if (Number(row.id.slice(row.id.indexOf(":") + 1)) >= 900_000) return who.role === "dm";
    return true;
  }

  /** Sessions in id order with a gap over four hours between them, newest first, as plain tuples. */
  function oracleSessions(rows: readonly Row[]): [string, string, number][] {
    const out: [string, string, number][] = [];
    let last = Number.NaN;
    for (const row of rows) {
      const at = Date.parse(row.at);
      const current = out[out.length - 1];
      if (current && at - last <= 4 * 3_600_000) {
        current[1] = row.id;
        current[2]++;
      } else out.push([row.id, row.id, 1]);
      last = at;
    }
    return out.reverse();
  }

  test("pages, counts, sessions and an export's ends agree with the readable rows for random archives, and rows others read change none", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Random");
    const dmId = (await dm.me(roomId)).memberId!;
    const players: string[] = [];
    for (const name of ["Pip", "Quin", "Rho"]) players.push(await t.client().join(roomId, name));
    const members = [dmId, ...players];
    const viewers: Who[] = [{ memberId: dmId, role: "dm" }, ...players.map((memberId) => ({ memberId, role: "player" as const }))];
    const actor = await t.manager.acquire(roomId);
    const state = actor.committed.state;
    const scanPool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 4 });
    const budget = new LogScanBudget({ waitMs: 10_000 });
    try {
      for (let seed = 1; seed <= 20; seed++) {
        const random = rng(seed);
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const rows: Row[] = [];
        let seq = 100;
        let at = Date.parse("2025-01-01T00:00:00.000Z");
        let counts = { shared: 0, party: 100_000, dm: 900_000 };
        const line = (): Row => {
          // An op's lines share a time. Between ops a few seconds pass, sometimes an evening's gap, sometimes a clock set back.
          const r = random();
          const kind = r < 0.35 ? "shared" : r < 0.65 ? "whisper" : r < 0.85 ? "party" : "dm";
          const from = pick(members);
          if (kind === "whisper") {
            const to = members.filter((m) => m !== from && random() < 0.5);
            return { id: `${seq}:${counts.shared++}`, at: new Date(at).toISOString(), kind: "whisper", from, to: to.length > 0 ? to : [pick(members.filter((m) => m !== from))], text: "w" };
          }
          if (kind === "party") return { id: `${seq}:${counts.party++}`, at: new Date(at).toISOString(), kind: "chat", from, to: [pick(players)], copyOf: `${seq}:0`, text: "p" };
          if (kind === "dm") return { id: `${seq}:${counts.dm++}`, at: new Date(at).toISOString(), kind: "chat", from: dmId, text: "d" };
          return { id: `${seq}:${counts.shared++}`, at: new Date(at).toISOString(), kind: "chat", from, text: "s" };
        };
        while (rows.length < 2_000) {
          seq += 1 + Math.floor(random() * 3);
          const step = random();
          at += step < 0.9 ? Math.floor(random() * 60_000) : step < 0.97 ? 5 * 3_600_000 : -3 * 3_600_000;
          counts = { shared: 0, party: 100_000, dm: 900_000 };
          const n = 1 + Math.floor(random() * 3);
          for (let i = 0; i < n; i++) rows.push(line());
        }
        // Within an op each audience numbers its own lines, so the archive's order is not the order they were made in.
        rows.sort((a, b) => compareIds(a.id, b.id));
        await t.pool.query("delete from room_log where room_id = $1", [roomId]);
        const store = (batch: readonly Row[]) =>
          t.pool.query(
            `insert into room_log (room_id, id, at, entry) select $1, i, a::timestamptz, e::jsonb from unnest($2::text[], $3::text[], $4::text[]) as x(i, a, e)`,
            [roomId, batch.map((r) => r.id), batch.map((r) => r.at), batch.map((r) => JSON.stringify(r))],
          );
        await store(rows);
        const history = new LogHistory({ pool: scanPool, batchRows: 1 + Math.floor(random() * 600) });
        const answers = async (who: Who, reader = history) => {
          const view = captureView({ state, seq: seq + 1 }, roomId, who);
          const scan = budget.open({ pool: "page", roomId, memberId: who.memberId });
          try {
            const back: string[] = [];
            let before: string | undefined;
            for (;;) {
              const page = await reader.page(view, { before, limit: 20 + Math.floor(random() * 81) }, scan);
              back.unshift(...page.entries.map((e) => e.id));
              if (page.nextBefore === null) break;
              before = page.nextBefore;
            }
            const forward: string[] = [];
            let after = "0:0";
            for (;;) {
              const page = await reader.page(view, { after, limit: 20 + Math.floor(random() * 81) }, scan);
              forward.push(...page.entries.map((e) => e.id));
              if (page.nextAfter === null) break;
              after = page.nextAfter;
            }
            const sessions = await reader.sessions(view, { limit: 50 }, scan);
            const ends = await reader.bounds(view, {}, scan);
            return { back, forward, lines: sessions.lines, sessions: sessions.sessions.map((s) => [s.firstId, s.lastId, s.lines]), ends: ends ? [ends.first.id, ends.last.id] : null };
          } finally {
            scan.close();
          }
        };
        const first = new Map<string, Awaited<ReturnType<typeof answers>>>();
        for (const who of viewers) {
          const mine = rows.filter((r) => readable(r, who));
          const got = await answers(who);
          const ids = mine.map((r) => r.id);
          assert.deepEqual(got.back, ids, `seed ${seed} ${who.role} ${who.memberId} backward`);
          assert.deepEqual(got.forward, ids, `seed ${seed} forward`);
          assert.equal(got.lines, mine.length, `seed ${seed} lines`);
          assert.deepEqual(got.sessions, oracleSessions(mine).slice(0, 50), `seed ${seed} sessions`);
          assert.deepEqual(got.ends, mine.length > 0 ? [ids[0], ids[ids.length - 1]] : null, `seed ${seed} ends`);
          first.set(who.memberId, got);
        }
        // Whispers between the DM and Pip, interleaved everywhere: Quin's and Rho's answers do not move.
        const extra: Row[] = [];
        for (const row of rows) {
          if (random() < 0.5) continue;
          const at2 = row.at;
          const s = Number(row.id.slice(0, row.id.indexOf(":")));
          extra.push({ id: `${s}:${50_000 + extra.length}`, at: at2, kind: "whisper", from: dmId, to: [players[0]!], text: "private" });
        }
        await store(extra);
        // A fresh reader, so the session lists are found again rather than read from the cache.
        const again = new LogHistory({ pool: scanPool, batchRows: 1 + Math.floor(random() * 600) });
        for (const who of viewers.slice(2)) assert.deepEqual(await answers(who, again), first.get(who.memberId), `seed ${seed} private additions`);
      }
    } finally {
      budget.close();
      await scanPool.end();
    }
  });
});

/** A scan connection whose answers a test controls. Pending queries fail when it is destroyed, as a real one's do. */
class FakeConnection extends EventEmitter {
  processID = 4242;
  readonly steps: string[];
  readonly released: (boolean | undefined)[] = [];
  hang: RegExp | null = null;
  #rows: LogEntry[];
  #at = 0;
  #pending: ((err: Error) => void)[] = [];

  constructor(rows: LogEntry[], steps: string[]) {
    super();
    this.#rows = rows;
    this.steps = steps;
  }

  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const word = text.trim().split(/\s+/)[0]!.toLowerCase();
    this.steps.push(word);
    if (this.hang?.test(text.trim())) return new Promise((_resolve, reject) => this.#pending.push(reject));
    if (word === "fetch") {
      const n = Number(/fetch (\d+)/.exec(text)![1]);
      const ids = this.#rows.slice(this.#at, this.#at + n).map((r) => ({ id: r.id }));
      this.#at += ids.length;
      return Promise.resolve({ rows: ids });
    }
    if (text.includes("id = any")) {
      const ids = new Set(params![1] as string[]);
      return Promise.resolve({ rows: this.#rows.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, entry: r })) });
    }
    return Promise.resolve({ rows: [] });
  }

  release(destroy?: boolean): void {
    this.steps.push(destroy ? "destroy" : "release");
    this.released.push(destroy);
    if (destroy) for (const reject of this.#pending.splice(0)) reject(new Error("Connection terminated"));
  }
}

describe("a scan's connection, every step bounded and cancellable", () => {
  const dm = { id: "dm1", rev: 1, name: "DM", color: "#f7df00", kind: "dm" as const, createdAt: "2026-01-01T00:00:00Z" };
  const state = createInitialState({ roomName: "Fake", dm: dm as never });
  const rows: LogEntry[] = Array.from({ length: 6 }, (_, i) => ({ id: `1:${i}`, at: "2025-10-01T19:00:00.000Z", kind: "chat", from: dm.id, text: `line ${i}` }));
  const view = captureView({ state, seq: 10 }, "FAKEROOM", { memberId: dm.id, role: "dm" });
  const tick = () => new Promise<void>((r) => setImmediate(r));

  function rig(connect: () => Promise<unknown>, cancelLog?: string[], cancel?: (client: { processID: number }) => Promise<void>) {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const budget = new LogScanBudget({
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => void timers.splice(timers.indexOf(t as never), 1),
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    const recorded = (client: { processID: number }) => (cancelLog?.push(`cancel ${client.processID}`), Promise.resolve());
    const history = new LogHistory({ pool: { connect } as never, cancel: (cancel ?? recorded) as never, batchRows: 2 });
    const scan = budget.open({ pool: "page", roomId: "FAKEROOM", memberId: dm.id });
    return { budget, history, scan, advance };
  }

  test("a checkout still waiting is given up on cancel, and a connection handed over after that is closed", async () => {
    let hand!: (c: FakeConnection) => void;
    const late = new FakeConnection(rows, []);
    const { budget, history, scan } = rig(() => new Promise((resolve) => (hand = resolve)));
    const page = history.page(view, { limit: 50 }, scan).then(
      () => "served",
      (err: unknown) => (err instanceof ScanCancelledError ? "cancelled" : String(err)),
    );
    await tick();
    assert.equal(budget.usage.turns.page, 1);
    scan.cancel(new Error("deadline"));
    assert.equal(await page, "cancelled");
    assert.equal(budget.usage.turns.page, 0);
    scan.close();
    assert.equal(budget.usage.leases.page, 0);
    hand(late);
    await tick();
    assert.deepEqual(late.released, [true], "the late connection is closed, never used");
  });

  test("a checkout the pool cannot give frees the turn and is asked again, until the lease wait runs out", async () => {
    let calls = 0;
    const good = new FakeConnection(rows, []);
    const { budget, history, scan, advance } = rig(() => (++calls <= 2 ? Promise.reject(new Error("timeout exceeded when trying to connect")) : Promise.resolve(good)));
    const page = history.page(view, { limit: 50 }, scan);
    for (let i = 0; i < 2; i++) {
      await tick();
      assert.equal(budget.usage.turns.page, 0, "no turn is held while waiting for a connection");
      advance(50);
    }
    assert.equal((await page).entries.length, 6);
    assert.equal(calls, 3);
    scan.close();

    const never = rig(() => Promise.reject(new Error("timeout exceeded when trying to connect")));
    const refused = never.history.page(view, { limit: 50 }, never.scan).then(
      () => "served",
      (err: unknown) => (err instanceof ScanBusyError ? "busy" : String(err)),
    );
    for (let i = 0; i < 25; i++) {
      await tick();
      never.advance(50);
    }
    assert.equal(await refused, "busy");
    never.scan.close();
    assert.deepEqual(never.budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a cancelled scan cancels its backend's query first, then drops the connection without a rollback", async () => {
    const steps: string[] = [];
    const conn = new FakeConnection(rows, steps);
    const { history, scan } = rig(() => Promise.resolve(conn), steps);
    let fetches = 0;
    const query = conn.query.bind(conn);
    conn.query = (text: string, params?: unknown[]) => {
      if (/^fetch/.test(text) && ++fetches === 2) conn.hang = /^fetch/;
      return query(text, params);
    };
    const page = history.page(view, { limit: 50 }, scan).then(
      () => "served",
      (err: unknown) => (err instanceof ScanCancelledError ? "cancelled" : String(err)),
    );
    for (let i = 0; i < 20 && fetches < 2; i++) await tick();
    scan.cancel(new Error("client went away"));
    assert.equal(await page, "cancelled");
    await tick();
    assert.deepEqual(steps.slice(-2), ["cancel 4242", "destroy"]);
    assert.ok(!steps.includes("rollback"));
    scan.close();
  });

  test("a closing rollback that stalls is dropped when the scan is cancelled, and an ended connection is not cancelled by its old id", async () => {
    const steps: string[] = [];
    const conn = new FakeConnection(rows, steps);
    conn.hang = /^rollback/;
    const { budget, history, scan } = rig(() => Promise.resolve(conn), steps);
    let settled = false;
    const page = history.page(view, { limit: 50 }, scan).finally(() => (settled = true));
    for (let i = 0; i < 20 && !steps.includes("rollback"); i++) await tick();
    await tick();
    assert.equal(settled, false, "the rollback is still waiting");
    conn.emit("end");
    scan.cancel(new Error("deadline"));
    await page;
    assert.deepEqual(conn.released, [true]);
    assert.ok(!steps.some((s) => s.startsWith("cancel")), "an ended connection's id is never cancelled");
    scan.close();
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a cancel in the moment a connection is handed over drops it before any query runs on it", async () => {
    const steps: string[] = [];
    const conn = new FakeConnection(rows, steps);
    let cancelNext = () => {};
    const { budget, history, scan } = rig(() => {
      // The pool answers, then the scan is cancelled one microtask later: after the checkout hands the connection on,
      // before the scan's own code has it.
      const answer = Promise.resolve(conn);
      void answer.then(() => queueMicrotask(() => cancelNext()));
      return answer;
    }, steps);
    cancelNext = () => scan.cancel(new Error("deadline"));
    await assert.rejects(history.page(view, { limit: 50 }, scan), ScanCancelledError);
    assert.ok(!steps.includes("begin"), steps.join(" "));
    assert.deepEqual(conn.released, [true]);
    scan.close();
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a dropped connection keeps its scan's lease until it is destroyed, so the room admits no other scan before", async () => {
    const steps: string[] = [];
    const conn = new FakeConnection(rows, steps);
    let finishCancel = () => {};
    const { budget, history, scan } = rig(
      () => Promise.resolve(conn),
      steps,
      () => new Promise<void>((resolve) => (finishCancel = resolve)),
    );
    // One batch, then the reader stops taking them, as a stalled download's does.
    const reading = history.batches(view, { order: "asc" }, scan, "lines")[Symbol.asyncIterator]();
    assert.equal((await reading.next()).done, false);
    // The export's stream closes: the scan is cancelled and closed, and its backend's cancel takes a while.
    scan.cancel(new Error("deadline"));
    scan.close();
    await tick();
    assert.deepEqual(conn.released, [], "the connection is still out while its cancel runs");
    assert.equal(budget.usage.leases.page, 1, "so the lease is still held");
    // The reader asks for more: the scan ends only once its connection is gone, never before.
    let ended = false;
    const next = reading.next().then(
      () => "more",
      (err: unknown) => (err instanceof ScanCancelledError ? "cancelled" : String(err)),
    );
    void next.then(() => (ended = true));
    await tick();
    assert.equal(ended, false, "the scan has not ended while its connection is out");
    const second = budget.open({ pool: "page", roomId: "FAKEROOM", memberId: "someone else" });
    let admitted = false;
    const later = second.batch(async () => void (admitted = true));
    await tick();
    assert.equal(admitted, false, "no second scan of the room while the first's connection is out");
    finishCancel();
    await later;
    assert.deepEqual(conn.released, [true]);
    assert.equal(admitted, true);
    assert.equal(await next, "cancelled");
    second.close();
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a query that fails or times out is followed by no more SQL: the backend is cancelled and the connection destroyed", async () => {
    const steps: string[] = [];
    const conn = new FakeConnection(rows, steps);
    const query = conn.query.bind(conn);
    let fetches = 0;
    conn.query = (text: string, params?: unknown[]) => {
      // What pg's query_timeout answers, while the statement may still run on the server.
      if (/^fetch/.test(text) && ++fetches === 2) {
        steps.push("fetch");
        return Promise.reject(new Error("Query read timeout"));
      }
      return query(text, params);
    };
    const { budget, history, scan } = rig(() => Promise.resolve(conn), steps);
    await assert.rejects(history.page(view, { limit: 50 }, scan), /Query read timeout/);
    assert.deepEqual(steps.slice(-3), ["fetch", "cancel 4242", "destroy"]);
    assert.ok(!steps.includes("rollback"), "no rollback queued behind the stuck query");
    scan.close();
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a request waiting on another's session list stops at its own cancel, and the one finding it goes on", async () => {
    let gateOpen = () => {};
    const gate = new Promise<void>((resolve) => (gateOpen = resolve));
    let gated = true;
    const history = new LogHistory({
      pool: { connect: () => Promise.resolve(new FakeConnection(rows, [])) } as never,
      cancel: () => Promise.resolve(),
      batchRows: 2,
      onBatch: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
      },
    });
    const budget = new LogScanBudget();
    const leader = budget.open({ pool: "page", roomId: "FAKEROOM", memberId: dm.id });
    const waiter = budget.open({ pool: "page", roomId: "FAKEROOM", memberId: dm.id });
    const found = history.sessions(view, { limit: 25 }, leader);
    await tick();
    const waiting = history.sessions(view, { limit: 25 }, waiter).then(
      () => "served",
      (err: unknown) => (err instanceof ScanCancelledError ? "cancelled" : String(err)),
    );
    await tick();
    waiter.cancel(new Error("client went away"));
    assert.equal(await waiting, "cancelled", "the wait ends with the waiter's own cancel");
    // A waiter already cancelled when it arrives gets no answer either.
    const late = budget.open({ pool: "page", roomId: "FAKEROOM", memberId: dm.id });
    late.cancel(new Error("deadline"));
    await assert.rejects(history.sessions(view, { limit: 25 }, late), ScanCancelledError);
    gateOpen();
    assert.equal((await found).lines, 6, "the one finding the list was not stopped by the waiters");
    for (const s of [leader, waiter, late]) s.close();
    budget.close();
  });
});

describe("PostgreSQL's cancel request", () => {
  test("stops only the backend whose secret it carries, and gives up on a server that does not answer", async () => {
    const url = TEST_DATABASE_URL;
    const victim = new pg.Client({ connectionString: url });
    const watcher = new pg.Client({ connectionString: url });
    await victim.connect();
    await watcher.connect();
    try {
      const sleeping = victim.query("select pg_sleep(3)").then(
        () => "finished",
        (err: Error) => err.message,
      );
      const running = async () =>
        (await watcher.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where pid = $1 and state = 'active'", [(victim as unknown as { processID: number }).processID])).rows[0]!.n === 1;
      for (let i = 0; i < 50 && !(await running()); i++) await new Promise((r) => setTimeout(r, 20));
      // As if the process id had passed to another session since: same id, another secret.
      const impostor = Object.assign(Object.create(victim) as pg.Client, { secretKey: ((victim as unknown as { secretKey: number }).secretKey ^ 1) | 0 });
      await cancelRequest(impostor);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await running(), true, "a request with another secret stops nothing");
      await cancelRequest(victim);
      assert.match(await sleeping, /cancel/i, "the backend's own secret stops it");
    } finally {
      await victim.end();
      await watcher.end();
    }
    // A server that takes the connection and never answers: the request gives up after its wait.
    const held: Socket[] = [];
    const silent = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const port = (silent.address() as { port: number }).port;
      const started = Date.now();
      await cancelRequest({ processID: 1, secretKey: 2, host: "127.0.0.1", port } as never, 200);
      assert.ok(Date.now() - started < 1_000);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  test("a scan's query_timeout cancels the statement on the server and destroys the connection, with no rollback", async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1, query_timeout: 200 });
    const watcher = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await watcher.connect();
    const sent: string[] = [];
    let backend = 0;
    const history = new LogHistory({
      pool: {
        connect: async () => {
          const client = await pool.connect();
          backend = (client as unknown as { processID: number }).processID;
          const query = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<unknown>;
          // The fetch becomes a statement that outlives the timeout, so pg gives up on it while the server still runs it.
          (client as unknown as { query: typeof query }).query = (text, params) => {
            sent.push(text.trim().split(/\s+/)[0]!.toLowerCase());
            return query(/^fetch/i.test(text.trim()) ? "select pg_sleep(5)" : text, params);
          };
          return client;
        },
      } as never,
    });
    const dm = { id: "dm1", rev: 1, name: "DM", color: "#f7df00", kind: "dm" as const, createdAt: "2026-01-01T00:00:00Z" };
    const view = captureView({ state: createInitialState({ roomName: "Timeout", dm: dm as never }), seq: 10 }, "NOSUCHROOM", { memberId: dm.id, role: "dm" });
    const budget = new LogScanBudget();
    const scan = budget.open({ pool: "page", roomId: "NOSUCHROOM", memberId: dm.id });
    try {
      await assert.rejects(history.page(view, { limit: 50 }, scan), /Query read timeout/);
      assert.ok(sent.includes("fetch") && !sent.includes("rollback"), `no rollback after the timeout: ${sent.join(", ")}`);
      assert.equal(pool.totalCount, 0, "the connection is destroyed, not returned");
      const active = async () => (await watcher.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where pid = $1 and state = 'active'", [backend])).rows[0]!.n;
      for (let i = 0; i < 50 && (await active()) > 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await active(), 0, "the server stopped the statement well before its 5 s");
      scan.close();
      assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
    } finally {
      await watcher.end();
      await pool.end();
    }
  });
});

describe("archive scans and what happens around them", () => {
  let t: Engine;
  const budget = new LogScanBudget();
  const counted: Record<string, number> = {};
  let gate: { pass: string; reached: () => void; release: Promise<void> } | null = null;
  const onBatch = async ({ pass }: { pass: string }) => {
    counted[pass] = (counted[pass] ?? 0) + 1;
    const g = gate;
    if (!g || g.pass !== pass) return;
    gate = null;
    g.reached();
    await g.release;
  };
  before(async () => {
    t = await startEngine({ log: { budget, history: { batchRows: 2, onBatch } } });
  });
  after(() => t.close());

  function pause(pass: string): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    gate = { pass, reached, release: new Promise<void>((r) => (release = r)) };
    return { reached: at, release };
  }

  async function roomWithLines(name: string): Promise<{ dm: TestClient; roomId: string; dmId: string }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const dmId = (await dm.me(roomId)).memberId!;
    for (let i = 0; i < 6; i++) {
      const entry = { id: `0:${i}`, at: "2025-10-01T19:00:00.000Z", kind: "chat", from: dmId, text: `line ${i}` };
      await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, entry.id, entry.at, JSON.stringify(entry)]);
    }
    return { dm, roomId, dmId };
  }

  const idle = async () => {
    for (let i = 0; i < 100 && budget.usage.scans > 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  };

  test("a scan whose connection the database ends fails its request, and the server goes on", async () => {
    const { dm, roomId } = await roomWithLines("Dropped");
    const paused = pause("page");
    const pending = dm.get(`/api/rooms/${roomId}/log?limit=50`);
    await paused.reached;
    const { rows } = await t.pool.query<{ pid: number }>(
      "select pid from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and query like 'select id, entry from room_log%'",
    );
    assert.equal(rows.length, 1, "the gated scan's backend");
    await t.pool.query("select pg_terminate_backend($1)", [rows[0]!.pid]);
    await new Promise((r) => setTimeout(r, 100));
    paused.release();
    const res = await pending;
    assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.body}`);
    await idle();
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?limit=50`)).statusCode, 200, "the next page is read on a new connection");
  });

  test("deleting a room while one of its pages waits ends the page busy and frees its lease", async () => {
    const { dm, roomId } = await roomWithLines("Deleted");
    const paused = pause("page");
    const pending = dm.get(`/api/rooms/${roomId}/log?limit=50`);
    await paused.reached;
    const gone = await dm.delete(`/api/rooms/${roomId}`, { name: "Deleted" });
    assert.equal(gone.statusCode, 204, gone.body);
    paused.release();
    const res = await pending;
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json<{ error: string }>().error, "busy");
    await idle();
  });

  test("two listings of one list at once find it once, and later ones read it from the cache", async () => {
    const { dm, roomId } = await roomWithLines("Twice");
    const phone = t.client();
    phone.token = dm.token;
    const before = counted.sessions ?? 0;
    const paused = pause("sessions");
    const first = dm.get(`/api/rooms/${roomId}/log/sessions`);
    await paused.reached;
    const second = phone.get(`/api/rooms/${roomId}/log/sessions`);
    await new Promise((r) => setTimeout(r, 50));
    paused.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.body, a.body);
    const found = (counted.sessions ?? 0) - before;
    for (let i = 0; i < 3; i++) assert.equal((await dm.get(`/api/rooms/${roomId}/log/sessions`)).body, a.body);
    assert.equal((counted.sessions ?? 0) - before, found, "the repeats read no rows");
    assert.ok(found <= 5, `one pass over 6 lines in batches of 2, not two (${found} batches)`);
  });

  test("a list found twice at once is held once in the cache, and is still a hit afterwards", async () => {
    const { roomId, dmId } = await roomWithLines("Held once");
    const actor = await t.manager.acquire(roomId);
    const view = captureView(actor.committed, roomId, { memberId: dmId, role: "dm" });
    const scanPool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 2 });
    const own = new LogScanBudget();
    let batches = 0;
    let hold: (() => void) | null = null;
    const held = new Promise<void>((r) => (hold = r));
    let waiting = true;
    const history = new LogHistory({
      pool: scanPool,
      batchRows: 2,
      onBatch: async () => {
        batches++;
        if (waiting) {
          waiting = false;
          await held;
        }
      },
    });
    try {
      const run = () => {
        const scan = own.open({ pool: "page", roomId, memberId: dmId });
        return history.sessions(view, { limit: 25 }, scan).finally(() => scan.close());
      };
      const one = run();
      for (let i = 0; i < 50 && batches === 0; i++) await new Promise((r) => setTimeout(r, 10));
      const two = run();
      await new Promise((r) => setTimeout(r, 20));
      hold!();
      const [x, y] = await Promise.all([one, two]);
      assert.deepEqual(y, x);
      const after = batches;
      assert.equal(history.cached.lists, 1);
      await run();
      assert.equal(batches, after, "a hit");
      assert.equal(history.cached.lists, 1);
    } finally {
      own.close();
      await scanPool.end();
    }
  });
});

describe("GET /api/rooms/:id/log with the archive's metadata complete", () => {
  let t: Engine;
  const readers: string[] = [];
  const appName = `rvtt-log-itest-${Math.random().toString(36).slice(2, 10)}`;
  before(async () => {
    t = await startEngine({
      log: {
        budget: { pageBurst: 100_000, pagePerSec: 100_000 },
        history: { onBatch: async ({ reader }) => void readers.push(reader) },
        migration: {
          connect: async () => {
            const c = new pg.Client({ connectionString: TEST_DATABASE_URL, application_name: appName });
            c.on("error", () => undefined);
            await c.connect();
            return c;
          },
        },
      },
    });
    t.app.logMigration.start();
    for (let i = 0; i < 1_000 && !t.app.logMigration.ready; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.app.logMigration.ready);
  });
  after(() => t.close());

  async function walk(c: TestClient, roomId: string, limit: number): Promise<string[]> {
    const bodies: string[] = [];
    let before: string | null = null;
    do {
      const res = await c.get(`/api/rooms/${roomId}/log?limit=${limit}${before ? `&before=${before}` : ""}`);
      assert.equal(res.statusCode, 200, res.body);
      bodies.push(res.body);
      before = res.json<Page>().nextBefore;
    } while (before !== null && bodies.length < 10_000);
    return bodies;
  }

  /** Reads until the backfill has completed the room and a read is indexed. */
  async function settled(c: TestClient, roomId: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      readers.length = 0;
      await c.get(`/api/rooms/${roomId}/log?limit=1`);
      if (readers.includes("indexed")) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("the room was never completed");
  }

  test("every readable line stays reachable through the indexed reader, with the raw reader's pages, however long a hidden run", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Indexed runs");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    await quin.join(roomId, "Quin");
    const chat = (id: string, at: string, text: string) =>
      t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, id, at, JSON.stringify({ id, at, kind: "chat", from: dmId, text })]);
    await chat("0:0", "2025-01-01T10:00:00.000Z", "first");
    await chat("0:50000", "2025-01-01T11:00:00.000Z", "last");
    // Rows written straight to the table, as an older server did: read raw until the backfill completes them.
    readers.length = 0;
    const raw = await walk(quin, roomId, 2);
    assert.equal(readers[0], "raw", "the first read is raw, and queues the room");
    await settled(quin, roomId);
    readers.length = 0;
    assert.deepEqual(await walk(quin, roomId, 2), raw, "the indexed reader's pages are the raw reader's");
    assert.ok(!readers.includes("raw"));
    let stored = 0;
    for (const run of [999, 1_000, 1_001, 1_100, 20_000]) {
      await t.pool.query(
        `insert into room_log (room_id, id, at, entry)
         select $1, '0:' || g, $4::timestamptz,
           jsonb_build_object('id', '0:' || g, 'at', $4::text, 'kind', 'whisper', 'from', $5::text, 'to', jsonb_build_array($6::text), 'text', 'psst ' || g)
         from generate_series($2::int, $3::int) g`,
        [roomId, stored + 1, run, "2025-01-01T10:30:00.000Z", dmId, pipId],
      );
      stored = run;
      await settled(quin, roomId);
      readers.length = 0;
      assert.deepEqual(await walk(quin, roomId, 2), raw, `run of ${run}`);
      assert.deepEqual(await walk(quin, roomId, 100), await walkRaw(quin, roomId, 100), `run of ${run}, pages of 100`);
    }
    const pipLines = (await walk(pip, roomId, 100)).flatMap((b) => JSON.parse(b).entries as LogEntry[]);
    assert.equal(pipLines.filter((e) => e.kind === "whisper").length, 20_000);
    const unindexed = await t.pool.query("select 1 from room_log where room_id = $1 and seq is null", [roomId]);
    assert.equal(unindexed.rowCount, 0);

    /** The same walk with one row lacking metadata, which sends every read raw, then put back. */
    async function walkRaw(c: TestClient, room: string, limit: number): Promise<string[]> {
      await t.pool.query("update room_log set seq = null where room_id = $1 and id = '0:1'", [room]);
      try {
        readers.length = 0;
        const bodies = await walk(c, room, limit);
        assert.ok(!readers.includes("indexed"), "a row without metadata sends every read raw");
        return bodies;
      } finally {
        await t.pool.query("update room_log set seq = 0 where room_id = $1 and id = '0:1'", [room]);
      }
    }
  });
});
