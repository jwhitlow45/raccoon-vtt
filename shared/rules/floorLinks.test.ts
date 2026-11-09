import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, run, thornToken, tower, withStairs } from "../floorLinksTestutil.ts";
import type { FloorLink, RoomState, Scene } from "../model.ts";
import type { Op } from "../protocol.ts";
import { DM, actor, effect } from "../testutil.ts";
import {
  LINK_WORDS,
  climbCost,
  climbKeepsSqueeze,
  climbLabel,
  isStairsRefusal,
  linkDir,
  linkHeight,
  linkProblem,
  pitUnder,
  rectGround,
  restoreStairsWords,
  standsOn,
  wallInside,
  type LinkDraft,
} from "./floorLinks.ts";

/*
 * The rules of stairs and ladders (docs/design/design-v1-floors.md phase 2,
 * 2, 3, 5.1, 6.1): which way an end leads and how high, the ground, walls
 * and pits under its squares, whether a creature stands on it, what a climb
 * costs, the builder's put rules and the words of each refusal.
 */

const edge = (sceneId: string, key: string): Op => ({ t: "build.edge", sceneId, edges: [{ key, feature: { kind: "wall" } }] });
const raise = (sceneId: string, cells: string[], height: number): Op => ({ t: "build.height", sceneId, cells, height });
const draft = (over: Partial<LinkDraft> = {}): LinkDraft => ({ id: "l1", pairId: "l2", sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", ...over });
const end = (s: RoomState, id = "l1"): FloorLink => s.floorLinks![id]!;
const withHeight = (s: RoomState, id: string, height: number | undefined): RoomState => {
  const scene = s.scenes[id]!;
  const { height: _h, ...floor } = scene.floor!;
  return { ...s, scenes: { ...s.scenes, [id]: { ...scene, floor: height === undefined ? floor : { ...floor, height } } } };
};

describe("an end's way and height (2, 5.1)", () => {
  test("up where its far floor lies above, down below, and a player's copy reads its dir", () => {
    const s = withStairs();
    assert.equal(linkDir(s, end(s, "l1")), "up");
    assert.equal(linkDir(s, end(s, "l2")), "down");
    const { to: _to, ...cut } = end(s, "l1");
    assert.equal(linkDir(s, { ...cut, dir: "down" }), "down");
    assert.equal(linkDir(s, cut), null);
  });

  test("the height is the upper floor's either way, 10 ft where it stores none", () => {
    const s = withHeight(withStairs(), UPPER, 25);
    assert.equal(linkHeight(s, end(s, "l1")), 25);
    assert.equal(linkHeight(s, end(s, "l2")), 25);
    const none = withHeight(s, UPPER, undefined);
    assert.equal(linkHeight(none, end(none, "l1")), 10);
    // The lower floor's own height is not the climb's.
    const lower = withHeight(withHeight(s, GROUND, 40), UPPER, 15);
    assert.equal(linkHeight(lower, end(lower, "l2")), 15);
  });
});

describe("the squares (3)", () => {
  test("one ground, or null where two heights meet", () => {
    const s = run(tower(), raise(UPPER, ["3,3", "4,3"], 15));
    assert.equal(rectGround(s.buildChunks, UPPER, { x: 3, y: 3, w: 2, h: 1 }), 15);
    assert.equal(rectGround(s.buildChunks, UPPER, { x: 3, y: 3, w: 3, h: 1 }), null);
    assert.equal(rectGround(s.buildChunks, GROUND, { x: 3, y: 3, w: 4, h: 4 }), 0);
  });

  test("a wall across the squares counts, one along their edge or beside them does not", () => {
    const rect = { x: 3, y: 3, w: 2, h: 2 };
    assert.equal(wallInside(tower(), GROUND, rect), false);
    for (const key of ["4,3,w", "3,4,n", "4,4,n"]) assert.equal(wallInside(run(tower(), edge(GROUND, key)), GROUND, rect), true, key);
    for (const key of ["3,3,w", "5,3,w", "3,3,n", "3,5,n", "6,3,w", "4,2,w"]) assert.equal(wallInside(run(tower(), edge(GROUND, key)), GROUND, rect), false, key);
    // A door counts as a wall does, open or shut.
    const door: Op = { t: "build.edge", sceneId: GROUND, edges: [{ key: "4,3,w", feature: { kind: "door", state: "open", secret: false, discovered: false } }] };
    assert.equal(wallInside(run(tower(), door), GROUND, rect), true);
  });

  test("a free wall through the squares counts, one touching a corner does not", () => {
    const free = (a: [number, number], b: [number, number]): Op => ({ t: "build.walls", sceneId: GROUND, put: [{ id: "w1abcdefghij", a, b, f: { kind: "wall" } }] });
    const rect = { x: 3, y: 3, w: 2, h: 1 };
    assert.equal(wallInside(run(tower(), free([3.5, 2], [3.5, 3.5])), GROUND, rect), true);
    assert.equal(wallInside(run(tower(), free([2, 2], [3, 3])), GROUND, rect), false);
    assert.equal(wallInside(run(tower(), free([3, 3], [5, 3])), GROUND, rect), false);
  });

  test("on hexes a wall line into a hex of the squares, or along a side two of them share, counts", () => {
    const hexes = (s: RoomState): RoomState => ({ ...s, scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, sc]) => [id, sc.floor ? ({ ...sc, gridShape: "hexRows" } as Scene) : sc])) });
    const free = (a: [number, number], b: [number, number]): Op => ({ t: "build.walls", sceneId: GROUND, put: [{ id: "w1abcdefghij", a, b, f: { kind: "wall" } }] });
    const rect = { x: 3, y: 3, w: 2, h: 1 };
    const base = hexes(tower());
    assert.equal(wallInside(base, GROUND, rect), false);
    // Far from the two hexes.
    assert.equal(wallInside(run(base, free([12, 12], [14, 12])), GROUND, rect), false);
    // Right across both.
    assert.equal(wallInside(run(base, free([2, 3.5], [7, 3.5])), GROUND, rect), true);
  });

  test("a pit trap's squares under the end, by id, and none for a trap without a pit", () => {
    const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false };
    const trap = (id: string, x: number, pit: boolean) => ({ id, rev: 1, sceneId: GROUND, name: id, zone: { cells: [{ x, y: 3, w: 1, h: 1 }] }, state: "armed" as const, found: false, rig: { ...rig, ...(pit ? { pit: { floor: -10 } } : {}) } });
    const s = tower({ traps: { b: trap("b", 4, true), a: trap("a", 4, false), c: trap("c", 9, true) } });
    assert.equal(pitUnder(s, GROUND, { x: 3, y: 3, w: 2, h: 1 }), "b");
    assert.equal(pitUnder(s, GROUND, { x: 3, y: 3, w: 1, h: 1 }), null);
    assert.equal(pitUnder(s, UPPER, { x: 3, y: 3, w: 2, h: 1 }), null);
  });
});

describe("standing on an end (6.1)", () => {
  const on = (s: RoomState, id = "l1") => standsOn(s, ANA, s.tokens.thorn!, end(s, id));
  test("inside the squares on their ground, by its snapped space", () => {
    assert.equal(on(withStairs()), "on");
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ x: 4, y: 3 }) } }))), "on");
    // Drawn between squares, it stands where it snaps.
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ x: 3.25, y: 2.75 }) } }))), "on");
  });

  test("nothing in the air over them, partly on squares it would fit, off them, or on another floor", () => {
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ elevation: 5 }) } }))), null);
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ x: 2, y: 3 }) } }))), null);
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ x: 8, y: 8 }) } }))), null);
    assert.equal(on(withStairs(tower({ tokens: { thorn: thornToken({ sceneId: UPPER }) } }))), null);
    // On raised squares it stands on their ground.
    const raised = withStairs(run(tower({ tokens: { thorn: thornToken({ elevation: 5 }) } }), raise(GROUND, ["3,3", "4,3"], 5)));
    assert.equal(on(raised), "on");
  });

  test("a Large creature on 1 by 1 stairs: squeeze to fit in a stairwell, too big in the open", () => {
    const large = thornToken({ size: "large", x: 2.5, y: 2.5 });
    const open = withStairs(tower({ tokens: { thorn: large } }), { rect: { x: 3, y: 3, w: 1, h: 1 } });
    assert.equal(on(open), "tooBig");
    let well = tower({ tokens: { thorn: large } });
    for (const key of ["3,2,w", "3,3,w", "3,4,w", "4,2,w", "4,3,w", "4,4,w"]) well = run(well, edge(GROUND, key));
    const stairwell = withStairs(well, { rect: { x: 3, y: 3, w: 1, h: 1 } });
    assert.equal(on(stairwell), "squeeze");
    // Squeezed there, it stands on them.
    const squeezed = { ...stairwell, tokens: { thorn: { ...large, squeeze: true as const } } };
    assert.equal(on(squeezed), "on");
  });

  test("a squeezed climber keeps its squeeze only where its full space would leave the squares", () => {
    const squeezed = thornToken({ size: "large", x: 2.5, y: 2.5, squeeze: true });
    const narrow = withStairs(tower({ tokens: { thorn: squeezed } }), { rect: { x: 3, y: 3, w: 1, h: 2 } });
    assert.equal(climbKeepsSqueeze(narrow, squeezed, end(narrow)), true);
    const full = { ...squeezed, x: 3, y: 3 };
    const wide = withStairs(tower({ tokens: { thorn: full } }), { rect: { x: 3, y: 3, w: 2, h: 2 } });
    assert.equal(climbKeepsSqueeze(wide, full, end(wide)), false);
    assert.equal(climbKeepsSqueeze(wide, thornToken(), end(wide)), false);
  });
});

describe("a climb's cost (5.1)", () => {
  const high = (s: RoomState) => withHeight(s, UPPER, 20);
  test("stairs the height, a ladder twice it without a Climb Speed, Prone a foot more per foot unless hidden, down as up", () => {
    const s = high(withStairs());
    const thorn = s.tokens.thorn!;
    assert.deepEqual(climbCost(s, thorn, { ...end(s), kind: "stairs" }), { moved: 20, cost: 20 });
    assert.deepEqual(climbCost(s, thorn, { ...end(s), kind: "ladder" }), { moved: 20, cost: 40 });
    assert.deepEqual(climbCost(s, thorn, { ...end(s, "l2"), kind: "ladder" }), { moved: 20, cost: 40 });
    const climber = { ...s, characters: { thorn: { ...s.characters.thorn!, actor: actor({ speeds: { walk: 30, climb: 20 } }) } } };
    assert.deepEqual(climbCost(climber, thorn, { ...end(s), kind: "ladder" }), { moved: 20, cost: 20 });
    const prone = (hidden: boolean) => ({ ...s, characters: { thorn: { ...s.characters.thorn!, actor: actor({ effects: [effect("p", { key: "prone", ...(hidden ? { hiddenFromPlayers: true } : {}) })] }) } } });
    assert.deepEqual(climbCost(prone(true), thorn, end(s)), { moved: 20, cost: 20 });
    assert.deepEqual(climbCost(prone(false), thorn, end(s)), { moved: 20, cost: 40 });
    assert.deepEqual(climbCost(prone(false), thorn, { ...end(s), kind: "ladder" }), { moved: 20, cost: 60 });
  });
});

describe("the put rules (3, 7.3)", () => {
  test("a sound draft passes, and each rule refuses in the builder's words", () => {
    const s = tower();
    assert.equal(linkProblem(s, draft()), null);
    assert.equal(linkProblem(s, draft({ to: ATTIC })), LINK_WORDS.notNext);
    assert.equal(linkProblem(s, draft({ to: "s2" })), LINK_WORDS.notNext);
    assert.equal(linkProblem(s, draft({ sceneId: ATTIC, to: UPPER, kind: "ladder" })), null);
    assert.equal(linkProblem(s, draft({ rect: { x: 18, y: 19, w: 2, h: 2 } })), "Ground floor ends before those squares.");
    const upperSmall = { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, bounds: { w: 4, h: 20 } } } };
    assert.equal(linkProblem(upperSmall, draft()), "Upper floor ends before those squares.");
    assert.equal(linkProblem(run(s, edge(GROUND, "4,3,w")), draft()), "A wall crosses those squares on Ground floor.");
    assert.equal(linkProblem(run(s, raise(UPPER, ["3,3"], 5)), draft()), "Those squares aren't one height on Upper floor.");
    // One raised height under the whole end is one height.
    assert.equal(linkProblem(run(s, raise(UPPER, ["3,3", "4,3"], 5)), draft()), null);
  });
});

describe("the words (6.3, 7.3, 8)", () => {
  test("the later edits' refusals are the stairs' rules, and a restore names the DM who placed them", () => {
    const ground = LINK_WORDS.changeGround("stairs", "Upper floor");
    const block = LINK_WORDS.block("ladder", "Attic");
    const between = LINK_WORDS.between("stairs", "Ground floor", "Upper floor");
    assert.equal(ground, "That would change the ground under the stairs to Upper floor. Remove them first.");
    assert.equal(block, "That would block the ladder to Attic. Remove it first.");
    assert.equal(between, "Stairs join Ground floor and Upper floor. Remove them before putting a floor between.");
    for (const words of [ground, block, between, LINK_WORDS.pitUnder("stairs")]) assert.equal(isStairsRefusal(words), true, words);
    for (const words of [LINK_WORDS.wall("Upper floor"), LINK_WORDS.noStairs, LINK_WORDS.tooMany("Tower"), "Tower's floors don't fit together any more."]) assert.equal(isStairsRefusal(words), false, words);
    assert.equal(restoreStairsWords(LINK_WORDS.block("stairs", "Upper floor")), "That would block the stairs to Upper floor. The DM who placed them can remove them.");
    assert.equal(restoreStairsWords(block), "That would block the ladder to Attic. The DM who placed it can remove it.");
    assert.equal(restoreStairsWords(between), "Stairs join Ground floor and Upper floor. The DM who placed them can remove them.");
    assert.equal(restoreStairsWords("the stairs changed"), "the stairs changed");
  });

  test("the climb's label and its refusals", () => {
    assert.equal(climbLabel("Thorn", "up", "stairs"), "moving Thorn up the stairs");
    assert.equal(climbLabel("Thorn", "down", "ladder"), "moving Thorn down the ladder");
    assert.equal(LINK_WORDS.carried("Thorn", "stairs"), "Thorn is carried. Its holder takes the stairs.");
    assert.equal(LINK_WORDS.tooBigSqueeze("stairs"), "Too big for these stairs. Squeeze to fit.");
    assert.equal(LINK_WORDS.changed("stairs"), "the stairs changed");
    assert.equal(LINK_WORDS.pitUnder("stairs"), "A pit can't open under stairs. Remove them first.");
  });

  test("no em dash or semicolon in any of them", () => {
    const all = [
      LINK_WORDS.noStairs, LINK_WORDS.locked, LINK_WORDS.notNext,
      ...(["stairs", "ladder"] as const).flatMap((k) => [LINK_WORDS.carried("Thorn", k), LINK_WORDS.tooBig(k), LINK_WORDS.tooBigSqueeze(k), LINK_WORDS.changed(k), LINK_WORDS.overEnd(k, "Attic"), LINK_WORDS.changeGround(k, "Attic"), LINK_WORDS.block(k, "Attic"), LINK_WORDS.between(k, "A", "B"), LINK_WORDS.pitUnder(k)]),
    ];
    for (const words of all) assert.doesNotMatch(words, /[\u2014;]/, words);
  });
});

describe("a DM's copy reads the rules as the server does", () => {
  test("standsOn and linkProblem read only what the copy of the scene holds", () => {
    const s = withStairs();
    assert.equal(standsOn(s, DM, s.tokens.thorn!, end(s)), "on");
    assert.equal(linkProblem(s, draft({ id: "l3", pairId: "l4", rect: { x: 10, y: 10, w: 1, h: 1 } })), null);
  });
});
