import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { roomStoredBytes } from "../assets/quota.ts";
import { solid } from "../assets/testImages.ts";
import { CLOSE } from "./connection.ts";
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
