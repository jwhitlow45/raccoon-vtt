import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { srdOnPass, unknownOnPass } from "../rules/pcStats.ts";
import { AREA_SPELLS } from "./area-spells.ts";
import { SAVE_SPELLS } from "./save-spells.ts";

describe("the spells that deal damage on a save (W7B-R2-3)", () => {
  test("each once, in name order, with a level and a rule", () => {
    assert.ok(SAVE_SPELLS.length >= 60, `only ${SAVE_SPELLS.length} spells`);
    const names = SAVE_SPELLS.map((s) => s.name);
    assert.deepEqual(names, [...new Set(names)].sort((a, b) => a.localeCompare(b)));
    for (const s of SAVE_SPELLS) {
      assert.match(s.srdId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, s.name);
      assert.ok(Number.isInteger(s.level) && s.level >= 0 && s.level <= 9, `${s.name} level`);
      assert.ok(s.onPass === "half" || s.onPass === "none", `${s.name} onPass`);
    }
  });

  test("every spell in the table is what an unset character spell of its name takes, at its own level and any other", () => {
    for (const s of SAVE_SPELLS) {
      assert.equal(srdOnPass({ name: s.name, kind: "spell" }), s.onPass, s.name);
      assert.equal(srdOnPass({ name: ` ${s.name.toUpperCase().replace(/’/g, "'")} `, kind: "spell" }), s.onPass, `${s.name}, in another case and apostrophe`);
      for (const level of [0, s.level, 9]) assert.equal(unknownOnPass({ name: s.name, kind: "spell", level }), s.onPass, `${s.name} at level ${level}`);
      assert.equal(srdOnPass({ name: s.name, kind: "other" }), undefined, `${s.name}: only a spell reads the SRD's rule`);
    }
  });

  test("every area preset that deals damage on a save is in the table, with the same rule", () => {
    const table = new Map(SAVE_SPELLS.map((s) => [s.name, s]));
    const presets = AREA_SPELLS.filter((a) => a.save && a.damage);
    assert.ok(presets.length >= 25, `only ${presets.length} damaging area presets`);
    for (const a of presets) {
      const s = table.get(a.name);
      assert.ok(s, `${a.name} is missing`);
      assert.equal(s.onPass, a.onPass ?? "none", a.name);
      assert.equal(s.level, a.level, `${a.name} level`);
    }
  });

  test("single-target spells read from their text, not the leveled default", () => {
    const rule = (name: string) => SAVE_SPELLS.find((s) => s.name === name)?.onPass;
    assert.equal(rule("Disintegrate"), "none");
    assert.equal(rule("Contagion"), "none");
    assert.equal(rule("Finger of Death"), "half");
    assert.equal(rule("Sacred Flame"), "none");
    assert.equal(rule("Mind Spike"), "half");
    // Left out: damage that takes no save, and a spell whose rounds differ.
    for (const name of ["Heat Metal", "Searing Smite", "Storm of Vengeance", "Bestow Curse"]) assert.equal(rule(name), undefined, name);
  });
});
