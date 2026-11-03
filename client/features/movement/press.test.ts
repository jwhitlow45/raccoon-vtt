import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { pressPlan } from "./press.ts";
import { thorn, world } from "./testing.ts";

/* An arrow key's step keeps each token's placement between squares, alone or in a group (docs/design/design-v1-snap-off.md 6.5). */

const placed = (over: Partial<Token>, nudge: { x: number; y: number }): Token => ({ ...thorn(over), nudge });

describe("an arrow step of tokens placed between squares", () => {
  test("a lone token steps a square and stays drawn as it was in its new box", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 2, y: -1 });
    const view = world({ tokens: [hero] });
    const plan = pressPlan(view, hero, { x: 4, y: 3 }, [hero], "player", WorkBudget.all());
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y, m.drawnAt]), [["thorn", 4, 3, { x: 4.25, y: 2.875 }]]);
  });

  test("a group's every token keeps its own placement", () => {
    const a = placed({ x: 3, y: 3 }, { x: 2, y: -1 });
    const b = placed({ id: "bree", x: 6, y: 3 }, { x: -3, y: 3 });
    const c = thorn({ id: "cade", x: 9, y: 3 });
    const view = world({ tokens: [a, b, c] });
    const plan = pressPlan(view, a, { x: 3, y: 4 }, [a, b, c], "player", WorkBudget.all());
    assert.deepEqual(
      plan.moves.map((m) => [m.tokenId, m.x, m.y, m.drawnAt]),
      [
        ["thorn", 3, 4, { x: 3.25, y: 3.875 }],
        ["bree", 6, 4, { x: 5.625, y: 4.375 }],
        ["cade", 9, 4, undefined],
      ],
    );
  });
});
