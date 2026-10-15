import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ipKey } from "./ipKey.ts";
import { PasswordHasher, Semaphore } from "./passwords.ts";
import { SlowLimits } from "./ratelimit.ts";
import { randomIp, startTestApp, type TestApp } from "./testing.ts";

const PASSWORD = "owlbear-druid-wand";

describe("request limits", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("at a shared IP, each session has its own allowance and the IP's is separate", async () => {
    const table = randomIp();
    const dm = t.client(table);
    const { roomId } = await dm.createRoom();
    const player = t.client(table);
    await player.join(roomId);

    // Well past the 120 an IP gets: counted per session, so nobody is limited.
    for (let i = 0; i < 130; i++) {
      assert.equal((await dm.get(`/api/rooms/${roomId}`)).statusCode, 200);
      assert.equal((await player.get(`/api/rooms/${roomId}`)).statusCode, 200);
    }
    const res = await dm.get(`/api/rooms/${roomId}`);
    assert.equal(res.headers["x-ratelimit-limit"], "600");

    // A device with no session shares the IP's 120.
    const anonymous = t.client(table);
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await anonymous.get(`/api/rooms/${roomId}`)).statusCode === 429) limited++;
    assert.ok(limited >= 5, `limited ${limited}`);
    // An invented cookie is no session, so it is counted against the IP too.
    const forger = t.client(table);
    forger.token = "C".repeat(43);
    assert.equal((await forger.get(`/api/rooms/${roomId}`)).statusCode, 429);
    // The sessions at that IP are unaffected.
    assert.equal((await dm.get(`/api/rooms/${roomId}/me`)).statusCode, 200);
    assert.equal((await player.get(`/api/rooms/${roomId}/me`)).statusCode, 200);
  });

  test("a percent-encoded path is limited like the route it reaches", async () => {
    const anonymous = t.client();
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const res = await anonymous.get("/%61pi/config");
      if (res.statusCode === 200) ok++;
      if (res.statusCode === 429) limited++;
    }
    assert.equal(ok, 120);
    assert.equal(limited, 10);
  });

  test("image reads have their own allowance, and it is a limit", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const before = Number((await dm.get(`/api/rooms/${roomId}`)).headers["x-ratelimit-remaining"]);
    const read = await dm.get("/api/assets/00000000-0000-4000-8000-000000000000/thumb");
    assert.equal(read.statusCode, 404);
    assert.equal(read.headers["x-ratelimit-limit"], "3000");
    // An encoded path is the same image read.
    assert.equal((await dm.get("/api/%61ssets/00000000-0000-4000-8000-000000000000/thumb")).headers["x-ratelimit-limit"], "3000");
    // Neither read spent the session's 600.
    assert.equal(Number((await dm.get(`/api/rooms/${roomId}`)).headers["x-ratelimit-remaining"]), before - 1);
  });

  test("one session is held to 600 a minute", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 605; i++) {
      const status = (await dm.get(`/api/rooms/${roomId}`)).statusCode;
      if (status === 200) ok++;
      if (status === 429) limited++;
    }
    assert.equal(ok, 600);
    assert.equal(limited, 5);
  });
});

describe("slow limits", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  async function insertEvents(key: string, n: number, ago = "1 second"): Promise<void> {
    await t.pool.query("insert into rate_events (key, at) select $1, now() - $3::interval from generate_series(1, $2)", [
      key,
      n,
      ago,
    ]);
  }

  test("20 password failures lock that IP out of that room, whatever session it uses", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const other = await dm.createRoom("Other room");
    const ip = randomIp();
    const guesser = t.client(ip);
    for (let i = 0; i < 20; i++) {
      assert.equal((await guesser.post(`/api/rooms/${roomId}/join`, { password: `wrong-guess-${i}` })).statusCode, 403);
    }
    const locked = await guesser.post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.equal(locked.statusCode, 429);
    assert.ok(Number(locked.headers["retry-after"]) >= 1);
    // The first delay is a second. Five more failures stretch it to 32 s, so
    // the checks below cannot race it.
    await insertEvents(`fail:${roomId}:${ipKey(ip)}`, 5);
    // A fresh device at the same IP is locked out the same.
    assert.equal((await t.client(ip).post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 429);
    // The DM key counts the same failures.
    assert.equal((await t.client(ip).post(`/api/rooms/${roomId}/dm`, { key: "A".repeat(43) })).statusCode, 429);
    // Another room, and another IP, are not affected.
    assert.equal((await t.client(ip).post(`/api/rooms/${other.roomId}/join`, { password: PASSWORD })).statusCode, 200);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 200);
  });

  test("delays grow to a 15-minute lockout", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const ip = randomIp();
    t.client(ip);
    await insertEvents(`fail:${roomId}:${ipKey(ip)}`, 25);
    const res = await t.client(ip).post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.equal(res.statusCode, 429);
    const wait = Number(res.headers["retry-after"]);
    assert.ok(wait > 25 && wait <= 32, `2^5 s after the latest failure, got ${wait}`);

    const burst = randomIp();
    t.client(burst);
    // 30 failures 11 minutes ago: out of the 10-minute window, still locked.
    await insertEvents(`fail:${roomId}:${ipKey(burst)}`, 30, "11 minutes");
    const lockout = await t.client(burst).post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.equal(lockout.statusCode, 429);
    const left = Number(lockout.headers["retry-after"]);
    assert.ok(left > 200 && left <= 240, `about 4 minutes of 15 left, got ${left}`);
  });

  test("failures from many IPs never lock a room for anyone else", async () => {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom();
    // Thirty addresses, each well past its own lockout, rows a room-wide count once left behind, and
    // the room's challenge count far past its threshold (it only asks for Turnstile, which is off here).
    for (let i = 0; i < 30; i++) {
      const ip = randomIp();
      t.client(ip);
      await insertEvents(`fail:${roomId}:${ipKey(ip)}`, 30);
    }
    await insertEvents(`fail:${roomId}`, 200);
    await insertEvents(`fail:room:${roomId}`, 200);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 200);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "New laptop" })).statusCode, 200);
    // A wrong guess is limited for its own address only. The room counts it toward the challenge, never a lockout.
    const count = async (key: string) => (await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [key])).rows[0]?.n;
    const before = await count(`fail:${roomId}`);
    const challenge = await count(`fail:room:${roomId}`);
    const guesser = t.client();
    assert.equal((await guesser.post(`/api/rooms/${roomId}/join`, { password: "wrong-guess" })).statusCode, 403);
    assert.equal(await count(`fail:${roomId}`), before);
    assert.equal(await count(`fail:room:${roomId}`), (challenge ?? 0) + 1);
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [`fail:${roomId}:${ipKey(guesser.ip)}`]);
    assert.equal(rows[0]?.n, 1);
  });

  test("addresses in one IPv6 /64 share one failure count", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    for (let i = 0; i < 20; i++) {
      const res = await t.client(`2001:db8:77:0::${(i + 1).toString(16)}`).post(`/api/rooms/${roomId}/join`, { password: `wrong-guess-${i}` });
      assert.equal(res.statusCode, 403);
    }
    assert.equal((await t.client("2001:db8:77:0::ffff").post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 429);
    assert.equal((await t.client("2001:db8:78:0::1").post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 200);
  });

  test("successful joins, claims and redemptions: 30 an hour per IP, 60 per room", async () => {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom();
    const busyIp = randomIp();
    t.client(busyIp);
    await insertEvents(`ok:ip:${ipKey(busyIp)}`, 30);
    assert.equal((await t.client(busyIp).post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 429);
    assert.equal((await t.client(busyIp).post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "X" })).statusCode, 429);
    const invite = (await dm.post(`/api/rooms/${roomId}/dm/invite`)).json<{ token: string }>().token;
    assert.equal((await t.client(busyIp).post("/api/dm/redeem", { token: invite, name: "X" })).statusCode, 429);

    await insertEvents(`ok:room:${roomId}`, 60);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 429);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token: invite, name: "X" })).statusCode, 429);
  });

  test("each success is counted per IP and per room", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const c = t.client();
    await c.join(roomId);
    const { rows } = await t.pool.query<{ key: string }>("select key from rate_events where key = any($1::text[])", [
      [`ok:ip:${ipKey(c.ip)}`, `ok:room:${roomId}`],
    ]);
    assert.deepEqual(rows.map((r) => r.key).sort(), [`ok:ip:${ipKey(c.ip)}`, `ok:room:${roomId}`].sort());
  });

  test("pruning deletes rows older than a day", async () => {
    const key = `prune-test:${randomIp()}`;
    await insertEvents(key, 2, "25 hours");
    await insertEvents(key, 1, "23 hours");
    await new SlowLimits(t.pool, t.config).prune();
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [key]);
    assert.equal(rows[0]?.n, 1);
    await t.pool.query("delete from rate_events where key = $1", [key]);
  });
});

describe("argon2 queue", () => {
  test("beyond 2 running and 8 waiting, password checks get 429", async () => {
    const hasher = new PasswordHasher(new Semaphore(2, 8));
    const t = await startTestApp({ hasher });
    try {
      const dm = t.client();
      const { roomId } = await dm.createRoom();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = Array.from({ length: 10 }, () => hasher.semaphore.run(() => gate));
      assert.equal(hasher.semaphore.active, 2);
      assert.equal(hasher.semaphore.waiting, 8);

      const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
      assert.equal(res.statusCode, 429);
      assert.deepEqual(res.json(), { error: "busy" });
      assert.ok(res.headers["retry-after"]);
      const create = await t.client().post("/api/rooms", { name: "Busy", playerPassword: PASSWORD, dmName: "DM" });
      assert.equal(create.statusCode, 429);

      release();
      await Promise.all(held);
      assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 200);
    } finally {
      await t.close();
    }
  });

  test("a real flood is refused rather than queued", async () => {
    const t = await startTestApp();
    try {
      const dm = t.client();
      const { roomId } = await dm.createRoom();
      const results = await Promise.all(
        Array.from({ length: 40 }, () => t.client().post(`/api/rooms/${roomId}/join`, { password: "not-the-password" })),
      );
      const statuses = results.map((r) => r.statusCode);
      assert.ok(statuses.includes(429), statuses.join(","));
      assert.ok(statuses.every((s) => s === 403 || s === 429));
    } finally {
      await t.close();
    }
  });
});
