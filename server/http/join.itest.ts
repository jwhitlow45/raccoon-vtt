import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MockAgent } from "undici";
import type { RoomState } from "#shared/model.ts";
import { ipKey } from "../auth/ipKey.ts";
import { PasswordHasher } from "../auth/passwords.ts";
import { startTestApp, type TestApp } from "../auth/testing.ts";
import { setTurnstileDispatcherForTests } from "../auth/turnstile.ts";

const PASSWORD = "owlbear-druid-wand";

describe("joining as a player", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  async function memberKinds(roomId: string): Promise<Record<string, string>> {
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    const members = rows[0]?.state.members ?? {};
    return Object.fromEntries(Object.values(members).map((m) => [m.name, m.kind]));
  }

  test("two steps: the password gives a ticket and the player roster, the ticket gives a grant", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const first = t.client();
    const firstId = await first.join(roomId, "Ayla", PASSWORD, "#AABBCC");
    assert.equal((await first.me(roomId)).role, "player");
    assert.deepEqual(await memberKinds(roomId), { "Dungeon Master": "dm", Ayla: "player" });

    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.equal(step1.statusCode, 200);
    const { ticket, players } = step1.json<{ ticket: string; players: unknown[] }>();
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    // Players only, name and color only, never the DM.
    assert.deepEqual(players, [{ id: firstId, name: "Ayla", color: "#aabbcc" }]);
    assert.ok(phone.token, "a session is created when the password is right");
    assert.equal((await phone.me(roomId)).status, 403, "no grant before step two");

    const step2 = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: firstId });
    assert.equal(step2.statusCode, 200);
    const joined = step2.json<{ roomId: string; memberId: string; role: string; member: { id: string; name: string; color: string; kind: string } }>();
    assert.deepEqual(
      { roomId: joined.roomId, memberId: joined.memberId, role: joined.role },
      { roomId, memberId: firstId, role: "player" },
    );
    // The answer carries the member the way GET /me does, since the join page goes on with it.
    assert.deepEqual(
      { id: joined.member.id, name: joined.member.name, color: joined.member.color, kind: joined.member.kind },
      { id: firstId, name: "Ayla", color: "#aabbcc", kind: "player" },
    );
    const me = await phone.me(roomId);
    assert.equal(me.role, "player");
    assert.equal(me.memberId, firstId);

    // Single use.
    const again = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: firstId });
    assert.equal(again.statusCode, 403);
    assert.equal(again.json<{ error: string }>().error, "bad_ticket");
  });

  test("step one carries every DM's current color, and no DM name or id", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const ownerId = (await owner.me(roomId)).memberId;
    assert.ok(ownerId);
    await t.client().join(roomId, "Pip", PASSWORD, "#30a46c");
    const bram = t.client();
    const claim = await bram.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Bram" });
    assert.equal(claim.statusCode, 200, claim.body);
    const bramId = claim.json<{ memberId: string }>().memberId;

    const step1 = async () => {
      const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
      assert.equal(res.statusCode, 200, res.body);
      return { body: res.body, json: res.json<{ ticket: string; players: Array<{ name: string }>; dmColors: string[] }>() };
    };

    // Both DMs start in the crest yellow: one entry per DM, in join order.
    const fresh = await step1();
    assert.deepEqual(Object.keys(fresh.json).sort(), ["dmColors", "players", "ticket"]);
    assert.deepEqual(fresh.json.dmColors, ["#f7df00", "#f7df00"]);
    assert.deepEqual(fresh.json.players.map((p) => p.name), ["Pip"]);

    // The owner picks blue in the Members color picker, a member.update the room writes to its snapshot.
    await t.pool.query(
      "update room_snapshots set state = jsonb_set(state, array['members', $2::text, 'color'], to_jsonb($3::text)) where room_id = $1",
      [roomId, ownerId, "#3e8ef7"],
    );
    const changed = await step1();
    assert.deepEqual(changed.json.dmColors, ["#3e8ef7", "#f7df00"]);
    for (const secret of [ownerId, bramId, "Dungeon Master", "Bram"]) {
      assert.ok(!changed.body.includes(secret), `step one names a DM: ${secret}`);
    }
  });

  test("a wrong password gives no ticket, no roster and no session", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const c = t.client();
    const res = await c.post(`/api/rooms/${roomId}/join`, { password: "wrong-password" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "bad_password" });
    assert.equal(c.token, undefined);
    assert.equal((await c.post("/api/rooms/ZZZZZZZZ/join", { password: PASSWORD })).statusCode, 404);
  });

  test("continuing as a DM member is refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const dmMemberId = (await dm.me(roomId)).memberId;
    assert.ok(dmMemberId);
    const c = t.client();
    const { ticket } = (await c.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    const res = await c.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: dmMemberId });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json<{ error: string }>().error, "not_a_player");
    assert.equal((await c.me(roomId)).status, 403);
    // A member no longer in the room reads as removed, as on the DM claim path.
    const unknown = await c.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: "no-such-member" });
    assert.equal(unknown.statusCode, 409);
    assert.equal(unknown.json<{ error: string }>().error, "member_removed");
    // A refused member does not use up the ticket.
    const ok = await c.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Bram", color: "#112233" });
    assert.equal(ok.statusCode, 200);
    const bram = ok.json<{ memberId: string; member: { id: string; name: string; kind: string } }>();
    assert.equal(bram.member.id, bram.memberId);
    assert.equal(bram.member.name, "Bram");
    assert.equal(bram.member.kind, "player");
  });

  test("a member the DM removed reads as removed, before or after the grant is written, and the ticket still joins someone new", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const pipId = await t.client().join(roomId, "Pip");
    const quinId = await t.client().join(roomId, "Quin");
    const phone = t.client();
    const { ticket } = (await phone.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();

    // Removed while the roster was open: refused before the ticket is used.
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${pipId}`)).statusCode, 204);
    const before = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: pipId });
    assert.equal(before.statusCode, 409);
    assert.equal(before.json<{ error: string }>().error, "member_removed");

    // Removed while the grant was being written: the grant is given up and the ticket comes back.
    const getMember = t.gateway.getMember;
    t.gateway.getMember = async (room, member) => {
      t.gateway.getMember = getMember;
      await t.gateway.removeMember(room, member);
      return getMember.call(t.gateway, room, member);
    };
    try {
      const during = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: quinId });
      assert.equal(during.statusCode, 409);
      assert.equal(during.json<{ error: string }>().error, "member_removed");
    } finally {
      t.gateway.getMember = getMember;
    }
    assert.equal((await phone.me(roomId)).status, 403);

    const fresh = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Rook", color: "#112233" });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal((await phone.me(roomId)).role, "player");
  });

  test("a member that was ever a DM cannot be continued, even once it is a player again", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    // A player who claimed DM with the key, then had it removed.
    const ayla = t.client();
    const aylaId = await ayla.join(roomId, "Ayla");
    assert.equal((await ayla.post(`/api/rooms/${roomId}/dm`, { key: dmKey })).statusCode, 200);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/members/${aylaId}`)).statusCode, 204);
    // A co-DM made by the key, then kicked.
    const bram = t.client();
    const claim = await bram.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Bram" });
    assert.equal(claim.statusCode, 200, claim.body);
    const bramId = claim.json<{ memberId: string }>().memberId;
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${bramId}/grants`)).statusCode, 204);
    assert.deepEqual(await memberKinds(roomId), { "Dungeon Master": "dm", Ayla: "player", Bram: "player" });
    const cato = t.client();
    const catoId = await cato.join(roomId, "Cato");

    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    const { ticket, players } = step1.json<{ ticket: string; players: Array<{ id: string }> }>();
    assert.deepEqual(players.map((p) => p.id), [catoId]);
    for (const formerDm of [aylaId, bramId]) {
      const res = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: formerDm });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json<{ error: string }>().error, "not_a_player");
    }
    assert.equal((await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: catoId })).statusCode, 200);
  });

  test("a ticket from room A is refused at room B, and stays usable at A", async () => {
    const dm = t.client();
    const a = await dm.createRoom("A");
    const b = await dm.createRoom("B");
    const c = t.client();
    const { ticket } = (await c.post(`/api/rooms/${a.roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    const wrongRoom = await c.post(`/api/rooms/${b.roomId}/join/complete`, { ticket, name: "Cy", color: "#112233" });
    assert.equal(wrongRoom.statusCode, 403);
    assert.equal((await c.me(b.roomId)).status, 403);
    const right = await c.post(`/api/rooms/${a.roomId}/join/complete`, { ticket, name: "Cy", color: "#112233" });
    assert.equal(right.statusCode, 200);
  });

  test("a ticket presented by another session is refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const verified = t.client();
    const { ticket } = (await verified.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();

    // Another device with its own session, and one with no session at all.
    const other = t.client();
    await other.join(roomId, "Other");
    const stolen = await other.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Thief", color: "#112233" });
    assert.equal(stolen.statusCode, 403);
    const anonymous = await t.client().post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Thief", color: "#112233" });
    assert.equal(anonymous.statusCode, 401);

    const own = await verified.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Owner", color: "#112233" });
    assert.equal(own.statusCode, 200);
    assert.equal((await memberKinds(roomId)).Thief, undefined);
  });

  test("a ticket is refused after a password change", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const c = t.client();
    const { ticket } = (await c.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    // Change the epoch directly, as a password change racing this join would,
    // so the check under the row lock is what refuses it.
    await t.pool.query("update rooms set player_epoch = player_epoch + 1 where id = $1", [roomId]);
    const res = await c.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Late", color: "#112233" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json<{ error: string }>().error, "stale_ticket");
    assert.equal((await c.me(roomId)).status, 403);
    assert.equal((await memberKinds(roomId)).Late, undefined);
  });

  test("an expired ticket is refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const c = t.client();
    const { ticket } = (await c.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      const res = await c.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Slow", color: "#112233" });
      assert.equal(res.statusCode, 403);
    } finally {
      Date.now = realNow;
    }
  });

  test("a DM device cannot join as a player over its DM grant", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const { ticket } = (await dm.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    const res = await dm.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Sneaky", color: "#112233" });
    assert.equal(res.statusCode, 409);
    assert.equal((await dm.me(roomId)).role, "dm");
  });

  test("bad names and colors are refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const c = t.client();
    const { ticket } = (await c.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    for (const body of [
      { ticket, name: "", color: "#112233" },
      { ticket, name: "  ", color: "#112233" },
      { ticket, name: "Bell\u0007", color: "#112233" },
      { ticket, name: "DM\u202E Bram", color: "#112233" },
      { ticket, name: "Ok", color: "red" },
      { ticket, name: "x".repeat(81), color: "#112233" },
      { ticket },
    ]) {
      const res = await c.post(`/api/rooms/${roomId}/join/complete`, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });
});

/** Counts password checks, so a test can tell whether a request reached the argon2 queue. */
class CountingHasher extends PasswordHasher {
  verifies = 0;

  override verify(phc: string, password: string): Promise<boolean> {
    this.verifies++;
    return super.verify(phc, password);
  }
}

describe("the join challenge after many wrong passwords", () => {
  const TURNSTILE = { TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "site-key" };
  let t: TestApp;
  let hasher: CountingHasher;
  let cloudflare: MockAgent;
  /** What Cloudflare was asked to verify: the token and the address it was sent with. */
  let verified: { response: string; remoteip: string }[] = [];

  before(async () => {
    hasher = new CountingHasher();
    t = await startTestApp({ env: TURNSTILE, hasher });
    cloudflare = new MockAgent();
    cloudflare.disableNetConnect();
    cloudflare
      .get("https://challenges.cloudflare.com")
      .intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
      .reply(200, (opts) => {
        const form = new URLSearchParams(String(opts.body));
        const response = form.get("response") ?? "";
        verified.push({ response, remoteip: form.get("remoteip") ?? "" });
        return { success: response === "solved" };
      })
      .persist();
    setTurnstileDispatcherForTests(cloudflare);
  });
  after(async () => {
    setTurnstileDispatcherForTests(null);
    await cloudflare.close();
    await t.close();
  });

  /** Creation needs the check too while Turnstile is on. Cloudflare's record of it is cleared. */
  async function createRoom(owner = t.client(), name = "Test room"): Promise<{ roomId: string; dmKey: string }> {
    const res = await owner.post("/api/rooms", { name, playerPassword: PASSWORD, dmName: "Dungeon Master", turnstileToken: "solved" });
    assert.equal(res.statusCode, 201, res.body);
    const { roomId, dmLink } = res.json<{ roomId: string; dmLink: string }>();
    t.track(roomId);
    verified = [];
    return { roomId, dmKey: dmLink.split("#dm=")[1] ?? "" };
  }

  /** Wrong passwords on a room, each from a new address, so no per-IP limit is near. */
  async function failFromManyIps(roomId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: `wrong-guess-${i}` });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json<{ error: string }>().error, "bad_password");
    }
  }

  async function roomFailures(roomId: string): Promise<number> {
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [
      `fail:room:${roomId}`,
    ]);
    return rows[0]?.n ?? 0;
  }

  test("under the threshold, joining needs no token and Cloudflare is never asked", async () => {
    const { roomId } = await createRoom();
    await failFromManyIps(roomId, 19);
    assert.equal(await roomFailures(roomId), 19);
    const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(verified, []);
  });

  test("at the threshold, counted across addresses, a join without a token is refused before the hash", async () => {
    const { roomId } = await createRoom();
    const other = await createRoom(t.client(), "Other room");
    // Twenty addresses with one wrong guess each: no address is near its own limit.
    await failFromManyIps(roomId, 20);

    const before = hasher.verifies;
    const c = t.client();
    for (const password of [PASSWORD, "wrong-guess"]) {
      const res = await c.post(`/api/rooms/${roomId}/join`, { password });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.json(), { error: "turnstile_required" });
    }
    assert.equal(hasher.verifies, before, "a challenged guess never reaches argon2");
    assert.equal(c.token, undefined, "and mints no session");
    assert.equal(await roomFailures(roomId), 20, "and is not counted as a wrong password");
    assert.deepEqual(verified, []);

    // The count is per room: the other room is not challenged.
    assert.equal((await t.client().post(`/api/rooms/${other.roomId}/join`, { password: PASSWORD })).statusCode, 200);
  });

  test("a solved check lets the join go on: the right password joins, a wrong one still counts", async () => {
    const { roomId } = await createRoom();
    await failFromManyIps(roomId, 20);

    const guesser = t.client("2001:db8:c0:1:2:3:4:5");
    const wrong = await guesser.post(`/api/rooms/${roomId}/join`, { password: "wrong-guess", turnstileToken: "solved" });
    assert.equal(wrong.statusCode, 403);
    assert.deepEqual(wrong.json(), { error: "bad_password" });
    assert.equal(await roomFailures(roomId), 21);
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [
      `fail:${roomId}:${ipKey(guesser.ip)}`,
    ]);
    assert.equal(rows[0]?.n, 1, "the per-IP count goes on as before");

    const player = t.client();
    const before = hasher.verifies;
    const right = await player.post(`/api/rooms/${roomId}/join`, { password: PASSWORD, turnstileToken: "solved" });
    assert.equal(right.statusCode, 200, right.body);
    assert.equal(hasher.verifies, before + 1);
    const { ticket } = right.json<{ ticket: string }>();
    const done = await player.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Ayla", color: "#3e8ef7" });
    assert.equal(done.statusCode, 200, done.body);

    // Cloudflare is sent the visitor's own address, as for room creation, not the /64 the limits count.
    assert.deepEqual(verified, [
      { response: "solved", remoteip: "2001:db8:c0:1:2:3:4:5" },
      { response: "solved", remoteip: player.ip },
    ]);
  });

  test("a token Cloudflare rejects answers turnstile_failed, before the hash and without counting", async () => {
    const { roomId } = await createRoom();
    await failFromManyIps(roomId, 20);
    const before = hasher.verifies;
    const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD, turnstileToken: "forged" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "turnstile_failed" });
    assert.equal(hasher.verifies, before);
    assert.equal(await roomFailures(roomId), 20);
    assert.deepEqual(verified.map((v) => v.response), ["forged"]);
  });

  test("Cloudflare not answering refuses the challenged join with turnstile_unavailable", async () => {
    const { roomId } = await createRoom();
    await failFromManyIps(roomId, 20);
    const down = new MockAgent();
    down.disableNetConnect();
    down.get("https://challenges.cloudflare.com").intercept({ path: "/turnstile/v0/siteverify", method: "POST" }).reply(500, "");
    setTurnstileDispatcherForTests(down);
    const before = hasher.verifies;
    try {
      const res = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD, turnstileToken: "solved" });
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { error: "turnstile_unavailable" });
      assert.equal(hasher.verifies, before, "an unverified join never reaches argon2");
      assert.equal(await roomFailures(roomId), 20, "and is not counted");
    } finally {
      setTurnstileDispatcherForTests(cloudflare);
      await down.close();
    }
  });

  test("a wrong DM key never counts toward the room's challenge", async () => {
    const { roomId } = await createRoom();
    const res = await t.client().post(`/api/rooms/${roomId}/dm`, { key: "A".repeat(43), name: "Mallory" });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(await roomFailures(roomId), 0);
  });

  test("a challenged room locks nobody out: devices with grants and the DM link work as before", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await createRoom(owner);
    const player = t.client();
    await player.join(roomId, "Bram");
    await failFromManyIps(roomId, 20);
    const challenged = await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    assert.deepEqual(challenged.json(), { error: "turnstile_required" });

    assert.equal((await player.me(roomId)).role, "player");
    assert.equal((await owner.me(roomId)).role, "dm");
    const laptop = t.client();
    assert.equal((await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Laptop" })).statusCode, 200);
    assert.equal((await laptop.me(roomId)).role, "dm");
  });
});

describe("the join challenge without Turnstile configured", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("no number of wrong passwords makes a join need a token", async () => {
    const { roomId } = await t.client().createRoom();
    for (let i = 0; i < 20; i++) {
      assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: `wrong-guess-${i}` })).statusCode, 403);
    }
    await t.pool.query("insert into rate_events (key, at) select $1, now() from generate_series(1, 200)", [`fail:room:${roomId}`]);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).statusCode, 200);
    const wrong = await t.client().post(`/api/rooms/${roomId}/join`, { password: "wrong-guess" });
    assert.deepEqual(wrong.json(), { error: "bad_password" });
  });
});
