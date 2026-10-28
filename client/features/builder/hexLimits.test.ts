import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { HEX_LIMITS } from "../grid/words.ts";
import { BUILD_MODES, type BuildMode } from "./store.ts";

const { brushWords, hexBuilderLine } = await import("./Options.tsx");

const hexRows = { shape: "hex", orient: "rows" } as const;
const hexColumns = { shape: "hex", orient: "columns" } as const;
const left = ["paint", "rect", "poly", "erase", "eraseRect", "edge", "height", "rough"] satisfies BuildMode[];
const kept = ["light", "stamp", "label"] satisfies BuildMode[];

describe("the builder's line on a hex scene (H1)", () => {
  test("every mode a hex scene cannot use says the builder limit", () => {
    for (const g of [hexRows, hexColumns]) for (const m of left) assert.equal(hexBuilderLine(m, g), HEX_LIMITS.builder, m);
  });
  test("lights, stamps and labels keep their own hints", () => {
    for (const m of kept) assert.equal(hexBuilderLine(m, hexRows), null, m);
  });
  test("a square scene never shows the limit", () => {
    for (const m of BUILD_MODES) assert.equal(hexBuilderLine(m.value, SQUARES), null, m.value);
  });
  test("the brush reads the cell word", () => {
    assert.equal(brushWords(1, SQUARES), "1 square");
    assert.equal(brushWords(3, SQUARES), "3 squares");
    assert.equal(brushWords(1, hexRows), "1 hex");
    assert.equal(brushWords(3, hexColumns), "3 hexes");
  });
});
