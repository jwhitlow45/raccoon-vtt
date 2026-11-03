import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trapCount } from "./trapSpots.ts";

describe("how many traps", () => {
  test("None places none, Few one per six rooms and Some one per three, at least one, at most 12", () => {
    assert.equal(trapCount("none", 40), 0);
    assert.equal(trapCount("few", 2), 1);
    assert.equal(trapCount("few", 12), 2);
    assert.equal(trapCount("few", 17), 2);
    assert.equal(trapCount("some", 2), 1);
    assert.equal(trapCount("some", 12), 4);
    assert.equal(trapCount("some", 40), 12);
    assert.equal(trapCount("few", 40), 6);
  });
});
