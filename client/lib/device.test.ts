import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

/*
 * A fresh copy of the module per test file, since the first key pressed
 * on a page is remembered for good, and the pointer stubbed as a touch
 * screen's: no fine pointer anywhere.
 */
type Device = typeof import("./device.ts");
const g = globalThis as { matchMedia?: unknown };
const before = g.matchMedia;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
after(() => {
  g.matchMedia = before;
});
const device = (await import(new URL("./device.ts?keyboard", import.meta.url).href)) as Device;

describe("a keyboard found by its first key (lib/device.ts)", () => {
  test("a touch screen has no keyboard until a key comes, and its listeners hear that key once", () => {
    let heard = 0;
    const stop = device.subscribeKeyboard(() => heard++);
    assert.equal(device.hasKeyboard(), false, "a touch screen, no key yet");
    for (const key of ["", "Unidentified", "Process"]) device.noteKeyboard(key);
    assert.deepEqual([device.hasKeyboard(), heard], [false, 0], "an on-screen keyboard's presses say nothing");
    device.noteKeyboard("Shift");
    assert.deepEqual([device.hasKeyboard(), heard], [true, 1], "the first real key");
    device.noteKeyboard("a");
    assert.equal(heard, 1, "only the change is told");
    stop();
  });
});
