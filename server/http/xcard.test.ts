import assert from "node:assert/strict";
import { test } from "node:test";
import { XCardLimits } from "./xcard.ts";

test("taps within 10 s of a shown card merge into it, and a later tap shows a new one", () => {
  let now = 1_000_000;
  const limits = new XCardLimits(() => now);
  assert.equal(limits.show("room"), true);
  now += 9_999;
  assert.equal(limits.show("room"), false);
  assert.equal(limits.show("other"), true, "rooms merge apart");
  now += 1;
  assert.equal(limits.show("room"), true);
});

test("one session taps at most 6 times in a sliding hour", () => {
  let now = 0;
  const limits = new XCardLimits(() => now);
  for (let i = 0; i < 6; i++) {
    assert.equal(limits.tap("s"), true);
    now += 60_000;
  }
  assert.equal(limits.tap("s"), false);
  assert.equal(limits.tap("t"), true, "another session has its own hour");
  // The first tap leaves the hour 3,600,000 ms after it was made.
  now = 3_600_000;
  assert.equal(limits.tap("s"), true);
  assert.equal(limits.tap("s"), false);
});
