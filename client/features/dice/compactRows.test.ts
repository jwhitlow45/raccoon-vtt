import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { presetTag, riderText, rowSummary } from "./options.ts";

describe("the compact rows' words (docs/design-v1-dice-ui.md 4)", () => {
  test("a preset's tag is its few characters, the effects' names left to the group's label", () => {
    assert.equal(presetTag({ sources: [], extra: [], notes: [] }), "");
    assert.equal(presetTag({ sources: [{ kind: "dis", from: "poisoned" }], extra: [], notes: [] }), "Dis");
    assert.equal(presetTag({ sources: [{ kind: "dis", from: "restrained" }], extra: ["+1d4"], extraFrom: ["blessed"], notes: [] }), "Dis +1d4");
    assert.equal(presetTag({ sources: [], extra: ["1d4"], notes: [] }), "+1d4");
    assert.equal(presetTag({ sources: [{ kind: "adv", from: "x" }], extra: [], fails: "paralyzed", notes: [] }), "Fails");
  });

  test("a save stands where an attack's bonus stands, its damage after it, and half on a pass only with damage to halve", () => {
    assert.equal(rowSummary({ attack: 6, damage: [{ formula: "1d8+3", type: "slashing" }, { formula: "2d8", type: "radiant", optional: true, name: "Divine Smite" }] }), "+6 to hit, 1d8+3 slashing, +2d8 Divine Smite");
    assert.equal(rowSummary({ attack: 4, damage: [{ formula: "1d6+2", type: "slashing" }, { formula: "1d4", optional: true, name: "if the attack roll had Advantage" }] }), "+4 to hit, 1d6+2 slashing, +1d4 with Advantage");
    assert.equal(rowSummary({ save: { ability: "dex", dc: 14, onPass: "none" }, damage: [{ formula: "2d8", type: "radiant" }] }), "DC 14 Dex, 2d8 radiant");
    assert.equal(rowSummary({ save: { ability: "wis", dc: 14, onPass: "half" }, damage: [] }), "DC 14 Wis");
    assert.equal(rowSummary({ save: { ability: "con", dc: 15, onPass: "half" }, damage: [{ formula: "5d6", type: "thunder" }] }), "DC 15 Con, half on a pass, 5d6 thunder");
    assert.equal(rowSummary({ damage: [], heal: { formula: "2d8+3" } }), "2d8+3 healing");
    assert.equal(rowSummary({ attack: -1, damage: [] }), "-1 to hit");
  });

  test("a rider's toggle is its short name, its dice being in the header", () => {
    assert.equal(riderText({ formula: "2d8", type: "radiant", optional: true, name: "Divine Smite" }), "Divine Smite");
    assert.equal(riderText({ formula: "1d4", optional: true, name: "if the attack roll had Advantage" }), "With Advantage");
    assert.equal(riderText({ formula: "1d6", optional: true, name: "when the target is in dim light or darkness" }), "When the target is in…");
    assert.equal(riderText({ formula: "1d6", optional: true }), "+1d6");
  });
});
