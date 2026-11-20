import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, applied, onThornsTurn, thornToken, tower } from "../floorLinksTestutil.ts";
import type { Token } from "../model.ts";
import { DM, token } from "../testutil.ts";

/*
 * A creature a move carries outside its turn keeps the path it had from
 * change format 64 (D-261119-016), so a player's move writes nothing of a
 * hidden passenger's but its pose. Ops stored before 64 dropped it, and
 * replay so. A fall's and a trapdoor's landings keep it too
 * (reducer/falls.test.ts).
 */

function move(tokenId: string, x: number, y: number) {
  return { t: "token.move" as const, tokenId, x, y };
}

describe("a creature a move carries outside its turn keeps its old path from 64 (D-261119-016)", () => {
  test("a goblin Thorn drags on Thorn's turn keeps its path from an earlier turn at 64 and loses it at 63", () => {
    const old = { turn: 1, stops: [{ x: 0, y: 0, elevation: 0 }] } as unknown as Token["path"];
    const state = onThornsTurn(tower({ tokens: { thorn: thornToken({ x: 3, y: 3 }), goblin: token("goblin", { x: 2, y: 3, path: old, attached: { to: "thorn", kind: "drag" } }) } }));
    const at64 = applied(state, move("thorn", 5, 3), ANA);
    assert.equal(at64.state.tokens.goblin!.x, 4);
    assert.deepEqual(at64.state.tokens.goblin!.path, old);
    const at63 = applied(state, move("thorn", 5, 3), ANA, 63);
    assert.equal(at63.state.tokens.goblin!.x, 4);
    assert.equal(at63.state.tokens.goblin!.path, undefined);
  });
});

describe("a creature a walk takes out and back to where it started keeps its old path from 64 (D-261119-016)", () => {
  // A Large horse on Ground floor with a goblin it drags beside it and an imp riding it, each with a path from an earlier turn.
  const old = { turn: 1, stops: [{ x: 0, y: 0, elevation: 0 }] } as unknown as Token["path"];
  const stable = (fight: boolean) => {
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", sceneId: GROUND, x: 10, y: 10 });
    const goblin = token("goblin", { sceneId: GROUND, x: 12, y: 10, path: old, attached: { to: "horse", kind: "drag" } });
    const imp = token("imp", { name: "Imp", size: "tiny", sceneId: GROUND, x: 10.5, y: 10.5, path: old, attached: { to: "horse", kind: "ride" } });
    const state = tower({ tokens: { thorn: thornToken(), horse, goblin, imp } });
    return fight ? onThornsTurn(state) : state;
  };
  // The DM walks the horse east and back to where it stood, so both walks leave their start and end on it.
  const loop = { t: "token.move" as const, tokenId: "horse", x: 10, y: 10, route: [[14, 10, 1, 0], [10, 10, 1, 0]] as [number, number, number, 0][] };

  for (const fight of [true, false]) {
    test(`${fight ? "on Thorn's turn" : "with no fight"}, the goblin and the imp keep their paths at 64, lose them at 63, and are not written at 62`, () => {
      const state = stable(fight);
      const at64 = applied(state, loop, DM).state;
      const at63 = applied(state, loop, DM, 63).state;
      const at62 = applied(state, loop, DM, 62).state;
      for (const id of ["goblin", "imp"]) {
        const was = state.tokens[id]!;
        for (const s of [at64, at63, at62]) assert.deepEqual([s.tokens[id]!.x, s.tokens[id]!.y], [was.x, was.y], `${id} ends where it started`);
        assert.deepEqual(at64.tokens[id]!.path, old, `${id} keeps its path at 64`);
        assert.equal(at63.tokens[id]!.path, undefined, `${id} loses its path at 63, as that version's walk out and back wrote it`);
        assert.equal(at62.tokens[id], state.tokens[id], `${id} is not written at 62`);
      }
    });
  }
});

