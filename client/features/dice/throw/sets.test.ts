import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contrast } from "../../../lib/accent.ts";
import { theme } from "../../../lib/theme.ts";
import { DEFAULT_DICE_SET, DICE_SETS, diceSet, parseDiceSet } from "./sets.ts";

/**
 * The dice sets (docs/design-v1-roll-animation.md 9.1), read unlit: lit and
 * shaded they were measured from rendered pixels, and the unlit colors are
 * what a new set is checked against before it is drawn.
 */
describe("the dice sets", () => {
  test("each set's result ink is at least 7:1 on its body, its faint numbers 1.8 to 3:1, and its edge at least 4.5:1 on the scrim", () => {
    for (const set of DICE_SETS) {
      assert.ok(contrast(set.ink, set.body) >= 7, `${set.name}: result ${contrast(set.ink, set.body).toFixed(1)}:1`);
      const faint = contrast(set.faint, set.body);
      assert.ok(faint >= 1.8 && faint <= 3, `${set.name}: faint ${faint.toFixed(1)}:1`);
      assert.ok(contrast(set.edge, theme.color.surface) >= 4.5, `${set.name}: edge ${contrast(set.edge, theme.color.surface).toFixed(1)}:1 on the scrim`);
    }
  });

  test("eight sets, Ivory first and the default, each with its own id and name", () => {
    assert.equal(DICE_SETS.length, 8);
    assert.equal(DICE_SETS[0]?.id, DEFAULT_DICE_SET);
    assert.equal(new Set(DICE_SETS.map((s) => s.id)).size, 8);
    assert.equal(new Set(DICE_SETS.map((s) => s.name)).size, 8);
    assert.equal(diceSet("ruby").name, "Ruby");
    assert.equal(diceSet("plaid").id, "ivory", "a set this version does not know is Ivory");
  });

  test("the stored choice reads as a known set's id, else Ivory", () => {
    assert.equal(parseDiceSet("gold"), "gold");
    for (const raw of [null, "", "Gold", "neon"]) assert.equal(parseDiceSet(raw), "ivory", String(raw));
  });
});
