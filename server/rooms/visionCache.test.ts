import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, SightTile, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { actor, deepClone, DM, env, P1, room, scene, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";

/**
 * Sight asked for in the middle of an op, as the reducer's "seen" marks
 * ask, must not be what the finished state answers: a transaction writes
 * into its state and the collections it copied after those questions, so a
 * cache keyed on either would keep the unfinished answer (W4-ASTRA-01).
 * Each case runs the op through the reducer and then checks sight against
 * a deep copy nothing has cached, and what exploring and projection make
 * of it.
 */

/** Tiles as plain data, for comparing answers from different objects. */
function plain(tiles: ReadonlyMap<string, SightTile>): Record<string, SightTile> {
  return Object.fromEntries([...tiles].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

function run(state: RoomState, op: Op, seq: number): RoomState {
  const result = applyOp(state, op, DM, env(seq));
  assert.ok(result.ok, `${op.t}: ${result.ok ? "" : result.message}`);
  return result.state;
}

/** The answer of a state no cache has seen: the same contents in new objects. */
function fresh(state: RoomState, sceneId = "s1"): Record<string, SightTile> {
  return plain(visionRules.partySight(deepClone(state), sceneId).tiles);
}

/** A dark 40 x 20 player scene with vision and fog on, and a party character with no darkvision at (14, 10). */
function darkRoom(tokens: Record<string, Token>, light: "bright" | "dark" = "dark"): RoomState {
  return room({
    scenes: { s1: scene("s1", { bounds: { w: 40, h: 20 }, fogEnabled: true, vision: { on: true, light }, autoWalls: "off" }) },
    tokens,
  });
}

describe("sight asked for during an op", () => {
  /** The orc's turn, in the dark, its torch's ground explored, and the move to (25, 3). */
  function torchBearer(): { before: RoomState; moved: RoomState } {
    const hero = token("hero", { kind: "pc", ownerIds: ["p1"], x: 14, y: 10 });
    const orc = token("orc", { x: 3, y: 3, light: { bright: 20, dim: 20 } });
    let s = darkRoom({ hero, orc });
    s = run(s, { t: "encounter.start", entries: [{ id: "e1", tokenId: "orc", value: 20 }, { id: "e2", tokenId: "hero", value: 10 }] }, 1);
    s = run(s, { t: "encounter.next" }, 2);
    const first = exploreOp(s);
    assert.ok(first, "the torch's ground is explored first");
    s = run(s, first, 3);
    assert.equal(exploreOp(s), null);
    return { before: s, moved: run(s, { t: "token.move", tokenId: "orc", x: 25, y: 3 }, 4) };
  }

  test("a torch bearer moved on its turn: sight, exploring and projection read where it stands at the end", () => {
    const { moved } = torchBearer();
    assert.deepEqual(plain(visionRules.partySight(moved, "s1").tiles), fresh(moved), "sight follows the torch to where it went");
    const explore = exploreOp(moved);
    assert.ok(explore, "the ground the torch lights now is explored");
    assert.ok(
      explore.tiles.some((t) => t.tx === 1 && t.ty === 0),
      "the destination's tile is among those explored",
    );
    const view = projectState(moved, P1, { sceneId: "s1" });
    assert.ok(view.tokens.orc, "players see the orc by its own torch");
    assert.deepEqual(view.sight, Object.fromEntries(Object.entries(fresh(moved)).map(([k, v]) => [`s1:${k}`, v])));
  });

  test("a move marks where the torch bearer stopped seen, by its own torch there", () => {
    const { moved } = torchBearer();
    assert.deepEqual(
      moved.tokens.orc!.path!.stops.map((p) => [p.x, p.y, p.seen === true]),
      [
        [3, 3, true],
        [25, 3, true],
      ],
    );
    assert.deepEqual(
      projectState(moved, P1, { sceneId: "s1" }).tokens.orc?.path?.stops.map((p) => [p.x, p.y]),
      [
        [3, 3],
        [25, 3],
      ],
      "players get both stops",
    );
  });

  test("a torch bearer walking into the dark is seen where it set out and not where it stopped", () => {
    // Its torch lights a 40 ft circle, and the party's character stands far west of where the orc ends up behind a wall.
    const hero = token("hero", { kind: "pc", ownerIds: ["p1"], x: 2, y: 10 });
    const orc = token("orc", { x: 6, y: 10, light: { bright: 5, dim: 0 } });
    const s0 = room({
      scenes: { s1: scene("s1", { bounds: { w: 40, h: 20 }, fogEnabled: true, vision: { on: true, light: "dark" }, autoWalls: "off" }) },
      tokens: { hero, orc },
      buildChunks: { "s1:1,0": { sceneId: "s1", cx: 1, cy: 0, rev: 0, cells: {}, edges: Object.fromEntries(Array.from({ length: 20 }, (_, y) => [`20,${y},w`, { kind: "wall" as const }])) } },
    });
    let s = run(s0, { t: "encounter.start", entries: [{ id: "e1", tokenId: "orc", value: 20 }, { id: "e2", tokenId: "hero", value: 10 }] }, 1);
    s = run(s, { t: "encounter.next" }, 2);
    const moved = run(s, { t: "token.move", tokenId: "orc", x: 30, y: 10 }, 3);
    assert.deepEqual(
      moved.tokens.orc!.path!.stops.map((p) => [p.x, p.y, p.seen === true]),
      [
        [6, 10, true],
        [30, 10, false],
      ],
    );
  });

  /*
   * W4-F-8: in one group move, the wolf's last stop is judged with every
   * token of the group where it ends, whatever order the moves are listed
   * in. Both ways matter: a torch arriving lights the wolf's destination,
   * and a torch leaving leaves it dark, where judging it with the torch
   * still in place would mark a stop players never saw.
   */
  for (const [direction, heroFrom, heroTo, lit] of [
    ["arriving", 2, 18, true],
    ["leaving", 18, 2, false],
  ] as const) {
    test(`a group move with the torch bearer ${direction} marks the wolf's last stop as the finished state shows it, in either order`, () => {
      const groupMove = (heroFirst: boolean): RoomState => {
        const hero = token("hero", { kind: "pc", ownerIds: ["p1"], x: heroFrom, y: 10, light: { bright: 20, dim: 0 } });
        const wolf = token("wolf", { x: 30, y: 10 });
        let s = darkRoom({ hero, wolf });
        s = run(s, { t: "encounter.start", entries: [{ id: "e1", tokenId: "wolf", value: 20 }, { id: "e2", tokenId: "hero", value: 10 }] }, 1);
        s = run(s, { t: "encounter.next" }, 2);
        const wolfMove = { tokenId: "wolf", x: 20, y: 10 };
        const heroMove = { tokenId: "hero", x: heroTo, y: 10 };
        return run(s, { t: "token.moveMany", moves: heroFirst ? [heroMove, wolfMove] : [wolfMove, heroMove] }, 3);
      };
      const marks = (s: RoomState) => s.tokens.wolf!.path!.stops.map((p) => [p.x, p.y, p.seen === true]);
      const wolfFirst = groupMove(false);
      const heroFirst = groupMove(true);
      assert.deepEqual(marks(wolfFirst), marks(heroFirst), "the same marks in either order");
      // The finished state's own answer, from a copy no cache has seen.
      const cold = visionRules.partySight(deepClone(wolfFirst), "s1").seesToken(wolfFirst.tokens.wolf!);
      assert.equal(cold, lit);
      assert.deepEqual(marks(wolfFirst), [
        [30, 10, false],
        [20, 10, lit],
      ]);
      assert.deepEqual(
        projectState(wolfFirst, P1, { sceneId: "s1" }).tokens.wolf?.path?.stops.map((p) => [p.x, p.y]),
        lit ? [[20, 10]] : undefined,
        lit ? "players get the stop they saw" : "players get no stop they never saw, and no wolf",
      );
    });
  }

  /*
   * W4-F-9: when the active creature stands somewhere its path does not
   * end (a landing, an erase or an undo changed its elevation without a
   * stop), the group move first adds a stop where it stands. That stop is
   * judged on the state before the group moved, so a torch bearer listed
   * earlier and leaving does not darken it in one order only.
   */
  test("the stop a group move adds where the active creature stood is judged before the group moved, in either order", () => {
    const groupMove = (heroFirst: boolean): RoomState => {
      const hero = token("hero", { kind: "pc", ownerIds: ["p1"], x: 28, y: 10, light: { bright: 20, dim: 0 } });
      const wolf = token("wolf", { x: 30, y: 10 });
      let s = darkRoom({ hero, wolf });
      s = run(s, { t: "encounter.start", entries: [{ id: "e1", tokenId: "wolf", value: 20 }, { id: "e2", tokenId: "hero", value: 10 }] }, 1);
      s = run(s, { t: "encounter.next" }, 2);
      // Lifted 5 ft with no stop, as a height painted under it would.
      s = { ...s, tokens: { ...s.tokens, wolf: { ...s.tokens.wolf!, elevation: 5 } } };
      const wolfMove = { tokenId: "wolf", x: 20, y: 10 };
      const heroMove = { tokenId: "hero", x: 2, y: 10 };
      return run(s, { t: "token.moveMany", moves: heroFirst ? [heroMove, wolfMove] : [wolfMove, heroMove] }, 3);
    };
    const marks = (s: RoomState) => s.tokens.wolf!.path!.stops.map((p) => [p.x, p.y, p.elevation, p.seen === true]);
    const wolfFirst = groupMove(false);
    assert.deepEqual(marks(wolfFirst), marks(groupMove(true)), "the same marks in either order");
    assert.deepEqual(marks(wolfFirst), [
      [30, 10, 0, true],
      [30, 10, 5, true],
      [20, 10, 5, false],
    ]);
  });

  test("one damage op that hurts an enemy first and then downs the only source leaves the party seeing nothing", () => {
    const hero = token("hero", { kind: "pc", ownerIds: ["p1"], x: 14, y: 10, actor: { inline: actor({ hp: { cur: 5, max: 20, temp: 0 } }) } });
    const goblin = token("goblin", { x: 30, y: 10 });
    const s = darkRoom({ hero, goblin }, "bright");
    assert.equal(visionRules.partySight(s, "s1").tiles.size, 6);
    const after = run(
      s,
      {
        t: "actor.damageMany",
        hits: [
          { target: { tokenId: "goblin" }, amount: 3 },
          { target: { tokenId: "hero" }, amount: 10 },
        ],
      },
      1,
    );
    assert.notEqual((after.tokens.hero!.actor as { inline: { life: string } }).inline.life, "alive");
    assert.deepEqual(fresh(after), {}, "a fresh look sees nothing");
    assert.deepEqual(plain(visionRules.partySight(after, "s1").tiles), {}, "and so does the cached one");
    assert.equal(exploreOp(after), null);
    const view = projectState(after, P1, { sceneId: "s1" });
    assert.equal(view.tokens.goblin, undefined, "the goblin is out of the party's sight");
    assert.deepEqual(view.sight, {});
  });
});
