import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DROPPED_SEEK_MS, Settle } from "./settle.ts";

describe("a placed element's one check", () => {
  test("an element that started where it was put, however late, is left alone", () => {
    const s = new Settle();
    s.placed(30_000);
    assert.equal(s.check(30_000), false);
    s.placed(30_000);
    assert.equal(s.check(30_000 - DROPPED_SEEK_MS), false, "2 s short is still where it was put, within a dropped seek's margin");
  });

  test("one more than 2 s short of where it was put had its seek dropped, and seeks once", () => {
    const s = new Settle();
    s.placed(30_000);
    assert.equal(s.check(0), true);
    assert.equal(s.check(0), false, "only the first check after a placement");
  });

  test("nothing placed, nothing to put right, and a new placement checks again", () => {
    const s = new Settle();
    assert.equal(s.check(0), false);
    s.placed(10_000);
    assert.equal(s.check(10_000), false);
    s.placed(10_000);
    assert.equal(s.check(1_000), true);
  });
});
