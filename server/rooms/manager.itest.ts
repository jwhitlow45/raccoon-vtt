import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * Loading, unloading and eviction (design 10.5 and 16.2), the snapshot
 * budget (10.4), grant changes reaching sockets (10.2), graceful restart
 * (15.4) and crash recovery by replay.
 */
const actor = {
  hp: { cur: 7, max: 7, temp: 0 },
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
};

async function fillScene(dm: Socket, sceneId: string, tokens: number): Promise<void> {
  for (let i = 0; i < tokens; i++) {
    dm.op({ t: "token.create", token: { id: uuidv7(), sceneId, kind: "monster", name: `Goblin ${i}`, size: "medium", x: i % 50, y: Math.floor(i / 50), actor: { inline: actor } } });
    // Stay under the per-socket op rate.
    if (i % 15 === 14) await new Promise((r) => setTimeout(r, 1_000));
  }
  await dm.next("ev", (m) => m.acks?.includes(dm.n) ?? false, 10_000);
}

describe("room loading and eviction", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { maxLoaded: 2, minLoadedMs: 1_500, minIdleMs: 1_500, idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  test("a third room is refused with 4011 while nothing qualifies, evicts the oldest idle room with 4010 later, and cannot loop", async () => {
    const owners = [t.client(), t.client(), t.client()];
    const rooms: string[] = [];
    for (const [i, owner] of owners.entries()) rooms.push((await owner.createRoom(`Room ${i}`)).roomId);
    const a = await t.connect(rooms[0]!, owners[0]!);
    await a.snapshot("a");
    const b = await t.connect(rooms[1]!, owners[1]!);
    await b.snapshot("b");
    // Both rooms are young: nothing may be evicted yet.
    const refused = await t.connect(rooms[2]!, owners[2]!);
    assert.equal((await refused.waitClosed()).code, 4011);
    assert.deepEqual(t.manager.loadedRoomIds.sort(), [rooms[0], rooms[1]].sort());

    await new Promise((r) => setTimeout(r, 1_600));
    const c = await t.connect(rooms[2]!, owners[2]!);
    await c.snapshot("c");
    // A is the oldest and idle, so it went, sockets and all.
    assert.equal((await a.waitClosed()).code, 4010);
    assert.deepEqual(t.manager.loadedRoomIds.sort(), [rooms[1], rooms[2]].sort());
    // A comes back: B is old enough and goes. B comes back: A and C are too young, so B waits with 4011 instead of looping.
    const a2 = await t.connect(rooms[0]!, owners[0]!);
    await a2.snapshot("a");
    assert.equal((await b.waitClosed()).code, 4010);
    const b2 = await t.connect(rooms[1]!, owners[1]!);
    assert.equal((await b2.waitClosed()).code, 4011);
    assert.equal(a2.closeCode, null);
    assert.equal(c.closeCode, null);
    a2.close();
    c.close();
  });

  test("a pinned room is never evicted and may evict the oldest unpinned room at once", async () => {
    // Free the slots from the previous test.
    for (const id of t.manager.loadedRoomIds) await t.manager.unload(id);
    const owners = [t.client(), t.client(), t.client()];
    const rooms: string[] = [];
    for (const [i, owner] of owners.entries()) rooms.push((await owner.createRoom(`Pin ${i}`)).roomId);
    await t.pool.query("update rooms set pinned = true where id = $1", [rooms[2]]);
    const a = await t.connect(rooms[0]!, owners[0]!);
    await a.snapshot("a");
    const b = await t.connect(rooms[1]!, owners[1]!);
    await b.snapshot("b");
    const pinned = await t.connect(rooms[2]!, owners[2]!);
    await pinned.snapshot("p");
    assert.equal((await a.waitClosed()).code, 4010);
    assert.equal(pinned.closeCode, null);
    // Now an unpinned room needs a slot: only B qualifies once it is old enough, never the pinned one.
    await new Promise((r) => setTimeout(r, 1_600));
    const a2 = await t.connect(rooms[0]!, owners[0]!);
    await a2.snapshot("a");
    assert.equal((await b.waitClosed()).code, 4010);
    assert.equal(pinned.closeCode, null);
    assert.ok(t.manager.loadedRoomIds.includes(rooms[2]!));
    a2.close();
    pinned.close();
  });
});

describe("idle unload, snapshots and recovery", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 300, actor: { snapshotOps: 3, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("an idle room unloads with its snapshot, and a crash is recovered by replaying the ops after it", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Replay");
    const s = await t.connect(roomId, owner);
    const sceneId = ((await s.snapshot("c1")).state as ProjectedState).meta.playerSceneId!;
    for (let i = 0; i < 3; i++) await s.apply({ t: "log.chat", text: `m${i}` });
    // Three ops: the snapshot schedule fires.
    await new Promise((r) => setTimeout(r, 300));
    const snap1 = await t.pool.query<{ seq: string }>("select seq::text from room_snapshots where room_id = $1", [roomId]);
    assert.equal(snap1.rows[0]?.seq, "3");
    const goblinId = uuidv7();
    await s.apply({ t: "token.create", token: { id: goblinId, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor } } });
    await s.apply({ t: "token.move", tokenId: goblinId, x: 4, y: 4 });
    // Crash: no snapshot, the actor is simply gone.
    await t.manager.unload(roomId, 1011, false);
    await s.waitClosed();
    const snap2 = await t.pool.query<{ seq: string }>("select seq::text from room_snapshots where room_id = $1", [roomId]);
    assert.equal(snap2.rows[0]?.seq, "3");
    const ops = await t.pool.query<{ seq: string }>("select seq::text from room_ops where room_id = $1 order by seq", [roomId]);
    assert.deepEqual(ops.rows.map((r) => r.seq), ["1", "2", "3", "4", "5"]);

    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot("c1", 6);
    assert.equal(snap.seq, 5);
    const state = snap.state as ProjectedState;
    assert.equal(state.tokens[goblinId]?.x, 4);
    assert.equal(state.log.length, 3);
    back.close();
    await back.waitClosed();
    // Idle: the room unloads on its own and writes the snapshot it owes.
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(t.manager.get(roomId), null);
    const snap3 = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(snap3.rows[0]?.seq, "5");
    assert.equal(snap3.rows[0]?.state.tokens[goblinId]?.x, 4);
  });

  test("version 4 heal, set and Revive ops on the dead replay as they applied then, and a new op is stored at the current version", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Op version 4");
    const s = await t.connect(roomId, owner);
    const sceneId = ((await s.snapshot("c1")).state as ProjectedState).meta.playerSceneId!;
    const goblin = (hp: number) => ({ ...actor, hp: { cur: hp, max: 20, temp: 0 }, life: "dead" });
    const [healed, set, revived] = [uuidv7(), uuidv7(), uuidv7()];
    for (const [id, hp] of [[healed, 0], [set, 0], [revived, 12]] as const) {
      await s.apply({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: goblin(hp) } } });
    }
    // Three ops: the snapshot schedule fires, so the ops below come after the snapshot, as a crash leaves them.
    await new Promise((r) => setTimeout(r, 300));
    await t.manager.unload(roomId, 1011, false);
    await s.waitClosed();
    const { rows } = await t.pool.query<{ seq: string; member: string }>(
      "select s.seq::text, (select actor_member_id from room_ops where room_id = $1 limit 1) as member from room_snapshots s where s.room_id = $1",
      [roomId],
    );
    assert.equal(rows[0]?.seq, "3");
    const stored = [
      { t: "actor.hp", target: { tokenId: healed }, change: { kind: "heal", amount: 5 } },
      { t: "actor.hp", target: { tokenId: set }, change: { kind: "set", cur: 9 } },
      { t: "actor.life", target: { tokenId: revived }, life: "alive" },
    ];
    for (const [i, op] of stored.entries()) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         values ($1, $2, now(), $3, 'dm', $4::jsonb, 4)`,
        [roomId, 4 + i, rows[0]!.member, JSON.stringify(op)],
      );
    }

    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot("c1", 4);
    assert.equal(snap.seq, 6);
    const vitals = (state: ProjectedState, id: string) => {
      const a = state.tokens[id]?.actor;
      assert.ok(a && "inline" in a);
      return [a.inline.life, a.inline.hp?.cur];
    };
    const state = snap.state as ProjectedState;
    assert.deepEqual(vitals(state, healed), ["dead", 0], "healing did nothing to the dead then");
    assert.deepEqual(vitals(state, set), ["dead", 9], "a set left it dead at the set HP");
    assert.deepEqual(vitals(state, revived), ["alive", 12], "Revive kept the HP it held");

    back.n = 3;
    await back.apply({ t: "actor.hp", target: { tokenId: healed }, change: { kind: "heal", amount: 5 } });
    const newest = await t.pool.query<{ op_version: number }>("select op_version from room_ops where room_id = $1 and seq = 7", [roomId]);
    assert.equal(newest.rows[0]?.op_version, OP_VERSION);
    back.close();
    await back.waitClosed();
  });

  test("a version 5 size and place update on the acting creature replays as a move, and a new resize is stored at version 6 as no movement", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Op version 5");
    const s = await t.connect(roomId, owner);
    const sceneId = ((await s.snapshot("c1")).state as ProjectedState).meta.playerSceneId!;
    const [thorn, gob] = [uuidv7(), uuidv7()];
    await s.apply({ t: "token.create", token: { id: thorn, sceneId, kind: "npc", name: "Thorn", size: "medium", x: 1, y: 1, actor: { inline: actor } } });
    await s.apply({ t: "token.create", token: { id: gob, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 20, y: 1, actor: { inline: actor } } });
    await s.apply({ t: "encounter.start", entries: [{ id: uuidv7(), tokenId: thorn, value: 20 }, { id: uuidv7(), tokenId: gob, value: 10 }] });
    // Three ops: the snapshot schedule fires, so the ops below come after the snapshot, as a crash leaves them.
    await new Promise((r) => setTimeout(r, 300));
    await t.manager.unload(roomId, 1011, false);
    await s.waitClosed();
    const { rows } = await t.pool.query<{ seq: string; member: string }>(
      "select s.seq::text, (select actor_member_id from room_ops where room_id = $1 limit 1) as member from room_snapshots s where s.room_id = $1",
      [roomId],
    );
    assert.equal(rows[0]?.seq, "3");
    const stored = [
      { t: "encounter.next" },
      { t: "token.move", tokenId: thorn, x: 4, y: 1 },
      { t: "token.update", tokenId: thorn, patch: { size: "large", x: 3, y: 0 } },
    ];
    for (const [i, op] of stored.entries()) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         values ($1, $2, now(), $3, 'dm', $4::jsonb, 5)`,
        [roomId, 4 + i, rows[0]!.member, JSON.stringify(op)],
      );
    }

    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot("c1", 4);
    assert.equal(snap.seq, 6);
    const stops = (state: ProjectedState) => state.tokens[thorn]!.path!.stops.map((stop) => ({ x: stop.x, uncounted: stop.uncounted === true, footprint: stop.footprint }));
    assert.deepEqual(
      stops(snap.state as ProjectedState),
      [
        { x: 1, uncounted: false, footprint: undefined },
        { x: 4, uncounted: false, footprint: undefined },
        { x: 3, uncounted: false, footprint: undefined },
      ],
      "the growth with a place was a counted leg then",
    );

    back.n = 3;
    await back.apply({ t: "token.update", tokenId: thorn, patch: { size: "huge" } });
    const newest = await t.pool.query<{ op_version: number }>("select op_version from room_ops where room_id = $1 and seq = 7", [roomId]);
    assert.equal(newest.rows[0]?.op_version, 6);
    back.close();
    await back.waitClosed();
    const again = await t.connect(roomId, owner);
    const reloaded = await again.snapshot("c2");
    const large = { w: 2, h: 2 };
    assert.deepEqual(stops(reloaded.state as ProjectedState), [
      { x: 1, uncounted: false, footprint: large },
      { x: 4, uncounted: false, footprint: large },
      { x: 3, uncounted: false, footprint: large },
      { x: 3, uncounted: true, footprint: undefined },
    ]);
    again.close();
    await again.waitClosed();
  });

  test("a replay that fails serves the room read-only", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Broken");
    const s = await t.connect(roomId, owner);
    await s.snapshot("c1");
    await s.apply({ t: "log.chat", text: "fine" });
    await t.manager.unload(roomId, 1011, false);
    await s.waitClosed();
    await t.pool.query("update room_ops set op = '{\"t\":\"token.delete\",\"tokenId\":\"missing\"}'::jsonb where room_id = $1 and seq = 1", [roomId]);
    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot("c1", 2);
    assert.equal(snap.seq, 0);
    back.n = 1;
    const refused = await back.apply({ t: "log.chat", text: "nope" });
    assert.equal(refused.rejects?.[0]?.code, "quota");
    back.close();
  });

  test("names over HTTP follow the protocol's name rule, so a join still replays after a crash", async () => {
    const owner = t.client();
    for (const separator of ["\u2028", "\u2029"]) {
      const room = await owner.post("/api/rooms", { name: `Thursday${separator}Group`, playerPassword: "owlbear-druid-wand", dmName: "DM" });
      assert.equal(room.statusCode, 400, room.body);
      const dm = await owner.post("/api/rooms", { name: "Thursday", playerPassword: "owlbear-druid-wand", dmName: `D${separator}M` });
      assert.equal(dm.statusCode, 400, dm.body);
    }
    const { roomId } = await owner.createRoom("Separators");
    const s = await t.connect(roomId, owner);
    await s.snapshot("c1");
    const joiner = t.client();
    for (const separator of ["\u2028", "\u2029"]) {
      const step1 = await joiner.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
      const { ticket } = step1.json<{ ticket: string }>();
      const refused = await joiner.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: `Sa${separator}m`, color: "#336699" });
      assert.equal(refused.statusCode, 400, refused.body);
    }
    const samId = await joiner.join(roomId, "  Sam  ");
    // Crash before any snapshot: the join is only in the op log.
    await t.manager.unload(roomId, 1011, false);
    await s.waitClosed();
    const ops = await t.pool.query<{ op: { t: string } }>("select op from room_ops where room_id = $1 order by seq", [roomId]);
    assert.deepEqual(ops.rows.map((r) => r.op.t), ["sys.memberJoin"]);

    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot("c2");
    assert.equal(snap.seq, 1);
    assert.equal((snap.state as ProjectedState).members[samId]?.name, "Sam");
    const written = await back.apply({ t: "log.chat", text: "still writable" });
    assert.equal(written.rejects, undefined);
    back.close();
  });

  test("graceful restart: sockets get 1012, snapshots are written, and clients resume", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Restart");
    const s = await t.connect(roomId, owner);
    await s.snapshot("c1");
    const n = s.op({ t: "log.chat", text: "before restart" });
    await s.next("ev", (m) => m.acks?.includes(n) ?? false);
    await t.restart();
    assert.equal((await s.waitClosed()).code, 1012);
    const snap = await t.pool.query<{ seq: string }>("select seq::text from room_snapshots where room_id = $1", [roomId]);
    assert.equal(snap.rows[0]?.seq, "1");
    const back = await t.connect(roomId, owner);
    const resumed = await back.snapshot("c1", n + 1);
    assert.equal(resumed.watermark, n);
    assert.equal((resumed.state as ProjectedState).log.length, 1);
    back.n = n;
    await back.apply({ t: "log.chat", text: "after restart" });
    back.close();
  });
});

describe("grants and sockets", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { grantRecheckMs: 500 } } });
  });
  after(() => t.close());

  test("kicking a DM closes its sockets with 4001, demotes its label, and its invites die", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom("Kick");
    const coDm = t.client();
    const coMemberId = await coDm.claimDm(roomId, dmKey);
    const invite = (await coDm.post(`/api/rooms/${roomId}/dm/invite`)).json<{ token: string }>().token;
    const ownerSocket = await t.connect(roomId, owner);
    await ownerSocket.snapshot("o");
    const coSocket = await t.connect(roomId, coDm);
    await coSocket.snapshot("c");
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${coMemberId}/grants`)).statusCode, 204);
    assert.equal((await coSocket.waitClosed()).code, 4001);
    const ev = await ownerSocket.next("ev", (m) => m.changes.some((c) => c.key === `member:${coMemberId}`));
    const member = ev.changes.find((c) => c.key === `member:${coMemberId}`);
    assert.ok(member && "value" in member);
    assert.equal((member.value as { kind: string }).kind, "player");
    const device = t.client();
    assert.equal((await device.post(`/api/rooms/${roomId}/dm/redeem`, { token: invite, name: "Late" })).statusCode, 403);
    ownerSocket.close();
  });

  test("removing a member signs it out, takes it off the roster and lets go of what it owned", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Remove");
    const player = t.client();
    const pipId = await player.join(roomId, "Pip");
    const ownerSocket = await t.connect(roomId, owner);
    const sceneId = ((await ownerSocket.snapshot("o")).state as ProjectedState).meta.playerSceneId!;
    const pipSocket = await t.connect(roomId, player);
    await pipSocket.snapshot("p");
    const tokenId = uuidv7();
    await ownerSocket.apply({ t: "token.create", token: { id: tokenId, sceneId, kind: "pc", name: "Pip", size: "medium", x: 1, y: 1, ownerIds: [pipId], actor: { inline: actor } } });
    const drawingId = uuidv7();
    const drawn = await pipSocket.apply({ t: "drawing.create", drawing: { id: drawingId, sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: pipId, visibility: "all" } });
    assert.equal(drawn.rejects, undefined);

    assert.equal((await player.delete(`/api/rooms/${roomId}/members/${pipId}`)).statusCode, 403);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${(await owner.me(roomId)).memberId}`)).statusCode, 400);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/no-such-member`)).statusCode, 404);
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${pipId}`)).statusCode, 204);
    assert.equal((await pipSocket.waitClosed()).code, 4001);
    const ev = await ownerSocket.next("ev", (m) => m.changes.some((c) => c.key === `member:${pipId}`));
    assert.deepEqual(ev.changes.find((c) => c.key === `member:${pipId}`), { key: `member:${pipId}`, deleted: true });
    const state = t.manager.get(roomId)!.committed.state;
    assert.equal(state.members[pipId], undefined);
    assert.deepEqual(state.tokens[tokenId]?.ownerIds, []);
    assert.equal(state.drawings[drawingId], undefined);
    assert.equal((await player.me(roomId)).status, 403);
    // Nobody can continue as the removed member, and removing it again finds nothing.
    const phone = t.client();
    const step1 = await phone.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
    const { ticket, players } = step1.json<{ ticket: string; players: Array<{ id: string }> }>();
    assert.deepEqual(players, []);
    const continued = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: pipId });
    assert.equal(continued.statusCode, 409);
    assert.equal(continued.json<{ error: string }>().error, "member_removed");
    assert.equal((await owner.delete(`/api/rooms/${roomId}/members/${pipId}`)).statusCode, 404);
    ownerSocket.close();
  });

  test("a grant removed in the database alone is caught by the periodic recheck, which also fixes the label", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom("Recheck");
    const coDm = t.client();
    const coMemberId = await coDm.claimDm(roomId, dmKey);
    const coSocket = await t.connect(roomId, coDm);
    await coSocket.snapshot("c");
    const ownerSocket = await t.connect(roomId, owner);
    await ownerSocket.snapshot("o");
    // What the admin CLI does: rows only, no actor in the loop.
    await t.pool.query("delete from grants where room_id = $1 and member_id = $2", [roomId, coMemberId]);
    assert.equal((await coSocket.waitClosed(3_000)).code, 4001);
    const ev = await ownerSocket.next("ev", (m) => m.changes.some((c) => c.key === `member:${coMemberId}`), 3_000);
    const member = ev.changes.find((c) => c.key === `member:${coMemberId}`);
    assert.equal((member as { value: { kind: string } }).value.kind, "player");
    ownerSocket.close();
  });

  test("a player who becomes the DM on the same session is resynced with the new role", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom("Promote");
    const player = t.client();
    await player.join(roomId, "Pip");
    const s = await t.connect(roomId, player);
    assert.equal((await s.snapshot("p")).you.role, "player");
    await player.claimDm(roomId, dmKey);
    const resync = await s.next("resync", () => true, 3_000);
    assert.equal(resync.reason, "role");
    assert.equal((await s.snapshot("p")).you.role, "dm");
    s.close();
  });

  test("socket caps per session", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Caps");
    const sockets: Socket[] = [];
    for (let i = 0; i < 8; i++) sockets.push(await t.connect(roomId, owner));
    await assert.rejects(t.connect(roomId, owner), /429/);
    for (const s of sockets) s.close();
  });
});

describe("snapshot budget", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { snapshotBudget: { windowMs: 16_000, sessionCount: 1, ipCount: 3, abuseMs: 30_000 } } });
  });
  after(() => t.close());

  test("a delayed snapshot keeps the client waiting with wait messages for at least 15 s, then arrives", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Budget");
    const first = await t.connect(roomId, owner);
    await first.snapshot("c1");
    const started = Date.now();
    const second = await t.connect(roomId, owner);
    second.hello("c2");
    const waits: number[] = [];
    let snapshot = null;
    while (!snapshot) {
      const wait = await second.maybe("wait", () => true, 2_500);
      if (wait) waits.push(wait.ms);
      snapshot = await second.maybe("snapshot", () => true, 10);
      if (Date.now() - started > 25_000) break;
    }
    assert.ok(snapshot, "the snapshot arrived");
    assert.ok(Date.now() - started >= 15_000, `delayed ${Date.now() - started} ms`);
    assert.ok(waits.length >= 6, `wait messages: ${waits.length}`);
    assert.ok(waits[0]! > 10_000);
    assert.equal(second.closeCode, null);
    first.close();
    second.close();
  });

  test("a large scene switch for 12 sockets at one IP in a pinned room stays connected, and waits only when unpinned", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Table");
    const ip = owner.ip;
    const dm = await t.connect(roomId, owner);
    const sceneId = ((await dm.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    await fillScene(dm, sceneId, 120);
    const players = [];
    for (let i = 0; i < 16; i++) {
      const p = t.client(ip);
      await p.join(roomId, `P${i}`);
      players.push(p);
    }
    // Unpinned: the IP budget (3 a window here) delays most of the table.
    const first = [];
    for (const p of players.splice(0, 4)) first.push(await t.connect(roomId, p, { ip }));
    const results = await Promise.all(first.map(async (s, i) => {
      s.hello(`u${i}`);
      return (await s.maybe("wait", () => true, 1_500)) !== null;
    }));
    assert.ok(results.some(Boolean), "some sockets had to wait while unpinned");
    for (const s of first) s.terminate();

    await t.pool.query("update rooms set pinned = true where id = $1", [roomId]);
    await t.manager.unload(roomId);
    const sockets: Socket[] = [];
    for (const [i, p] of players.entries()) {
      const s = await t.connect(roomId, p, { ip });
      sockets.push(s);
      const snap = await s.snapshot(`p${i}`);
      assert.ok(Object.keys((snap.state as ProjectedState).tokens).length >= 120);
    }
    for (const s of sockets) assert.equal(s.closeCode, null);
    for (const s of sockets) s.close();
    dm.close();
  });
});

describe("rooms from one creator", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { maxLoaded: 10, maxPerCreatorIp: 1, minLoadedMs: 60_000, minIdleMs: 60_000, idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  test("at most so many loaded rooms created from one IP, others unaffected", async () => {
    const creator = t.client();
    const first = (await creator.createRoom("First")).roomId;
    const second = (await creator.createRoom("Second")).roomId;
    const a = await t.connect(first, creator);
    await a.snapshot("a");
    const b = await t.connect(second, creator);
    assert.equal((await b.waitClosed()).code, 4011);
    const other = t.client();
    const theirs = (await other.createRoom("Elsewhere")).roomId;
    const c = await t.connect(theirs, other);
    await c.snapshot("c");
    assert.equal(a.closeCode, null);
    a.close();
    c.close();
  });
});
