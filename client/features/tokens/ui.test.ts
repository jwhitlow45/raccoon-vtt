import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { numberCommit } = await import("./ui.tsx");

describe("what a number field's commit does", () => {
  const hp = { value: 10, min: 1, max: 100 };
  test("a new number in bounds is sent, rounded, and the same number sends nothing", () => {
    assert.deepEqual(numberCommit("20", hp), { shows: "20", sends: 20 });
    assert.deepEqual(numberCommit(" 19.6 ", hp), { shows: "20", sends: 20 });
    assert.deepEqual(numberCommit("10", hp), { shows: "10" });
  });
  test("a number out of bounds is clamped, and a typed minus sign counts", () => {
    assert.deepEqual(numberCommit("500", hp), { shows: "100", sends: 100 });
    assert.deepEqual(numberCommit("−5", { value: 0, min: -20, max: 40 }), { shows: "-5", sends: -5 });
  });
  test("text that is no number snaps back, and so does empty unless the field may be unset", () => {
    assert.deepEqual(numberCommit("ten", hp), { shows: "10" });
    assert.deepEqual(numberCommit("", hp), { shows: "10" });
    assert.deepEqual(numberCommit("", { ...hp, nullable: true }), { shows: "", sends: null });
    assert.deepEqual(numberCommit("", { value: undefined, min: 1, max: 100, nullable: true }), { shows: "" });
  });
});
