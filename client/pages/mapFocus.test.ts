import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spaceMovesMap } from "./mapFocus.ts";

describe("spaceMovesMap (P3R-2)", () => {
  // Stand-ins for the page's elements: only who they are matters.
  const body = {} as Element;
  const map = {} as Element;
  const button = {} as Element;

  test("Space holds the map while nothing has focus, or the map itself does", () => {
    assert.equal(spaceMovesMap(null, body, map), true);
    assert.equal(spaceMovesMap(body, body, map), true);
    assert.equal(spaceMovesMap(map, body, map), true, "focus left on the map after the last roll card closed");
  });

  test("anything else with focus keeps its own Space", () => {
    assert.equal(spaceMovesMap(button, body, map), false);
    assert.equal(spaceMovesMap(button, body, null), false, "a room with no map drawn yet");
  });
});
