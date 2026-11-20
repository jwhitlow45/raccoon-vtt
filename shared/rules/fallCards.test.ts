import assert from "node:assert/strict";
import { test } from "node:test";
import { byFallAge, fallPlace } from "./fallCards.ts";

test("a card's place is the part of its id after the seq, and cards go oldest first by op, then by place (FLR4-OPUS-4)", () => {
  assert.deepEqual(["120:0", "120:12", "9:3"].map(fallPlace), [0, 12, 3]);
  const cards = [{ id: "130:1", made: 130 }, { id: "9:0", made: 9 }, { id: "130:0", made: 130 }, { id: "130:10", made: 130 }];
  assert.deepEqual([...cards].sort(byFallAge).map((c) => c.id), ["9:0", "130:0", "130:1", "130:10"]);
});
