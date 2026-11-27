import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The Select tool's hold to ping (docs/design/design-v1-features.md 8,
 * D-261127-309): Ping and laser hidden on this device turns the hold off,
 * and a hold under way as it hides sends no ping, whether its time comes up
 * after the switch or the switch drops it first.
 */

const { listenHoldToPing } = await import("./PingController.ts");
const { LONG_PRESS_MS } = await import("../../lib/gestures.ts");

type Listener = (e: Partial<PointerEvent>) => void;

/** A stage's container and window that a test presses on, and timers it runs by hand. */
function page(opts: { enabled: () => boolean }) {
  const on = new Map<string, Listener>();
  const target = {
    addEventListener: (type: string, l: Listener) => void on.set(type, l),
    removeEventListener: (type: string) => void on.delete(type),
  };
  const timers = new Map<number, () => void>();
  let next = 1;
  const pings: { x: number; y: number }[] = [];
  const hold = listenHoldToPing(
    {
      el: { ...target, getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect } as never,
      win: target as never,
      onToken: () => false,
    },
    {
      enabled: opts.enabled,
      at: (p) => p,
      ping: (x, y) => void pings.push({ x, y }),
      closing: () => false,
      setTimer: (run, ms) => {
        assert.equal(ms, LONG_PRESS_MS);
        const id = next++;
        timers.set(id, run);
        return id as never;
      },
      clearTimer: (id) => void timers.delete(id as never),
    },
  );
  return {
    press: () => on.get("pointerdown")?.({ pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 20 }),
    timeUp: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    pending: () => timers.size,
    pings,
    hold,
  };
}

describe("hold to ping", () => {
  test("a press held still pings where it is", () => {
    const p = page({ enabled: () => true });
    p.press();
    p.timeUp();
    assert.deepEqual(p.pings, [{ x: 10, y: 20 }]);
  });

  test("off at the press, the hold starts nothing", () => {
    const p = page({ enabled: () => false });
    p.press();
    assert.equal(p.pending(), 0);
    p.timeUp();
    assert.deepEqual(p.pings, []);
  });

  test("turned off while the hold runs, its time coming up sends no ping", () => {
    let enabled = true;
    const p = page({ enabled: () => enabled });
    p.press();
    enabled = false;
    p.timeUp();
    assert.deepEqual(p.pings, [], "the timer reads the switch again before it sends");
  });

  test("turning the hold off drops a hold under way", () => {
    const p = page({ enabled: () => true });
    p.press();
    assert.equal(p.pending(), 1);
    p.hold.cancel();
    assert.equal(p.pending(), 0, "the pending timer is cleared");
    p.timeUp();
    assert.deepEqual(p.pings, []);
  });
});
