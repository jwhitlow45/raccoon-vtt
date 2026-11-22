import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, FAR, keptForPlayers, KEPT_FOR_PLAYERS_FULL, ROOM_FULL, roundUp, SCENE_FULL } from "#shared/limits.ts";
import type { Actor, LogEntry, Member, PcStats, RoomState, Viewer } from "#shared/model.ts";
import { MAX_NOTES, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { actor, castAsk, character, companionBlock, DM, drawing, effect, entry, env, member, randomDiceRoll, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { farAnswer, parked } from "./copyTwinsTesting.ts";
import { fullRoom } from "./limitsTesting.ts";
import { PLAYER_OPS, playerTable } from "./playerOpsTesting.ts";
import { exactCopies, farRoomBytes, farWidths, growthBound, heldBytes, measuredStateBytes, overFarLine, ownCopyBytes, ownHeldBytes, PER_PLAYER_FULL, playerBlockBytes, playerReadings, projectedSceneBytes, readingAt, roomLevelBytes, SizeGuard, widestPerPlayerReserve, type FarScope } from "./sizeGuard.ts";

/*
 * The byte lines under player limits: the near lines (the guard's state and
 * scene limits) answer the DM and the server alone, over the DM's part, and
 * only an op that grows the measure; a player's op meets the far line
 * alone, which reads the DM's part in steps of FAR.byteStep and what seats
 * hold exactly, with per-player vision's reserves at their widest.
 */

const P1: Viewer = { memberId: "p1", role: "player" };
const MIB = 1024 * 1024;

/** A drawing create as its sender sends it. */
function line(id: string, sceneId = "s1"): Op {
  return { t: "drawing.create", drawing: { id, sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op;
}

/** `bytes` of the DM's notes on tokens across scenes s2.., so no scene's own part nears its limit. */
function filled(state: RoomState, bytes: number, ownerIds: string[] = []): RoomState {
  const out = { ...state, scenes: { ...state.scenes }, tokens: { ...state.tokens } };
  const per = 4_000;
  for (let i = 0; i * per < bytes; i++) {
    const sceneId = `f${Math.floor(i / 100)}`;
    out.scenes[sceneId] ??= scene(sceneId, { order: 10 + Math.floor(i / 100) });
    out.tokens[`fill${i}`] = token(`fill${i}`, { sceneId, notes: "n".repeat(Math.min(per, bytes - i * per)), ownerIds });
  }
  return out;
}

function judged(state: RoomState, op: Op, viewer: Viewer, guard: SizeGuard, far: Parameters<SizeGuard["check"]>[5], exempt = false) {
  const r = applyOp(state, op, viewer, env(9));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return guard.check(r.state, ["s1"], growthBound(state, r.state, r.touched), state, viewer.role, far, exempt);
}

describe("the near lines answer the DM alone, over the DM's part", () => {
  test("a player's op is never refused by the near lines, however full the room", () => {
    const state = filled(room(), 64 * 1024);
    const guard = new SizeGuard({ stateLimit: 1_000, sceneLimit: 1_000 });
    guard.stateMeasured(measuredStateBytes(state), state);
    assert.deepEqual(judged(state, line("d1"), P1, guard, "none"), { ok: true });
  });

  test("the DM's growing op is refused past the line by what no seat holds, and taken while players' things fill it", () => {
    const base = room();
    const players = filled(base, 64 * 1024, []);
    // The same bytes as players' own areas: their seats hold them, so the DM's part leaves them out.
    const theirs: RoomState = { ...base, templates: { ...base.templates } };
    for (let i = 0; i < 16; i++) theirs.templates[`a${i}`] = { id: `a${i}`, rev: 0, sceneId: "s1", shape: "sphere", size: 5, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "p1", visibility: "all", label: "x".repeat(80) } as never;
    const limitOf = (s: RoomState) => measuredStateBytes(s) - heldBytes(s) + 400;
    const dmOp: Op = { t: "token.update", tokenId: "fill0", patch: { notes: "m".repeat(4_000) } };
    const tight = new SizeGuard({ stateLimit: limitOf(players) });
    tight.stateMeasured(measuredStateBytes(players), players);
    assert.equal(judged(players, dmOp, DM, tight, "none").ok, true, "a same-size edit adds nothing");
    const grow: Op = { t: "token.update", tokenId: "fill1", patch: { notes: "m".repeat(4_000) } };
    const more = filled(players, 0);
    more.tokens.fill1 = { ...more.tokens.fill1!, notes: "" };
    const small = new SizeGuard({ stateLimit: limitOf(more) });
    small.stateMeasured(measuredStateBytes(more), more);
    assert.equal(judged(more, grow, DM, small, "none").ok, false, "the DM's own notes past the line are refused");
    const seated = new SizeGuard({ stateLimit: measuredStateBytes(theirs) - heldBytes(theirs) + 200 });
    seated.stateMeasured(measuredStateBytes(theirs), theirs);
    assert.ok(heldBytes(theirs) > 16 * 80, "the players' areas are their seats'");
    assert.equal(judged(theirs, line("d1"), DM, seated, "none").ok, true, "a DM's small drawing fits beside the players' things");
  });

  test("players' companion blocks leave the DM's part of the room", () => {
    const state = room();
    state.characters.c1 = { id: "c1", rev: 0, ownerIds: ["p1"], name: "Ayla", size: "medium", actor: state.tokens.t1?.actor as never } as never;
    assert.equal(playerBlockBytes(state), 0);
  });
});

describe("an exempt kind", () => {
  test("meets no line, the DM's either, and its growth is counted, so the DM's next growing op past the line is refused", () => {
    const base = room();
    for (let i = 0; i < 10; i++) base.tokens[`g${i}`] = token(`g${i}`, { sceneId: "s1", x: i });
    const label = "Frightened of the dark, the deep water and the thing that waits below the ford";
    const conditions: Op = { t: "actor.effects", add: Object.keys(base.tokens).map((tokenId) => ({ target: { tokenId }, effect: { id: `e-${tokenId}`, key: "frightened", label } })) } as Op;
    const after = applyOp(base, conditions, DM, env(9));
    assert.ok(after.ok);
    // A line halfway up what the conditions add to the tokens: the scene with its room-level part after them and its own
    // part before them fits under it, and the scene after them does not.
    const own = projectedSceneBytes(after.state, "s1") - projectedSceneBytes(base, "s1") - (roomLevelBytes(after.state) - roomLevelBytes(base));
    assert.ok(own > 1_000, `the conditions add ${own} bytes to the tokens`);
    const near = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: projectedSceneBytes(after.state, "s1") - Math.floor(own / 2) });
    near.stateMeasured(measuredStateBytes(base), base);
    // An op before them, so the guard's scene measures are of the room they start from.
    assert.equal(judged(base, { t: "token.update", tokenId: "g9", patch: { name: "Wolf" } }, DM, near, "none").ok, true);
    assert.deepEqual(judged(base, conditions, DM, near, "today", true), { ok: true });
    const note: Op = { t: "token.update", tokenId: "g0", patch: { notes: "A short note" } };
    assert.equal(judged(after.state, note, DM, near, "none").ok, false);
  });
});

describe("the far line", () => {
  function nearFar(dmBytes: number): RoomState {
    return filled(room(), dmBytes);
  }

  test("a player's op is refused once the far reading passes the line, in the room-full words, and taken under it", () => {
    const over = nearFar(FAR.roomBytes + 64 * 1024);
    const guard = new SizeGuard();
    guard.stateMeasured(measuredStateBytes(over), over);
    assert.ok(farRoomBytes(over, true) > FAR.roomBytes);
    assert.deepEqual(judged(over, line("d1"), P1, guard, "widest"), { ok: false, code: "quota", message: ROOM_FULL });
    // Under by more than the far widths every creature counts at (farWidths).
    const under = nearFar(FAR.roomBytes - BOOKKEEPING_RESERVE.room - 3 * MIB);
    const free = new SizeGuard();
    free.stateMeasured(measuredStateBytes(under), under);
    assert.deepEqual(judged(under, line("d1"), P1, free, "widest"), { ok: true });
  });

  test("players' companion blocks count in the far reading: past the line by them a player's op is refused, and the DM's notice counts them", () => {
    const under = nearFar(FAR.roomBytes - BOOKKEEPING_RESERVE.room - 2 * MIB);
    const before = farRoomBytes(under, true);
    const state: RoomState = { ...under, characters: { ...under.characters, pc: character("pc", { ownerIds: ["p1"] }) }, companionBlocks: { ...under.companionBlocks } };
    const traits = [1, 2, 3].map((i) => ({ name: `Trait ${i}`, text: "w".repeat(4_000) }));
    for (let i = 0; playerBlockBytes(state) < 3 * MIB; i++) state.companionBlocks[`b${i}`] = companionBlock(`b${i}`, "pc", { traits });
    const blocks = playerBlockBytes(state);
    const reading = farRoomBytes(state, true);
    assert.ok(Math.abs(reading - before - blocks) <= FAR.byteStep, `${reading} against ${before} and ${blocks} of blocks`);
    const guard = new SizeGuard();
    guard.stateMeasured(measuredStateBytes(state), state);
    assert.equal(guard.over, overFarLine(state));
    assert.ok(guard.over > 0 && Math.abs(guard.over - (before + blocks - FAR.roomBytes)) <= FAR.byteStep, `over by ${guard.over}`);
    assert.deepEqual(judged(state, line("d1"), P1, guard, "widest"), { ok: false, code: "quota", message: ROOM_FULL });
  });

  test("an op that meets the line stops the bookkeeping reserve short of it, and an exempt kind goes on to the line itself", () => {
    // A room whose far reading with today's reserves sits inside the reserve: past the line less it, short of the line.
    const inside = nearFar(FAR.roomBytes - BOOKKEEPING_RESERVE.room - 2 * MIB);
    for (let pad = 64 * 1024; farRoomBytes(inside, false) <= FAR.roomBytes - BOOKKEEPING_RESERVE.room; pad += 64 * 1024) inside.tokens.fill0 = { ...inside.tokens.fill0!, notes: "p".repeat(pad) };
    const reading = farRoomBytes(inside, false);
    assert.ok(reading > FAR.roomBytes - BOOKKEEPING_RESERVE.room && reading <= FAR.roomBytes, `${reading} inside the reserve`);
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(inside), inside);
    assert.equal(judged(inside, line("d1"), P1, guard, "widest").ok, false, "a player's create");
    assert.equal(judged(inside, { t: "token.update", tokenId: "fill1", patch: { notes: "m".repeat(8_000) } }, DM, guard, "today").ok, false, "the DM's growing note");
    const prone: Op = { t: "actor.effect.add", target: { tokenId: "fill0" }, effect: { id: "e1", key: "prone" } } as Op;
    assert.deepEqual(judged(inside, prone, DM, guard, "today", true), { ok: true }, "a condition, an exempt kind");
  });

  test("an op that grows the room-level part meets every scene's far line, though it touches none", () => {
    const state = room();
    // s1 alone past its far line with the DM's notes, the room well under its own.
    for (let i = 0; i * 4_000 < FAR.sceneBytes + 256 * 1024; i++) state.tokens[`big${i}`] = token(`big${i}`, { sceneId: "s1", notes: "n".repeat(4_000) });
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    assert.ok(farRoomBytes(state, false) < FAR.roomBytes - BOOKKEEPING_RESERVE.room);
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(state), state);
    const notes = applyOp(state, { t: "character.update", characterId: "c1", patch: { actor: { notes: "A long note about the road" } } } as Op, DM, env(9));
    assert.ok(notes.ok, notes.ok ? "" : notes.message);
    assert.deepEqual(guard.check(notes.state, [], growthBound(state, notes.state, notes.touched), state, "dm", "today"), { ok: false, code: "quota", message: SCENE_FULL });
  });

  test("past the line an exempt kind that grows the room is refused, and one that adds nothing taken", () => {
    const over = nearFar(FAR.roomBytes + 64 * 1024);
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(over), over);
    const prone: Op = { t: "actor.effect.add", target: { tokenId: "fill0" }, effect: { id: "e1", key: "prone" } } as Op;
    assert.equal(judged(over, prone, DM, guard, "today", true).ok, false, "a condition");
    assert.deepEqual(judged(over, { t: "token.update", tokenId: "fill0", patch: { notes: "short" } }, DM, guard, "today", true), { ok: true }, "a shrink");
  });

  test("the reading holds the DM's part in steps: two rooms whose DM's parts differ inside one step read alike", () => {
    const a = nearFar(FAR.roomBytes - 3 * FAR.byteStep);
    const b = { ...a, tokens: { ...a.tokens, fill0: { ...a.tokens.fill0!, notes: "n".repeat(3_000) } } };
    const ra = farRoomBytes(a, true);
    const rb = farRoomBytes(b, true);
    assert.equal(ra % FAR.byteStep, 0);
    assert.equal(Math.floor((measuredStateBytes(a) - measuredStateBytes(b)) / FAR.byteStep) <= 1, true);
    assert.ok(ra === rb || Math.abs(ra - rb) === FAR.byteStep, "only the step the DM's part is in shows");
    assert.equal(roundUp(1, FAR.byteStep), FAR.byteStep);
  });

  test("a deletion or an op that adds nothing passes past the line", () => {
    const over = nearFar(FAR.roomBytes + 64 * 1024);
    const guard = new SizeGuard();
    guard.stateMeasured(measuredStateBytes(over), over);
    assert.deepEqual(judged(over, { t: "token.update", tokenId: "fill0", patch: { notes: "short" } }, DM, guard, "today"), { ok: true });
  });

  test("a player's far reading holds per-player vision at its widest, so a join moves nothing, and a DM's op that raises it is refused in PER_PLAYER_FULL's words", () => {
    const base = room();
    base.scenes.pp = scene("pp", { order: 2, bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    const joined = { ...base, members: { ...base.members, p3: member("p3") as Member } };
    assert.equal(widestPerPlayerReserve(joined), widestPerPlayerReserve(base), "a join does not widen it");
    assert.equal(farRoomBytes(joined, true), farRoomBytes(base, true));
    // A room whose far reading at the widest has room for less than one more per-player scene takes.
    const switchOn: Op = { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } } } as Op;
    const after = applyOp(base, switchOn, DM, env(9));
    assert.ok(after.ok);
    const rise = widestPerPlayerReserve(after.state) - widestPerPlayerReserve(base);
    assert.ok(rise > 2 * FAR.byteStep, `the switch widens the reserve by ${rise}`);
    // Filled toward a reading half the rise under the line, the fill's own overhead measured out once.
    const target = FAR.roomBytes - Math.floor(rise / 2);
    let fill = target - farRoomBytes(base, true);
    fill -= farRoomBytes(filled(base, fill), true) - target;
    const room0 = filled(base, fill);
    assert.ok(farRoomBytes(room0, true) <= FAR.roomBytes, `${farRoomBytes(room0, true)} within the line`);
    // The near lines at their test size would answer first: this reads the far line alone.
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(room0), room0);
    assert.deepEqual(judged(room0, switchOn, DM, guard, "widestDm"), { ok: false, code: "quota", message: PER_PLAYER_FULL });
  });

  test("a room past the far line at its widest is told by how many bytes", () => {
    const over = nearFar(FAR.roomBytes + MIB);
    const guard = new SizeGuard();
    guard.stateMeasured(measuredStateBytes(over), over);
    assert.ok(guard.over > MIB - FAR.byteStep && guard.over === overFarLine(over));
    const under = nearFar(MIB);
    const fine = new SizeGuard();
    fine.stateMeasured(measuredStateBytes(under), under);
    assert.equal(fine.over, 0);
  });
});

/** How many bytes of the DM's notes `filled` adds to `base` for its far reading at the widest to be about `target`, the fill's own overhead measured out. */
function fillFor(base: RoomState, target: number): number {
  let fill = target - farRoomBytes(base, true);
  for (let i = 0; i < 3; i++) fill -= farRoomBytes(filled(base, fill), true) - target;
  return fill;
}

/** A player's op as the actor judges it at the far line: at the widest, holding exactly only their own copy's own things. */
function playerJudged(state: RoomState, op: Op, memberId: string): ReturnType<SizeGuard["check"]> {
  const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
  guard.stateMeasured(measuredStateBytes(state), state);
  const r = applyOp(state, op, { memberId, role: "player" }, env(9));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return guard.check(r.state, ["s1"], growthBound(state, r.state, r.touched), state, "player", "widest", false, memberId);
}

describe("a scene whose id is \"room\" is read as a scene, and the room as the room", () => {
  /** P1's room on a scene with the id "room", and `fill` bytes of the DM's notes on it and on scenes of their own. */
  const roomScene = (onScene: number, elsewhere: number): RoomState => {
    const base = room();
    base.scenes = { ...base.scenes, room: scene("room", { order: 1 }) };
    base.meta = { ...base.meta, playerSceneId: "room" };
    const state = filled(base, elsewhere);
    for (let i = 0; i * 4_000 < onScene; i++) state.tokens[`here${i}`] = token(`here${i}`, { sceneId: "room", notes: "n".repeat(4_000) });
    return state;
  };
  const judgedOn = (state: RoomState) => {
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(state), state);
    const r = applyOp(state, line("d1", "room"), P1, env(9));
    assert.ok(r.ok, r.ok ? "" : r.message);
    return { answer: guard.check(r.state, ["room"], growthBound(state, r.state, r.touched), state, "player", "widest", false, "p1"), scene: guard.refusedScene };
  };

  test("P1's line on it is refused by the scene's line while that scene is past it, and by the room's while the room is", () => {
    const scenePast = roomScene(FAR.sceneBytes, 0);
    assert.ok(farRoomBytes(scenePast, true) < FAR.roomBytes - BOOKKEEPING_RESERVE.room - FAR.byteStep, "the room under its line");
    assert.deepEqual(judgedOn(scenePast), { answer: { ok: false, code: "quota", message: SCENE_FULL }, scene: "room" });
    const roomPast = roomScene(0, FAR.roomBytes);
    assert.deepEqual(judgedOn(roomPast), { answer: { ok: false, code: "quota", message: ROOM_FULL }, scene: null });
  });
});

/*
 * A player's exact part keeps each thing's place apart by kind, the room,
 * the companion blocks or a floor by its id, so a scene whose id is "room"
 * or "blocks" reads as any scene. Twins apart only in that scene's id, the
 * word or a plain id as long, P1's 399 kept rulers there each anchored on
 * their hero at all 50 stops, read alike in every scope and answer P1's
 * line there alike at every line around it.
 */
describe("scene ids \"room\" and \"blocks\" are read as scenes in a player's exact part", () => {
  /** P1's room on a scene with the id `sceneId`: their hero there and 399 rulers they kept on it, each anchored on the hero at all 50 stops. */
  const rulers = (sceneId: string): RoomState => {
    const state = room();
    state.scenes = { ...state.scenes, [sceneId]: scene(sceneId, { order: 2 }) };
    state.meta = { ...state.meta, playerSceneId: sceneId };
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "" }) });
    state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], sceneId, x: 2, y: 2 });
    const points = Array.from({ length: 100 }, (_, i) => 2 + (i % 2));
    for (let i = 0; i < 399; i++) state.drawings[`ruler${i}`] = drawing(`ruler${i}`, { sceneId, kind: "ruler", points, anchors: points.slice(50).map(() => "hero"), ownerId: "p1", visibility: "all" });
    return state;
  };
  /** `state` with its scene `from` given the id `to`, as long, so the twins store the same bytes. */
  const renamed = (state: RoomState, from: string, to: string): RoomState => {
    const on = <T extends { sceneId: string }>(things: Record<string, T>) => Object.fromEntries(Object.entries(things).map(([id, thing]) => [id, thing.sceneId === from ? { ...thing, sceneId: to } : thing]));
    const { [from]: moved, ...scenes } = state.scenes;
    return { ...state, meta: { ...state.meta, playerSceneId: to }, scenes: { ...scenes, [to]: { ...moved!, id: to } }, tokens: on(state.tokens), drawings: on(state.drawings) };
  };
  /** Each reading of P1's line on `sceneId`, that scene's scope named alike in both twins. */
  const readings = (state: RoomState, sceneId: string) => {
    const r = applyOp(state, line("d1", sceneId), P1, env(9));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const named = (scope: FarScope): FarScope => (scope.kind === "scene" && scope.main === sceneId ? { kind: "scene", main: "the rulers' scene" } : scope);
    return playerReadings(state, r.state, "p1").map((reading) => ({ ...reading, scope: named(reading.scope) }));
  };

  for (const [word, plain] of [["room", "roam"], ["blocks", "blokes"]] as const) {
    test(`P1's rulers on a scene named "${word}" read in every scope as on one named "${plain}", before P1's line there and after`, () => {
      const twin = rulers(plain);
      const plainReadings = readings(twin, plain);
      assert.ok(readingAt(plainReadings, { kind: "scene", main: "the rulers' scene" })!.after.exact > 2 * MIB, "P1's rulers count in their scene's exact part");
      assert.ok(readingAt(plainReadings, { kind: "scene", main: "s1" })!.after.exact < 4096, "and not in another scene's");
      assert.deepEqual(readings(renamed(twin, plain, word), word), plainReadings);
    });

    test(`P1's line on a scene named "${word}" is answered as on one named "${plain}", just past another scene's line and just under or past its own`, () => {
      // A create meets a scene's line short of its bookkeeping (shared/limits.ts farByteLine), so under it is under that.
      for (const [at, offset, said] of [["s1", 40_000, "taken"], [plain, -BOOKKEEPING_RESERVE.scene - 40_000, "taken"], [plain, 40_000, `quota: ${SCENE_FULL}`]] as const) {
        const twin = rulers(plain);
        parked([twin], "scene", at, offset);
        const [answer, named] = [farAnswer(twin, line("d1", plain), P1, 9), farAnswer(renamed(twin, plain, word), line("d1", word), P1, 9)];
        assert.equal(answer.said, said, `${at} ${offset}`);
        assert.equal(named.said, said, `${at} ${offset}`);
        if (answer.scope) assert.deepEqual(named.scope, { kind: "scene", main: word });
      }
    });
  }
});

describe("LP43-PRIV-1: a player's far reading never reads whose an unseen thing is", () => {
  test("twin rooms whose one difference is an upstairs area's owner, P2 or the DM, answer P1's line alike at every fill around the line", () => {
    const twin = (owner: string) => {
      const base = room();
      // A DM whose id is as long as P2's, as every member's minted id is, so the twins store the same bytes.
      base.members.d2 = member("d2", "dm");
      base.scenes = { ...base.scenes, s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground" } }), up: scene("up", { order: 1, floor: { of: "s1", level: 1, name: "Upper" } }) };
      base.characters.c1 = character("c1", { ownerIds: ["p1"] });
      base.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
      base.templates = { zup: template("zup", { sceneId: "up", ownerId: owner, label: "x".repeat(200) }) };
      return base;
    };
    // The same fill in both, read off the DM's twin.
    const fill = fillFor(twin("d2"), FAR.roomBytes - BOOKKEEPING_RESERVE.room - MIB);
    const rooms = [filled(twin("p2"), fill), filled(twin("d2"), fill)];
    const area = measuredStateBytes(rooms[0]!) - measuredStateBytes({ ...rooms[0]!, templates: {} });
    const padded = (state: RoomState, n: number): RoomState => ({ ...state, tokens: { ...state.tokens, pad: token("pad", { sceneId: "f0", notes: "p".repeat(n) }) } });
    const takes = (state: RoomState, n: number) => playerJudged(padded(state, n), line(`d${n}`), "p1").ok;
    // Where P1's line stops being taken in the DM's twin, then every 32 bytes across twice the area's bytes each side of it.
    let [lo, hi] = [0, 2 * MIB];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (takes(rooms[1]!, mid)) lo = mid;
      else hi = mid;
    }
    const apart: number[] = [];
    for (let n = hi - 2 * area; n <= hi + 2 * area; n += 32) if (takes(rooms[0]!, n) !== takes(rooms[1]!, n)) apart.push(n);
    assert.deepEqual(apart, [], `the twins answer apart at pads ${apart.slice(0, 5).join(", ")} (the area is ${area} bytes)`);
    assert.ok(takes(rooms[0]!, hi - 2 * area) && !takes(rooms[0]!, hi + 2 * area), "the window holds the line");
  });

  test("LIMITS-2: a player's add reads the players' line, never the DM's sooner one", () => {
    // P1's reading between the DM's line and the players': P1's line taken, the DM's growing note refused in the kept words.
    const reserve = keptForPlayers(room());
    const state = filled(room(), fillFor(room(), FAR.roomBytes - BOOKKEEPING_RESERVE.room - reserve / 2));
    const reading = farRoomBytes(state, true);
    assert.ok(reading > FAR.roomBytes - BOOKKEEPING_RESERVE.room - reserve && reading < FAR.roomBytes - BOOKKEEPING_RESERVE.room - FAR.byteStep, `${reading} inside the kept room`);
    assert.deepEqual(playerJudged(state, line("d1"), "p1"), { ok: true }, "P1's line");
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(state), state);
    assert.deepEqual(judged(state, { t: "token.update", tokenId: "fill1", patch: { notes: "m".repeat(8_000) } }, DM, guard, "dmAdd"), { ok: false, code: "quota", message: KEPT_FOR_PLAYERS_FULL }, "the DM's growing note");
  });
});

/**
 * P1's own things of every class on s1, two DM creatures P1 cannot see, so
 * a twin may name them where P1's copy leaves them out, and the DM's pad on
 * s2, a scene P1 never holds.
 */
function ownTable(pad: number): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"] });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.pet = token("pet", { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 4, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
  for (const id of ["hidden-dm-creature-one", "hidden-dm-creature-two"]) state.tokens[id] = token(id, { visibility: "dm", x: 20, y: 20 });
  state.templates.a1 = template("a1", { label: "Fireball" });
  state.drawings.d1 = drawing("d1", { anchors: ["hero", null], points: [2.5, 2.5, 9, 9] });
  state.casts.k1 = castAsk("k1", { caster: "hero", area: "a1", targets: ["hero"] });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("r1", { tokenId: "hero" })] };
  state.tokens.pad = token("pad", { sceneId: "s2", notes: "p".repeat(pad) });
  return state;
}

/** P1's companion's actor with `patch`. */
function petActor(state: RoomState, patch: Partial<Actor>): void {
  const pet = state.tokens.pet!;
  if (!("inline" in pet.actor)) throw new Error("the companion keeps its own actor");
  state.tokens.pet = { ...pet, actor: { inline: { ...pet.actor.inline, ...patch } } };
}

/** Changes to P1's own things that P1's copy never shows (shared/project.ts), each only adding stored bytes. */
const UNSHOWN: Record<string, (state: RoomState) => void> = {
  "a DM's note on P1's companion": (s) => petActor(s, { dmNotes: "d".repeat(400) }),
  "a condition the DM hid on it": (s) => petActor(s, { effects: [effect("e1", { key: "custom", label: "h".repeat(400), hiddenFromPlayers: true })] }),
  "the room monster it was placed from, and its lair": (s) => petActor(s, { monsterId: "m".repeat(300), inLair: true }),
  "the targets of P1's ask that P1 cannot see": (s) => (s.casts.k1 = { ...s.casts.k1!, targets: ["hero", "hidden-dm-creature-one", "hidden-dm-creature-two"] }),
  "the caster of P1's area that P1 cannot see": (s) => (s.templates.a1 = { ...s.templates.a1!, casterId: "hidden-dm-creature-one" }),
  "the DM's label and marks on P1's row": (s) => (s.encounter = { ...s.encounter!, entries: [entry("r1", { tokenId: "hero", label: "l".repeat(300), groupKey: "g".repeat(100), hadTurn: true })] }),
  "where the anchored stop of P1's ruler was kept": (s) => (s.drawings.d1 = { ...s.drawings.d1!, points: [123.456789012345, 987.654321098765, 9, 9] }),
  "how often the DM wrote to P1's creature": (s) => (s.tokens.hero = { ...s.tokens.hero!, rev: 123_456_789 }),
  "how often the DM wrote to P1's area": (s) => (s.templates.a1 = { ...s.templates.a1!, rev: 123_456_789 }),
};

/** P1's stepped part before its rounding and reserves: the measure less what P1's exact part takes out of it. */
function steppedOf(state: RoomState, sceneIds?: readonly string[]): number {
  const widths = farWidths(state, sceneIds ? new Set(floorsOf(state, sceneIds[0]!).map((floor) => floor.id)) : undefined);
  return (sceneIds ? projectedSceneBytes(state, sceneIds[0]!) : measuredStateBytes(state)) + widths - ownHeldBytes(state, "p1", sceneIds).sub;
}

/**
 * A twin of `shown` with `unshown` applied and the DM's pad trimmed by what it adds to P1's stepped part, so both read
 * the same. A change to a field P1's own ops write too (OWN_WRITTEN), such as a rev, adds nothing there to trim.
 */
function unshownTwin(shown: RoomState, unshown: (state: RoomState) => void): { twin: RoomState; bytes: number } {
  const twin = structuredClone(shown);
  unshown(twin);
  const bytes = steppedOf(twin) - steppedOf(shown);
  const pad = shown.tokens.pad!.notes!.length;
  assert.ok(bytes >= 0 && bytes <= pad, `the change adds ${bytes} stepped bytes the pad gives back`);
  twin.tokens.pad = { ...twin.tokens.pad!, notes: "p".repeat(pad - bytes) };
  return { twin, bytes };
}

function copyOf(state: RoomState): string {
  return stableStringify(projectState(state, P1, { sceneId: null }));
}

describe("LP43-PRIV-2: a player's exact part holds their own things only as their copy shows them", () => {
  for (const [what, unshown] of Object.entries(UNSHOWN)) {
    test(`${what}: the twins' copies, P1's exact parts and stepped parts are equal`, () => {
      const shown = ownTable(4_000);
      const { twin } = unshownTwin(shown, unshown);
      assert.equal(copyOf(twin), copyOf(shown), "P1's copies are equal");
      assert.ok(ownHeldBytes(shown, "p1").shown > 0, "P1 holds their own things exactly");
      assert.equal(ownHeldBytes(twin, "p1").shown, ownHeldBytes(shown, "p1").shown, "the room's exact part");
      assert.equal(ownHeldBytes(twin, "p1", ["s1"]).shown, ownHeldBytes(shown, "p1", ["s1"]).shown, "the scene's exact part");
      assert.equal(steppedOf(twin), steppedOf(shown), "the room's stepped part");
    });
  }

  test("twin rooms with every unshown change or none answer P1's line alike at every fill around the line", () => {
    const shown = ownTable(20_000);
    let hidden = shown;
    let unshownBytes = 0;
    for (const unshown of Object.values(UNSHOWN)) {
      const { twin, bytes } = unshownTwin(hidden, unshown);
      hidden = twin;
      unshownBytes += bytes;
    }
    assert.equal(copyOf(hidden), copyOf(shown), "P1's copies are equal");
    const fill = fillFor(shown, FAR.roomBytes - BOOKKEEPING_RESERVE.room - MIB);
    const rooms = [filled(shown, fill), filled(hidden, fill)];
    const padded = (state: RoomState, n: number): RoomState => ({ ...state, tokens: { ...state.tokens, more: token("more", { sceneId: "f0", notes: "q".repeat(n) }) } });
    const takes = (state: RoomState, n: number) => playerJudged(padded(state, n), line(`d${n}`), "p1").ok;
    let [lo, hi] = [0, 2 * MIB];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (takes(rooms[0]!, mid)) lo = mid;
      else hi = mid;
    }
    // Held exactly, the unshown bytes would part the twins just above the line or up to a step below it.
    const apart: number[] = [];
    for (let n = hi - 512; n <= hi + 512; n += 32) if (takes(rooms[0]!, n) !== takes(rooms[1]!, n)) apart.push(n);
    assert.deepEqual(apart, [], `the twins answer apart at pads ${apart.slice(0, 5).join(", ")} (the unshown changes store ${unshownBytes} bytes)`);
    assert.ok(unshownBytes > 512 && takes(rooms[0]!, hi - 512) && !takes(rooms[0]!, hi + 512), "the window holds the line");
  });
});

describe("LP43-PRIV-3: behind a blackout a player's exact part holds nothing", () => {
  test("P1's own ask or a DM's of the same bytes: P1's copy holds neither, so the exact parts are equal and hold no ask", () => {
    const twin = (by: string) => {
      const state = ownTable(0);
      // A DM whose id is as long as P1's.
      state.members.d1 = member("d1", "dm");
      state.casts = { k1: castAsk("k1", { by, caster: "hero", area: undefined, targets: ["hero"] }) };
      state.meta = { ...state.meta, view: { follow: false, blackout: true } };
      return state;
    };
    const [own, dms] = [twin("p1"), twin("d1")];
    assert.equal(copyOf(own), copyOf(dms), "P1's copies are equal");
    assert.equal(measuredStateBytes(own), measuredStateBytes(dms), "the rooms store the same bytes");
    assert.deepEqual(ownHeldBytes(own, "p1"), ownHeldBytes(dms, "p1"), "P1's own ask behind a blackout, or the DM's");
    // A blackout keeps their member and characters, which are not scene data, and drops every ask.
    assert.equal(ownHeldBytes(own, "p1").shown, ownHeldBytes({ ...own, casts: {} }, "p1").shown, "as no ask at all");
  });
});

describe("LP43R2-1: the room the DM's adds leave the players", () => {
  test("at the DM's last add a player keeps more than the kept bytes less one step, a join's bytes aside, and the worst case comes within a few KiB of it", () => {
    const players = FAR.roomBytes - BOOKKEEPING_RESERVE.room;
    const reserve = keptForPlayers(room());
    const dmLine = players - reserve;
    const base = room();
    base.characters.c1 = character("c1", { ownerIds: ["p1"] });
    base.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    // P2's one area, exact in the DM's reading and stepped in P1's, sized so it is 150 bytes more than what P1's reading
    // alone holds exactly, their member and character, which the DM's reading steps.
    base.templates.a2 = template("a2", { ownerId: "p2", label: "" });
    base.templates.a2 = template("a2", { ownerId: "p2", label: "y".repeat(150 - (heldBytes(base) - ownHeldBytes(base, "p1").sub)) });
    assert.equal(heldBytes(base) - ownHeldBytes(base, "p1").sub, 150);
    // P1's own area sized so what seats hold sits 100 bytes under a whole step. The DM's last add then leaves 100 bytes
    // of the DM's room, and P1's reading rounds P2's area up to a whole step, the most a reading rounds.
    base.templates.a1 = template("a1", { label: "" });
    base.templates.a1 = template("a1", { label: "x".repeat(FAR.byteStep - 100 - heldBytes(base)) });
    assert.equal(heldBytes(base) % FAR.byteStep, FAR.byteStep - 100);
    // The DM's notes to two steps under the DM's line, then the largest pad the DM's line takes: its part ends on a step's edge.
    const below = filled(base, fillFor(base, dmLine) - 2 * FAR.byteStep);
    const at = (n: number): RoomState => ({ ...below, tokens: { ...below.tokens, pad: token("pad", { sceneId: "s2", notes: "n".repeat(n) }) } });
    const dmTakes = (state: RoomState) => farRoomBytes(state, true) <= dmLine;
    let [lo, hi] = [0, 4 * FAR.byteStep];
    assert.ok(dmTakes(at(lo)) && !dmTakes(at(hi)));
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (dmTakes(at(mid))) lo = mid;
      else hi = mid;
    }
    const last = at(lo);
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(last), last);
    const goblin = { t: "token.create", token: { id: "dmnew", sceneId: "s2", kind: "monster", name: "Goblin", size: "medium", x: 3, y: 3, actor: { inline: actor() } } } as Op;
    assert.deepEqual(judged(last, goblin, DM, guard, "dmAdd"), { ok: false, code: "quota", message: KEPT_FOR_PLAYERS_FULL }, "the DM's next add");
    const keeps = (state: RoomState) => players - farRoomBytes(state, true, measuredStateBytes(state), ownHeldBytes(state, "p1"));
    // What P1's exact part counts past what it takes out of the stepped part: their own fields at their widths.
    const widths = (state: RoomState) => ownHeldBytes(state, "p1").shown - ownHeldBytes(state, "p1").sub;
    const kept = keeps(last);
    const least = reserve - FAR.byteStep - widths(last);
    assert.ok(kept > least && kept < least + 4 * 1024, `the worst case: P1 keeps ${kept} bytes, their widths ${widths(last)}`);
    // A player joins: their bytes come out of what P1 keeps, and the rounding P1 reads never takes more than its step.
    const joined: RoomState = { ...last, members: { ...last.members, p3: member("p3") } };
    const join = measuredStateBytes(joined) - measuredStateBytes(last);
    const left = keeps(joined);
    assert.ok(left > reserve - FAR.byteStep - widths(joined) - join, `after a join of ${join} bytes P1 keeps ${left} bytes`);
    // The guard reads the same: P1's own area of 1 KiB under what P1 keeps is taken, and of 1 KiB over it refused.
    const withArea = (label: string): RoomState => ({ ...joined, templates: { ...joined.templates, a3: template("a3", { label }) } });
    const overhead = measuredStateBytes(withArea("")) - measuredStateBytes(joined);
    const takesArea = (bytes: number) => {
      const next = withArea("y".repeat(bytes - overhead));
      const judge = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
      judge.stateMeasured(measuredStateBytes(joined), joined);
      return judge.check(next, ["s1"], measuredStateBytes(next) - measuredStateBytes(joined), joined, "player", "widest", false, "p1").ok;
    };
    assert.ok(takesArea(left - 1024), "P1's area 1 KiB under what P1 keeps");
    assert.ok(!takesArea(left + 1024), "P1's area 1 KiB over it");
  });
});

/** P1's character's stat block with `chars` characters of roll names, 60 to a roll. */
function statsWith(chars: number): PcStats {
  const rolls: PcStats["rolls"] = [];
  for (let i = 0; i * 60 < chars; i++) rolls.push({ id: `roll${i}`, name: "r".repeat(Math.min(60, chars - i * 60)), kind: "other" } as PcStats["rolls"][number]);
  const abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  return { abilities, saves: [], skills: {}, adjust: {}, defenses: {}, rolls } as PcStats;
}

describe("LP44-PRIV-1: a player's own adds off the floors never move their stepped part", () => {
  /** What P1's own ops grow off the floors, each a sweep of `most` characters, and the length the line sits at. */
  const SWEEPS: Record<string, { most: number; grow: (state: RoomState, chars: number) => RoomState }> = {
    "their character's notes": { most: 4_000, grow: (s, chars) => ({ ...s, characters: { ...s.characters, c1: { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, notes: "n".repeat(chars) } } } }) },
    "their character's sheet": { most: 490, grow: (s, chars) => ({ ...s, characters: { ...s.characters, c1: { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, sheetUrl: `https://${"s".repeat(chars)}` } } } }) },
    "their character's stat block": { most: 2_400, grow: (s, chars) => ({ ...s, characters: { ...s.characters, c1: { ...s.characters.c1!, stats: statsWith(chars) } } }) },
    "their character's companion block": { most: 4_000, grow: (s, chars) => ({ ...s, companionBlocks: { ...s.companionBlocks, b1: { ...s.companionBlocks.b1!, traits: [{ name: "Notes", text: "t".repeat(chars) }] } } }) },
  };
  /** Changes outside P1's copy, each about 100 bytes. */
  const HIDDEN: Record<string, (state: RoomState) => RoomState> = {
    "100 bytes of the DM's notes on a creature": (s) => ({ ...s, tokens: { ...s.tokens, g1: { ...s.tokens.g1!, actor: { inline: actor({ dmNotes: "d".repeat(100) }) } } } }),
    "a condition the DM hid": (s) => ({ ...s, tokens: { ...s.tokens, g1: { ...s.tokens.g1!, actor: { inline: actor({ dmNotes: "", effects: [effect("e1", { key: "custom", label: "h".repeat(50), hiddenFromPlayers: true })] }) } } } }),
    "100 bytes of P2's character notes": (s) => ({ ...s, characters: { ...s.characters, c2: { ...s.characters.c2!, actor: { ...s.characters.c2!.actor, notes: "q".repeat(100) } } } }),
  };

  /** P1 plays Hero (c1) with an area and a companion block, P2 plays Bree (c2), and the DM's goblin stands on s1. */
  function table(): RoomState {
    const base = room();
    base.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "" }) });
    base.characters.c2 = character("c2", { name: "Bree", ownerIds: ["p2"], actor: actor({ notes: "", dmNotes: "" }) });
    base.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    base.tokens.g1 = token("g1", { x: 6, y: 6, actor: { inline: actor({ dmNotes: "" }) } });
    base.templates.a1 = template("a1", { label: "" });
    base.companionBlocks = { b1: { ...companionBlock("b1", "c1"), traits: [] } };
    return base;
  }

  /** The first length of a sweep P1's far reading refuses: P1's answers are monotone in the length, so it says every answer. */
  function firstRefused(what: string, sweep: (typeof SWEEPS)[string], state: RoomState): number {
    const takes = (chars: number) => {
      const next = sweep.grow(state, chars);
      const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
      guard.stateMeasured(measuredStateBytes(state), state);
      return guard.check(next, ["s1"], Math.max(0, measuredStateBytes(next) - measuredStateBytes(state)), state, "player", "widest", false, "p1").ok;
    };
    let [taken, refused] = [0, sweep.most];
    assert.ok(takes(taken) && !takes(refused), `${what}: the sweep holds the line`);
    while (refused - taken > 1) {
      const mid = Math.floor((taken + refused) / 2);
      if (takes(mid)) taken = mid;
      else refused = mid;
    }
    return refused;
  }

  /** The twins of `shown`, P1's own area sized so the line sits halfway through each sweep, answer P1's every length alike. */
  function assertSweepsAlike(shown: RoomState, sweeps: ReadonlyArray<string>, exactOf: (state: RoomState) => number): void {
    for (const what of sweeps) {
      const sweep = SWEEPS[what]!;
      const sized = (state: RoomState): RoomState => {
        const exact = exactOf(sweep.grow(state, 0));
        return { ...state, templates: { ...state.templates, a1: template("a1", { label: "x".repeat(FAR.byteStep - Math.floor(sweep.most / 2) - exact) }) } };
      };
      const rooms: Array<[string, RoomState]> = [["shown", sized(shown)], ...Object.entries(HIDDEN).map(([name, hide]) => [name, sized(hide(shown))] as [string, RoomState])];
      const [base0, ...apart] = rooms.map(([name, state]) => [name, firstRefused(what, sweep, state)] as const);
      for (const [name, at] of apart) assert.equal(at, base0![1], `${what}: with ${name}, P1's first length refused`);
      for (const [name, state] of rooms.slice(1)) assert.equal(copyOf(state), copyOf(rooms[0]![1]), `${what}: P1's copy is the same with ${name}`);
    }
  }

  test("twin rooms apart only outside P1's copy answer P1's every length of each alike, the line inside each sweep", () => {
    const players = FAR.roomBytes - BOOKKEEPING_RESERVE.room;
    const base = table();
    // The DM's notes, then a pad on s2 that leaves P1's stepped part 600 bytes under its step's edge below the line, so
    // no hidden change takes it past the edge.
    const edge = players - FAR.byteStep;
    const stepped = (state: RoomState) => {
      const exact = ownHeldBytes(state, "p1");
      return farRoomBytes(state, true, measuredStateBytes(state), exact) - exact.shown;
    };
    const filledBase = filled(base, fillFor(base, edge) - 2 * FAR.byteStep);
    const padded = (n: number): RoomState => ({ ...filledBase, tokens: { ...filledBase.tokens, pad: token("pad", { sceneId: "s2", notes: "p".repeat(n) }) } });
    let [lo, hi] = [0, 4 * FAR.byteStep];
    assert.ok(stepped(padded(lo)) <= edge && stepped(padded(hi)) > edge);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (stepped(padded(mid)) <= edge) lo = mid;
      else hi = mid;
    }
    assertSweepsAlike(padded(lo - 600), Object.keys(SWEEPS), (state) => ownHeldBytes(state, "p1").shown);
  });

  test("a scene's reading holds the room-level part of P1's exact part too, so the twins answer alike at the scene's line", () => {
    // s1 filled with the DM's notes to P1's scene line, the room's far under its own. A companion block counts only in the
    // room's reading, so the scene's sweeps are the room-level ones.
    const players = FAR.sceneBytes - BOOKKEEPING_RESERVE.scene;
    const edge = players - FAR.byteStep;
    const base = table();
    const stepped = (state: RoomState) => roundUp(steppedOf(state, ["s1"]), FAR.byteStep);
    const onScene = (bytes: number): RoomState => {
      const out = { ...base, tokens: { ...base.tokens } };
      for (let i = 0; i * MAX_NOTES < bytes; i++) out.tokens[`sf${String(i).padStart(5, "0")}`] = token(`sf${String(i).padStart(5, "0")}`, { x: 20, y: 20, notes: "n".repeat(Math.min(MAX_NOTES, bytes - i * MAX_NOTES)) });
      return out;
    };
    let [lo, hi] = [0, players];
    assert.ok(stepped(onScene(lo)) <= edge && stepped(onScene(hi)) > edge);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (stepped(onScene(mid)) <= edge) lo = mid;
      else hi = mid;
    }
    const shown = onScene(lo - 600);
    assert.ok(farRoomBytes(shown, true, measuredStateBytes(shown), ownHeldBytes(shown, "p1")) < FAR.roomBytes - BOOKKEEPING_RESERVE.room - 2 * FAR.byteStep, "the room's reading is far under its line");
    assertSweepsAlike(shown, ["their character's notes", "their character's sheet", "their character's stat block"], (state) => ownHeldBytes(state, "p1", ["s1"]).shown);
  });
});

describe("LP44-PRIV-1: what a player's own op writes past their copy counts at its width, so hidden values never move their reading", () => {
  /** P1's room reading at its widest. */
  const reading = (state: RoomState) => farRoomBytes(state, true, measuredStateBytes(state), ownHeldBytes(state, "p1"));

  /**
   * Twin rooms apart only in `hidden`, a value P1's copy does not hold in a
   * thing P1's ops write, with a pad that puts the first room's stepped part
   * on a step's edge, where a hidden byte would read a whole step more.
   */
  function twinsAtTheEdge(base: RoomState, hidden: (state: RoomState) => RoomState): [RoomState, RoomState] {
    const filledBase = filled(base, fillFor(base, FAR.roomBytes - BOOKKEEPING_RESERVE.room - MIB) - 2 * FAR.byteStep);
    const padded = (n: number): RoomState => ({ ...filledBase, tokens: { ...filledBase.tokens, pad: token("pad", { sceneId: "s2", notes: "p".repeat(n) }) } });
    // The longest pad that reads as no pad does: the stepped part then ends on the step's edge.
    const at = reading(padded(0));
    let [lo, hi] = [0, FAR.byteStep + 1];
    assert.ok(reading(padded(hi)) > at, "a step's pad reads a step more");
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (reading(padded(mid)) === at) lo = mid;
      else hi = mid;
    }
    const first = padded(lo);
    assert.ok(reading(padded(lo + 1)) > reading(first), "one more stored byte reads a step more");
    return [first, hidden(first)];
  }

  function table(): RoomState {
    const state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "" }) });
    state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    state.tokens.g1 = token("g1", { x: 6, y: 6, hpVisibility: "label", actor: { inline: actor({ dmNotes: "" }) } });
    return state;
  }

  test("an HP change P1 made to a creature whose HP P1 does not read: its line's take-back data, 9 or 10 HP before", () => {
    const base = table();
    const vitals = (cur: number) => ({ hp: { cur, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    const line = (cur: number): LogEntry => ({ id: "900:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", tokenId: "g1", seen: true, change: "damage", amount: 3, label: "Healthy", left: { cur: cur - 3, max: 20, temp: 0 }, revert: { before: vitals(cur), after: vitals(cur - 3) } } as LogEntry["data"] });
    base.log = [line(9)];
    const [nine, ten] = twinsAtTheEdge(base, (s) => ({ ...s, log: [line(10)] }));
    assert.equal(copyOf(ten), copyOf(nine), "P1's copies are equal");
    assert.ok(measuredStateBytes(ten) > measuredStateBytes(nine), "the second room stores more");
    assert.equal(reading(ten), reading(nine));
  });

  test("P1's answer to a roll request whose result P1 does not read: pass, or no result yet", () => {
    const base = table();
    const request = (target: RoomState["rolls"][string]["targets"][number]): RoomState["rolls"][string] =>
      ({ id: "r1", rev: 3, test: { kind: "save", ability: "dex", choices: [] } as never, dc: 15, dcShown: false, resultShown: false, at: "2026-10-12T20:00:00.000Z", targets: [target] }) as RoomState["rolls"][string];
    base.rolls = { r1: request({ tokenId: "hero", total: 17, by: "p1" }) };
    const [open, passed] = twinsAtTheEdge(base, (s) => ({ ...s, rolls: { r1: request({ tokenId: "hero", total: 17, by: "p1", result: "pass" }) } }));
    assert.equal(copyOf(passed), copyOf(open), "P1's copies are equal");
    assert.ok(measuredStateBytes(passed) > measuredStateBytes(open), "the second room stores more");
    assert.equal(reading(passed), reading(open));
  });
});

describe("LP44-PRIV-1: the far line's quick bound holds a player's widths, so every answer is the exact reading's", () => {
  test("a player's create where the quick bound sits a step under the line and their reading past it is refused, as the exact reading says", () => {
    const players = FAR.roomBytes - BOOKKEEPING_RESERVE.room;
    const create = line("d1");
    const applied = (state: RoomState) => {
      const r = applyOp(state, create, P1, env(9));
      assert.ok(r.ok);
      return r;
    };
    // The room's total with the far line's reserves as the guard bounds it without reading, from the measure before the
    // create and its growth's bound, and what P1's exact part takes out of the room after it.
    const bound = (state: RoomState) => {
      const r = applied(state);
      return measuredStateBytes(state) + growthBound(state, r.state, r.touched) + farWidths(r.state);
    };
    const total = (state: RoomState) => measuredStateBytes(applied(state).state) + farWidths(applied(state).state);
    const sub = (state: RoomState) => ownHeldBytes(applied(state).state, "p1").sub;
    // P1's own notes across characters of theirs, `full` of them whole and two that share `extra`, which move the total and
    // what P1's part takes out alike.
    const at = (full: number, extra: number, pad: number): RoomState => {
      const state = filled(room(), 8 * MIB);
      for (let i = 0; i < full + 2; i++) {
        const length = i < full ? MAX_NOTES : Math.min(MAX_NOTES, Math.max(0, extra - (i - full) * MAX_NOTES));
        state.characters[`c${i}`] = character(`c${i}`, { ownerIds: ["p1"], actor: actor({ notes: "n".repeat(length) }) });
      }
      state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c0" }, ownerIds: ["p1"], x: 2, y: 2 });
      state.tokens.pad = token("pad", { sceneId: "s2", notes: "p".repeat(pad) });
      return state;
    };
    // What the bound counts past the total.
    const slack = bound(at(40, 0, 0)) - total(at(40, 0, 0));
    // P1's part placed so their stepped part ends a byte past a step's edge once the bound sits a step under the line.
    const want = (FAR.byteStep - 1 - slack) % FAR.byteStep;
    const need = (full: number) => (want - (sub(at(full, 0, 0)) % FAR.byteStep) + FAR.byteStep) % FAR.byteStep;
    let full = 40;
    while (need(full) > 2 * MAX_NOTES) full++;
    const extra = need(full);
    assert.equal(sub(at(full, extra, 0)) % FAR.byteStep, want);
    // The DM's pad, which moves the bound, the total and P1's stepped part alike, puts the bound a step under the line.
    const pad = players - FAR.byteStep - bound(at(full, extra, 0));
    assert.ok(pad > 0, `a pad of ${pad} bytes`);
    const state = at(full, extra, pad);
    assert.equal(bound(state), players - FAR.byteStep);
    const next = applied(state).state;
    const held = ownHeldBytes(next, "p1");
    assert.ok(held.shown - held.sub > slack + 1, "P1's widths count past what the exact part takes out by more than the bound's slack");
    assert.ok(farRoomBytes(next, true, measuredStateBytes(next), held) > players, "P1's reading after the create is past the line");
    const answer = (measured: boolean) => {
      const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
      // A guard that never measured reads exactly every time.
      if (measured) guard.stateMeasured(measuredStateBytes(state), state);
      const r = applied(state);
      return guard.check(r.state, ["s1"], growthBound(state, r.state, r.touched), state, "player", "widest", false, "p1");
    };
    assert.deepEqual(answer(true), answer(false));
    assert.equal(answer(true).ok, false);
  });
});

describe("D-261119-017: a player's things that follow a creature stay in their exact part, in sight of it or not", () => {
  /**
   * P1's things that follow a wolf of the DM's: a kept ruler from Hero to
   * it, an area on it, a companion riding it, an ask naming it and one on
   * the area, the wolf in P1's sight or out of it, its name one character
   * longer out of sight so both rooms store the same bytes.
   */
  function onTheWolf(seen: boolean): RoomState {
    const state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    state.tokens.wolf = token("wolf", { x: 6, y: 6, name: seen ? "Wolf" : "Wolf1", visibility: seen ? "all" : "dm" });
    state.tokens.pet = token("pet", { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 6, y: 6, size: "tiny", attached: { to: "wolf", kind: "ride" }, actor: { inline: actor({ dmNotes: "" }) } });
    state.drawings.r1 = drawing("r1", { kind: "ruler", ownerId: "p1", anchors: ["hero", "wolf"], points: [2.5, 2.5, 6.5, 6.5] });
    state.templates.a1 = template("a1", { ownerId: "p1", attachedTo: "wolf", casterId: "wolf", label: "Faerie Fire" });
    state.casts.k1 = castAsk("k1", { by: "p1", caster: "hero", area: undefined, targets: ["hero", "wolf"] });
    state.casts.k2 = castAsk("k2", { by: "p1", caster: "hero", area: "a1" });
    return state;
  }

  test("a kept ruler, an area, a ride and an ask on a creature: P1's exact part takes out the same and their stepped part reads the same whether P1 sees it", () => {
    const [seen, unseen] = [onTheWolf(true), onTheWolf(false)];
    assert.equal(measuredStateBytes(seen), measuredStateBytes(unseen), "the rooms store the same bytes");
    assert.notEqual(copyOf(seen), copyOf(unseen), "P1 sees the wolf in one");
    assert.ok(ownHeldBytes(seen, "p1").shown > 0);
    // What the exact part shows follows the copy, which shows the wolf in one room only.
    assert.equal(ownHeldBytes(unseen, "p1").sub, ownHeldBytes(seen, "p1").sub, "the room's exact part");
    assert.equal(ownHeldBytes(unseen, "p1", ["s1"]).sub, ownHeldBytes(seen, "p1", ["s1"]).sub, "the scene's exact part");
    assert.equal(steppedOf(unseen), steppedOf(seen), "the room's stepped part");
    assert.equal(steppedOf(unseen, ["s1"]), steppedOf(seen, ["s1"]), "the scene's stepped part");
  });
  test("a kept ruler, an area, a ride and asks on a creature P1 does not see count alike in P1's exact part, whatever its id and place", () => {
    /** P1's things on a hidden creature `id` at `at`, their companion riding it where P1 last saw it, and an ask on a hidden area of the same id. */
    const onHidden = (id: string, at: number): RoomState => {
      const state = room();
      state.characters.c1 = character("c1", { ownerIds: ["p1"] });
      state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
      state.tokens[id] = token(id, { x: at, y: at, visibility: "dm" });
      state.templates[id] = template(id, { x: at, ownerId: "dm1", visibility: "dm" } as never);
      state.tokens.pet = token("pet", { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 5, y: 5, size: "tiny", attached: { to: id, kind: "ride" }, actor: { inline: actor({ dmNotes: "" }) } });
      state.drawings.r1 = drawing("r1", { kind: "ruler", ownerId: "p1", anchors: ["hero", id], points: [2.5, 2.5, at + 0.5, at + 0.5] });
      state.templates.a1 = template("a1", { ownerId: "p1", attachedTo: id, casterId: "hero", label: "Faerie Fire" });
      state.casts.k1 = castAsk("k1", { by: "p1", caster: "hero", area: undefined, targets: ["hero", id] });
      state.casts.k2 = castAsk("k2", { by: "p1", caster: "hero", area: id });
      return state;
    };
    const [near, far] = [onHidden("w", 7), onHidden("w".repeat(40), 12)];
    assert.equal(copyOf(near), copyOf(far), "P1's copies are equal");
    assert.deepEqual(ownHeldBytes(far, "p1").shown, ownHeldBytes(near, "p1").shown, "the room's exact part");
    assert.deepEqual(ownHeldBytes(far, "p1", ["s1"]).shown, ownHeldBytes(near, "p1", ["s1"]).shown, "the scene's exact part");
  });
});
