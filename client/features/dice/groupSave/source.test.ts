import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sourceIds } from "./chain.ts";

/** Where a group save's rows come from until the roll (docs/design-v1-roll-options.md 5.1). */

describe("a group save's source", () => {
  test("a save action's group save follows the selection less the acting creature, so selecting the targets after it opens fills it", () => {
    const source = { kind: "selection" as const, tokenIds: [], live: true as const, except: "dragon" };
    assert.deepEqual(sourceIds(source, ["dragon"]), [], "opened with the dragon alone selected");
    assert.deepEqual(sourceIds(source, ["g1", "g2", "g3"]), ["g1", "g2", "g3"]);
    assert.deepEqual(sourceIds(source, ["dragon", "g1"]), ["g1"], "the dragon never targets itself");
  });

  test("Set up a group save follows the selection, a creature added or dropped included, and a quick tap keeps the creatures it rolled", () => {
    const setup = { kind: "selection" as const, tokenIds: ["g1", "g2"], live: true as const };
    assert.deepEqual(sourceIds(setup, ["g1", "g2", "g3"]), ["g1", "g2", "g3"]);
    assert.deepEqual(sourceIds(setup, ["g2"]), ["g2"]);
    const quick = { kind: "selection" as const, tokenIds: ["g1", "g2"] };
    assert.deepEqual(sourceIds(quick, ["g3"]), ["g1", "g2"]);
  });

  test("an area's rows are its caught creatures, whatever is selected", () => {
    assert.deepEqual(sourceIds({ kind: "area", templateId: "a1" }, ["g9"], (id) => (id === "a1" ? ["g1"] : [])), ["g1"]);
  });
});
