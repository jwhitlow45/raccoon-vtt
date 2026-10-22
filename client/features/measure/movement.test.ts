import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PathStop, RoomState, Token, TurnStart } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { RESHAPE_NOT_A_MOVE } from "#shared/reducer/tokens.ts";
import { DM, P1, P2, room, token } from "#shared/testutil.ts";
import { resizeGroup } from "../tokens/resize.ts";
import { dragLabel, dragReading, ellipseExit, halvedSpeeds, leftText, movedFeet, movementText, pathNow, remoteWalk, speedsLeft, trailSegments, turnTrail, type DragWalk, type MovingToken, type TurnView } from "./movement.ts";
import { ownWalk, type Walker } from "#shared/rules/movement.ts";
import { walkTrace } from "#shared/rules/route.ts";

const five = { feetPerCell: 5, diagonal: "five" as const };
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" as const };
const euclid = { feetPerCell: 5, diagonal: "euclid" as const };

/** A token walking as itself (rules/movement.ts ownWalk). */
function tok(over: Partial<MovingToken> = {}): MovingToken & Walker {
  return ownWalk({ id: "t1", sceneId: "s1", size: "medium", x: 0, y: 0, elevation: 0, ...over });
}

const start: TurnStart = { entryId: "e1", tokenId: "t1", sceneId: "s1", x: 2, y: 2, elevation: 0 };
/** The turn of e1, named 7, as a DM's copy holds it. */
const fight: TurnView = { activeEntryId: "e1", turnStart: { ...start, seq: 7 }, entries: [{ id: "e1", tokenId: "t1" }, { id: "e2", tokenId: "t2" }] };
const stop = (x: number, y: number, elevation = 0): PathStop => ({ x, y, elevation });

describe("movement since the turn began", () => {
  test("counts the corner's steps by the diagonal rule, with climbing as vertical steps", () => {
    const from = { x: 0, y: 0, elevation: 0 };
    assert.equal(movedFeet(tok(), from, { x: 3, y: 2, elevation: 0 }, five), 15);
    assert.equal(movedFeet(tok(), from, { x: 3, y: 2, elevation: 0 }, fiveTen), 20);
    assert.equal(movedFeet(tok(), from, { x: 3, y: 4, elevation: 0 }, euclid), 25);
    assert.equal(movedFeet(tok(), from, { x: 1, y: 0, elevation: 30 }, five), 30, "flying up 30 ft while moving a square");
    assert.equal(movedFeet(tok({ size: "large" }), from, { x: 1, y: 0, elevation: 0 }, five), 5, "a Large creature moved one square moved 5 ft");
  });

  test("reads from snapped positions, so a token dropped off the grid counts whole squares", () => {
    assert.equal(movedFeet(tok(), { x: 0.2, y: 0, elevation: 0 }, { x: 2.4, y: 0, elevation: 0 }, five), 10);
    assert.equal(movedFeet(tok({ size: "tiny" }), { x: 0, y: 0, elevation: 0 }, { x: 0.5, y: 0, elevation: 0 }, five), 2.5);
  });

  test("the trail runs through every stop of this turn, and Moved adds up the legs that count, out and back included", () => {
    const stops: PathStop[] = [stop(2, 2), stop(4, 2), { ...stop(4, 4), uncounted: true }, stop(5, 4)];
    const trail = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 5, y: 4, path: { turn: 7, stops } }), rules: five, role: "dm" })!;
    assert.deepEqual(trail.spots, stops.map((s) => ({ x: s.x, y: s.y, elevation: s.elevation })));
    assert.deepEqual(trail.legs.map((l) => l.counted), [true, false, true]);
    assert.equal(trail.movedFt, 15, "10 ft and 5 ft, without the 10 ft shove");
    assert.deepEqual([trail.from, trail.to], [{ x: 2, y: 2, w: 1, h: 1 }, { x: 5, y: 4, w: 1, h: 1 }]);
    const back = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 2, y: 2, path: { turn: 7, stops: [stop(2, 2), stop(6, 2), stop(2, 2)] } }), rules: five, role: "dm" })!;
    assert.equal(back.movedFt, 40, "out and back is the whole walk, not the difference");
    const climb = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 2, y: 2, elevation: 10, path: { turn: 7, stops: [stop(2, 2), stop(2, 2, 10)] } }), rules: five, role: "dm" })!;
    assert.equal(climb.movedFt, 10, "flying straight up is moving");
    const diagonal = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 2, y: 2, path: { turn: 7, stops: [stop(0, 0), stop(1, 1), stop(2, 2)] } }), rules: fiveTen, role: "dm" })!;
    assert.equal(diagonal.movedFt, 15, "the 5-10-5 count runs along the whole path, not leg by leg");
    const shoved = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 3, y: 3, path: { turn: 7, stops: [stop(0, 0), stop(1, 1), { ...stop(2, 2), uncounted: true }, stop(3, 3)] } }), rules: fiveTen, role: "dm" })!;
    assert.equal(shoved.movedFt, 15, "a shove's diagonal is not the creature's");
  });

  test("the DM's trail draws no leg a holder carried the creature, which its holder's own trail shows (docs/design-v1-attach.md 7.2)", () => {
    const stops: PathStop[] = [stop(2, 2), stop(4, 2), { ...stop(8, 2), uncounted: true, carried: true }, stop(8, 4)];
    const trail = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 8, y: 4, path: { turn: 7, stops } }), rules: five, role: "dm" })!;
    assert.deepEqual(trail.legs.map((l) => [l.counted, l.carried]), [[true, false], [false, true], [true, false]]);
    assert.equal(trail.movedFt, 20, "the carried leg counts nothing");
    assert.deepEqual(trailSegments(trail).map((s) => s.leg), [0, 2]);
    // A player's copy holds the same leg as an uncounted one, without the mark: drawn faint, as any leg that does not count.
    const theirs = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 8, y: 4, path: { turn: 7, stops: stops.map(({ carried: _c, ...rest }) => rest) } }), rules: five, role: "player" })!;
    assert.deepEqual(trailSegments(theirs).map((s) => [s.leg, s.counted]), [[0, true], [1, false], [2, true]]);
  });

  test("an earlier turn's path, another row's turn or another scene draws no trail, and a turn from before paths reads straight from its start", () => {
    const token = tok({ x: 5, y: 4, path: { turn: 6, stops: [stop(9, 9), stop(5, 4)] } });
    const stale = turnTrail({ encounter: fight, sceneId: "s1", token, rules: five, role: "dm" })!;
    assert.deepEqual(stale.spots, [{ x: 2, y: 2, elevation: 0 }, { x: 5, y: 4, elevation: 0 }], "from where this turn began, not along the old path");
    const older: TurnView = { ...fight, turnStart: start };
    assert.equal(turnTrail({ encounter: older, sceneId: "s1", token: tok({ x: 5, y: 4 }), rules: five, role: "dm" })!.movedFt, 15);
    assert.equal(turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 2, y: 2 }), rules: five, role: "dm" }), null, "not moved yet");
    assert.equal(turnTrail({ encounter: { ...fight, activeEntryId: "e2" }, sceneId: "s1", token, rules: five, role: "dm" }), null, "another row's turn");
    assert.equal(turnTrail({ encounter: fight, sceneId: "s2", token, rules: five, role: "dm" }), null, "another scene in view");
    assert.equal(turnTrail({ encounter: fight, sceneId: "s1", token: undefined, rules: five, role: "dm" }), null, "a token this viewer cannot see");
    assert.equal(turnTrail({ encounter: null, sceneId: "s1", token, rules: five, role: "dm" }), null);
  });

  test("a player trusts a path of the active creature without the turn's start to check it against, and the DM never does", () => {
    const unknown: TurnView = { activeEntryId: "e1", started: true, entries: [{ id: "e1", tokenId: "t1" }] };
    const token = tok({ x: 6, y: 2, path: { turn: 7, stops: [stop(2, 2), stop(4, 2)] } });
    assert.equal(pathNow(unknown, token, "player"), token.path);
    assert.equal(pathNow(unknown, token, "dm"), null);
    assert.equal(pathNow({ ...unknown, entries: [{ id: "e1", tokenId: "t2" }] }, token, "player"), null);
    assert.equal(pathNow(fight, { ...token, path: { turn: 6, stops: [] } }, "player"), null, "with the start, a player checks too");
    const trail = turnTrail({ encounter: unknown, sceneId: "s1", token, rules: five, role: "player" })!;
    assert.deepEqual(trail.spots.map((s) => s.x), [2, 4, 6], "where it stands now, which they see, joins the stops they saw");
    assert.equal(trail.movedFt, 20);
  });

  test("lines leave a round token at its edge", () => {
    const r = { x: 0, y: 0, w: 2, h: 2 };
    assert.deepEqual(ellipseExit(r, { x: 10, y: 1 }), { x: 2, y: 1 });
    const diag = ellipseExit(r, { x: 11, y: 11 });
    assert.ok(Math.abs(Math.hypot(diag.x - 1, diag.y - 1) - 1) < 1e-9);
    assert.deepEqual(ellipseExit(r, { x: 1.2, y: 1 }), { x: 1, y: 1 }, "a point inside gives the center");
  });

  test("what is left of each speed, with the Dash band past the speed and the fly speed first in the air", () => {
    assert.deepEqual(speedsLeft({ walk: 30 }, 0, 10), [{ kind: "walk", speed: 30, leftFt: 20, band: "walk" }]);
    assert.deepEqual(speedsLeft({ walk: 30 }, 0, 30), [{ kind: "walk", speed: 30, leftFt: 0, band: "walk" }]);
    assert.deepEqual(speedsLeft({ walk: 30 }, 0, 45), [{ kind: "walk", speed: 30, leftFt: 15, band: "dash" }]);
    assert.deepEqual(speedsLeft({ walk: 30 }, 0, 70), [{ kind: "walk", speed: 30, leftFt: 10, band: "over" }]);
    assert.deepEqual(
      speedsLeft({ walk: 30, fly: 60, swim: 15, climb: 30 }, 0, 10).map((s) => s.kind),
      ["walk", "fly", "swim"],
      "climbing and burrowing are left to the table",
    );
    assert.deepEqual(speedsLeft({ walk: 30, fly: 60 }, 20, 10).map((s) => s.kind), ["fly", "walk"], "in the air, flying comes first");
    assert.deepEqual(speedsLeft({ walk: 30 }, 20, 10).map((s) => s.kind), ["walk"], "a creature lifted without a fly speed still walks");
    assert.deepEqual(speedsLeft({ walk: 0 }, 0, 10), [], "no speed set reads as unknown");
    assert.deepEqual(speedsLeft(undefined, 0, 10), [], "a viewer who does not get the speeds");
  });

  test("the marker says what was moved, and what is left only to those who know the speeds", () => {
    assert.equal(movementText(15, []), "Moved 15 ft");
    assert.equal(movementText(15, speedsLeft({ walk: 30 }, 0, 15)), "Moved 15 ft\n15 ft left");
    assert.equal(movementText(40, speedsLeft({ walk: 30 }, 0, 40)), "Moved 40 ft\n20 ft left with Dash");
    assert.equal(movementText(70, speedsLeft({ walk: 30 }, 0, 70)), "Moved 70 ft\n10 ft past Dash");
    assert.equal(movementText(15, speedsLeft({ walk: 30, fly: 60, swim: 10 }, 0, 15)), "Moved 15 ft\n15 ft left · Fly 45 ft", "a speed already passed is left out");
    assert.equal(movementText(35, speedsLeft({ walk: 30, fly: 60 }, 10, 35)), "Moved 35 ft\nFly: 25 ft left");
  });

  test("another member's drag reads its band and what is left from the cost its frame carries, terrain included", () => {
    // A 30 ft Speed, 25 ft of corners, and 45 ft as the dragging device counted it through rubble.
    const walker = tok({ x: 0, y: 0 });
    const to = { x: 5, y: 0 };
    const read = dragReading({ token: walker, to, encounter: null, activeTokenId: null, speeds: { walk: 30 }, rules: five, role: "dm", walk: remoteWalk(walker, to, []), costFt: 45 });
    assert.equal(dragLabel(read), "45 ft · 15 ft left with Dash");
    assert.equal(read.left!.band, "dash", "drawn yellow");
    const plain = dragReading({ token: walker, to, encounter: null, activeTokenId: null, speeds: { walk: 30 }, rules: five, role: "dm", walk: remoteWalk(walker, to, []) });
    assert.equal(dragLabel(plain), "25 ft · 5 ft left", "a frame without a cost reads its corners");
  });

  test("a drag reads against the speed: from the turn's start for the active creature, from the drag's start outside a fight", () => {
    const walker = tok({ x: 5, y: 2 });
    const entries = [{ id: "e1", tokenId: "t1" }];
    const older: TurnView = { activeEntryId: "e1", turnStart: start, entries };
    const base = { token: walker, to: { x: 7, y: 2 }, encounter: older, activeTokenId: "t1", speeds: { walk: 30 }, rules: five, role: "dm" as const };
    assert.deepEqual(dragReading(base), { dragFt: 10, diag: [0, 0], left: { kind: "walk", speed: 30, leftFt: 5, band: "walk" } }, "a turn from before paths: 15 ft straight from its start, 10 ft more");
    assert.equal(dragReading({ ...base, to: { x: 9, y: 2 } }).left!.band, "dash");
    assert.equal(dragReading({ ...base, to: { x: 17, y: 2 } }).left!.band, "over");
    assert.deepEqual(dragReading({ ...base, activeTokenId: "t2" }), { dragFt: 10, diag: [0, 0] }, "another creature during a fight reads no speed");
    assert.deepEqual(dragReading({ ...base, speeds: undefined }), { dragFt: 10, diag: [0, 0] }, "a viewer without the speeds");
    // Hidden creature's turn for a player: a fight with no active row they see.
    assert.deepEqual(dragReading({ ...base, encounter: { activeEntryId: null, started: true, entries: [] }, activeTokenId: null }), { dragFt: 10, diag: [0, 0] });
    for (const encounter of [null, { activeEntryId: null, entries: [] }, { activeEntryId: null, started: false, entries }]) {
      assert.equal(dragReading({ ...base, encounter, activeTokenId: null }).left!.leftFt, 20, "outside a fight, from where the drag began");
    }
    assert.equal(dragReading({ ...base, encounter: { activeEntryId: "e1", entries } }).left!.leftFt, 20, "a fight from before the spot was recorded");
    assert.equal(dragReading({ ...base, encounter: { activeEntryId: "e1", turnStart: { ...start, sceneId: "s2" }, entries } }).left!.leftFt, 20);
  });

  test("the active creature's drag adds its leg to the path so far, without the legs that do not count", () => {
    const along = (stops: PathStop[], at: { x: number; y: number }) => tok({ ...at, path: { turn: 7, stops } });
    const base = { to: { x: 7, y: 2 }, encounter: fight, activeTokenId: "t1", speeds: { walk: 30 }, rules: five, role: "dm" as const };
    const zigzag = along([stop(2, 2), stop(2, 4), stop(5, 2)], { x: 5, y: 2 });
    assert.deepEqual(dragReading({ ...base, token: zigzag }), { dragFt: 10, diag: [0, 0], left: { kind: "walk", speed: 30, leftFt: 25, band: "dash" } }, "25 ft of path and 10 ft more is 35 ft, into the Dash");
    const shoved = along([stop(2, 2), { ...stop(5, 2), uncounted: true }], { x: 5, y: 2 });
    assert.deepEqual(dragReading({ ...base, token: shoved }).left, { kind: "walk", speed: 30, leftFt: 20, band: "walk" }, "the shove is free");
    assert.equal(dragReading({ ...base, token: tok({ x: 2, y: 2 }) }).left!.leftFt, 5, "not moved yet: the drag alone, from where the turn began");
    const diagonal = along([stop(0, 0), stop(1, 1)], { x: 1, y: 1 });
    assert.deepEqual(dragReading({ ...base, token: diagonal, to: { x: 2, y: 2 }, rules: fiveTen }), { dragFt: 10, diag: [1, 0], left: { kind: "walk", speed: 30, leftFt: 15, band: "walk" } }, "the drag's diagonal is the turn's second, 10 ft under 5-10-5");
    assert.equal(dragReading({ ...base, token: zigzag, encounter: { ...fight, activeEntryId: null, started: false } }).left!.leftFt, 20, "outside a fight a path is not read");
  });

  test("the drag label names the speed it reads against", () => {
    assert.equal(leftText({ kind: "walk", speed: 30, leftFt: 5, band: "walk" }), "5 ft left");
    assert.equal(leftText({ kind: "fly", speed: 60, leftFt: 5, band: "dash" }), "Fly: 5 ft left with Dash");
    assert.equal(leftText({ kind: "walk", speed: 30, leftFt: 10, band: "over" }), "10 ft past Dash");
  });
});

describe("a resize on the turn (docs/design-v1-token-window.md 8.7)", () => {
  const MEDIUM = { w: 1, h: 1 };
  const TINY = { w: 0.5, h: 0.5 };

  test("each end of a leg is measured at its own stop's size, and a leg across sizes between the two middles", () => {
    const familiar = tok({ size: "medium" });
    assert.equal(movedFeet(familiar, { ...stop(4, 4), footprint: TINY }, { ...stop(4.5, 4), footprint: TINY }, five), 2.5, "a Tiny's half-square leg after it grew");
    assert.equal(movedFeet(familiar, stop(4, 4), stop(4.5, 4), five), 5, "read at the size now, it would be a whole square");
    assert.equal(movedFeet(tok({ size: "large" }), { ...stop(4, 4), footprint: MEDIUM }, stop(4, 4), five), 2.5, "Medium to Large in place: the middle moves half a square each way");
    assert.equal(movedFeet(tok({ size: "huge" }), { ...stop(4, 4), footprint: MEDIUM }, stop(3, 3), five), 0, "Medium to Huge keeps the middle");
  });

  /** Thorn, P1's druid at 1,1, whose turn it is, a goblin far off, every op through the reducer with the next seq. */
  function played(ops: Op[], over: Partial<Token> = {}): RoomState {
    let state = room({ tokens: { thorn: token("thorn", { kind: "npc", name: "Thorn", ownerIds: ["p1"], x: 1, y: 1, ...over }), gob: token("gob", { x: 20, y: 1 }) } });
    const all: Op[] = [{ t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] }, { t: "encounter.next" }, ...ops];
    for (const [i, op] of all.entries()) {
      const r = applyOp(state, op, DM, { seq: i + 1, at: "2026-10-12T20:00:00.000Z" });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    }
    return state;
  }

  /** Thorn's trail as the DM, his owner and another player who saw him move read it, each from their own copy. */
  function trails(state: RoomState) {
    const rules = state.meta.settings;
    return [DM, P1, P2].map((viewer) => {
      const copy = projectState(state, viewer, { sceneId: state.meta.playerSceneId }) as unknown as RoomState;
      const encounter = copy.encounter as unknown as TurnView;
      return turnTrail({ encounter, sceneId: "s1", token: copy.tokens.thorn as MovingToken, rules: { feetPerCell: rules.feetPerCell, diagonal: rules.diagonal }, role: viewer.role })!;
    });
  }

  test("Thorn moves 15 ft and grows to Huge: his trail still reads 15 ft, its legs drawn at Medium, the resize's faint, for everyone", () => {
    const state = played([
      { t: "token.move", tokenId: "thorn", x: 4, y: 1 },
      { t: "token.update", tokenId: "thorn", patch: { size: "huge", x: 3, y: 0 } },
    ]);
    for (const [i, trail] of trails(state).entries()) {
      const who = ["the DM", "his owner", "another player"][i];
      assert.equal(trail.movedFt, 15, who);
      assert.deepEqual(trail.legs.map((l) => l.counted), [true, false], `${who}: the resize's leg does not count`);
      assert.deepEqual(trail.rects, [{ x: 1, y: 1, w: 1, h: 1 }, { x: 4, y: 1, w: 1, h: 1 }, { x: 3, y: 0, w: 3, h: 3 }], `${who}: each stop at its own size`);
      assert.deepEqual(trail.from, { x: 1, y: 1, w: 1, h: 1 }, `${who}: the ring at the size the turn began at`);
    }
  });

  test("a diagonal before the resize and one after count 5 then 10 under 5-10-5", () => {
    const state = played([
      { t: "room.update", settings: { diagonal: "fiveTen" } },
      { t: "token.move", tokenId: "thorn", x: 2, y: 2 },
      { t: "token.update", tokenId: "thorn", patch: { size: "large" } },
      { t: "token.move", tokenId: "thorn", x: 3, y: 3 },
    ]);
    for (const trail of trails(state)) {
      assert.equal(trail.movedFt, 15);
      assert.deepEqual(trail.diagonals, { h: 2, v: 0 }, "the resize took no diagonal");
    }
  });

  test("a squeezed Large shrunk to Medium in its corridor keeps every earlier leg's feet and look, for everyone, and on replay", () => {
    const squeezedIn: Op[] = [{ t: "token.move", tokenId: "thorn", x: 13.5, y: 4.5, squeeze: true }];
    const before = trails(played(squeezedIn, { size: "large", x: 6, y: 4 }));
    const shrunk = played([...squeezedIn, { t: "token.update", tokenId: "thorn", patch: { size: "medium", x: 14, y: 5 } }], { size: "large", x: 6, y: 4 });
    const after = trails(shrunk);
    for (const [i, trail] of after.entries()) {
      const who = ["the DM", "his owner", "another player"][i];
      assert.equal(before[i]!.movedFt, 37.5, `${who}: the squeeze's leg`);
      assert.equal(trail.movedFt, 37.5, `${who}: the shrink changed the feet moved before it`);
      assert.deepEqual(trail.rects.slice(0, 2), before[i]!.rects.slice(0, 2), `${who}: the shrink redrew the earlier stops`);
      assert.deepEqual(trail.legs.map((l) => l.counted), [true, false], `${who}: the shrink's leg does not count`);
    }
    // The start was made full size, the corridor's stop squeezed, and the shrink's stop at the size now.
    assert.deepEqual(shrunk.tokens.thorn!.path!.stops.map((s) => s.footprint), [{ w: 2, h: 2 }, { w: 2, h: 2, squeeze: true }, undefined]);
    // Replayed, the same ops make the same path. An op stored before version 6 replays as it did then, with no footprint.
    assert.deepEqual(played([...squeezedIn, { t: "token.update", tokenId: "thorn", patch: { size: "medium", x: 14, y: 5 } }], { size: "large", x: 6, y: 4 }).tokens.thorn!.path, shrunk.tokens.thorn!.path);
    const old = room({ tokens: { thorn: token("thorn", { kind: "npc", ownerIds: ["p1"], size: "large", x: 6, y: 4 }), gob: token("gob", { x: 20, y: 1 }) } });
    let replayed = old;
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] }, { t: "encounter.next" }, ...squeezedIn, { t: "token.update", tokenId: "thorn", patch: { size: "medium", x: 14, y: 5 } }] as Op[]).entries()) {
      const r = applyOp(replayed, op, DM, { seq: i + 1, at: "2026-10-12T20:00:00.000Z", opVersion: 5 });
      assert.ok(r.ok);
      replayed = r.state;
    }
    assert.equal(replayed.tokens.thorn!.path!.stops.some((s) => s.footprint !== undefined), false, "a version 5 op stamps nothing");
  });

  test("a move into a squeeze and back out keeps the first leg's feet, each stop read with the footprint it had", () => {
    const state = played(
      [
        { t: "token.move", tokenId: "thorn", x: 13.5, y: 4.5, squeeze: true },
        { t: "token.move", tokenId: "thorn", x: 16, y: 4 },
      ],
      { size: "large", x: 6, y: 4 },
    );
    const stops = state.tokens.thorn!.path!.stops;
    assert.deepEqual(stops.map((s) => s.footprint), [{ w: 2, h: 2 }, { w: 2, h: 2, squeeze: true }, undefined], "each earlier stop holds the footprint it was made with");
    const thorn = state.tokens.thorn as MovingToken;
    assert.equal(movedFeet(thorn, stops[0]!, stops[1]!, five), 37.5, "into the corridor, between the middles");
    for (const trail of trails(state)) assert.equal(trail.legs.length, 2);
  });

  test("a Tiny familiar's half-square move, then its growth to Medium, still reads 2.5 ft", () => {
    const state = played(
      [
        { t: "token.move", tokenId: "thorn", x: 4.5, y: 4 },
        { t: "token.update", tokenId: "thorn", patch: { size: "medium", x: 4, y: 4 } },
      ],
      { size: "tiny", x: 4, y: 4 },
    );
    for (const trail of trails(state)) {
      assert.equal(trail.movedFt, 2.5);
      assert.deepEqual(trail.rects.map((r) => r.w), [0.5, 0.5, 1]);
    }
  });

  /*
   * A squeeze taken or left in place (the build review's round 2,
   * W5-BUILD-DATA-01): a same-size update clears a squeeze where the
   * creature stands, as a group's resize does for a member already at the
   * size chosen, and a move to the spot it stands on may take or leave one.
   */
  const squeezedIn: Op[] = [{ t: "token.move", tokenId: "thorn", x: 13.5, y: 4.5, squeeze: true }];
  const inCorridor = { size: "large" as const, x: 6, y: 4 };

  test("a group's resize to the size a squeezed member already has leaves its earlier feet, for everyone, and its leg counts nothing", () => {
    const mid = played(squeezedIn, inCorridor);
    const group = resizeGroup(mid, [mid.tokens.thorn!], { size: "large" }, "dm", {});
    assert.deepEqual(group.ops.map((op) => op.patch), [{ size: "large" }], "the squeezed member's patch keeps its place");
    const state = played([...squeezedIn, ...group.ops], inCorridor);
    assert.equal(state.tokens.thorn!.squeeze, undefined, "the same size still stands it full size");
    for (const [i, trail] of trails(state).entries()) {
      const who = ["the DM", "his owner", "another player"][i];
      assert.equal(trail.movedFt, 37.5, `${who}: the same-size resize changed the feet moved before it`);
      assert.deepEqual(trail.legs.map((l) => l.counted), [true, false], `${who}: the squeeze left in place counts`);
    }
    assert.deepEqual(state.tokens.thorn!.path!.stops.map((s) => s.footprint), [{ w: 2, h: 2 }, { w: 2, h: 2, squeeze: true }, undefined]);
    const refused = applyOp(state, { t: "token.countLeg", tokenId: "thorn", counts: false }, DM, { seq: 99, at: "2026-10-12T20:00:00.000Z" });
    assert.ok(!refused.ok && refused.message === RESHAPE_NOT_A_MOVE, "Doesn't count marks a leg that was no move");
  });

  test("a mixed group's resize, one member growing and the squeezed one staying its size, keeps every earlier leg of the squeezed one", () => {
    for (const size of ["large", "huge"] as const) {
      const mid = played(squeezedIn, inCorridor);
      const group = resizeGroup(mid, [mid.tokens.thorn!, mid.tokens.gob!], { size }, "dm", {});
      assert.equal(group.ops.length, 2, `${size}: both members resized`);
      const state = played([...squeezedIn, ...group.ops], inCorridor);
      assert.equal(state.tokens.gob!.size, size);
      for (const trail of trails(state)) {
        assert.equal(trail.movedFt, 37.5, `${size}: the group's resize changed the feet moved before it`);
        assert.deepEqual(trail.legs.map((l) => l.counted), [true, false]);
      }
    }
  });

  test("a move to the spot it stands on that takes or leaves a squeeze counts nothing and keeps the feet before it, and a move into one still counts", () => {
    const state = played(
      [
        ...squeezedIn,
        { t: "token.move", tokenId: "thorn", x: 13.5, y: 4.5 },
        { t: "token.move", tokenId: "thorn", x: 13.5, y: 4.5, squeeze: true },
      ],
      inCorridor,
    );
    for (const trail of trails(state)) {
      assert.equal(trail.movedFt, 37.5);
      assert.deepEqual(trail.legs.map((l) => l.counted), [true, false, false]);
    }
    const stops = state.tokens.thorn!.path!.stops;
    assert.deepEqual(stops.map((s) => s.footprint), [{ w: 2, h: 2 }, { w: 2, h: 2, squeeze: true }, { w: 2, h: 2 }, undefined], "each stop keeps the footprint it was made with");
    // The move into the corridor was a move: "Doesn't count" marks it.
    const marked = applyOp(played(squeezedIn, inCorridor), { t: "token.countLeg", tokenId: "thorn", counts: false }, DM, { seq: 99, at: "2026-10-12T20:00:00.000Z" });
    assert.ok(marked.ok, "a move into a squeeze is a move");
  });

  /*
   * Random turns of moves, resizes, squeezes, group resizes, climbs,
   * teleports and marks. The invariants: no op changes the feet or the
   * count of any leg made before it, for the DM, the owner and another
   * player alike (a mark changes only the last leg's count), and an op
   * that leaves the creature where it stood adds no feet.
   */
  test("random turns: no op changes the feet of the legs before it, and nothing done in place adds feet", () => {
    const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
    const DIAGONALS = ["five", "fiveTen", "euclid"] as const;
    const viewers = [DM, P1, P2];
    const at = "2026-10-12T20:00:00.000Z";
    /** Each viewer's legs of Thorn's trail: the feet of a counted leg, measured on from the legs before it as the trail does. */
    const legsOf = (state: RoomState) =>
      viewers.map((viewer) => {
        const copy = projectState(state, viewer, { sceneId: state.meta.playerSceneId }) as unknown as RoomState;
        const thorn = copy.tokens.thorn as MovingToken;
        const path = pathNow(copy.encounter as unknown as TurnView, thorn, viewer.role);
        if (!path) return [];
        const rules = { feetPerCell: state.meta.settings.feetPerCell, diagonal: state.meta.settings.diagonal };
        const counter = { h: 0, v: 0 };
        return path.stops.slice(1).map((to, i) => ({ counted: to.uncounted !== true, ft: to.uncounted === true ? 0 : movedFeet(thorn, path.stops[i]!, to, rules, counter) }));
      });
    const total = (legs: { ft: number }[]) => legs.reduce((sum, leg) => sum + leg.ft, 0);
    // How often a change of footprint in place came up, so the run is known to try the case it guards.
    let reshapedInPlace = 0;
    for (let seed = 1; seed <= 150; seed++) {
      let n = seed;
      // mulberry32: a seeded sequence, so a failure names the seed that makes it again.
      const random = () => {
        n = (n + 0x6d2b79f5) | 0;
        let t = Math.imul(n ^ (n >>> 15), 1 | n);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
      const half = () => 2 + Math.floor(random() * 32) / 2;
      let state = played([{ t: "room.update", settings: { diagonal: pick(DIAGONALS) } }], { size: pick(SIZES), x: 6, y: 4 });
      let seq = 100;
      const done: Op[] = [];
      for (let step = 0; step < 30; step++) {
        const thorn = state.tokens.thorn!;
        const roll = random();
        let ops: Op[];
        if (roll < 0.25) ops = [{ t: "token.move", tokenId: "thorn", x: half(), y: half(), ...(random() < 0.5 ? { squeeze: true as const } : {}) }];
        else if (roll < 0.4) ops = [{ t: "token.move", tokenId: "thorn", x: thorn.x, y: thorn.y, ...(thorn.squeeze ? {} : { squeeze: true as const }) }];
        else if (roll < 0.52) ops = [{ t: "token.update", tokenId: "thorn", patch: { size: pick(SIZES), ...(random() < 0.5 ? { x: half(), y: half() } : {}) } }];
        else if (roll < 0.62) ops = [{ t: "token.update", tokenId: "thorn", patch: { size: thorn.size } }];
        else if (roll < 0.74) ops = resizeGroup(state, [thorn, state.tokens.gob!], { size: pick(SIZES) }, "dm", {}).ops;
        else if (roll < 0.82) ops = [{ t: "token.update", tokenId: "thorn", patch: { elevation: thorn.elevation + (random() < 0.5 ? 5 : -5) } }];
        else if (roll < 0.9) ops = [{ t: "token.move", tokenId: "thorn", x: half(), y: half(), teleport: "wall" }];
        else ops = [{ t: "token.countLeg", tokenId: "thorn", counts: random() < 0.5 }];
        for (const op of ops) {
          const r = applyOp(state, op, DM, { seq: seq++, at });
          if (!r.ok) continue;
          done.push(op);
          const was = legsOf(state);
          const now = legsOf(r.state);
          const stood = state.tokens.thorn!;
          const stands = r.state.tokens.thorn!;
          const why = `seed ${seed}, after ${JSON.stringify(done)}`;
          for (const [v, before] of was.entries()) {
            const after = now[v]!;
            const kept = op.t === "token.countLeg" ? before.length - 1 : before.length;
            assert.deepEqual(after.slice(0, kept), before.slice(0, kept), `${["the DM", "the owner", "another player"][v]}: a leg before the op changed, ${why}`);
            const inPlace = stood.x === stands.x && stood.y === stands.y && stood.elevation === stands.elevation;
            if (inPlace && op.t !== "token.countLeg") assert.equal(total(after), total(before), `${["the DM", "the owner", "another player"][v]}: an op in place added feet, ${why}`);
            if (v === 0 && inPlace && after.length > before.length) reshapedInPlace++;
          }
          state = r.state;
        }
      }
    }
    assert.ok(reshapedInPlace > 100, `only ${reshapedInPlace} changes of footprint in place`);
  });
});

describe("a drag along a route (docs/design-v1-movement.md 3.1, 3.2 and 4.2)", () => {
  const walker = tok({ x: 0, y: 0 });
  const calm = { encounter: null, activeTokenId: null, speeds: { walk: 30 }, rules: five, role: "dm" as const };
  const flat = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, elevation: 0 }));
  const walk = (points: [number, number][], pieces: [number, number, number, 0 | 1][], halved: (x: number) => boolean = () => false, prone = false): DragWalk => ({
    route: { points: flat(points), pieces },
    build: { buildChunks: {} },
    trace: walkTrace({}, ownWalk(walker), flat(points)),
    halved: (at) => (halved(at.x) ? "Spirit Guardians" : null),
    prone,
  });

  test("the label reads the leg's cost and names what cost extra", () => {
    const rubble = walk(
      [
        [0, 0],
        [2, 0],
        [4, 0],
      ],
      [
        [2, 0, 0, 0],
        [4, 0, 1, 0],
      ],
    );
    const read = dragReading({ ...calm, token: walker, to: { x: 4, y: 0 }, walk: rubble });
    assert.equal(read.dragFt, 30);
    assert.deepEqual(read.extra, { ft: 10, words: "+10 ft for difficult terrain" });
    const wade = walk([[0, 0], [2, 0]], [[2, 0, 2, 1]]);
    assert.equal(dragReading({ ...calm, token: walker, to: { x: 2, y: 0 }, walk: wade }).extra!.words, "+20 ft for difficult terrain and swimming");
    assert.equal(dragReading({ ...calm, speeds: { walk: 30, swim: 30 }, token: walker, to: { x: 2, y: 0 }, walk: wade }).extra!.words, "+10 ft for difficult terrain", "a Swim Speed takes the swimming foot off");
    assert.equal(dragReading({ ...calm, token: walker, to: { x: 2, y: 0 }, walk: walk([[0, 0], [2, 0]], [[2, 0, 1, 0]], undefined, true) }).extra!.words, "+10 ft for crawling");
    assert.equal(dragReading({ ...calm, token: walker, to: { x: 2, y: 0 }, walk: walk([[0, 0], [2, 0]], [[2, 0, 3, 0]]) }).extra!.words, "+30 ft for overgrowth");
    assert.equal(dragLabel(read), "30 ft · 0 ft left\n+10 ft for difficult terrain");
  });

  test("Spirit Guardians: 10 ft outside and 10 ft inside reads yellow from the second step in, and stays yellow after it leaves", () => {
    const inside = (x: number) => x >= 2 && x <= 4;
    const pieces: [number, number, number, 0 | 1][] = [[2, 0, 0, 0], [4, 0, 0, 0]];
    const into = dragReading({ ...calm, token: walker, to: { x: 4, y: 0 }, walk: walk([[0, 0], [2, 0], [4, 0]], pieces, inside) });
    assert.equal(into.halfSpeed, "Spirit Guardians");
    assert.deepEqual(into.left, { kind: "walk", speed: 15, leftFt: 10, band: "dash" }, "20 ft used against 15: a Dash, 10 ft left with it");
    const first = dragReading({ ...calm, token: walker, to: { x: 3, y: 0 }, walk: walk([[0, 0], [2, 0], [3, 0]], [[2, 0, 0, 0], [3, 0, 0, 0]], inside) });
    assert.equal(first.left!.band, "walk", "the first step in is 15 ft against 15");
    const out = dragReading({ ...calm, token: walker, to: { x: 6, y: 0 }, walk: walk([[0, 0], [2, 0], [4, 0], [6, 0]], [...pieces, [6, 0, 0, 0]], inside) });
    assert.equal(out.halfSpeed, undefined);
    assert.deepEqual(out.left, { kind: "walk", speed: 30, leftFt: 30, band: "dash" }, "out again with the full Speed, but the walk needed a Dash");
    // 35 ft inside, past its halved Dash of 30, then 5 ft out: 40 ft is within the full Dash, so the words are the area's.
    const deep = (x: number) => x < 7.5;
    const past = dragReading({ ...calm, token: walker, to: { x: 8, y: 0 }, walk: walk([[0, 0], [8, 0]], [[8, 0, 0, 0]], deep) });
    assert.deepEqual(past.left, { kind: "walk", speed: 15, leftFt: 5, band: "over" });
    assert.equal(dragLabel(past), "40 ft · 5 ft past Dash");
  });

  test("a halved Speed rounds down, and the marker reads used where it differs from moved", () => {
    assert.deepEqual(halvedSpeeds({ walk: 25, fly: 30 }), { walk: 12, fly: 15 });
    const left = speedsLeft(halvedSpeeds({ walk: 25 }), 0, 10);
    assert.equal(movementText(10, left, 10), "Moved 10 ft\n2 ft left");
    assert.equal(movementText(25, speedsLeft({ walk: 30 }, 0, 35), 35), "Moved 25 ft, used 35 ft\n25 ft left with Dash");
  });

  test("the trail reads stored costs where the copy holds them, and corners' geometry everywhere else", () => {
    const stops: PathStop[] = [stop(2, 2), { ...stop(4, 4), via: [2, 4], moved: 20, cost: 30 }];
    const owned = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 4, y: 4, path: { turn: 7, stops } }), rules: five, role: "dm" })!;
    assert.deepEqual([owned.movedFt, owned.usedFt], [20, 30]);
    assert.deepEqual(owned.legs[0]!.via, [{ x: 2, y: 4 }]);
    const theirs: PathStop[] = [stop(2, 2), { ...stop(4, 4), via: [2, 4] }];
    const seen = turnTrail({ encounter: fight, sceneId: "s1", token: tok({ x: 4, y: 4, path: { turn: 7, stops: theirs } }), rules: five, role: "player" })!;
    assert.deepEqual([seen.movedFt, seen.usedFt], [20, 20], "down two squares, then across two: never the straight 10 ft");
  });
});
