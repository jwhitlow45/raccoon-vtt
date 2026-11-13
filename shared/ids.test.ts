import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { idTime, isUuidv7, uuidv7 } from "./ids.ts";

test("a version 7 id gives back the time it was made at, to the millisecond", () => {
  for (const at of [0, 1, 1_700_000_000_123, 2 ** 48 - 1]) assert.equal(idTime(uuidv7(at)), at);
});

test("an id of another version, or not an id, has no time", () => {
  assert.equal(isUuidv7(randomUUID()), false);
  assert.equal(idTime(randomUUID()), null);
  assert.equal(idTime("g1"), null);
  // A version nibble of 7 with the wrong variant is not one either.
  assert.equal(idTime("0192f0a8-6c1e-7a4b-1c3d-000000000001"), null);
  assert.equal(isUuidv7(uuidv7().toUpperCase()), true);
});
