import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, FAR, KEPT_FOR_PLAYERS, KEPT_FOR_PLAYERS_FULL, roundUp } from "#shared/limits.ts";
import type { Member, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { character, companionBlock, DM, env, member, room, scene, template, token } from "#shared/testutil.ts";
import { farRoomBytes, growthBound, heldBytes, measuredStateBytes, overFarLine, PER_PLAYER_FULL, playerBlockBytes, projectedSceneBytes, roomLevelBytes, SizeGuard, widestPerPlayerReserve } from "./sizeGuard.ts";

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
    assert.deepEqual(judged(over, line("d1"), P1, guard, "widest"), { ok: false, code: "quota", message: `the room is full: it is at its ${Math.floor(FAR.roomBytes / MIB)} MiB size limit` });
    const under = nearFar(FAR.roomBytes - BOOKKEEPING_RESERVE.room - 2 * MIB);
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
    assert.deepEqual(judged(state, line("d1"), P1, guard, "widest"), { ok: false, code: "quota", message: `the room is full: it is at its ${Math.floor(FAR.roomBytes / MIB)} MiB size limit` });
  });

  test("an op that meets the line stops the bookkeeping reserve short of it, and an exempt kind goes on to the line itself", () => {
    // A room whose far reading with today's reserves sits inside the reserve: past the line less it, short of the line.
    const inside = nearFar(FAR.roomBytes - BOOKKEEPING_RESERVE.room - MIB);
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
    assert.deepEqual(guard.check(notes.state, [], growthBound(state, notes.state, notes.touched), state, "dm", "today"), { ok: false, code: "quota", message: `this scene is at its ${FAR.sceneBytes / MIB} MiB size limit` });
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

  test("LIMITS-2: a player's add reads the players' line, never the DM's 1 MiB sooner one", () => {
    // P1's reading between the DM's line and the players': P1's line taken, the DM's growing note refused in the kept words.
    const state = filled(room(), fillFor(room(), FAR.roomBytes - BOOKKEEPING_RESERVE.room - KEPT_FOR_PLAYERS / 2));
    const reading = farRoomBytes(state, true);
    assert.ok(reading > FAR.roomBytes - BOOKKEEPING_RESERVE.room - KEPT_FOR_PLAYERS && reading < FAR.roomBytes - BOOKKEEPING_RESERVE.room - FAR.byteStep, `${reading} inside the kept 1 MiB`);
    assert.deepEqual(playerJudged(state, line("d1"), "p1"), { ok: true }, "P1's line");
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(state), state);
    assert.deepEqual(judged(state, { t: "token.update", tokenId: "fill1", patch: { notes: "m".repeat(8_000) } }, DM, guard, "dmAdd"), { ok: false, code: "quota", message: KEPT_FOR_PLAYERS_FULL }, "the DM's growing note");
  });
});
