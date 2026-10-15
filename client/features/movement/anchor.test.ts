import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cardPlace } from "./anchor.ts";

const phone = { width: 390, height: 844 };
const bars = { top: 52, right: 0, bottom: 60, left: 0 };

describe("a card over the map", () => {
  test("hangs on the side it prefers, centered on its anchor", () => {
    assert.deepEqual(cardPlace({ anchor: { x: 200, y: 400 }, viewport: phone, insets: bars, width: 160, height: 76, gap: 14, prefer: "above" }), { left: 120, top: 310 });
    assert.deepEqual(cardPlace({ anchor: { x: 200, y: 400 }, viewport: phone, insets: bars, width: 160, height: 76, gap: 12, prefer: "below" }), { left: 120, top: 412 });
  });

  test("takes the other side when its own has no room", () => {
    // Too close to the top bar to hang above.
    assert.equal(cardPlace({ anchor: { x: 200, y: 100 }, viewport: phone, insets: bars, width: 160, height: 76, gap: 14, prefer: "above" }).top, 114);
    // Too close to the toolbar to hang below.
    assert.equal(cardPlace({ anchor: { x: 200, y: 760 }, viewport: phone, insets: bars, width: 288, height: 112, gap: 12, prefer: "below" }).top, 636);
  });

  test("stays inside the canvas the bars leave clear, at either edge", () => {
    assert.equal(cardPlace({ anchor: { x: 10, y: 400 }, viewport: phone, insets: bars, width: 288, height: 112, gap: 12, prefer: "below" }).left, 8);
    assert.equal(cardPlace({ anchor: { x: 385, y: 400 }, viewport: phone, insets: bars, width: 288, height: 112, gap: 12, prefer: "below" }).left, 94);
    // An anchor off the top of the screen still puts the card where it can be read.
    assert.equal(cardPlace({ anchor: { x: 200, y: -300 }, viewport: phone, insets: bars, width: 160, height: 76, gap: 14, prefer: "above" }).top, 60);
  });
});
