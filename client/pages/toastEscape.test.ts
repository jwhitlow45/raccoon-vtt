import assert from "node:assert/strict";
import { test } from "node:test";
import { toastEscape } from "./toastEscape.ts";

for (const order of ["toast first", "popover first"]) {
  test(`Escape closes the focused popover and leaves the toast expanded: ${order}`, () => {
    const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    let expanded = true;
    let open = true;
    const focused = { closest: (selector: string) => selector === "[data-rvtt-popover]" && open ? {} as Element : null };
    const toast = () => toastEscape(event, focused, () => { expanded = false; });
    const popover = () => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      open = false;
    };
    for (const handler of order === "toast first" ? [toast, popover] : [popover, toast]) handler();
    assert.equal(open, false);
    assert.equal(expanded, true);
    assert.equal(event.defaultPrevented, true);
  });
}

test("Escape without a focused popover shrinks the toast and consumes the key", () => {
  for (const focused of [null, { closest: () => null }]) {
    const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    let shrinks = 0;
    toastEscape(event, focused, () => shrinks++);
    assert.equal(shrinks, 1);
    assert.equal(event.defaultPrevented, true);
  }
});

test("other keys and a consumed Escape leave the toast alone", () => {
  for (const event of [{ key: "Enter", defaultPrevented: false }, { key: "Escape", defaultPrevented: true }]) {
    toastEscape({ ...event, preventDefault() { assert.fail("unused key consumed"); } }, null, () => assert.fail("toast shrank"));
  }
});
