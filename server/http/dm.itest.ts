import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Member, RoomState } from "#shared/model.ts";
import { startTestApp, type TestApp, type TestClient } from "../auth/testing.ts";
import { ipKey } from "../auth/ipKey.ts";
import { sha256 } from "../auth/tokens.ts";

describe("DM access", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  async function members(roomId: string): Promise<Record<string, Member>> {
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    return rows[0]?.state.members ?? {};
  }

  async function sessionIdOf(c: TestClient): Promise<string> {
    const { rows } = await t.pool.query<{ id: string }>("select id from sessions where token_hash = $1", [
      sha256(c.token ?? ""),
    ]);
    const id = rows[0]?.id;
    assert.ok(id, "the client's token names a session");
    return id;
  }

  async function invite(dm: TestClient, roomId: string): Promise<string> {
    const res = await dm.post(`/api/rooms/${roomId}/dm/invite`);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json<{ token: string; link: string; expiresAt: string }>();
    assert.equal(body.link, `/r/${roomId.slice(0, 4)}-${roomId.slice(4)}#invite=${body.token}`);
    return body.token;
  }

  test("claiming DM rotates the token on the same session row and upgrades the player member", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const player = t.client();
    const memberId = await player.join(roomId, "Co-DM");
    // The same member on a second device stays a player.
    const secondDevice = t.client();
    const { ticket } = (await secondDevice.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).json<{
      ticket: string;
    }>();
    await secondDevice.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId });

    const sessionId = await sessionIdOf(player);
    const oldToken = player.token;
    const res = await player.post(`/api/rooms/${roomId}/dm`, { key: dmKey });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { roomId, memberId, role: "dm" });
    assert.notEqual(player.token, oldToken);

    // Same row, new token: the old cookie is dead at once.
    assert.equal(await sessionIdOf(player), sessionId);
    const me = await player.me(roomId);
    assert.equal(me.role, "dm");
    assert.equal(me.memberId, memberId);
    const stale = t.client();
    stale.token = oldToken;
    assert.equal((await stale.me(roomId)).status, 403);

    assert.equal((await members(roomId))[memberId]?.kind, "dm");
    assert.equal((await secondDevice.me(roomId)).role, "player");
  });

  test("a device with no grant is shown the DM members, then becomes someone new with a name", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const creator = (await owner.me(roomId)).memberId ?? "";
    const laptop = t.client();
    const nameless = await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey });
    assert.equal(nameless.statusCode, 409);
    assert.deepEqual(nameless.json(), {
      error: "choose_member",
      roomId,
      dmMembers: [{ id: creator, name: "Dungeon Master", color: "#f7df00" }],
    });
    assert.equal(laptop.token, undefined);

    const res = await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Laptop DM" });
    assert.equal(res.statusCode, 200);
    const { memberId } = res.json<{ memberId: string }>();
    assert.notEqual(memberId, creator);
    assert.equal((await members(roomId))[memberId]?.kind, "dm");
    assert.equal((await laptop.me(roomId)).role, "dm");
    const listed = (await t.client().post(`/api/rooms/${roomId}/dm`, { key: dmKey })).json<{ dmMembers: Array<{ id: string }> }>();
    assert.deepEqual(listed.dmMembers.map((m) => m.id), [creator, memberId]);
  });

  test("one DM on a second device continues as their own member, so no second member appears", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const creator = (await owner.me(roomId)).memberId ?? "";
    const before = Object.keys(await members(roomId)).length;
    const laptop = t.client();
    const res = await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey, memberId: creator });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { roomId, memberId: creator, role: "dm" });
    const me = await laptop.me(roomId);
    assert.deepEqual([me.role, me.memberId], ["dm", creator]);
    assert.equal(Object.keys(await members(roomId)).length, before);
    const { devices } = (await owner.get(`/api/rooms/${roomId}/dm/devices`)).json<{ devices: Array<{ memberId: string }> }>();
    assert.deepEqual(devices.map((d) => d.memberId), [creator, creator]);
  });

  test("an invite asks the same question without being spent, and a bare one says its room", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const creator = (await owner.me(roomId)).memberId ?? "";
    const token = await invite(owner, roomId);
    const tablet = t.client();
    const asked = await tablet.post(`/api/rooms/${roomId}/dm/redeem`, { token });
    assert.equal(asked.statusCode, 409);
    assert.equal(asked.json<{ error: string }>().error, "choose_member");
    const bare = await tablet.post("/api/dm/redeem", { token });
    assert.equal(bare.statusCode, 409);
    assert.equal(bare.json<{ roomId: string }>().roomId, roomId);
    const res = await tablet.post(`/api/rooms/${roomId}/dm/redeem`, { token, memberId: creator });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json<{ memberId: string }>().memberId, creator);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token, memberId: creator })).statusCode, 403);
  });

  test("after the DM link is replaced, the creator's other device continues as their own member", async () => {
    const phone = t.client();
    const { roomId, dmKey } = await phone.createRoom();
    const creator = (await phone.me(roomId)).memberId ?? "";
    const laptop = t.client();
    assert.equal((await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey, memberId: creator })).statusCode, 200);

    // The laptop replaces the link: the phone loses its grant, while the
    // member stays a DM through the laptop.
    const replaced = await laptop.post(`/api/rooms/${roomId}/dm/replace-link`);
    const newKey = replaced.json<{ dmLink: string }>().dmLink.split("#dm=")[1] ?? "";
    assert.equal((await phone.me(roomId)).status, 403);
    assert.equal((await members(roomId))[creator]?.kind, "dm");

    const asked = await phone.post(`/api/rooms/${roomId}/dm`, { key: newKey });
    assert.deepEqual(asked.json<{ dmMembers: Array<{ id: string }> }>().dmMembers.map((m) => m.id), [creator]);
    const res = await phone.post(`/api/rooms/${roomId}/dm`, { key: newKey, memberId: creator });
    assert.equal(res.statusCode, 200, res.body);
    const me = await phone.me(roomId);
    assert.deepEqual([me.role, me.memberId], ["dm", creator]);
    const dms = Object.values(await members(roomId)).filter((m) => m.kind === "dm");
    assert.deepEqual(dms.map((m) => m.id), [creator]);
  });

  test("a player member, a former DM or a missing member can never be picked", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const player = t.client();
    const playerId = await player.join(roomId, "Pip");
    const coDm = t.client();
    const coId = await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Co-DM" }).then((r) => r.json<{ memberId: string }>().memberId);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/members/${coId}`)).statusCode, 204);
    assert.equal((await members(roomId))[coId]?.kind, "player");

    const intruder = t.client();
    for (const memberId of [playerId, coId]) {
      const res = await intruder.post(`/api/rooms/${roomId}/dm`, { key: dmKey, memberId });
      assert.equal(res.statusCode, 403, memberId);
      assert.deepEqual(res.json(), { error: "not_a_dm" });
    }
    const missing = await intruder.post(`/api/rooms/${roomId}/dm`, { key: dmKey, memberId: "no-such-member" });
    assert.equal(missing.statusCode, 409);
    assert.deepEqual(missing.json(), { error: "member_removed" });
    // Nothing was written: no session, no grant, and the player is still only a player.
    assert.equal(intruder.token, undefined);
    assert.equal((await members(roomId))[playerId]?.kind, "player");
    const grants = await t.pool.query("select role from grants where room_id = $1 and member_id = $2", [roomId, playerId]);
    assert.deepEqual(grants.rows, [{ role: "player" }]);
    const listed = (await intruder.post(`/api/rooms/${roomId}/dm`, { key: dmKey })).json<{ dmMembers: Array<{ id: string }> }>();
    assert.ok(!listed.dmMembers.some((m) => m.id === playerId || m.id === coId));
  });

  test("a wrong key is refused and counted", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const c = t.client();
    const res = await c.post(`/api/rooms/${roomId}/dm`, { key: "A".repeat(43), name: "X" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "bad_key" });
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [
      `fail:${roomId}:${ipKey(c.ip)}`,
    ]);
    assert.equal(rows[0]?.n, 1);
  });

  test("invites: DM only, single use, and they make a DM device", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const player = t.client();
    await player.join(roomId);
    assert.equal((await player.post(`/api/rooms/${roomId}/dm/invite`)).statusCode, 403);

    const token = await invite(owner, roomId);
    const tablet = t.client();
    const res = await tablet.post(`/api/rooms/${roomId}/dm/redeem`, { token, name: "Tablet" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await tablet.me(roomId)).role, "dm");

    const reuse = await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token, name: "Again" });
    assert.equal(reuse.statusCode, 403);
    assert.deepEqual(reuse.json(), { error: "bad_invite" });
  });

  test("redeeming as a player upgrades that member and rotates the session", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const player = t.client();
    const memberId = await player.join(roomId, "Promoted");
    const sessionId = await sessionIdOf(player);
    const before = player.token;
    const token = await invite(owner, roomId);
    const res = await player.post(`/api/rooms/${roomId}/dm/redeem`, { token });
    assert.equal(res.statusCode, 200);
    assert.notEqual(player.token, before);
    assert.equal(await sessionIdOf(player), sessionId);
    assert.equal((await player.me(roomId)).memberId, memberId);
    assert.equal((await members(roomId))[memberId]?.kind, "dm");
  });

  test("an expired invite is refused", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const token = await invite(owner, roomId);
    await t.pool.query("update dm_invites set expires_at = now() - interval '1 second' where room_id = $1", [roomId]);
    const res = await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token, name: "Late" });
    assert.equal(res.statusCode, 403);
  });

  test("an invite from room A is refused at room B", async () => {
    const owner = t.client();
    const a = await owner.createRoom("A");
    const b = await owner.createRoom("B");
    const token = await invite(owner, a.roomId);
    const c = t.client();
    const res = await c.post(`/api/rooms/${b.roomId}/dm/redeem`, { token, name: "Wrong room" });
    assert.equal(res.statusCode, 403);
    assert.equal((await c.me(b.roomId)).status, 403);
    // Still unused, so it works where it belongs.
    assert.equal((await c.post(`/api/rooms/${a.roomId}/dm/redeem`, { token, name: "Right room" })).statusCode, 200);
  });

  test("a bare invite token finds its room", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const token = await invite(owner, roomId);
    const phone = t.client();
    const res = await phone.post("/api/dm/redeem", { token, name: "Home Screen app" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ roomId: string }>().roomId, roomId);
    assert.equal((await phone.me(roomId)).role, "dm");
    assert.equal((await t.client().post("/api/dm/redeem", { token, name: "Twice" })).statusCode, 403);
    assert.equal((await t.client().post("/api/dm/redeem", { token: "B".repeat(43), name: "Nope" })).statusCode, 403);
  });

  test("replacing the DM link leaves only the replacer with DM", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const coDm = t.client();
    const coMemberId = (await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Co-DM" })).json<{ memberId: string }>()
      .memberId;
    const ownerPhone = t.client();
    await ownerPhone.post(`/api/rooms/${roomId}/dm/redeem`, { token: await invite(owner, roomId), name: "Owner phone" });
    const pending = await invite(coDm, roomId);
    const player = t.client();
    await player.join(roomId);
    const coSession = await sessionIdOf(coDm);

    const res = await owner.post(`/api/rooms/${roomId}/dm/replace-link`);
    assert.equal(res.statusCode, 200);
    const newKey = res.json<{ dmLink: string }>().dmLink.split("#dm=")[1] ?? "";
    assert.notEqual(newKey, dmKey);

    assert.equal((await owner.me(roomId)).role, "dm");
    assert.equal((await coDm.me(roomId)).status, 403);
    assert.equal((await ownerPhone.me(roomId)).status, 403);
    assert.equal((await player.me(roomId)).role, "player");
    assert.equal((await members(roomId))[coMemberId]?.kind, "player");
    const ownerMember = (await owner.me(roomId)).memberId ?? "";
    assert.equal((await members(roomId))[ownerMember]?.kind, "dm");
    assert.ok(
      t.gateway.closed.some(
        (c) => c.roomId === roomId && c.code === 4001 && "sessionIds" in c.filter && c.filter.sessionIds.includes(coSession),
      ),
    );

    const dmGrants = await t.pool.query("select 1 from grants where room_id = $1 and role = 'dm'", [roomId]);
    assert.equal(dmGrants.rowCount, 1);
    // The old key and every older invite are dead, the new key works.
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Leaked" })).statusCode, 403);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token: pending, name: "Old" })).statusCode, 403);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm`, { key: newKey, name: "Fresh" })).statusCode, 200);
  });

  test("an invite minted before an epoch bump is refused", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const token = await invite(owner, roomId);
    // Bump the epoch without the cleanup, so the epoch check alone refuses it.
    await t.pool.query("update rooms set dm_epoch = dm_epoch + 1 where id = $1", [roomId]);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token, name: "Old" })).statusCode, 403);
    // The owner's own grant went stale with it, and is deleted on its check.
    assert.equal((await owner.me(roomId)).status, 403);
    const grants = await t.pool.query("select 1 from grants where room_id = $1", [roomId]);
    assert.equal(grants.rowCount, 0);
  });

  test("the devices list shows every DM device, and revoking one deletes its invites and resets kind", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const coDm = t.client();
    const coMemberId = (await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Co-DM" })).json<{ memberId: string }>()
      .memberId;
    const coInvite = await invite(coDm, roomId);
    const ownerInvite = await invite(owner, roomId);
    const coSession = await sessionIdOf(coDm);

    const list = await owner.get(`/api/rooms/${roomId}/dm/devices`);
    assert.equal(list.statusCode, 200);
    const { devices, invites } = list.json<{
      devices: Array<{ sessionId: string; memberId: string; device: string; online: boolean; current: boolean }>;
      invites: Array<{ expiresAt: string; used: boolean }>;
    }>();
    assert.equal(devices.length, 2);
    assert.ok(devices.every((d) => d.online === false), "no sockets without a room engine");
    // Only this device's own invites, so its invite card can tell when its invite is used.
    assert.equal(invites.length, 1);
    assert.equal(invites[0]?.used, false);
    assert.equal(devices.filter((d) => d.current).length, 1);
    assert.ok(devices.some((d) => d.sessionId === coSession && d.memberId === coMemberId && !d.current));

    const res = await owner.delete(`/api/rooms/${roomId}/dm/devices/${coSession}`);
    assert.equal(res.statusCode, 204);
    assert.equal((await coDm.me(roomId)).status, 403);
    assert.equal((await members(roomId))[coMemberId]?.kind, "player");
    assert.ok(
      t.gateway.closed.some(
        (c) => c.roomId === roomId && c.code === 4001 && "sessionIds" in c.filter && c.filter.sessionIds.includes(coSession),
      ),
    );
    // Only the revoked device's invites are gone.
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token: coInvite, name: "X" })).statusCode, 403);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token: ownerInvite, name: "Y" })).statusCode, 200);
    const after = (await owner.get(`/api/rooms/${roomId}/dm/devices`)).json<{ invites: Array<{ expiresAt: string; used: boolean }> }>();
    assert.deepEqual(after.invites.map((i) => i.used), [true]);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/devices/${coSession}`)).statusCode, 404);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/devices/not-a-uuid`)).statusCode, 404);
  });

  test("revoking one of two DM devices of a member keeps its kind until the last", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    // One person on two devices: both join as the same player, then both
    // redeem an invite, which upgrades that one member.
    const phone = t.client();
    const memberId = await phone.join(roomId, "Co-DM");
    const tablet = t.client();
    const { ticket } = (await tablet.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).json<{
      ticket: string;
    }>();
    await tablet.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId });
    for (const device of [phone, tablet]) {
      const res = await device.post(`/api/rooms/${roomId}/dm/redeem`, { token: await invite(owner, roomId) });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json<{ memberId: string }>().memberId, memberId);
    }
    assert.equal((await members(roomId))[memberId]?.kind, "dm");

    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/devices/${await sessionIdOf(phone)}`)).statusCode, 204);
    assert.equal((await members(roomId))[memberId]?.kind, "dm");
    assert.equal((await tablet.me(roomId)).role, "dm");
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/devices/${await sessionIdOf(tablet)}`)).statusCode, 204);
    assert.equal((await members(roomId))[memberId]?.kind, "player");
  });

  test("remove DM deletes every DM grant of the member and its invites, and resets kind", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const coDm = t.client();
    const coMemberId = (await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Co-DM" })).json<{ memberId: string }>()
      .memberId;
    const coInvite = await invite(coDm, roomId);
    const player = t.client();
    await player.join(roomId);

    assert.equal((await player.delete(`/api/rooms/${roomId}/dm/members/${coMemberId}`)).statusCode, 403);
    const ownerMember = (await owner.me(roomId)).memberId;
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/members/${ownerMember}`)).statusCode, 400);

    const res = await owner.delete(`/api/rooms/${roomId}/dm/members/${coMemberId}`);
    assert.equal(res.statusCode, 204);
    assert.equal((await coDm.me(roomId)).status, 403);
    assert.equal((await members(roomId))[coMemberId]?.kind, "player");
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token: coInvite, name: "X" })).statusCode, 403);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/dm/members/no-such-member`)).statusCode, 404);

    // The former co-DM can rejoin with the password, but only as someone
    // new: a member that was a DM keeps the whispers it had as DM, so
    // nobody may continue as it.
    const { ticket, players } = (await coDm.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).json<{
      ticket: string;
      players: Array<{ id: string }>;
    }>();
    assert.ok(!players.some((p) => p.id === coMemberId));
    assert.equal((await coDm.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: coMemberId })).statusCode, 403);
    assert.equal((await coDm.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Co-DM again", color: "#112233" })).statusCode, 200);
  });
});

describe("kicking", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("kick deletes the member's grants on every device and leaves it in the roster", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const phone = t.client();
    const memberId = await phone.join(roomId, "Kicked");
    const tablet = t.client();
    const { ticket } = (await tablet.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).json<{
      ticket: string;
    }>();
    await tablet.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId });
    const bystander = t.client();
    await bystander.join(roomId, "Stays");

    assert.equal((await bystander.delete(`/api/rooms/${roomId}/members/${memberId}/grants`)).statusCode, 403);
    const res = await owner.delete(`/api/rooms/${roomId}/members/${memberId}/grants`);
    assert.equal(res.statusCode, 204);
    assert.equal((await phone.me(roomId)).status, 403);
    assert.equal((await tablet.me(roomId)).status, 403);
    assert.equal((await bystander.me(roomId)).role, "player");
    const close = t.gateway.closed.findLast((c) => c.roomId === roomId);
    assert.ok(close && close.code === 4001 && "sessionIds" in close.filter && close.filter.sessionIds.length === 2);

    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(rows[0]?.state.members[memberId]?.name, "Kicked");
    // A kicked player who knows the password can come back.
    const back = await phone.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(back.statusCode, 200);
  });

  test("a kicked DM's invite is refused and its kind resets", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom();
    const coDm = t.client();
    const coMemberId = (await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Co-DM" })).json<{ memberId: string }>()
      .memberId;
    const res = await coDm.post(`/api/rooms/${roomId}/dm/invite`);
    const { token } = res.json<{ token: string }>();

    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${coMemberId}/grants`)).statusCode, 204);
    assert.equal((await coDm.me(roomId)).status, 403);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(rows[0]?.state.members[coMemberId]?.kind, "player");
    const redeem = await t.client().post(`/api/rooms/${roomId}/dm/redeem`, { token, name: "Smuggled" });
    assert.equal(redeem.statusCode, 403);
    const bare = await t.client().post("/api/dm/redeem", { token, name: "Smuggled" });
    assert.equal(bare.statusCode, 403);
  });

  test("a DM cannot kick itself, and unknown members are 404", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom();
    const me = (await owner.me(roomId)).memberId;
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${me}/grants`)).statusCode, 400);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/nobody/grants`)).statusCode, 404);
  });
});
