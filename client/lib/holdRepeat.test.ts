import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeClock } from "../state/testing.ts";
import { HoldRepeat, REPEAT_DELAY_MS, REPEAT_EVERY_MS } from "./holdRepeat.ts";

/** A stepper from `start` in 5 ft steps up to `max`, counting its steps, on a fake clock. */
function stepper(start: number, max: number) {
  const clock = new FakeClock();
  const held: boolean[] = [];
  const s = { value: start, steps: 0, clock, held, repeat: null as unknown as HoldRepeat };
  s.repeat = new HoldRepeat({
    step: () => {
      s.steps++;
      s.value = Math.min(max, s.value + 5);
      return s.value < max;
    },
    onHold: (h) => held.push(h),
    timers: clock,
  });
  return s;
}

describe("a button that repeats while held", () => {
  test("a press steps once, and the click that ends it adds none", () => {
    const s = stepper(10, 100);
    s.repeat.press();
    s.clock.advance(100);
    s.repeat.release();
    s.repeat.click(false);
    assert.equal(s.value, 15);
    assert.equal(s.clock.pendingTimers, 0);
  });

  test("a second step comes only 400 ms into the hold, then one every 80 ms", () => {
    const s = stepper(10, 100);
    s.repeat.press();
    s.clock.advance(REPEAT_DELAY_MS - 1);
    assert.equal(s.value, 15);
    s.clock.advance(1);
    assert.equal(s.value, 20);
    s.clock.advance(REPEAT_EVERY_MS - 1);
    assert.equal(s.value, 20);
    s.clock.advance(1);
    assert.equal(s.value, 25);
  });

  test("a 1.68 s hold takes 10 ft to 100 ft, and the repeat stops there while still held", () => {
    const s = stepper(10, 100);
    s.repeat.press();
    s.clock.advance(1_680);
    assert.equal(s.value, 100);
    assert.equal(s.repeat.repeating, false);
    assert.equal(s.clock.pendingTimers, 0);
    const steps = s.steps;
    s.clock.advance(5_000);
    assert.equal(s.steps, steps, "no step past the top");
  });

  test("lifting stops the repeat, and a tap after a hold steps once", () => {
    const s = stepper(10, 100);
    s.repeat.press();
    s.clock.advance(REPEAT_DELAY_MS);
    s.repeat.release();
    s.repeat.click(false);
    assert.equal(s.value, 20);
    s.clock.advance(5_000);
    assert.equal(s.value, 20);
    s.repeat.press();
    s.repeat.release();
    s.repeat.click(false);
    assert.equal(s.value, 25);
  });

  test("a keyboard click steps every time, so Enter's key repeat repeats it", () => {
    const s = stepper(10, 100);
    s.repeat.click(true);
    s.repeat.click(true);
    s.repeat.click(true);
    assert.equal(s.value, 25);
    // Even straight after a press, whose own click was not dropped yet.
    s.repeat.press();
    s.repeat.release();
    s.repeat.click(true);
    assert.equal(s.value, 35);
  });

  test("a press says when it starts and ends, so the value is spoken once at the end", () => {
    const s = stepper(10, 100);
    s.repeat.press();
    s.clock.advance(1_000);
    s.repeat.release();
    s.repeat.release();
    assert.deepEqual(s.held, [true, false]);
  });
});
