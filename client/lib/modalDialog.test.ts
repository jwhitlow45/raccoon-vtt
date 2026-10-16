import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applySheetDialogSteps, closeLedger, openingFocus, sheetDialogSteps, sheetFocusAfter, stopIndex, tabStops, wrapFocusIndex, type DialogLike } from "./modalDialog.ts";

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

describe("focus as a modal dialog opens", () => {
  const inside = new Set(["title field"]);
  const inDialog = (el: string) => inside.has(el);

  test("a field focused by autoFocus during the commit keeps focus, and focus goes back to the control that had it before", () => {
    assert.deepEqual(openingFocus(null, "title field", inDialog, "New page button"), { opener: "New page button", first: "title field" });
  });

  test("with nothing focused inside, the dialog takes focus and gives it back to what had it as it opened", () => {
    assert.deepEqual(openingFocus(null, "Filters button", inDialog, "Filters button"), { opener: "Filters button", first: null });
    assert.deepEqual(openingFocus(null, null, inDialog, null), { opener: null, first: null });
  });

  test("a second run of the effect, as StrictMode makes in development, keeps the autofocused field after the cleanup gave focus back", () => {
    const first = openingFocus(null, "title field", inDialog, "New page button");
    // The cleanup between the two runs closed the dialog and focused the opener.
    assert.deepEqual(openingFocus(first, "New page button", inDialog, "New page button"), { opener: "New page button", first: "title field" });
  });

  test("a field that left the dialog since is passed over, and the dialog takes focus", () => {
    const first = openingFocus(null, "stat block field", (el) => el === "stat block field", "Paste button");
    assert.deepEqual(openingFocus(first, "Paste button", inDialog, "Paste button"), { opener: "Paste button", first: null });
  });
});

describe("a sheet's one dialog (useSheetDialog)", () => {
  /** A dialog that records what was done to it, as the browser's would stand. */
  function fakeDialog() {
    const calls: string[] = [];
    const attrs = new Map<string, string>();
    const el: DialogLike & { calls: string[]; attrs: Map<string, string> } = {
      open: false,
      calls,
      attrs,
      show() {
        calls.push("show");
        el.open = true;
      },
      showModal() {
        calls.push("showModal");
        el.open = true;
      },
      close() {
        calls.push("close");
        el.open = false;
      },
      setAttribute: (name, value) => void attrs.set(name, value),
      removeAttribute: (name) => void attrs.delete(name),
    };
    return el;
  }

  test("the steps from how it stands to how the sheet asks", () => {
    assert.deepEqual(sheetDialogSteps("closed", { shown: true, modal: false }), ["show"]);
    assert.deepEqual(sheetDialogSteps("closed", { shown: true, modal: true }), ["showModal"]);
    assert.deepEqual(sheetDialogSteps("shown", { shown: false, modal: false }), ["close"]);
    assert.deepEqual(sheetDialogSteps("modal", { shown: false, modal: true }), ["close"]);
    assert.deepEqual(sheetDialogSteps("shown", { shown: true, modal: true }), ["close", "showModal"], "a change of mode closes first");
    assert.deepEqual(sheetDialogSteps("modal", { shown: true, modal: false }), ["close", "show"]);
    assert.deepEqual(sheetDialogSteps("closed", { shown: false, modal: true }), [], "hidden, a change of mode only changes how it will open");
    assert.deepEqual(sheetDialogSteps("modal", { shown: true, modal: true }), []);
  });

  test("open as show(), and as showModal() with aria-modal", () => {
    const plain = fakeDialog();
    applySheetDialogSteps(plain, ["show"], closeLedger());
    assert.deepEqual(plain.calls, ["show"]);
    assert.equal(plain.attrs.has("aria-modal"), false);
    const modal = fakeDialog();
    applySheetDialogSteps(modal, ["showModal"], closeLedger());
    assert.deepEqual(modal.calls, ["showModal"]);
    assert.equal(modal.attrs.get("aria-modal"), "true");
  });

  test("close with aria-modal removed, and a switch of mode as close() then the other open", () => {
    const el = fakeDialog();
    const ledger = closeLedger();
    applySheetDialogSteps(el, ["showModal"], ledger);
    applySheetDialogSteps(el, ["close", "show"], ledger);
    assert.deepEqual(el.calls, ["showModal", "close", "show"]);
    assert.equal(el.attrs.has("aria-modal"), false, "a plain sheet is no modal");
    applySheetDialogSteps(el, ["close", "showModal"], ledger);
    assert.equal(el.attrs.get("aria-modal"), "true");
    applySheetDialogSteps(el, ["close"], ledger);
    assert.equal(el.open, false);
    assert.equal(el.attrs.has("aria-modal"), false, "Hide drops the marker");
  });

  test("its own closes (Hide, a switch, Close) are heard as its own, and a close it did not ask for is the viewer's", () => {
    const el = fakeDialog();
    const ledger = closeLedger();
    applySheetDialogSteps(el, ["showModal"], ledger);
    applySheetDialogSteps(el, ["close", "show"], ledger);
    applySheetDialogSteps(el, ["close"], ledger);
    // Each close event arrives a task later.
    assert.equal(ledger.heard(), "own");
    assert.equal(ledger.heard(), "own");
    assert.equal(ledger.heard(), "viewer", "Escape repeated with no tap between closed it: onCancel closes the panel");
  });

  test("a close step on a dialog already closed calls nothing and owes no event", () => {
    const el = fakeDialog();
    const ledger = closeLedger();
    applySheetDialogSteps(el, ["close"], ledger);
    assert.deepEqual(el.calls, []);
    assert.equal(ledger.heard(), "viewer");
  });

  test("focus after show() returns to the element noted before, and a request made after it still wins", () => {
    assert.equal(sheetFocusAfter({ steps: ["show"], before: "outside", hiding: false }), "before", "a turn strip's tap keeps focus on the strip");
    assert.equal(sheetFocusAfter({ steps: ["show"], before: "page", hiding: false }), "page", "nothing had focus: the browser's pick is taken back");
    assert.equal(sheetFocusAfter({ steps: ["showModal"], before: "outside", hiding: false }), null, "modal: focus stays inside where the browser put it");
  });

  test("a switch of mode keeps focus on its element inside the sheet", () => {
    assert.equal(sheetFocusAfter({ steps: ["close", "showModal"], before: "inside", hiding: false }), "before");
    assert.equal(sheetFocusAfter({ steps: ["close", "show"], before: "inside", hiding: false }), "before");
    assert.equal(sheetFocusAfter({ steps: ["close", "showModal"], before: "outside", hiding: false }), null);
  });

  test("closing holds focus: Hide moves it to Panels, and focus elsewhere stays", () => {
    assert.equal(sheetFocusAfter({ steps: ["close"], before: "inside", hiding: true }), "hide");
    assert.equal(sheetFocusAfter({ steps: ["close"], before: "page", hiding: true }), "hide", "a tap that focused nothing, as in Safari");
    assert.equal(sheetFocusAfter({ steps: ["close"], before: "outside", hiding: true }), "before");
    assert.equal(sheetFocusAfter({ steps: [], before: "inside", hiding: false }), null);
  });
});
