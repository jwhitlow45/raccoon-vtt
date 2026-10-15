import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../state/scope.ts";
import {
  alertsSummaryEntry,
  dockSummaryButton,
  publishAlertsSummary,
  registerSheetReturnFocus,
  RETURN_RANK,
  returnFocusAfterSheet,
  SheetFocusRegistry,
  sheetFocusSlot,
  sheetReturnTarget,
} from "./sheetFocus.ts";

/** Enough of an element for the registry: whether it is on the page and drawn, whether it sits under `hidden`, and a focus that may not take. */
function fakeElement(name: string, options: { connected?: boolean; drawn?: boolean; folded?: boolean; refuses?: boolean } = {}) {
  const doc = { activeElement: null as unknown };
  const el = {
    name,
    isConnected: options.connected ?? true,
    ownerDocument: doc,
    focused: 0,
    getClientRects: () => ({ length: options.drawn === false ? 0 : 1 }),
    closest: (selector: string) => (selector === "[hidden]" && options.folded ? {} : null),
    focus() {
      el.focused++;
      if (!options.refuses) doc.activeElement = el;
    },
  };
  return el;
}

function ref(el: ReturnType<typeof fakeElement> | null) {
  return { current: el as unknown as HTMLElement | null };
}

describe("where focus goes when a sheet closes", () => {
  test("nothing registered leaves focus to the room", () => {
    const r = new SheetFocusRegistry();
    assert.equal(sheetReturnTarget(r), null);
    assert.equal(returnFocusAfterSheet(r), false);
  });

  test("a roll card the sheet was hiding outranks the token bar, whatever registered first", () => {
    const r = new SheetFocusRegistry();
    const card = fakeElement("card");
    const bar = fakeElement("bar");
    const offBar = registerSheetReturnFocus(r, ref(bar), RETURN_RANK.tokenBar);
    const offCard = registerSheetReturnFocus(r, ref(card), RETURN_RANK.rollCard);
    assert.equal(sheetReturnTarget(r), card as unknown as HTMLElement);
    assert.equal(returnFocusAfterSheet(r), true);
    assert.equal(card.focused, 1);
    assert.equal(bar.focused, 0);
    offCard();
    assert.equal(sheetReturnTarget(r), bar as unknown as HTMLElement, "once the card goes, the bar is next");
    offBar();
    assert.equal(sheetReturnTarget(r), null);
  });

  test("an element that is not on the page, not yet rendered, not drawn or folded under hidden is passed over", () => {
    const r = new SheetFocusRegistry();
    const off = [
      registerSheetReturnFocus(r, ref(fakeElement("gone", { connected: false })), RETURN_RANK.rollCard),
      registerSheetReturnFocus(r, ref(null), RETURN_RANK.rollCard),
      registerSheetReturnFocus(r, ref(fakeElement("undrawn", { drawn: false })), RETURN_RANK.rollCard),
      registerSheetReturnFocus(r, ref(fakeElement("folded", { folded: true })), RETURN_RANK.rollCard),
    ];
    const bar = fakeElement("bar");
    off.push(registerSheetReturnFocus(r, ref(bar), RETURN_RANK.tokenBar));
    assert.equal(sheetReturnTarget(r), bar as unknown as HTMLElement);
    for (const f of off) f();
  });
});

test("focus that does not land on the target reports false, so Room places focus itself", () => {
  const r = new SheetFocusRegistry();
  const stubborn = fakeElement("stubborn", { refuses: true });
  const off = registerSheetReturnFocus(r, ref(stubborn), RETURN_RANK.tokenBar);
  assert.equal(returnFocusAfterSheet(r), false);
  assert.equal(stubborn.focused, 1);
  off();
});

describe("the alerts summary slot", () => {
  test("empty until something publishes, and empty again once it withdraws", () => {
    const r = new SheetFocusRegistry();
    assert.equal(alertsSummaryEntry(r), null);
    let opened = 0;
    const withdraw = publishAlertsSummary(r, { text: "Roll asked", name: "the DM asks for a Wisdom check", waiting: true, open: () => opened++ });
    const entry = alertsSummaryEntry(r);
    assert.equal(entry?.text, "Roll asked");
    assert.equal(entry?.waiting, true);
    entry?.open();
    assert.equal(opened, 1);
    withdraw();
    assert.equal(alertsSummaryEntry(r), null);
  });

  test("the entry published last shows, and withdrawing it brings back the one before", () => {
    const r = new SheetFocusRegistry();
    const first = publishAlertsSummary(r, { text: "Rolls 1/3", name: "rolls 1 of 3 answered", waiting: false, open() {} });
    const second = publishAlertsSummary(r, { text: "Roll asked", name: "the DM asks for a Dexterity save", waiting: true, open() {} });
    assert.equal(alertsSummaryEntry(r)?.text, "Roll asked");
    second();
    assert.equal(alertsSummaryEntry(r)?.text, "Rolls 1/3");
    second();
    assert.equal(alertsSummaryEntry(r)?.text, "Rolls 1/3", "withdrawing twice changes nothing");
    first();
    assert.equal(alertsSummaryEntry(r), null);
  });
});

// "View as a player" mounts a second Room over the DM's (features/dm/PlayerPreview.tsx), each with its own scope.
describe("a DM's room and a player preview mounted together", () => {
  test("a preview with no requests reads no rolls line, so its dock opens and announces nothing of the DM's", () => {
    const dm = new RoomScope().get(sheetFocusSlot);
    const preview = new RoomScope().get(sheetFocusSlot);
    let opened = 0;
    const withdraw = publishAlertsSummary(dm, { text: "Roll asked", name: "the DM asks for a Wisdom check", waiting: true, open: () => opened++ });
    // Room's dock reads `waiting` and calls `open()`, and FoldStatus announces the text and name: all from this entry.
    assert.equal(alertsSummaryEntry(preview), null);
    assert.equal(alertsSummaryEntry(dm)?.waiting, true);
    alertsSummaryEntry(dm)?.open();
    assert.equal(opened, 1);
    withdraw();
  });

  test("each room's summary changes reach only its own readers, and the newest of its own shows", () => {
    const dm = new RoomScope().get(sheetFocusSlot);
    const preview = new RoomScope().get(sheetFocusSlot);
    const heard = { dm: 0, preview: 0 };
    dm.summaryListeners.add(() => heard.dm++);
    preview.summaryListeners.add(() => heard.preview++);
    const own = publishAlertsSummary(preview, { text: "Rolls 0/1", name: "rolls 0 of 1 answered", waiting: false, open() {} });
    const dms = publishAlertsSummary(dm, { text: "Rolls 1/3", name: "rolls 1 of 3 answered", waiting: false, open() {} });
    assert.equal(alertsSummaryEntry(preview)?.text, "Rolls 0/1", "the DM's newer line does not replace the preview's");
    assert.deepEqual(heard, { dm: 1, preview: 1 });
    dms();
    own();
    assert.equal(alertsSummaryEntry(preview), null);
  });

  test("a sheet closing in the preview never hands focus to the DM's token bar", () => {
    const dm = new RoomScope().get(sheetFocusSlot);
    const preview = new RoomScope().get(sheetFocusSlot);
    const bar = fakeElement("the DM's bar");
    const off = registerSheetReturnFocus(dm, ref(bar), RETURN_RANK.tokenBar);
    assert.equal(sheetReturnTarget(preview), null);
    assert.equal(returnFocusAfterSheet(preview), false);
    assert.equal(bar.focused, 0);
    assert.equal(sheetReturnTarget(dm), bar as unknown as HTMLElement);
    off();
  });
});

describe("the dock's summary button, which Room publishes", () => {
  test("a folding roll card finds it in its own room while it is drawn, and nothing otherwise", () => {
    const r = new SheetFocusRegistry();
    assert.equal(dockSummaryButton(r), null, "no dock yet");
    const button = fakeElement("summary");
    r.dockSummary = ref(button);
    assert.equal(dockSummaryButton(r), button as unknown as HTMLElement);
    assert.equal(dockSummaryButton(new SheetFocusRegistry()), null, "another room's dock is not this one's");
    r.dockSummary = ref(fakeElement("folded", { folded: true }));
    assert.equal(dockSummaryButton(r), null);
  });
});
