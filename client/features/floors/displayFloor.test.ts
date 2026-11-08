import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayFloor } from "./displayFloor.ts";
import { heldHere } from "./follow.ts";
import { ATTIC, playerCopy, TOWER, tower, UPPER } from "./testing.ts";

/* A table display's floor (docs/design/design-v1-floors.md 7.3, D-261102-491). */

describe("the floor a table display shows", () => {
  const held = heldHere(playerCopy(tower(), [TOWER, UPPER, ATTIC]), TOWER);
  const at = (partyFloors: string[], last: string | null, dm: string | null = null) => displayFloor({ held, partyFloors, last, start: TOWER, dm });

  test("the party's floor, the one shown last while it is one of them, else the lowest of them, else the start floor", () => {
    assert.equal(at([ATTIC], TOWER), ATTIC);
    assert.equal(at([UPPER, ATTIC], ATTIC), ATTIC, "a tie keeps the floor shown, so the screen never flips");
    assert.equal(at([ATTIC, UPPER], TOWER), UPPER, "else the lowest");
    assert.equal(at([], ATTIC), TOWER, "none: the start floor");
    assert.equal(at(["gone"], ATTIC), TOWER, "a floor not held counts for nothing");
  });

  test("following the DM, the DM's floor while the display holds it", () => {
    assert.equal(at([ATTIC], ATTIC, UPPER), UPPER);
    assert.equal(at([ATTIC], ATTIC, "elsewhere"), ATTIC, "a floor it does not hold leaves the party's");
  });

  test("a display holding one floor shows it", () => {
    const one = heldHere(playerCopy(tower(), [TOWER]), TOWER);
    assert.equal(displayFloor({ held: one, partyFloors: [], last: null, start: TOWER, dm: null }), TOWER);
    assert.equal(displayFloor({ held: [], partyFloors: [], last: null, start: null, dm: null }), null, "behind a blackout, none");
  });
});
