import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HoldRepeat } from "../../../lib/holdRepeat.ts";
import { FakeClock } from "../../../state/testing.ts";
import { RoomScope } from "../../../state/scope.ts";
import { HEIGHT_MAX_FT, HEIGHT_MIN_FT, heightSlot, stepHeight } from "./store.ts";

describe("the height stepper", () => {
  test("steps 5 ft at a time from 20 ft down to 100 ft up, and says when it is at either end", () => {
    const store = new RoomScope().get(heightSlot).store;
    assert.deepEqual([HEIGHT_MIN_FT, HEIGHT_MAX_FT], [-20, 100]);
    store.setState({ height: 90 });
    assert.equal(stepHeight(store, 5), true);
    assert.equal(stepHeight(store, 5), false, "at the top");
    assert.equal(store.getState().height, 100);
    assert.equal(stepHeight(store, 5), false);
    assert.equal(store.getState().height, 100);
    store.setState({ height: -15 });
    assert.equal(stepHeight(store, -5), false, "at the bottom");
    assert.equal(stepHeight(store, -5), false);
    assert.equal(store.getState().height, -20);
    assert.equal(stepHeight(store, 5), true);
  });

  test("a held + reads the store on every step, so a change from elsewhere carries on from there", () => {
    const store = new RoomScope().get(heightSlot).store;
    const clock = new FakeClock();
    const plus = new HoldRepeat({ step: () => stepHeight(store, 5), timers: clock });
    plus.press();
    assert.equal(store.getState().height, 15);
    store.setState({ height: 80 });
    clock.advance(400);
    assert.equal(store.getState().height, 85);
    clock.advance(10_000);
    assert.equal(store.getState().height, 100);
    assert.equal(clock.pendingTimers, 0, "the repeat stopped at the top while still held");
  });
});
