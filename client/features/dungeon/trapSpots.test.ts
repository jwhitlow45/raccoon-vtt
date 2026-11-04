import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trapCount } from "./settings.ts";

describe("how many traps", () => {
  test("Traps in twelfths of the rooms: None none, Few one per six, Some one per three, Many one per two, the steps between, at least one and at most 20", () => {
    assert.equal(trapCount(0, 40), 0);
    assert.equal(trapCount(2, 2), 1);
    assert.equal(trapCount(2, 12), 2);
    assert.equal(trapCount(2, 17), 2);
    assert.equal(trapCount(2, 40), 6);
    assert.equal(trapCount(4, 2), 1);
    assert.equal(trapCount(4, 12), 4);
    assert.equal(trapCount(4, 40), 13);
    assert.equal(trapCount(6, 12), 6);
    assert.equal(trapCount(6, 40), 20);
    assert.deepEqual([1, 3, 5].map((t) => trapCount(t, 12)), [1, 3, 5]);
    assert.equal(trapCount(1, 6), 1, "at least one");
  });
});
