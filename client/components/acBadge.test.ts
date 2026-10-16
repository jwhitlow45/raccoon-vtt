import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acBadgeBox, SHIELD_PATH } from "./acBadge.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AcBadge } = await import("./AcBadge.tsx");

describe("the AC badge's box (docs/design-v1-token-panel.md 3.9)", () => {
  test("is nothing for an AC of 0, nor for what the protocol never allows", () => {
    for (const size of ["sm", "md"] as const) {
      for (const ac of [0, -1, 101, 1.5, Number.NaN]) assert.equal(acBadgeBox(ac, size), null, `${ac} at ${size}`);
    }
  });

  test("md is 22 tall with a 13 px number, at least 20 wide, and widens to its digits: 20, 24 and 32 for 9, 99 and 100", () => {
    const boxes = [9, 15, 99, 100].map((ac) => acBadgeBox(ac, "md"));
    for (const box of boxes) assert.deepEqual({ height: box?.height, textPx: box?.textPx }, { height: 22, textPx: 13 });
    assert.deepEqual(boxes.map((box) => box?.width), [20, 24, 24, 32]);
  });

  test("sm is 18 tall with an 11 px number, at least 16 wide, and widens to its digits: 16, 20 and 26", () => {
    const boxes = [9, 15, 99, 100].map((ac) => acBadgeBox(ac, "sm"));
    for (const box of boxes) assert.deepEqual({ height: box?.height, textPx: box?.textPx }, { height: 18, textPx: 11 });
    assert.deepEqual(boxes.map((box) => box?.width), [16, 20, 20, 26]);
  });

  test("holds every number from 1 to 100 with room on both sides, and never narrows as the number grows", () => {
    for (const size of ["sm", "md"] as const) {
      let before = 0;
      for (let ac = 1; ac <= 100; ac++) {
        const box = acBadgeBox(ac, size);
        assert.ok(box, `${ac} at ${size}`);
        assert.ok(box.width >= String(ac).length * box.textPx * 0.6 + 6, `${ac} at ${size} is ${box.width} wide`);
        assert.ok(box.width >= before, `${ac} at ${size} is narrower than ${ac - 1}`);
        before = box.width;
      }
    }
  });
});

describe("AcBadge", () => {
  test("is an image named by its AC, titled Armor Class, holding the shield and the number", () => {
    const markup = renderToStaticMarkup(createElement(AcBadge, { ac: 15, size: "sm" }));
    assert.match(markup, /^<span role="img" aria-label="Armor Class 15" title="Armor Class"/);
    assert.match(markup, /width:20px;height:18px/);
    assert.ok(markup.includes(`d="${SHIELD_PATH}"`));
    assert.match(markup, />15<\/span><\/span>$/);
    assert.doesNotMatch(markup, /tabindex/i, "not a Tab stop");
  });

  test("is md unless asked, and draws nothing for an AC of 0, an effect's", () => {
    assert.match(renderToStaticMarkup(createElement(AcBadge, { ac: 100 })), /width:32px;height:22px/);
    assert.equal(renderToStaticMarkup(createElement(AcBadge, { ac: 0, size: "sm" })), "");
  });

  test("keeps the party bar's shield outline, stretched from its own bounds to fill the box", () => {
    assert.equal(SHIELD_PATH, "M12 2 4 5v6c0 5.2 3.4 9.8 8 11 4.6-1.2 8-5.8 8-11V5z");
    assert.match(renderToStaticMarkup(createElement(AcBadge, { ac: 100 })), /viewBox="3\.5 1\.5 17 21" preserveAspectRatio="none"/);
  });
});
