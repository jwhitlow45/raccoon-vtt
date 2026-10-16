import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acBadgeBox } from "./acBadge.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AcBadge } = await import("./AcBadge.tsx");

describe("the AC badge's box", () => {
  test("is nothing for an AC of 0, and for what the protocol never allows", () => {
    for (const size of ["sm", "md"] as const) {
      assert.equal(acBadgeBox(0, size), null);
      assert.equal(acBadgeBox(-1, size), null);
      assert.equal(acBadgeBox(101, size), null);
      assert.equal(acBadgeBox(Number.NaN, size), null);
    }
  });

  test("md is 22 tall with a 13 px number, at least 20 wide, and widens to its digits", () => {
    const nine = acBadgeBox(9, "md")!;
    const ninetyNine = acBadgeBox(99, "md")!;
    const hundred = acBadgeBox(100, "md")!;
    assert.deepEqual([nine.height, nine.textPx, nine.width], [22, 13, 20]);
    assert.ok(Math.abs(ninetyNine.width - 24) <= 1, `99 is about 24 wide, got ${ninetyNine.width}`);
    assert.ok(Math.abs(hundred.width - 32) <= 1, `100 is about 32 wide, got ${hundred.width}`);
    assert.ok(ninetyNine.width > nine.width && hundred.width > ninetyNine.width);
  });

  test("sm is 18 tall with an 11 px number, at least 16 wide, and widens to its digits", () => {
    const nine = acBadgeBox(9, "sm")!;
    const ninetyNine = acBadgeBox(99, "sm")!;
    const hundred = acBadgeBox(100, "sm")!;
    assert.deepEqual([nine.height, nine.textPx, nine.width], [18, 11, 16]);
    assert.ok(ninetyNine.width > nine.width && hundred.width > ninetyNine.width);
    for (const box of [nine, ninetyNine, hundred]) assert.ok(box.width < acBadgeBox(100, "md")!.width);
  });
});

describe("the AC badge (docs/design-v1-token-panel.md 3.9)", () => {
  test("md is 20, 24 and 32 wide for 9, 99 and 100, sm 16, 20 and 26", () => {
    assert.deepEqual([9, 99, 100].map((ac) => acBadgeBox(ac, "md")?.width), [20, 24, 32]);
    assert.deepEqual([9, 99, 100].map((ac) => acBadgeBox(ac, "sm")?.width), [16, 20, 26]);
  });

  test("renders nothing for an AC of 0, an effect's", () => {
    assert.equal(renderToStaticMarkup(createElement(AcBadge, { ac: 0, size: "sm" })), "");
  });

  test("is an image named Armor Class 15, the shield and number hidden inside it", () => {
    const markup = renderToStaticMarkup(createElement(AcBadge, { ac: 15, size: "sm" }));
    assert.match(markup, /^<span role="img" aria-label="Armor Class 15" title="Armor Class"/);
    assert.match(markup, />15<\/span>/);
  });
});
