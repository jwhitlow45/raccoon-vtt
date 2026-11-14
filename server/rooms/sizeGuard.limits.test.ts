import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR, roundUp } from "#shared/limits.ts";
import type { Member, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, member, room, scene, token } from "#shared/testutil.ts";
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

function judged(state: RoomState, op: Op, viewer: Viewer, guard: SizeGuard, far: Parameters<SizeGuard["check"]>[5]) {
  const r = applyOp(state, op, viewer, env(9));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return guard.check(r.state, ["s1"], growthBound(state, r.state, r.touched), state, viewer.role, far);
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
    assert.deepEqual(judged(base, conditions, DM, near, "exempt"), { ok: true });
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
    const under = nearFar(FAR.roomBytes - 2 * MIB);
    const free = new SizeGuard();
    free.stateMeasured(measuredStateBytes(under), under);
    assert.deepEqual(judged(under, line("d1"), P1, free, "widest"), { ok: true });
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
