import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { BOOKKEEPING_RESERVE, FAR, farByteLine, KEPT_FOR_PLAYERS_FULL, keptForPlayers, ROOM_FULL, SCENE_FULL, SEAT, sizeRemedy } from "#shared/limits.ts";
import { toggleReads } from "#shared/farLine.ts";
import { GROUND, UPPER, thornToken, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { ROLL_ASKED_ALREADY } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { shownName } from "#shared/numbering.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { entry, env, scene, template, token } from "#shared/testutil.ts";
import type { RoomActor } from "./actor.ts";
import { farRoomBytes, farWidths, projectedSceneBytes } from "./sizeGuard.ts";
import { scopeActor, scopeFixture, until, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * How the room's ops meet the byte lines under player limits (actor.ts
 * #bytesMeet): past the far line, deletions and ops that add nothing are
 * taken and every growing op refused, a player's alike, while a move off
 * the turn adds nothing the far line counts, which holds a creature's place
 * at its widest (D-261119-011). Inside
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
  test("a deletion, a move and an edit that adds nothing are taken, and creates and growing edits refused, a player's and the DM's alike", async (t) => {
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
    const full = (role: "dm" | "player") => `quota: ${sizeRemedy(ROOM_FULL, role)}`;
    // Moves to two-digit cells store a byte more, which the far line already counts at every creature's widest place.
    assert.equal(answer(await player.send({ t: "token.move", tokenId: f.pc, x: 12, y: 3 })), "taken", "a player's move to a wider place");
    assert.equal(answer(await dm.send({ t: "token.move", tokenId: f.goblin, x: 11, y: 4 })), "taken", "the DM's move to a wider place");
    assert.equal(answer(await player.send({ t: "token.move", tokenId: f.pc, x: 7, y: 3 })), "taken", "a player's move that adds nothing");
    const line = (id: string, ownerId: string) => ({ t: "drawing.create", drawing: { id, sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId, visibility: "all" } });
    assert.equal(answer(await player.send(line(uuidv7(), f.player.id))), full("player"), "a player's create");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "n1", patch: { notes: "m".repeat(4_000) } })), "taken", "an edit that adds nothing");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: f.goblin, patch: { notes: "m".repeat(4_000) } })), full("dm"), "a growing edit");
    assert.equal(answer(await dm.send({ t: "token.delete", tokenId: "n2" })), "taken", "a deletion");
    // Removing the active row starts the next turn and writes its line: a deletion's bookkeeping, taken too.
    const active = h.actor.committed.state.encounter?.activeEntryId;
    assert.ok(active);
    const logged = h.actor.committed.state.log.length;
    assert.equal(answer(await dm.send({ t: "encounter.remove", entryIds: [active] })), "taken", "the active row's removal");
    assert.ok(h.actor.committed.state.log.length > logged, "it wrote a line");
  });
});

describe("a fight's start meets the line as any create does, setting nothing aside for its history or its walks (D-261121-066, 125)", () => {
  const start = (f: ReturnType<typeof scopeFixture>, tokens = [f.goblin, f.pc]) => ({ t: "encounter.start", entries: tokens.map((tokenId, i) => ({ id: uuidv7(), tokenId, value: 20 - (i % 20) })) });
  const dmLineOf = (state: RoomState) => farByteLine("meets", "room", { dmKept: keptForPlayers(state) })!;

  test("past the line it is refused in the room-full words, as a create is", async (t) => {
    const f = filled(FAR.roomBytes + MIB);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(start(f))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`);
    assert.equal(h.actor.committed.state.encounter, null, "no fight started");
    const line = { t: "drawing.create", drawing: { id: uuidv7(), sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: f.dm.id, visibility: "all" } };
    assert.equal(answer(await dm.send(line)), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "the DM's create");
  });

  test("with the DM's reading 0.9 MiB under the DM's line, it is taken", async (t) => {
    const dmLine = dmLineOf(scopeFixture().state);
    const f = filled(dmLine - 3 * MIB);
    for (let pad = 64 * 1024; farRoomBytes(f.state, true) <= dmLine - 1.15 * MIB; pad += 64 * 1024) f.state.tokens.n0 = { ...f.state.tokens.n0!, notes: "p".repeat(pad) };
    const reading = farRoomBytes(f.state, true);
    assert.ok(reading > dmLine - 1.15 * MIB && reading <= dmLine - 0.9 * MIB, `${dmLine - reading} short of the DM's line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(start(f))), "taken");
    assert.ok(h.actor.committed.state.encounter !== null, "the fight started");
  });

  test("48 players' full creature seats on one scene, with the room and the scene each 0.9 MiB under the DM's lines: the DM's start over 100 creatures there is taken", async (t) => {
    const f = scopeFixture();
    // The fixture's two players and 46 more, each with their creature seat full.
    const players = [f.player.id, f.unrelated.id, ...Array.from({ length: 46 }, (_, p) => `seat-${String(p).padStart(2, "0")}`)];
    for (const [p, id] of players.entries()) {
      f.state.members[id] ??= { ...f.state.members[f.player.id]!, id, name: `Player ${p}` };
      for (let i = 0; i < SEAT.tokens; i++) f.state.tokens[`${id}-t${i}`] = token(`${id}-t${i}`, { sceneId: f.sceneId, name: "Wolf", ownerIds: [id], x: i, y: p });
    }
    const dmLine = dmLineOf(f.state);
    const sceneLine = farByteLine("meets", "scene", { dmKept: keptForPlayers(f.state) })!;
    const sceneReading = () => projectedSceneBytes(f.state, f.sceneId) + farWidths(f.state, new Set([f.sceneId]));
    const theirs: string[] = [];
    for (let i = 0; sceneReading() <= sceneLine - 1.15 * MIB; i++) {
      theirs.push(`dm-${i}`);
      f.state.tokens[`dm-${i}`] = token(`dm-${i}`, { sceneId: f.sceneId, name: "Goblin", x: i % 50, y: 50 + Math.floor(i / 50), notes: "n".repeat(8_000) });
    }
    for (let i = 0; farRoomBytes(f.state, true) <= dmLine - 1.15 * MIB; i++) {
      f.state.scenes[`fill${Math.floor(i / 100)}`] ??= scene(`fill${Math.floor(i / 100)}`, { order: 10 + Math.floor(i / 100) });
      f.state.tokens[`n${i}`] = token(`n${i}`, { sceneId: `fill${Math.floor(i / 100)}`, notes: "n".repeat(16_000) });
    }
    assert.ok(sceneLine - sceneReading() >= 0.9 * MIB, `the scene ${sceneLine - sceneReading()} short of its line`);
    assert.ok(dmLine - farRoomBytes(f.state, true) >= 0.9 * MIB, `the room ${dmLine - farRoomBytes(f.state, true)} short of its line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(start(f, theirs.slice(0, 100)))), "taken");
    assert.equal(h.actor.committed.state.encounter?.entries.length, 100);
  });

  test("one a scene's line refuses keeps the scene's words, since a scene's reading holds no history", async (t) => {
    const f = scopeFixture();
    f.state.scenes.big = scene("big", { order: 10 });
    for (let i = 0; i * 4_000 < FAR.sceneBytes; i++) f.state.tokens[`n${i}`] = token(`n${i}`, { sceneId: "big", notes: "n".repeat(4_000) });
    // The room under the DM's line once the fight starts, its history at its bound included, so only the scene's line answers.
    const started = applyOp(f.state, start(f) as Op, { memberId: f.dm.id, role: "dm" }, env(9));
    assert.ok(started.ok && farRoomBytes(started.state, true) <= dmLineOf(started.state), `${started.ok ? farRoomBytes(started.state, true) : started.message} against the DM's line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(start(f))), `quota: ${sizeRemedy(SCENE_FULL, "dm")}`);
  });

  test("one the near line refuses keeps the room-full words", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 1_000, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.match(answer(await dm.send(start(f))), /^quota: the room is full\. /);
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

/*
 * FLR4-FABLE-5: a scene's measure counts a comma for each entry on a floor,
 * so a creature crossing floors moves it by nothing whatever else either
 * floor holds. Past the tower's line, Ana's fall, flight, fall undo and
 * climb answer alike whether a creature she cannot see stands on the floor
 * Thorn leaves or the one he reaches.
 */
describe("a creature crossing floors past a scene's line answers alike whatever hidden creatures the floors hold (FLR4-FABLE-5)", () => {
  /** The tower with Thorn, the DM's hidden notes filling `pad` past the scene's line, and a hidden goblin on `goblin` or none. */
  const world = (base: RoomState, goblin: string | null, pad: string): RoomState => {
    const out = { ...base, tokens: { ...base.tokens } };
    if (goblin !== null) out.tokens.gob = token("gob", { sceneId: goblin, name: "Goblin", x: 12, y: 12, visibility: "dm" });
    for (let i = 0; i * 4_000 < FAR.sceneBytes; i++) out.tokens[`n${i}`] = token(`n${i}`, { sceneId: pad, visibility: "dm", x: 15, y: 15, notes: "n".repeat(4_000) });
    return out;
  };
  const copyOf = (state: RoomState) => stableStringify(projectState(state, { memberId: "p1", role: "player" }, { sceneId: null }));
  const said = (event: { rejects?: { message: string }[] | undefined }) => event.rejects?.[0]?.message ?? "taken";

  /** Ana's answers to `steps` on each world, which must look alike to her. */
  async function answers(t: TestContext, worlds: RoomState[], steps: (ana: ScopeClient, actor: RoomActor) => Promise<string[]>): Promise<string[][]> {
    assert.ok(worlds.every((w) => copyOf(w) === copyOf(worlds[0]!)), "Ana's copies are alike");
    const out: string[][] = [];
    for (const state of worlds) {
      const h = await scopeActor(t, state, { idGate: false, sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
      out.push(await steps(await h.connect(state.members.p1!, "player"), h.actor));
    }
    return out;
  }

  test("Thorn alone on Upper floor walks onto the hole, or flies down through it", async (t) => {
    for (const [thorn, op] of [[{}, { t: "token.move", tokenId: "thorn", x: 6, y: 6 }], [{ x: 6, y: 6, elevation: 5 }, { t: "token.climb", tokenId: "thorn", linkId: "o1" }]] as const) {
      const base = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6, ...thorn }) } }));
      const got = await answers(t, [null, UPPER, "at"].map((goblin) => world(base, goblin, GROUND)), async (ana) => [said(await ana.send(op as never))]);
      assert.ok(got.every((g) => g[0] === got[0]![0]), `${op.t}: ${JSON.stringify(got)}`);
    }
  });

  test("the DM's hidden area riding Thorn goes with him as he falls, flies down or climbs, and each answer is taken, with the area or without", async (t) => {
    const ride = (state: RoomState, on: string): RoomState => ({ ...state, templates: { ...state.templates, ride: template("ride", { sceneId: on, attachedTo: "thorn", visibility: "dm", ownerId: "dm1", size: 5 }) } });
    const steps = [
      [{ sceneId: UPPER, x: 4, y: 6 }, { t: "token.move", tokenId: "thorn", x: 6, y: 6 }, withOpening, UPPER, GROUND],
      [{ sceneId: UPPER, x: 6, y: 6, elevation: 5 }, { t: "token.climb", tokenId: "thorn", linkId: "o1" }, withOpening, UPPER, GROUND],
      [{}, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, withStairs, GROUND, UPPER],
    ] as const;
    for (const [at, op, build, from, to] of steps) {
      const base = build(tower({ tokens: { thorn: thornToken(at) } }));
      const worlds = [world(base, null, GROUND), ride(world(base, null, GROUND), from), ride(world(base, from, GROUND), from)];
      const got = await answers(t, worlds, async (ana, actor) => [said(await ana.send(op as never)), actor.committed.state.templates.ride?.sceneId ?? "none"]);
      assert.deepEqual(got, [["taken", "none"], ["taken", to], ["taken", to]], `${op.t} ${JSON.stringify(op)}: ${JSON.stringify(got)}`);
    }
  });

  test("Ana's undo of Thorn's fall, with a hidden creature on Ground floor or none", async (t) => {
    const base = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }));
    const got = await answers(t, [null, GROUND, UPPER].map((goblin) => world(base, goblin, UPPER)), async (ana) => {
      const fall = said(await ana.send({ t: "token.move", tokenId: "thorn", x: 6, y: 6 } as never));
      const head = ana.history().play?.undo?.head;
      return [fall, head ? said(await ana.send({ t: "undo", scope: "play", head: head.id } as never)) : "no step"];
    });
    assert.ok(got.every((g) => JSON.stringify(g) === JSON.stringify(got[0])), JSON.stringify(got));
  });

  test("Thorn climbs the stairs up, with a hidden creature on either floor or none", async (t) => {
    const base = withStairs(tower({ tokens: { thorn: thornToken() } }));
    const got = await answers(t, [null, GROUND, UPPER].map((goblin) => world(base, goblin, UPPER)), async (ana) => [said(await ana.send({ t: "token.climb", tokenId: "thorn", linkId: "l1" } as never))]);
    assert.ok(got.every((g) => g[0] === got[0]![0]), JSON.stringify(got));
  });
});

describe("a walk a player's op takes off a creature outside the turn stays out of their Undo (D-261121-128)", () => {
  /** P1's Pip on the turn, riding a mastiff that rides a warhorse only the DM sees, which holds a walk of the turn where `walked`. */
  function riding(walked: boolean) {
    const f = scopeFixture();
    const state = f.state;
    state.tokens.pip = token("pip", { sceneId: f.sceneId, name: "Pip", kind: "pc", size: "small", ownerIds: [f.player.id], x: 4, y: 4, attached: { to: "dog", kind: "ride", steer: true } });
    state.tokens.dog = token("dog", { sceneId: f.sceneId, name: "Mastiff", kind: "npc", x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
    state.tokens.horse = token("horse", { sceneId: f.sceneId, name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, visibility: "dm", ...(walked ? { path: { turn: 7, stops: [{ x: 2, y: 4, elevation: 0 }, { x: 4, y: 4, elevation: 0 }] } } : {}) });
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "rpip",
      entries: [{ id: "rpip", tokenId: "pip", value: 20 }, { id: "rgob", tokenId: f.goblin, value: 5 }],
      turnStart: { entryId: "rpip", tokenId: "pip", sceneId: f.sceneId, x: 4, y: 4, elevation: 0, seen: true, seq: 7, mounts: ["dog", "horse"] },
    } as RoomState["encounter"];
    return { f, state };
  }

  test("Pip gets off, the DM edits the hidden warhorse, and P1's Undo answers alike whether the warhorse walked or not", async (t) => {
    const got: string[][] = [];
    for (const walked of [true, false]) {
      const { f, state } = riding(walked);
      const h = await scopeActor(t, state);
      const dm = await h.connect(f.dm);
      const p1 = await h.connect(f.player, "player");
      const off = answer(await p1.send({ t: "token.detach", tokenId: "pip", x: 5, y: 4 }));
      assert.equal(off, "taken");
      assert.equal(h.actor.committed.state.tokens.horse!.path, undefined, "the warhorse left the turn without a walk");
      const edit = answer(await dm.send({ t: "token.update", tokenId: "horse", patch: { notes: "Saddle sores." } }));
      const undo = answer(await p1.send({ t: "undo", scope: "play", head: p1.head().id }));
      got.push([off, edit, undo]);
    }
    assert.deepEqual(got[0], got[1]);
    assert.deepEqual(got[0], ["taken", "taken", "taken"]);
  });
});

describe("LP47A-SHOW-1: a hide or a show is bookkeeping, past the DM's lines and the players' (D-261122-041)", () => {
  const SETTINGS = [
    { moveAny: "none", damage: false },
    { moveAny: "all", damage: false },
    { moveAny: "chosen", damage: false },
    { moveAny: "nobody chosen", damage: false },
    { moveAny: "none", damage: true },
    { moveAny: "all", damage: true },
    { moveAny: "chosen", damage: true },
    { moveAny: "nobody chosen", damage: true },
  ] as const;
  type Setting = (typeof SETTINGS)[number];
  const dmLineOf = (state: RoomState) => farByteLine("meets", "room", { dmKept: keptForPlayers(state) })!;
  const createLine = FAR.roomBytes - BOOKKEEPING_RESERVE.room;

  /**
   * The fixture under `setting`, with the DM's hidden bandits and area, a
   * locked statue and a creature whose name is hidden, its reading at its
   * widest filled with the DM's notes to near `line` and then padded until
   * `past` holds of it.
   */
  function room(setting: Setting, line: (state: RoomState) => number, past: (state: RoomState) => boolean) {
    const f = filled(4 * MIB);
    const moveAny = setting.moveAny === "chosen" ? [f.player.id] : setting.moveAny === "nobody chosen" ? [] : setting.moveAny;
    f.state.meta = { ...f.state.meta, settings: { ...f.state.meta.settings, playersMoveAny: moveAny, playersApplyDamage: setting.damage } };
    for (const id of ["lurker", "flank1", "flank2"]) f.state.tokens[id] = token(id, { sceneId: f.sceneId, name: "Bandit", x: 2, y: 9, visibility: "dm" });
    f.state.templates.zone = template("zone", { sceneId: f.sceneId, ownerId: f.dm.id, visibility: "dm" });
    f.state.tokens.statue = token("statue", { sceneId: f.sceneId, name: "Statue", x: 6, y: 9, locked: true });
    f.state.tokens.masked = token("masked", { sceneId: f.sceneId, name: "Bandit chief of the Black Road", nameHidden: true, x: 7, y: 9 });
    const near = line(f.state) - farRoomBytes(f.state, true) - FAR.byteStep;
    assert.ok(near > 0, "filled short of the line");
    for (let pad = near; !past(f.state); pad += 16 * 1024) f.state.tokens.n0 = { ...f.state.tokens.n0!, notes: "p".repeat(pad) };
    return f;
  }

  const shows = (f: ReturnType<typeof filled>) =>
    [
      ["a creature's show", { t: "token.update", tokenId: "lurker", patch: { visibility: "all" } }],
      ["a group's show", { t: "token.updateMany", tokenIds: ["flank1", "flank2"], patch: { visibility: "all" } }],
      ["an area's show", { t: "template.update", templateId: "zone", patch: { visibility: "all" } }],
      // An unlock stores a byte more ("false"), as a show does.
      ["an unlock", { t: "token.update", tokenId: "statue", patch: { locked: false } }],
      // So does a name's reveal ("false"), whatever the name (D-261122-042).
      ["a name's reveal", { t: "token.update", tokenId: "masked", patch: { nameHidden: false } }],
    ] as const;

  const stroke = (f: ReturnType<typeof filled>, ownerId: string) => ({ t: "drawing.create", drawing: { id: uuidv7(), sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId, visibility: "all" } });

  for (const setting of SETTINGS) {
    const named = `Who can move any token ${setting.moveAny}, Players apply damage ${setting.damage ? "on" : "off"}`;

    test(`${named}: past the DM's line, where the DM's create is refused in the kept words, each is taken`, async (t) => {
      const f = room(setting, dmLineOf, (state) => farRoomBytes(state, true) > dmLineOf(state));
      assert.ok(farRoomBytes(f.state, true) < createLine - MIB, "well short of the players' line");
      const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
      const dm = await h.connect(f.dm);
      assert.equal(answer(await dm.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(KEPT_FOR_PLAYERS_FULL, "dm")}`, "the DM's create");
      for (const [what, op] of shows(f)) assert.equal(answer(await dm.send(op)), "taken", what);
      const state = h.actor.committed.state;
      assert.deepEqual([state.tokens.lurker!.visibility, state.tokens.flank2!.visibility, state.templates.zone!.visibility, state.tokens.statue!.locked, state.tokens.masked!.nameHidden], ["all", "all", "all", false, false]);
    });

    test(`${named}: past the players' line, inside the bookkeeping reserve, each is taken, and so are a hide's Undo and Redo`, async (t) => {
      const f = room(setting, () => createLine, (state) => farRoomBytes(state, false) > createLine);
      assert.ok(farRoomBytes(f.state, true) <= FAR.roomBytes - 64 * 1024, `${FAR.roomBytes - farRoomBytes(f.state, true)} short of the line`);
      const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
      const dm = await h.connect(f.dm);
      const player = await h.connect(f.player, "player");
      assert.equal(answer(await player.send(stroke(f, f.player.id))), `quota: ${sizeRemedy(ROOM_FULL, "player")}`, "a player's create");
      assert.equal(answer(await dm.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "the DM's create");
      for (const [what, op] of shows(f)) assert.equal(answer(await dm.send(op)), "taken", what);
      assert.equal(answer(await dm.send({ t: "token.update", tokenId: "lurker", patch: { visibility: "dm" } })), "taken", "a hide");
      assert.equal(answer(await dm.send({ t: "undo", scope: "play", head: dm.head().id })), "taken", "the hide's Undo, a show");
      assert.equal(h.actor.committed.state.tokens.lurker!.visibility, "all");
      assert.equal(answer(await dm.send({ t: "redo", scope: "play", head: dm.head("play", "redo").id })), "taken", "its Redo");
      assert.equal(h.actor.committed.state.tokens.lurker!.visibility, "dm");
    });
  }

  /**
   * Past the players' line, with a wolf the party met alone (so it has no
   * number) and a second wolf hidden: DM A toggles the first, DM B shows
   * the second, whose meeting numbers the first, and DM A's Undo puts back
   * a toggle on a creature numbered since (LP47FIXA-ASTRA-01).
   */
  async function numberedBetween(t: TestContext, toggle: Op, back: (state: RoomState) => unknown, before: unknown) {
    const f = room(SETTINGS[0], () => createLine, (state) => farRoomBytes(state, false) > createLine);
    f.state.tokens.wolf1 = token("wolf1", { sceneId: f.sceneId, name: "Wolf", x: 8, y: 9, met: 2 });
    f.state.tokens.wolf2 = token("wolf2", { sceneId: f.sceneId, name: "Wolf", x: 9, y: 9, visibility: "dm" });
    const scene = f.state.scenes[f.sceneId]!;
    f.state.scenes[f.sceneId] = { ...scene, numbers: { names: { ...scene.numbers?.names, Wolf: [2, 1] } } };
    f.state.numbering = { rev: 0, groups: 2 };
    assert.ok(farRoomBytes(f.state, true) <= FAR.roomBytes - 64 * 1024, `${FAR.roomBytes - farRoomBytes(f.state, true)} short of the line`);
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dmA = await h.connect(f.dm);
    const dmB = await h.connect(f.otherDm);
    assert.equal(answer(await dmA.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "past the players' line");
    assert.equal(answer(await dmA.send(toggle)), "taken", "DM A's toggle");
    assert.equal(answer(await dmB.send({ t: "token.update", tokenId: "wolf2", patch: { visibility: "all" } })), "taken", "DM B's show");
    const numbered = await until(() => (h.actor.committed.state.tokens.wolf1!.number === 1 ? true : undefined), "the first wolf numbered by the second's meeting");
    assert.ok(numbered);
    // A lock is a step of setup, a hide of play (shared/undoScope.ts).
    const scope = dmA.history().setup?.undo.head ? "setup" : "play";
    assert.equal(answer(await dmA.send({ t: "undo", scope, head: dmA.head(scope).id })), "taken", "DM A's Undo");
    const wolf = h.actor.committed.state.tokens.wolf1!;
    assert.deepEqual([back(h.actor.committed.state), wolf.number], [before, 1], "put back, keeping its number");
  }

  test("a hide's Undo past the players' line is taken after another creature's meeting numbered it since", async (t) => {
    await numberedBetween(t, { t: "token.update", tokenId: "wolf1", patch: { visibility: "dm" } }, (state) => state.tokens.wolf1!.visibility, "all");
  });

  test("a lock's Undo past the players' line is taken after another creature's meeting numbered it since", async (t) => {
    await numberedBetween(t, { t: "token.update", tokenId: "wolf1", patch: { locked: true } }, (state) => state.tokens.wolf1!.locked, false);
  });

  test("only a DM's Undo is read for toggles: a player's never reads the stored fields it would compare (LP47-OPUS-5)", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player, "player");
    const undo = async (who: ScopeClient) => {
      const scope = who.history().setup?.undo.head ? "setup" : "play";
      return answer(await who.send({ t: "undo", scope, head: who.head(scope).id }));
    };
    assert.equal(answer(await player.send(stroke(f, f.player.id))), "taken", "a player's stroke");
    const read = toggleReads.count;
    assert.equal(await undo(player), "taken", "its Undo");
    assert.equal(toggleReads.count, read, "a player's Undo reads nothing for toggles");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: f.goblin, patch: { visibility: "dm" } })), "taken", "the DM's hide");
    assert.equal(await undo(dm), "taken", "its Undo");
    assert.equal(toggleReads.count, read + 1, "a DM's Undo is read");
  });

  test("past the players' line, a show in a fight that shows the creature's row too, as the action bar sends it, is taken, and so are its Undo and Redo (D-261122-043)", async (t) => {
    const f = room(SETTINGS[0], () => createLine, (state) => farRoomBytes(state, false) > createLine);
    f.state.encounter = { rev: 0, round: 1, activeEntryId: "rgob", entries: [entry("rgob", { tokenId: f.goblin, value: 18 }), entry("rlurk", { tokenId: "lurker", value: 12, tieOrder: 1, hidden: true })] } as RoomState["encounter"];
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "past the players' line");
    const group = uuidv7();
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "lurker", patch: { visibility: "all" } }, group)), "taken", "the show");
    assert.equal(answer(await dm.send({ t: "encounter.update", entryId: "rlurk", patch: { hidden: false } }, group)), "taken", "its row's");
    const shown = (state: RoomState) => [state.tokens.lurker!.visibility, state.encounter!.entries.find((e) => e.id === "rlurk")!.hidden];
    assert.deepEqual(shown(h.actor.committed.state), ["all", false]);
    assert.equal(answer(await dm.send({ t: "undo", scope: "play", head: dm.head().id })), "taken", "its Undo, one step");
    assert.deepEqual(shown(h.actor.committed.state), ["dm", true]);
    assert.equal(answer(await dm.send({ t: "redo", scope: "play", head: dm.head("play", "redo").id })), "taken", "its Redo");
    assert.deepEqual(shown(h.actor.committed.state), ["all", false]);
  });

  test("past the players' line, a name's hide is taken and its Undo, which puts the earlier numbering back, is refused as an edit is (LP47FIXA-NAMEHIDE-UNDO)", async (t) => {
    const f = room(SETTINGS[0], () => createLine, (state) => farRoomBytes(state, false) > createLine);
    f.state.tokens.wolf1 = token("wolf1", { sceneId: f.sceneId, name: "Wolf", x: 8, y: 9, met: 2 });
    f.state.tokens.wolf2 = token("wolf2", { sceneId: f.sceneId, name: "Wolf", x: 9, y: 9, nameHidden: true, met: 3 });
    const scene = f.state.scenes[f.sceneId]!;
    f.state.scenes[f.sceneId] = { ...scene, numbers: { names: { ...scene.numbers?.names, Wolf: [2, 1], [shownName(f.state.tokens.wolf2)]: [3, 1] } } };
    f.state.numbering = { rev: 0, groups: 3 };
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    const wolf2 = () => h.actor.committed.state.tokens.wolf2!;
    assert.equal(answer(await dm.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "past the players' line");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "wolf2", patch: { nameHidden: false } })), "taken", "the reveal");
    assert.equal(wolf2().number, 2, "numbered under its name");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "wolf2", patch: { nameHidden: true } })), "taken", "the hide");
    assert.equal(wolf2().number, 3, "the hide numbers it again under the name players read");
    const scope = dm.history().setup?.undo.head ? "setup" : "play";
    const undo = answer(await dm.send({ t: "undo", scope, head: dm.head(scope).id }));
    assert.match(undo, /^quota: could not undo changing Wolf 2: the room is full\./, "its Undo puts the number back and is refused");
    assert.deepEqual([wolf2().nameHidden, wolf2().number], [true, 3], "and nothing changes");
  });

  test("past the players' line, a name's reveal that meets the creature under its name, numbering both wolves, and its Undo are taken, and its Redo is refused", async (t) => {
    const f = room(SETTINGS[0], () => createLine, (state) => farRoomBytes(state, false) > createLine);
    f.state.tokens.wolf1 = token("wolf1", { sceneId: f.sceneId, name: "Wolf", x: 8, y: 9, met: 2 });
    f.state.tokens.wolf2 = token("wolf2", { sceneId: f.sceneId, name: "Wolf", x: 9, y: 9, nameHidden: true, met: 3 });
    const scene = f.state.scenes[f.sceneId]!;
    f.state.scenes[f.sceneId] = { ...scene, numbers: { names: { ...scene.numbers?.names, Wolf: [2, 1], [shownName(f.state.tokens.wolf2)]: [3, 1] } } };
    f.state.numbering = { rev: 0, groups: 3 };
    const h = await scopeActor(t, f.state, { sizeLimits: { stateLimit: 64 * MIB, sceneLimit: 64 * MIB } });
    const dm = await h.connect(f.dm);
    assert.equal(answer(await dm.send(stroke(f, f.dm.id))), `quota: ${sizeRemedy(ROOM_FULL, "dm")}`, "past the players' line");
    assert.equal(answer(await dm.send({ t: "token.update", tokenId: "wolf2", patch: { nameHidden: false } })), "taken", "the reveal");
    await until(() => (h.actor.committed.state.tokens.wolf2!.number === 2 && h.actor.committed.state.tokens.wolf1!.number === 1 ? true : undefined), "both wolves numbered by the meeting");
    const scope = dm.history().setup?.undo.head ? "setup" : "play";
    assert.equal(answer(await dm.send({ t: "undo", scope, head: dm.head(scope).id })), "taken", "its Undo");
    assert.equal(h.actor.committed.state.tokens.wolf2!.nameHidden, true);
    // The Redo numbers the creature again, which meets the limit as an edit does (LP47FIXA-NAMEHIDE-UNDO).
    const redo = answer(await dm.send({ t: "redo", scope, head: dm.head(scope, "redo").id }));
    assert.match(redo, /^quota: could not redo changing Wolf: the room is full\./, "its Redo is refused");
    assert.equal(h.actor.committed.state.tokens.wolf2!.nameHidden, true, "and the name stays hidden");
  });
});
