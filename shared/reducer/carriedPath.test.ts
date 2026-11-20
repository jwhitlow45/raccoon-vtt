import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, applied, onThornsTurn, thornToken, tower } from "../floorLinksTestutil.ts";
import type { Token } from "../model.ts";
import { token } from "../testutil.ts";

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
