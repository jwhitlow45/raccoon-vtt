import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handoutPages } from "./handouts.ts";
import type { Handout } from "./model.ts";

describe("handoutPages (docs/design-v1-pdf-handouts.md 3.1)", () => {
  const base: Handout = { id: "h", rev: 0, assetId: "a", title: "Strange letter", to: "all", shownAt: "" };

  test("a handout without pages is its one image, with no size", () => {
    assert.deepEqual(handoutPages(base), [{ assetId: "a" }]);
  });

  test("a handout of pages is every page in order with its size, the first included", () => {
    const pages = [
      { assetId: "a", width: 1584, height: 2048 },
      { assetId: "b", width: 2048, height: 1584 },
      { assetId: "a", width: 1584, height: 2048 },
    ];
    assert.deepEqual(handoutPages({ ...base, pages }), pages);
  });

  test("a show op's input reads the same, in either shape", () => {
    assert.deepEqual(handoutPages({ assetId: "a" }), [{ assetId: "a" }]);
    assert.deepEqual(handoutPages({ pages: [{ assetId: "b", width: 1, height: 2 }] }), [{ assetId: "b", width: 1, height: 2 }]);
  });
});
