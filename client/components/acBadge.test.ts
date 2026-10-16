import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acBadgeBox } from "./acBadge.ts";

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
