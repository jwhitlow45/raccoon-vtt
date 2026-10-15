import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stopIndex, tabStops, wrapFocusIndex } from "./modalDialog.ts";

describe("focus wrapping in a modal dialog", () => {
  test("Tab from the last control goes to the first", () => {
    assert.equal(wrapFocusIndex(5, 4, false), 0);
  });

  test("Shift+Tab from the first control, or from the dialog itself, goes to the last", () => {
    assert.equal(wrapFocusIndex(5, 0, true), 4);
    assert.equal(wrapFocusIndex(5, -1, true), 4);
  });

  test("Tab from the dialog itself goes to the first control", () => {
    assert.equal(wrapFocusIndex(5, -1, false), 0);
  });

  test("between the ends the browser moves focus as usual", () => {
    assert.equal(wrapFocusIndex(5, 2, false), null);
    assert.equal(wrapFocusIndex(5, 2, true), null);
    assert.equal(wrapFocusIndex(5, 0, false), null);
    assert.equal(wrapFocusIndex(5, 4, true), null);
  });

  test("a dialog with one control keeps focus on it", () => {
    assert.equal(wrapFocusIndex(1, 0, false), 0);
    assert.equal(wrapFocusIndex(1, 0, true), 0);
  });

  test("a dialog without controls leaves Tab alone", () => {
    assert.equal(wrapFocusIndex(0, -1, false), null);
  });
});

describe("Tab stops with a group of native radios", () => {
  type Control = { id: string; radio?: { name: string; checked: boolean } };
  const radio = (c: Control) => c.radio ?? null;
  const close: Control = { id: "close" };
  const save: Control = { id: "save" };
  function group(checked: number | null): Control[] {
    return ["a", "b", "c"].map((id, i) => ({ id, radio: { name: "ability", checked: i === checked } }));
  }
  /** Where Tab or Shift+Tab from a control lands, when the dialog wraps it; null leaves it to the browser. */
  function wrapFrom(controls: Control[], from: Control, shift: boolean): string | null {
    const stops = tabStops(controls, radio);
    const next = wrapFocusIndex(stops.length, stopIndex(stops, from, radio), shift);
    return next === null ? null : stops[next]!.id;
  }

  for (const [checked, id] of [[0, "a"], [1, "b"], [2, "c"]] as const) {
    test(`a group last with no footer, option ${id} checked: one stop, wrapping both ways`, () => {
      const radios = group(checked);
      const controls = [close, ...radios];
      assert.deepEqual(tabStops(controls, radio).map((c) => c.id), ["close", id]);
      assert.equal(wrapFrom(controls, close, true), id, "Shift+Tab from Close goes to the checked option");
      assert.equal(wrapFrom(controls, radios[checked]!, false), "close", "Tab from the checked option wraps to Close");
      assert.equal(wrapFrom(controls, radios[checked]!, true), null, "Shift+Tab from it is the browser's, back to Close");
    });

    test(`a group in the middle, option ${id} checked: the browser moves past it, and the ends still wrap`, () => {
      const radios = group(checked);
      const controls = [close, ...radios, save];
      assert.equal(wrapFrom(controls, radios[checked]!, false), null);
      assert.equal(wrapFrom(controls, save, false), "close");
      assert.equal(wrapFrom(controls, close, true), "save");
    });
  }

  test("with nothing checked the group's stop is its first option", () => {
    assert.deepEqual(tabStops([close, ...group(null)], radio).map((c) => c.id), ["close", "a"]);
  });

  test("a focused option that is not checked counts as its group's stop", () => {
    const radios = group(0);
    const stops = tabStops([close, ...radios], radio);
    assert.equal(stopIndex(stops, radios[2]!, radio), 1);
    assert.equal(stopIndex(stops, null, radio), -1);
  });
});
