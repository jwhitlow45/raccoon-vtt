import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { edge, lift, paint } from "../discoveryTestutil.ts";
import type { EdgeFeature, RoomState, Token, Trap, TrapRig, Viewer } from "../model.ts";
import { touchLanding } from "../permissions.ts";
import { cellVision } from "../perPlayerTestutil.ts";
import { gridOfToken } from "../project.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { visionRules } from "../ruleHooks.ts";
import { nudgeValid } from "../rules/nudge.ts";
import { DM, P1, env, member, room, scene, token } from "../testutil.ts";

/*
 * Placements between squares in the reducer (docs/design/design-v1-snap-off.md
 * 5.3): a named move keeps one only when it lands where aimed, and the pass at
 * the end of every op drops one that no longer holds where its token ends.
 */

let seq = 1;
function applied(state: RoomState, op: Op, who: Viewer = DM): Applied {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return r;
}
const run = (state: RoomState, op: Op, who: Viewer = DM) => applied(state, op, who).state;
const nudgeOf = (state: RoomState, id: string) => state.tokens[id]?.nudge;

function allValid(state: RoomState): void {
  for (const t of Object.values(state.tokens)) assert.ok(nudgeValid(gridOfToken(state, t), t), `${t.id} keeps a nudge that does not hold`);
}

const bree = (over: Partial<Token> = {}) => token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 3, y: 3, ...over });

describe("a named move keeps a placement only where it lands as aimed (5.3)", () => {
  test("an Alt-drop lands on its square drawn where it was let go, and an ordinary move clears it", () => {
    const s = run(room({ tokens: { bree: bree({ x: 0, y: 0 }) } }), { t: "token.move", tokenId: "bree", x: 3, y: 3, drawnAt: { x: 3.375, y: 2.625 } });
    assert.deepEqual([s.tokens.bree!.x, s.tokens.bree!.y], [3, 3], "the rules box is the snapped one");
    assert.deepEqual(nudgeOf(s, "bree"), { x: 3, y: -3 });
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5, y: 3 }), "bree"), undefined);
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 3, y: 3 }), "bree"), undefined, "a named move without one, in place too");
  });

  test("a move to another box carrying the old nudge keeps it, as a group's members and an arrow step send it", () => {
    const s = room({ tokens: { bree: bree({ nudge: { x: 2, y: 1 } }), gob: token("gob", { x: 6, y: 3, nudge: { x: -1, y: 0 } }) } });
    assert.deepEqual(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 4, y: 3, drawnAt: { x: 4.25, y: 3.125 } }), "bree"), { x: 2, y: 1 });
    const group = run(s, {
      t: "token.moveMany",
      moves: [
        { tokenId: "bree", x: 3, y: 5, drawnAt: { x: 3.25, y: 5.125 } },
        { tokenId: "gob", x: 6, y: 5 },
      ],
    });
    assert.deepEqual(nudgeOf(group, "bree"), { x: 2, y: 1 });
    assert.equal(nudgeOf(group, "gob"), undefined, "a member sent without one goes back on the grid");
  });

  test("a drawn point past the bound, on the landing, or a landing off the grid leaves none", () => {
    const s = room({ tokens: { bree: bree() } });
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5, y: 3, drawnAt: { x: 5.5, y: 3 } }), "bree"), undefined);
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5, y: 3, drawnAt: { x: 4, y: 3 } }), "bree"), undefined, "the aim of another box");
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5, y: 3, drawnAt: { x: 5, y: 3 } }), "bree"), undefined);
    // A cut to a half-off hold, as the touch rule may land a walk, is off its grid: the drawn point is kept by no box.
    assert.equal(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5.5, y: 3, drawnAt: { x: 5.625, y: 3 } }), "bree"), undefined);
    assert.deepEqual(nudgeOf(run(s, { t: "token.move", tokenId: "bree", x: 5, y: 3, squeeze: true, drawnAt: { x: 5.25, y: 3 } }), "bree"), { x: 2, y: 0 }, "a Medium creature's flag is no squeeze");
  });

  test("a squeezed landing takes none", () => {
    const s = room({ tokens: { ogre: token("ogre", { size: "large", x: 3, y: 3, nudge: { x: 1, y: 0 } }) } });
    const r = run(s, { t: "token.move", tokenId: "ogre", x: 5, y: 3, squeeze: true, drawnAt: { x: 5.125, y: 3 } });
    assert.equal(r.tokens.ogre!.squeeze, true);
    assert.equal(nudgeOf(r, "ogre"), undefined);
  });
});

describe("the touch rule's landing and a trap's stop (5.3, section 10)", () => {
  const real = { ...visionRules };
  before(() => Object.assign(visionRules, cellVision));
  after(() => Object.assign(visionRules, real));
  const WALL: EdgeFeature = { kind: "wall" };

  test("a free drop into the dark held at a wall lands at its last clear spot without the nudge", () => {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
    s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark" } };
    s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
    paint(s, { x: 0, y: 0, w: 24, h: 16 });
    lift(s, "party", { x: 0, y: 3, w: 5, h: 5 });
    edge(s, "8,5,w", WALL);
    const op: Op = { t: "token.move", tokenId: "thorn", x: 12, y: 5, drawnAt: { x: 12.25, y: 5 } };
    const landed = touchLanding(op, P1, s, { canUseAsset: () => true });
    assert.ok(landed && landed.op.t === "token.move");
    assert.deepEqual([landed.op.x, landed.op.y], [7, 5]);
    const r = run(s, landed.op, P1);
    assert.deepEqual([r.tokens.thorn!.x, r.tokens.thorn!.y], [7, 5]);
    assert.equal(nudgeOf(r, "thorn"), undefined);
  });

  function rig(over: Partial<TrapRig> = {}): TrapRig {
    return { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "A click underfoot.", ...over };
  }
  const plate = (x: number): Trap => ({ id: "plate", rev: 0, sceneId: "s1", name: "plate", zone: { cells: [{ x, y: 5, w: 1, h: 1 }] }, state: "armed", found: false, rig: rig() });

  test("a trap's stop short of the aim clears it, and a stop on the aim keeps it", () => {
    const thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 0, y: 5 });
    const op: Op = { t: "token.move", tokenId: "thorn", x: 8, y: 5, drawnAt: { x: 8.25, y: 4.875 } };
    const short = run(room({ tokens: { thorn }, traps: { plate: plate(3) } }), op, P1);
    assert.deepEqual([short.tokens.thorn!.x, short.tokens.thorn!.y], [3, 5], "stopped on the plate");
    assert.equal(nudgeOf(short, "thorn"), undefined);
    const onAim = run(room({ tokens: { thorn }, traps: { plate: plate(8) } }), op, P1);
    assert.equal(onAim.traps.plate!.state, "sprung");
    assert.deepEqual([onAim.tokens.thorn!.x, onAim.tokens.thorn!.y], [8, 5]);
    assert.deepEqual(nudgeOf(onAim, "thorn"), { x: 2, y: -1 });
  });
});

describe("what a move takes along keeps a placement where it still holds (5.3)", () => {
  /** A Large warhorse at 4,4 ridden by Bree, dragging a goblin. */
  function stable(): RoomState {
    return room({
      scenes: { s1: scene("s1"), s2: scene("s2"), hx: scene("hx", { gridShape: "hexRows" }) },
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4 }),
        bree: bree({ x: 4, y: 4, nudge: { x: 2, y: 2 }, attached: { to: "horse", kind: "ride", steer: true } }),
        gob: token("gob", { name: "Goblin 2", size: "small", x: 6, y: 4, nudge: { x: -2, y: 0 }, attached: { to: "horse", kind: "drag" } }),
      },
    });
  }

  test("a holder's move on squares takes its rider and what it drags with their nudges", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 10, y: 6 });
    assert.deepEqual(nudgeOf(s, "bree"), { x: 2, y: 2 });
    assert.deepEqual(nudgeOf(s, "gob"), { x: -2, y: 0 });
    allValid(s);
  });

  test("a holder held off its grid drags its goblin off the goblin's grid, which clears its nudge", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 10.5, y: 6 });
    assert.equal(s.tokens.gob!.x % 1 === 0, false, "dragged by the holder's own move");
    assert.equal(nudgeOf(s, "gob"), undefined);
    allValid(s);
  });

  test("a group sent to a hex scene comes without nudges, and to a square one with them", () => {
    const hex = run(stable(), { t: "token.update", tokenId: "horse", patch: { sceneId: "hx" } });
    assert.equal(hex.tokens.bree!.sceneId, "hx");
    assert.equal(nudgeOf(hex, "bree"), undefined);
    assert.equal(nudgeOf(hex, "gob"), undefined);
    const squares = run(stable(), { t: "token.update", tokenId: "horse", patch: { sceneId: "s2" } });
    assert.deepEqual(nudgeOf(squares, "bree"), { x: 2, y: 2 });
  });

  test("a nudged rider seated at a half seat loses it, and one seated on a square keeps it", () => {
    const loose = stable();
    const { attached: _a, ...free } = loose.tokens.bree!;
    loose.tokens.bree = { ...free, x: 2, y: 4 };
    const half = run(loose, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 4.5, y: 4.5, elevation: 0 });
    assert.deepEqual([half.tokens.bree!.x, half.tokens.bree!.y], [4.5, 4.5]);
    assert.equal(nudgeOf(half, "bree"), undefined);
    const square = run(loose, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 0 });
    assert.deepEqual(nudgeOf(square, "bree"), { x: 2, y: 2 });
  });
});

describe("token updates (5.3)", () => {
  const s = () => room({ tokens: { bree: bree({ nudge: { x: 3, y: 0 } }) } });

  test("a placement in place sets the nudge from the token's own spot, and null or its own spot clears it", () => {
    const placedHere = run(room({ tokens: { bree: bree() } }), { t: "token.update", tokenId: "bree", patch: { drawnAt: { x: 2.75, y: 3.125 } } });
    assert.deepEqual(nudgeOf(placedHere, "bree"), { x: -2, y: 1 });
    assert.deepEqual([placedHere.tokens.bree!.x, placedHere.tokens.bree!.y], [3, 3], "no move");
    assert.equal(placedHere.tokens.bree!.path, undefined, "no leg on a path");
    assert.equal(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { drawnAt: null } }), "bree"), undefined);
    assert.equal(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { drawnAt: { x: 3, y: 3 } } }), "bree"), undefined);
    assert.equal(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { drawnAt: { x: 3.5, y: 3 } } }), "bree"), undefined, "past the bound");
  });

  test("a resize, a scene change and a place edit clear it, and facing or height keep it", () => {
    for (const patch of [{ size: "large" }, { x: 3 }, { y: 4 }, { sceneId: "s2" }] as const) {
      const state = s();
      state.scenes.s2 = scene("s2");
      assert.equal(nudgeOf(run(state, { t: "token.update", tokenId: "bree", patch }), "bree"), undefined, JSON.stringify(patch));
    }
    assert.deepEqual(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { rotation: 90 } }), "bree"), { x: 3, y: 0 });
    assert.deepEqual(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { elevation: 10 } }), "bree"), { x: 3, y: 0 });
    assert.deepEqual(nudgeOf(run(s(), { t: "token.update", tokenId: "bree", patch: { name: "Bree the Bold" } }), "bree"), { x: 3, y: 0 });
  });

  test("a group's resize clears them as one token's does", () => {
    const state = room({ tokens: { a: token("a", { x: 3, y: 3, nudge: { x: 3, y: 0 } }), b: token("b", { x: 5, y: 3, nudge: { x: 1, y: -1 } }) } });
    const r = run(state, { t: "token.updateMany", tokenIds: ["a", "b"], patch: { size: "tiny" } });
    assert.equal(nudgeOf(r, "a"), undefined);
    assert.equal(nudgeOf(r, "b"), undefined);
  });
});

describe("the pass after every op (5.3, D-261102-436)", () => {
  const grid = (shape: "hexRows" | "squares"): Op => ({ t: "scene.update", sceneId: "s1", patch: { gridShape: shape } });

  test("a switch to hexes clears every nudge on the scene, its undo gives them back, and its redo clears them again", () => {
    const state = room({ tokens: { a: token("a", { x: 3, y: 3, nudge: { x: 3, y: 0 } }), b: token("b", { x: 5, y: 3 }) } });
    state.scenes.s2 = scene("s2");
    state.tokens.c = token("c", { sceneId: "s2", x: 1, y: 1, nudge: { x: 1, y: 1 } });
    const hexed = applied(state, grid("hexRows"));
    assert.equal(nudgeOf(hexed.state, "a"), undefined);
    assert.deepEqual(nudgeOf(hexed.state, "c"), { x: 1, y: 1 }, "another scene's");
    assert.ok(hexed.touched.includes("token:a"));
    assert.ok(!hexed.touched.includes("token:b"), "a token with nothing to drop is not written");
    const undo = applied(hexed.state, { t: "sys.restore", entries: hexed.inverse!, from: "undo", deps: true });
    assert.equal(undo.state.scenes.s1!.gridShape, undefined);
    assert.deepEqual(nudgeOf(undo.state, "a"), { x: 3, y: 0 });
    const redo = applied(undo.state, { t: "sys.restore", entries: undo.inverse!, from: "redo", deps: true });
    assert.equal(redo.state.scenes.s1!.gridShape, "hexRows");
    assert.equal(nudgeOf(redo.state, "a"), undefined);
  });

  test("a restore that puts a nudged token on a hex scene, or off its square, keeps none", () => {
    const state = room({ scenes: { s1: scene("s1"), hx: scene("hx", { gridShape: "hexRows" }) }, tokens: { a: token("a", { x: 3, y: 3 }) } });
    const put = (value: Token): RestoreEntry[] => [{ key: "token:a", value }];
    const onHex = run(state, { t: "sys.restore", entries: put({ ...state.tokens.a!, sceneId: "hx", nudge: { x: 1, y: 0 } }), from: "undo" });
    assert.equal(nudgeOf(onHex, "a"), undefined);
    const offSquare = run(state, { t: "sys.restore", entries: put({ ...state.tokens.a!, x: 3.5, nudge: { x: 1, y: 0 } }), from: "undo" });
    assert.equal(nudgeOf(offSquare, "a"), undefined);
    const kept = run(state, { t: "sys.restore", entries: put({ ...state.tokens.a!, nudge: { x: 1, y: 0 } }), from: "undo" });
    assert.deepEqual(nudgeOf(kept, "a"), { x: 1, y: 0 });
  });

  test("a scene's copy keeps its tokens' placements", () => {
    const state = room({ tokens: { a: token("a", { x: 3, y: 3, nudge: { x: 3, y: 0 } }) } });
    const r = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    const copies = Object.values(r.tokens).filter((t) => t.sceneId === "s9");
    assert.equal(copies.length, 1);
    assert.deepEqual(copies[0]!.nudge, { x: 3, y: 0 });
  });
});
