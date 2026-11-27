import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DM } from "#shared/testutil.ts";
import { resetAllFeatures, setModuleShown } from "../modules/store.ts";
import { indexOf, PAT_VIEW, seededRoom, viewOf } from "../search/search.testutil.ts";

/*
 * A character's slot fields in the room search while their parts hide on
 * this device (docs/design/design-v1-features.md 3, docs/design/design-v1-slots.md 4):
 * Spell slots and Hit Point Dice each take their own result, and Classes,
 * a line both count for, leaves only once both hide.
 */

const FIELDS = ["spell-slots", "hit-dice", "classes"] as const;

/** Which of Bree's slot fields Pat's index holds, Pat playing her. */
function patFinds(): string[] {
  const index = indexOf(PAT_VIEW());
  return FIELDS.filter((f) => index.byId.has(`field:character:bree:${f}`));
}

afterEach(() => resetAllFeatures());

describe("a character's slot fields in the search", () => {
  test("every one while both parts show", () => {
    assert.deepEqual(patFinds(), ["spell-slots", "hit-dice", "classes"]);
  });

  test("Spell slots hidden takes its result, and Classes stays", () => {
    setModuleShown("spellSlots", "player", false);
    assert.deepEqual(patFinds(), ["hit-dice", "classes"]);
  });

  test("Hit Point Dice hidden takes its result, and Classes stays", () => {
    setModuleShown("hitDice", "player", false);
    assert.deepEqual(patFinds(), ["spell-slots", "classes"]);
  });

  test("both hidden take Classes too", () => {
    setModuleShown("spellSlots", "player", false);
    setModuleShown("hitDice", "player", false);
    assert.deepEqual(patFinds(), []);
  });

  test("a role's choices are that role's alone", () => {
    setModuleShown("spellSlots", "dm", false);
    setModuleShown("hitDice", "dm", false);
    assert.deepEqual(patFinds(), ["spell-slots", "hit-dice", "classes"], "the DM's choices leave Pat's results");
    const dm = indexOf(viewOf(seededRoom(), DM));
    assert.ok(!dm.byId.has("field:character:bree:spell-slots") && !dm.byId.has("field:character:bree:hit-dice"), "the DM's own leave");
  });
});
