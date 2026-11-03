import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardTheme } from "../../lib/theme.ts";

const { dragColor } = await import("./RulerLayer.tsx");

describe("a drag's color", () => {
  test("is its speed band's, green, yellow or red", () => {
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: 10, band: "walk" }), boardTheme.color.success);
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: 10, band: "dash" }), boardTheme.color.crest);
    assert.equal(dragColor({ kind: "walk", speed: 30, leftFt: -5, band: "over" }), boardTheme.color.danger);
  });

  test("with no band to show, the text color, never the crest yellow a Dash wears", () => {
    assert.equal(dragColor(undefined), boardTheme.color.text);
    assert.equal(dragColor(null), boardTheme.color.text);
    assert.notEqual(dragColor(undefined), boardTheme.color.crest);
  });
});
