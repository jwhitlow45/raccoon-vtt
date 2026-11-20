import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, OPENING_RECT, UPPER, thornToken, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { fellThrough } from "./follow.ts";
import { fellLine } from "./words.ts";

/*
 * The owner's polite status after a fall (docs/design/design-v1-floors.md
 * phase 4, 4.4): the device that followed Thorn to Ground floor says he
 * fell where he stands under the tower's opening (a hole in Upper floor, 2
 * by 2 at 6, 6), and that he is there after any other way.
 */

const ON = { x: OPENING_RECT.x, y: OPENING_RECT.y };

describe("the fall's polite line (phase 4, 4.4)", () => {
  test("the words", () => {
    assert.equal(fellLine("Thorn", "Ground floor"), "Thorn fell to Ground floor. Showing Ground floor.");
  });

  test("on the ground under the hole he fell, and anywhere else he only is there", () => {
    const s = withStairs(withOpening(tower()));
    assert.equal(fellThrough(s, thornToken({ ...ON })), true, "under the hole, on the ground");
    assert.equal(fellThrough(s, thornToken({ x: 7, y: 7 })), true, "anywhere inside it");
    assert.equal(fellThrough(s, thornToken({ ...ON, elevation: 5 })), false, "in the air there: a flight down");
    assert.equal(fellThrough(s, thornToken()), false, "on the stairs: a climb");
    assert.equal(fellThrough(s, thornToken({ x: 5, y: 6 })), false, "beside the hole");
    assert.equal(fellThrough(s, thornToken({ ...ON, sceneId: UPPER })), false, "on the hole's own end upstairs");
    assert.equal(fellThrough(tower(), thornToken({ ...ON, sceneId: GROUND })), false, "no opening at all");
  });
});
