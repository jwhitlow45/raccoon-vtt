import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { settleFollowers } from "./dropSettle.ts";

/*
 * Live play 40 (LP40-HEXFILE-2): after a drop the board drew a dragged
 * goblin at its holder's offset, and where the server's walk left it where
 * it stood, nothing redrew it until a reload.
 */

/** A node that records where it is put and how often its layer draws. */
function node(x: number, y: number) {
  const draws = { n: 0 };
  const at = { x, y };
  return {
    at,
    draws,
    position(p: { x: number; y: number }) {
      at.x = p.x;
      at.y = p.y;
    },
    getLayer: () => ({ batchDraw: () => void draws.n++ }),
  };
}

describe("a drop's followers settle on this copy's places once its answer lands (LP40-HEXFILE-2)", () => {
  test("each node goes where the copy holds its token, though that place never changed, and one the copy no longer holds stays", () => {
    const goblin = node(8, 5);
    const grik = node(7, 5);
    const gone = node(3, 3);
    const places: Record<string, { x: number; y: number }> = { goblin: { x: 10, y: 5 }, grik: { x: 9, y: 5 } };
    settleFollowers(
      [
        { id: "goblin", node: goblin },
        { id: "grik", node: grik },
        { id: "gone", node: gone },
      ],
      (id) => places[id] ?? null,
    );
    assert.deepEqual([goblin.at, grik.at, gone.at], [{ x: 10, y: 5 }, { x: 9, y: 5 }, { x: 3, y: 3 }]);
    assert.deepEqual([goblin.draws.n, grik.draws.n, gone.draws.n], [1, 1, 0], "each moved node's layer draws");
  });
});
