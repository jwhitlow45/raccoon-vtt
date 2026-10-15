import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PathStop, TurnStart } from "#shared/model.ts";
import { dragReading, ellipseExit, leftText, movedFeet, movementText, pathNow, speedsLeft, turnTrail, type MovingToken, type TurnView } from "./movement.ts";

const five = { feetPerCell: 5, diagonal: "five" as const };
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" as const };
const euclid = { feetPerCell: 5, diagonal: "euclid" as const };

function tok(over: Partial<MovingToken> = {}): MovingToken {
  return { id: "t1", sceneId: "s1", size: "medium", x: 0, y: 0, elevation: 0, ...over };
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
    assert.equal(movementText(15, speedsLeft({ walk: 30, fly: 60, swim: 10 }, 0, 15)), "Moved 15 ft\n15 ft left · fly 45 ft", "a speed already passed is left out");
    assert.equal(movementText(35, speedsLeft({ walk: 30, fly: 60 }, 10, 35)), "Moved 35 ft\nFly: 25 ft left");
  });

  test("a drag reads against the speed: from the turn's start for the active creature, from the drag's start outside a fight", () => {
    const walker = tok({ x: 5, y: 2 });
    const entries = [{ id: "e1", tokenId: "t1" }];
    const older: TurnView = { activeEntryId: "e1", turnStart: start, entries };
    const base = { token: walker, to: { x: 7, y: 2 }, encounter: older, activeTokenId: "t1", speeds: { walk: 30 }, rules: five, role: "dm" as const };
    assert.deepEqual(dragReading(base), { dragFt: 10, left: { kind: "walk", speed: 30, leftFt: 5, band: "walk" } }, "a turn from before paths: 15 ft straight from its start, 10 ft more");
    assert.equal(dragReading({ ...base, to: { x: 9, y: 2 } }).left!.band, "dash");
    assert.equal(dragReading({ ...base, to: { x: 17, y: 2 } }).left!.band, "over");
    assert.deepEqual(dragReading({ ...base, activeTokenId: "t2" }), { dragFt: 10 }, "another creature during a fight reads no speed");
    assert.deepEqual(dragReading({ ...base, speeds: undefined }), { dragFt: 10 }, "a viewer without the speeds");
    // Hidden creature's turn for a player: a fight with no active row they see.
    assert.deepEqual(dragReading({ ...base, encounter: { activeEntryId: null, started: true, entries: [] }, activeTokenId: null }), { dragFt: 10 });
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
    assert.deepEqual(dragReading({ ...base, token: zigzag }), { dragFt: 10, left: { kind: "walk", speed: 30, leftFt: 25, band: "dash" } }, "25 ft of path and 10 ft more is 35 ft, into the Dash");
    const shoved = along([stop(2, 2), { ...stop(5, 2), uncounted: true }], { x: 5, y: 2 });
    assert.deepEqual(dragReading({ ...base, token: shoved }).left, { kind: "walk", speed: 30, leftFt: 20, band: "walk" }, "the shove is free");
    assert.equal(dragReading({ ...base, token: tok({ x: 2, y: 2 }) }).left!.leftFt, 5, "not moved yet: the drag alone, from where the turn began");
    const diagonal = along([stop(0, 0), stop(1, 1)], { x: 1, y: 1 });
    assert.deepEqual(dragReading({ ...base, token: diagonal, to: { x: 2, y: 2 }, rules: fiveTen }), { dragFt: 10, left: { kind: "walk", speed: 30, leftFt: 15, band: "walk" } }, "the drag's diagonal is the turn's second, 10 ft under 5-10-5");
    assert.equal(dragReading({ ...base, token: zigzag, encounter: { ...fight, activeEntryId: null, started: false } }).left!.leftFt, 20, "outside a fight a path is not read");
  });

  test("the drag label names the speed it reads against", () => {
    assert.equal(leftText({ kind: "walk", speed: 30, leftFt: 5, band: "walk" }), "5 ft left");
    assert.equal(leftText({ kind: "fly", speed: 60, leftFt: 5, band: "dash" }), "Fly: 5 ft left with Dash");
    assert.equal(leftText({ kind: "walk", speed: 30, leftFt: 10, band: "over" }), "10 ft past Dash");
  });
});
