import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { followSelection, newPage, sourceIds } from "./chain.ts";

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

  test("a live page keeps its last picks, so a reload, which selects nothing, shows the same rows (W7B-R2-1)", () => {
    let page = newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: ["g1", "g2"], live: true }, test: { kind: "save", ability: "dex" }, dc: 13, secret: true, spell: false, switches: { dcShown: true, resultShown: true } });
    page = followSelection(page, ["g2", "g3"]);
    assert.deepEqual(page.source.kind === "selection" && page.source.tokenIds, ["g2", "g3"]);
    assert.equal(followSelection(page, ["g2", "g3"]), page, "nothing changed, the same page");
    const restored = JSON.parse(JSON.stringify(page)) as typeof page;
    assert.deepEqual(sourceIds(restored.source, []), ["g2", "g3"], "after a reload nothing is selected, and the picks stand");
    assert.equal(followSelection(restored, []), restored, "an empty selection never wipes the picks");
    const breath = newPage({ id: "b", sceneId: "s", source: { kind: "selection", tokenIds: [], live: true, except: "dragon" }, test: { kind: "save", ability: "dex" }, dc: 13, secret: true, spell: false, switches: { dcShown: true, resultShown: true } });
    assert.deepEqual(sourceIds(followSelection(breath, ["dragon", "g1"]).source, []), ["g1"], "the acting creature is never a pick");
    const rolled = { ...page, phase: "rolled" as const };
    assert.equal(followSelection(rolled, ["g9"]), rolled, "after the roll the rows are frozen");
  });
});
