import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { previewSide } = await import("./GenerateDialog.tsx");

/*
 * The wide card's preview side: half the room is the floor, and the choices
 * keep 360 px (a side panel's width) once the body is 736 px wide.
 */

const TALL = 10_000;
const GAP = 16;

test("the choices get 360 px from a body width of 736, and the columns split evenly below it", () => {
  for (const [width, side] of [
    [735, 359],
    [736, 360],
    [737, 361],
    [700, 342],
  ] as const) {
    assert.equal(previewSide(width, TALL), side, `body ${width}`);
  }
  for (const width of [736, 737, 900, 1006]) assert.ok(width - GAP - previewSide(width, TALL) >= 360 - 1, `choices at ${width}`);
  assert.equal(736 - GAP - previewSide(736, TALL), 360);
});

test("a short body caps the side at its height", () => {
  assert.equal(previewSide(1006, 601), 601);
  assert.equal(previewSide(1006, 529), 529);
  assert.equal(previewSide(1006, TALL), 630);
});

test("a body narrower than the gap gives 0", () => {
  assert.equal(previewSide(10, TALL), 0);
});
