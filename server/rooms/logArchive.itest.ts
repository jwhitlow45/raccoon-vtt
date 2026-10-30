import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { roomStoredBytes } from "../assets/quota.ts";
import { solid } from "../assets/testImages.ts";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { rng } from "#shared/testutil.ts";
import { CLOSE } from "./connection.ts";
import { captureView, compareIds, LogHistory, type HistoryView } from "./logHistory.ts";
import { LogScanBudget } from "./logScanBudget.ts";
import { commitBatch, loadRoom, writeSnapshot, type OpRecord } from "./persistence.ts";
import { failCommits, startEngine, type Engine } from "./testing.ts";

/**
 * The log archive's writes and what they may decide (design 7.2 and 10.5):
 * a short disk skips a batch's log rows and nothing else, and the archive's
 * bytes never decide a room's quota.
 */
describe("the log archive", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ env: { ROOM_QUOTA_MB: "1" } });
  });
  after(() => t.close());

  /** Replaces the asset volume's free-disk answer, which the archive asks too, until the returned function puts it back. */
  function diskAnswer(answer: () => Promise<boolean>): { calls: () => number; restore: () => void } {
    const assets = t.app.assets;
    let calls = 0;
    const own = Object.getOwnPropertyDescriptor(assets, "archiveDiskOk");
    assets.archiveDiskOk = () => {
      calls++;
      return answer();
    };
    return {
      calls: () => calls,
      restore: () => {
        if (own) Object.defineProperty(assets, "archiveDiskOk", own);
        else delete (assets as { archiveDiskOk?: unknown }).archiveDiskOk;
      },
    };
  }

  test("a short disk or a failed check skips only a batch's log rows, and commit failures keep their own rules", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Short disk");
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    const archived = async (seq: number) =>
      (await t.pool.query<{ n: number }>("select count(*)::int as n from room_log where room_id = $1 and split_part(id, ':', 1) = $2", [roomId, String(seq)])).rows[0]!.n;
    const ops = async (seq: number) => (await t.pool.query<{ n: number }>("select count(*)::int as n from room_ops where room_id = $1 and seq = $2", [roomId, seq])).rows[0]!.n;
    const chat = async (text: string) => {
      const ev = await socket.apply({ t: "log.chat", text });
      assert.ok(ev.acks?.length, `${text} was acknowledged`);
      return ev.seq;
    };
    let answer: () => Promise<boolean> = () => Promise.resolve(true);
    const disk = diskAnswer(() => answer());
    try {
      const a = await chat("a");
      assert.equal(await archived(a), 1);

      answer = () => Promise.resolve(false);
      const b = await chat("b");
      assert.equal(await ops(b), 1, "the op commits");
      assert.equal(await archived(b), 0, "its line does not reach the archive");
      const live = await t.connect(roomId, dm);
      const snap = await live.snapshot("dm2");
      assert.ok((snap.state as { log: { text?: string }[] }).log.some((e) => e.text === "b"), "the live log keeps it");
      live.close();

      answer = () => Promise.reject(new Error("statfs failed"));
      const c = await chat("c");
      assert.equal(await ops(c), 1);
      assert.equal(await archived(c), 0, "a failed check counts as a short disk");

      // A failure before COMMIT is retried as always, and the retry asks the guard again.
      answer = () => Promise.resolve(false);
      const before = disk.calls();
      const failing = failCommits(t.pool, ["before"]);
      try {
        const d = await chat("d");
        assert.equal(failing.remaining(), 0);
        assert.equal(await ops(d), 1);
        assert.equal(await archived(d), 0);
        assert.ok(disk.calls() - before >= 2, "asked on each attempt");
      } finally {
        failing.restore();
      }

      // A lost COMMIT answer is read back, never written twice, with its lines once.
      answer = () => Promise.resolve(true);
      const lost = failCommits(t.pool, ["committed"]);
      try {
        const e = await chat("e");
        assert.equal(lost.remaining(), 0);
        assert.equal(await ops(e), 1);
        assert.equal(await archived(e), 1);
      } finally {
        lost.restore();
      }
    } finally {
      disk.restore();
      socket.close();
    }
  });

  test("archive bytes alone never keep a room read-only or refuse an upload: loading measures the stored flag again first", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Long history");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    // About 2 MiB of whispers on disk, past the 1 MiB quota, in rows that do not compress away.
    await t.pool.query(
      `insert into room_log (room_id, id, at, entry)
       select $1, '0:' || g, '2025-01-01T00:00:00Z',
         jsonb_build_object('id', '0:' || g, 'at', '2025-01-01T00:00:00.000Z', 'kind', 'whisper', 'from', $2::text, 'to', jsonb_build_array($3::text), 'text', t.x)
       from generate_series(1, 400) g,
         lateral (select string_agg(md5(random()::text || g::text || i::text), '') as x from generate_series(1, 300) i) t`,
      [roomId, dmId, pipId],
    );
    const quota = 1024 * 1024;
    const stored = await roomStoredBytes(t.pool, roomId);
    assert.ok(stored < quota, `the quota's own count is small (${stored})`);
    const { rows } = await t.pool.query<{ bytes: number }>("select coalesce(sum(pg_column_size(l.*)), 0)::int as bytes from room_log l where room_id = $1", [roomId]);
    assert.ok(stored + rows[0]!.bytes >= quota, "the room is past its quota on disk");
    // As a room that went read-only while the archive still counted, unloaded, with nothing to delete and nothing queued.
    await t.manager.unload(roomId, CLOSE.evicted, false);
    await t.pool.query("update rooms set read_only = true where id = $1", [roomId]);

    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    assert.equal((await t.pool.query<{ read_only: boolean }>("select read_only from rooms where id = $1", [roomId])).rows[0]!.read_only, false);
    const ev = await socket.apply({ t: "log.chat", text: "writable again" });
    assert.ok(ev.acks?.length, JSON.stringify(ev.rejects));
    const png = await solid(64, 64, "#2a7").png().toBuffer();
    const up = await pip.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, png);
    assert.equal(up.statusCode, 200, up.body);
    socket.close();
  });
});

describe("the archive reader against the reducer's own lines", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  type Who = { memberId: string; role: "dm" | "player" };

  function monster(sceneId: string, name: string, visibility: "all" | "dm"): Extract<Op, { t: "token.create" }> {
    return {
      t: "token.create",
      token: {
        id: uuidv7(),
        sceneId,
        kind: "monster",
        name,
        size: "medium",
        x: 2,
        y: 2,
        visibility,
        actor: {
          inline: {
            hp: { cur: 500, max: 500, temp: 0 },
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

  /**
   * Who may read a line, from the audience rules written out again here
   * rather than taken from the projector: a whisper its parties, a party copy
   * its one reader, a DM line the DMs, and a shared line everyone, except a
   * hit on a monster players cannot see now.
   */
  function readable(line: LogEntry, who: Who, hidden: ReadonlySet<string>): boolean {
    if (line.kind === "whisper") return line.from === who.memberId || (line.to?.includes(who.memberId) ?? false);
    if (line.to !== undefined) return who.role === "player" && line.to[0] === who.memberId;
    if (Number(line.id.slice(line.id.indexOf(":") + 1)) >= 900_000) return who.role === "dm";
    if (who.role === "dm") return true;
    const token = (line.data as { tokenId?: string } | undefined)?.tokenId;
    return token === undefined || !hidden.has(token);
  }

  test("pages, counts, sessions and an export's ends agree with the lines 2,000 reducer ops wrote, through ring prunes, snapshots and reloads", async () => {
    const SEEDS = 20;
    const OPS = 2_000;
    const stats: { refused: number; reloads: number; snapshots: number; lines: number; live: number; hidden: boolean }[] = [];
    const scanPool = new pg.Pool({ connectionString: t.config.DATABASE_URL, max: 4 });
    const budget = new LogScanBudget({ waitMs: 10_000 });
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const random = rng(seed);
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const dmClient = t.client();
        const { roomId } = await dmClient.createRoom(`Reducer ${seed}`);
        await t.manager.unload(roomId, CLOSE.evicted, false);
        let loaded = (await loadRoom(t.pool, roomId))!;
        let state = loaded.state;
        let seq = loaded.seq;
        const dmId = Object.values(state.members).find((m) => m.kind === "dm")!.id;
        const archived: LogEntry[] = [];
        let pending: OpRecord[] = [];
        let at = Date.parse("2025-01-01T18:00:00.000Z");
        let snapshots = 0;
        let reloads = 0;
        const flush = async () => {
          if (pending.length === 0) return;
          await commitBatch(t.pool, roomId, { ops: pending, watermarks: [] });
          for (const r of pending) archived.push(...r.log);
          pending = [];
          if (random() < 0.15) {
            await writeSnapshot(t.pool, roomId, seq, state);
            snapshots++;
          }
          if (random() < 0.05) {
            // A reload: the snapshot plus the ops after it, as a restart would.
            loaded = (await loadRoom(t.pool, roomId))!;
            assert.equal(loaded.seq, seq);
            assert.equal(loaded.replayFailed, false);
            state = loaded.state;
            reloads++;
          }
        };
        const apply = async (op: Op, actor: Who): Promise<boolean> => {
          const step = random();
          at += step < 0.9 ? Math.floor(random() * 60_000) : step < 0.97 ? 5 * 3_600_000 : -3 * 3_600_000;
          const result = applyOp(state, op, actor, { seq: seq + 1, at: new Date(at).toISOString(), opVersion: OP_VERSION });
          if (!result.ok) return false;
          seq++;
          state = result.state;
          pending.push({ seq, at: new Date(at).toISOString(), actor, op, log: result.log });
          if (pending.length >= 1 + Math.floor(random() * 50)) await flush();
          return true;
        };
        const server = { memberId: "server", role: "dm" as const };
        const players: string[] = [];
        for (const name of ["Pip", "Quin", "Rho"]) {
          const id = uuidv7();
          players.push(id);
          assert.ok(await apply({ t: "sys.memberJoin", member: { id, name, color: "#336699", kind: "player", createdAt: new Date(at).toISOString() } } as Op, server));
        }
        const members = [dmId, ...players];
        const role = (id: string): Who => ({ memberId: id, role: id === dmId ? "dm" : "player" });
        const scene = state.meta.playerSceneId!;
        const seen = monster(scene, "Goblin", "all");
        const lurker = monster(scene, "Lurker", "dm");
        assert.ok(await apply(seen, role(dmId)));
        assert.ok(await apply(lurker, role(dmId)));
        let applied = 0;
        let refused = 0;
        while (applied < OPS) {
          const r = random();
          const from = pick(members);
          let op: Op;
          let by = role(from);
          if (r < 0.35) op = { t: "log.chat", text: `chat ${applied}` } as Op;
          else if (r < 0.65) {
            const to = members.filter((m) => m !== from && random() < 0.5);
            op = { t: "log.whisper", to: to.length > 0 ? to : [pick(members.filter((m) => m !== from))], text: `whisper ${applied}` } as Op;
          } else if (r < 0.95) {
            op = { t: "actor.hp", target: { tokenId: pick([seen, lurker]).token.id }, change: { kind: random() < 0.5 ? "damage" : "heal", amount: 1 } } as Op;
            by = role(dmId);
          } else {
            const visibility = state.tokens[lurker.token.id]?.visibility === "dm" ? "all" : "dm";
            op = { t: "token.update", tokenId: lurker.token.id, patch: { visibility } } as Op;
            by = role(dmId);
          }
          if (await apply(op, by)) applied++;
          else refused++;
        }
        await flush();
        assert.ok(state.log.length < archived.length, "the live rings dropped lines the archive keeps");
        archived.sort((a, b) => compareIds(a.id, b.id));
        const hidden = new Set(Object.values(state.tokens).filter((tk) => tk.visibility === "dm").map((tk) => tk.id));
        const answers = async (who: Who, reader: LogHistory, view: HistoryView) => {
          const scan = budget.open({ pool: "page", roomId, memberId: who.memberId });
          try {
            const back: string[] = [];
            let beforeId: string | undefined;
            for (;;) {
              const page = await reader.page(view, { before: beforeId, limit: 20 + Math.floor(random() * 81) }, scan);
              back.unshift(...page.entries.map((e) => e.id));
              if (page.nextBefore === null) break;
              beforeId = page.nextBefore;
            }
            const forward: string[] = [];
            let afterId = "0:0";
            for (;;) {
              const page = await reader.page(view, { after: afterId, limit: 20 + Math.floor(random() * 81) }, scan);
              forward.push(...page.entries.map((e) => e.id));
              if (page.nextAfter === null) break;
              afterId = page.nextAfter;
            }
            const listing = await reader.sessions(view, { limit: 50 }, scan);
            const ends = await reader.bounds(view, {}, scan);
            return { back, forward, lines: listing.lines, sessions: listing.sessions.map((x) => [x.firstId, x.lastId, x.lines]), ends: ends ? [ends.first.id, ends.last.id] : null };
          } finally {
            scan.close();
          }
        };
        // The run is only a test if it wrote what the rules tell apart: hits on both monsters, whispers, and a hidden monster at the end in half the seeds.
        const hits = archived.filter((line) => line.data?.type === "hp");
        assert.ok(hits.some((line) => (line.data as { tokenId?: string }).tokenId === lurker.token.id));
        assert.ok(hits.some((line) => (line.data as { tokenId?: string }).tokenId === seen.token.id));
        assert.ok(archived.some((line) => line.kind === "whisper"));
        const first = new Map<string, Awaited<ReturnType<typeof answers>>>();
        for (const id of members) {
          const who = role(id);
          const mine = archived.filter((line) => readable(line, who, hidden));
          const ids = mine.map((line) => line.id);
          const got = await answers(who, new LogHistory({ pool: scanPool, batchRows: 1 + Math.floor(random() * 600) }), captureView({ state, seq }, roomId, who));
          const label = `seed ${seed} ${who.role} ${players.indexOf(id)}`;
          assert.deepEqual(got.back, ids, `${label} backward`);
          assert.deepEqual(got.forward, ids, `${label} forward`);
          assert.equal(got.lines, mine.length, `${label} lines`);
          assert.deepEqual(got.sessions, oracleSessions(mine).slice(0, 50), `${label} sessions`);
          assert.deepEqual(got.ends, ids.length > 0 ? [ids[0], ids[ids.length - 1]] : null, `${label} ends`);
          first.set(id, got);
        }
        // More ops only the DM and Pip read: Quin's and Rho's answers do not move, read afresh at the new seq.
        for (let i = 0; i < 200; i++) await apply({ t: "log.whisper", to: [i % 2 === 0 ? players[0]! : dmId], text: `private ${i}` } as Op, role(i % 2 === 0 ? dmId : players[0]!));
        await flush();
        for (const id of players.slice(1)) {
          const who = role(id);
          const again = await answers(who, new LogHistory({ pool: scanPool, batchRows: 1 + Math.floor(random() * 600) }), captureView({ state, seq }, roomId, who));
          assert.deepEqual(again, first.get(id), `seed ${seed} private additions`);
        }
        assert.ok(snapshots > 0, `seed ${seed} wrote snapshots`);
        stats.push({ refused, reloads, snapshots, lines: archived.length, live: state.log.length, hidden: hidden.size > 0 });
      }
      assert.ok(stats.some((s) => s.hidden) && stats.some((s) => !s.hidden), "some seeds end with the monster hidden and some with it seen");
      assert.ok(stats.some((s) => s.reloads > 0), "some seeds reload");
      console.log(`reducer agreement: ${JSON.stringify(stats.map((s) => [s.lines, s.live, s.snapshots, s.reloads, s.refused, s.hidden]))}`);
    } finally {
      budget.close();
      await scanPool.end();
    }
  });
});

/** Sessions in id order with a gap over four hours between them, newest first, as plain tuples. */
function oracleSessions(rows: readonly LogEntry[]): [string, string, number][] {
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
