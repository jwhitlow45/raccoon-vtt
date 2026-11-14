import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { BOOKKEEPING_RESERVE, FAR } from "#shared/limits.ts";
import { ROLL_ASKED_ALREADY } from "#shared/permissions.ts";
import { applyOp } from "#shared/reducer.ts";
import { scene, token } from "#shared/testutil.ts";
import { farRoomBytes } from "./sizeGuard.ts";
import { scopeActor, scopeFixture, until, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * How the room's ops meet the byte lines under player limits (actor.ts
 * #bytesMeet): past the far line, deletions and ops that add nothing are
 * taken and every growing op refused, a move too, a player's alike; inside
 * the bookkeeping reserve a growing move is taken where a create is
 * refused; at the near line, moving the players to a scene that reserves no
 * more is taken, and to one that reserves more is refused as before.
 */

const MIB = 1024 * 1024;

/** The fixture with the DM's notes on tokens across scenes of their own, `bytes` of them. */
function filled(bytes: number): ReturnType<typeof scopeFixture> {
  const f = scopeFixture();
  const per = 4_000;
  for (let i = 0; i * per < bytes; i++) {
    const sceneId = `fill${Math.floor(i / 100)}`;
    f.state.scenes[sceneId] ??= scene(sceneId, { order: 10 + Math.floor(i / 100) });
    f.state.tokens[`n${i}`] = token(`n${i}`, { sceneId, notes: "n".repeat(per) });
  }
  return f;
}

const answer = (event: { rejects?: { n: number; code: string; message: string }[] | undefined; acks?: number[] | undefined }) => {
  const reject = event.rejects?.[0];
  return reject ? `${reject.code}: ${reject.message}` : "taken";
};

describe("ops past the far line", () => {
  test("a deletion and a move or edit that adds nothing are taken, and creates, growing edits and growing moves refused, a player's and the DM's alike", async (t) => {
    const f = filled(FAR.roomBytes + MIB);
    // A fight already running, its first row's turn on.
    const rows = [uuidv7(), uuidv7()];
    const fight = applyOp(f.state, { t: "encounter.start", entries: [{ id: rows[0]!, tokenId: f.goblin, value: 20 }, { id: rows[1]!, tokenId: f.pc, value: 10 }] }, { memberId: f.dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
    assert.ok(fight.ok);
    const turn = applyOp(fight.state, { t: "encounter.next" } as never, { memberId: f.dm.id, role: "dm" }, { seq: 2, at: new Date().toISOString() });
    assert.ok(turn.ok, turn.ok ? "" : turn.message);
    f.state = turn.state;
    assert.ok(farRoomBytes(f.state, true) > FAR.roomBytes);
    // The near lines out of the way, so the far line alone answers.
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player, "player");
    const full = `quota: the room is full: it is at its ${Math.floor(FAR.roomBytes / MIB)} MiB size limit`;
    // Moves to two-digit cells grow the room by a byte, and past the line every growing op is refused, bookkeeping too.
    assert.equal(answer(await player.send({ t: "token.move", tokenId: f.pc, x: 12, y: 3 })), full, "a player's growing move");
    assert.equal(answer(await dm.send({ t: "token.move", tokenId: f.goblin, x: 11, y: 4 })), full, "the DM's growing move");
    assert.equal(answer(await player.send({ t: "token.move", tokenId: f.pc, x: 7, y: 3 })), "taken", "a player's move that adds nothing");
    const line = (id: string, ownerId: string) => ({ t: "drawing.create", drawing: { id, sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId, visibility: "all" } });
    assert.equal(answer(await player.send(line(uuidv7(), f.player.id))), full, "a player's create");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "n1", patch: { notes: "m".repeat(4_000) } })), "taken", "an edit that adds nothing");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: f.goblin, patch: { notes: "m".repeat(4_000) } })), full, "a growing edit");
    assert.equal(answer(await dm.send({ t: "token.delete", tokenId: "n2" })), "taken", "a deletion");
    // Removing the active row starts the next turn and writes its line: a deletion's bookkeeping, taken too.
    const active = h.actor.committed.state.encounter?.activeEntryId;
    assert.ok(active);
    const logged = h.actor.committed.state.log.length;
    assert.equal(answer(await dm.send({ t: "encounter.remove", entryIds: [active] })), "taken", "the active row's removal");
    assert.ok(h.actor.committed.state.log.length > logged, "it wrote a line");
  });
});

describe("ops inside the bookkeeping reserve", () => {
  test("a growing move is taken, a create refused, a player's and the DM's alike", async (t) => {
    // A room whose far reading sits inside the reserve, past the line less it and short of the line, at its widest and today's.
    const f = filled(FAR.roomBytes - BOOKKEEPING_RESERVE.room - 4 * MIB);
    assert.ok(farRoomBytes(f.state, false) <= FAR.roomBytes - BOOKKEEPING_RESERVE.room, "filled below the reserve");
    for (let pad = 64 * 1024; farRoomBytes(f.state, false) <= FAR.roomBytes - BOOKKEEPING_RESERVE.room; pad += 64 * 1024) f.state.tokens.n0 = { ...f.state.tokens.n0!, notes: "p".repeat(pad) };
    assert.ok(farRoomBytes(f.state, true) <= FAR.roomBytes, `${farRoomBytes(f.state, true)} short of the line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player, "player");
    const line = (id: string, ownerId: string) => ({ t: "drawing.create", drawing: { id, sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId, visibility: "all" } });
    assert.match(answer(await player.send(line(uuidv7(), f.player.id))), /^quota: the room is full/, "a player's create");
    assert.match(answer(await dm.send(line(uuidv7(), f.dm.id))), /^quota: the room is full/, "the DM's create");
    assert.equal(answer(await player.send({ t: "token.move", tokenId: f.pc, x: 12, y: 3 })), "taken", "a player's growing move");
    assert.equal(answer(await dm.send({ t: "token.move", tokenId: f.goblin, x: 11, y: 4 })), "taken", "the DM's growing move");
  });
});

describe("joins and the far line", () => {
  test("six joins on per-player scenes change no answer of a player's op inside the bookkeeping reserve", async (t) => {
    const f = scopeFixture();
    for (let i = 0; i < 9; i++) f.state.scenes[`pp${i}`] = scene(`pp${i}`, { order: 5 + i, bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    // The DM's notes until the reading at the widest sits inside the reserve.
    f.state.tokens.pad = token("pad", { sceneId: "pp0", notes: "" });
    for (let pad = 16 * 1024; farRoomBytes(f.state, true) <= FAR.roomBytes - BOOKKEEPING_RESERVE.room; pad += 16 * 1024) f.state.tokens.pad = { ...f.state.tokens.pad!, notes: "p".repeat(pad) };
    assert.ok(farRoomBytes(f.state, true) <= FAR.roomBytes, `${farRoomBytes(f.state, true)} short of the line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const player = await h.connect(f.player, "player");
    const line = () => ({ t: "drawing.create", drawing: { id: uuidv7(), sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: f.player.id, visibility: "all" } });
    const answers = async () => [answer(await player.send(line())), answer(await player.send({ t: "token.move", tokenId: f.pc, x: 12, y: 3 }))];
    const before = await answers();
    assert.match(before[0]!, /^quota: the room is full/);
    await player.send({ t: "token.move", tokenId: f.pc, x: 8, y: 3 });
    // Each join stores the joiner's per-player layers, which the widest reading held already.
    for (let i = 0; i < 6; i++) await h.actor.sys({ t: "sys.memberJoin", member: { id: uuidv7(), name: `Wren ${i}`, color: "#3366ff", kind: "player", createdAt: new Date(0).toISOString() } });
    assert.deepEqual(await answers(), before);
  });
});

describe("moving the players past the near line", () => {
  test("to a played scene that reserves no more is taken, and to a larger unplayed one is refused", async (t) => {
    const f = scopeFixture();
    const dark = (id: string, w: number, order: number) => scene(id, { order, bounds: { w, h: w }, fogEnabled: true, vision: { on: true, light: "dark" } });
    f.state.scenes[f.sceneId] = { ...f.state.scenes[f.sceneId]!, bounds: { w: 60, h: 60 }, fogEnabled: true, vision: { on: true, light: "dark" } };
    f.state.scenes.small = dark("small", 30, 2);
    f.state.scenes.large = dark("large", 200, 3);
    // Both played already, so a move between them adds no memory reserve: only a larger unplayed scene does.
    f.state.playedScenes = { [f.sceneId]: { sceneId: f.sceneId, rev: 0 }, small: { sceneId: "small", rev: 0 } };
    // A fight running, its first row's turn on.
    const started = applyOp(f.state, { t: "encounter.start", entries: [{ id: uuidv7(), tokenId: f.goblin, value: 20 }, { id: uuidv7(), tokenId: f.pc, value: 10 }] }, { memberId: f.dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
    assert.ok(started.ok);
    const turn = applyOp(started.state, { t: "encounter.next" } as never, { memberId: f.dm.id, role: "dm" }, { seq: 2, at: new Date().toISOString() });
    assert.ok(turn.ok);
    // A room already past its limits, as a room loaded under a lower one is: a move that reserves no more is cleanup.
    const h = await scopeActor(t, turn.state, { sizeLimits: { stateLimit: 1_000, sceneLimit: 1_000 } });
    const dm = await h.connect(f.dm);
    // A deletion meets no line, whatever its bookkeeping writes: the active row's removal starts the next turn.
    const active = h.actor.committed.state.encounter!.activeEntryId!;
    assert.equal(answer(await dm.send({ t: "encounter.remove", entryIds: [active] })), "taken");
    assert.equal(answer(await dm.send({ t: "room.setPlayerScene", sceneId: "small" })), "taken");
    assert.match(answer(await dm.send({ t: "room.setPlayerScene", sceneId: "large" })), /^quota: /);
    assert.equal(h.actor.committed.state.meta.playerSceneId, "small");
  });
});

describe("the op rates", () => {
  /** The answer to an op sent at the client's next number: "taken", "busy", or a refusal. */
  async function sent(client: ScopeClient, op: unknown): Promise<string> {
    const n = ++client.n;
    await client.actor.op(client.conn, n, op);
    return until(() => {
      if (client.sent.some((m) => m.t === "retry" && m.n === n && m.code === "busy")) {
        // Sent again at the same number, as a client does after `busy`.
        client.n--;
        return "busy";
      }
      const event = client.sent.find((m) => m.t === "ev" && (m.acks?.includes(n) || m.rejects?.some((r) => r.n === n)));
      return event ? answer(event as never) : undefined;
    }, `the answer to ${n}`);
  }

  test("a player's ops spend their member's bucket across their sockets, at one socket's numbers, and the room's bucket answers the DM alone", async (t) => {
    const f = scopeFixture();
    // Clocks that stand still, so no bucket refills. The room's burst is two.
    const still = () => 0;
    const h = await scopeActor(t, f.state, { roomOpsPerSec: 1, now: still });
    const dm = await h.connect(f.dm, "dm", still);
    const laptop = await h.connect(f.player, "player", still);
    const phone = await h.connect(f.player, "player", still);
    const chat = { t: "log.chat", text: "hi" };
    assert.deepEqual([await sent(dm, chat), await sent(dm, chat), await sent(dm, chat)], ["taken", "taken", "busy"], "the room's two, then busy");
    const answers: string[] = [];
    for (let i = 0; i < 40; i++) answers.push(await sent(laptop, { t: "token.move", tokenId: f.pc, x: 8 + (i % 2), y: 3 }));
    for (let i = 0; i < 20; i++) answers.push(await sent(phone, { t: "token.move", tokenId: f.pc, x: 8 + (i % 2), y: 4 }));
    assert.deepEqual(answers, Array(60).fill("taken"), "a player's sixty across two sockets, the room's bucket spent");
    assert.equal(await sent(phone, chat), "busy", "the phone's own socket has room, the member's bucket none");
    const other = await h.connect(f.unrelated, "player", still);
    assert.equal(await sent(other, chat), "taken", "another player's own bucket");
  });
});

describe("a damage roll's tag on an ask", () => {
  test("is taken with the sender's own roll and once, and refused without it or a second time", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const player = await h.connect(f.player);
    const other = await h.connect(f.unrelated, "player");
    const ask = (tag: string) => ({ t: "cast.ask", cast: { id: uuidv7(), caster: f.pc, sceneId: f.sceneId, spell: "Fireball", targets: [f.goblin], damage: { tag, parts: 1 } } });
    const roll = (tag: string) => ({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "8d6" }] });
    const used = `invalid: ${ROLL_ASKED_ALREADY}`;
    const tag = uuidv7();
    assert.equal(answer(await player.send(ask(tag))), used, "no roll under the tag");
    assert.equal(answer(await other.send(roll(tag))), "taken");
    assert.equal(answer(await player.send(ask(tag))), used, "another member's roll under the tag");
    const own = uuidv7();
    assert.equal(answer(await player.send(roll(own))), "taken");
    assert.equal(answer(await player.send(ask(own))), "taken", "their own roll");
    assert.equal(answer(await player.send(ask(own))), used, "the roll went with the first ask");
  });
});
