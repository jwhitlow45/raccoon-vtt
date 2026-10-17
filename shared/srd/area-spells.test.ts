import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseFormula } from "../dice/formula.ts";
import type { AreaShape } from "../model.ts";
import { DAMAGE_TYPES } from "../rules/damage.ts";
import { AREA_SPELLS, type AreaSpell } from "./area-spells.ts";

const SHAPES: readonly AreaShape[] = ["sphere", "cylinder", "cone", "cube", "line", "emanation"];

const spell = (name: string): AreaSpell => {
  const s = AREA_SPELLS.find((x) => x.name === name);
  assert.ok(s, `no area spell named ${name}`);
  return s;
};

/** The area fields only, for exact comparisons. */
const area = (s: AreaSpell) => ({
  shape: s.shape,
  size: s.size,
  ...(s.width !== undefined ? { width: s.width } : {}),
  ...(s.height !== undefined ? { height: s.height } : {}),
  attached: s.attached,
});

describe("area spells", () => {
  test("every entry has a valid shape and size", () => {
    assert.ok(AREA_SPELLS.length >= 60, `only ${AREA_SPELLS.length} presets`);
    const ids = new Set<string>();
    for (const s of AREA_SPELLS) {
      assert.ok(!ids.has(s.srdId), `duplicate ${s.srdId}`);
      ids.add(s.srdId);
      assert.match(s.srdId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(SHAPES.includes(s.shape), `${s.name} shape ${s.shape}`);
      assert.ok(Number.isInteger(s.level) && s.level >= 0 && s.level <= 9, `${s.name} level`);
      // The bounds of AreaTemplate.size, width and height.
      assert.ok(s.size >= 5 && s.size <= 1000 && s.size % 5 === 0, `${s.name} size ${s.size}`);
      if (s.shape === "line") assert.ok(s.width !== undefined && s.width >= 5 && s.width <= 1000, `${s.name} width`);
      else assert.equal(s.width, undefined, `${s.name} has a width but is not a line`);
      if (s.shape === "cylinder") assert.ok(s.height !== undefined && s.height >= 5 && s.height <= 1000, `${s.name} height`);
      else assert.equal(s.height, undefined, `${s.name} has a height but is not a cylinder`);
      if (s.attached) {
        assert.equal(s.shape, "emanation", `${s.name} is attached but not an emanation`);
        assert.ok(s.fromCaster, `${s.name} is attached but its range is not Self`);
      }
      assert.equal(s.fromCaster, s.range.startsWith("Self"), `${s.name} fromCaster`);
      assert.equal(typeof s.concentration, "boolean");
      if (s.note !== undefined) assert.doesNotMatch(s.note, /[;\u2014]/, `${s.name} note`);
    }
  });

  test("is sorted by name", () => {
    const names = AREA_SPELLS.map((s) => s.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  test("spot checks against SRD 5.2.1", () => {
    assert.deepEqual(area(spell("Fireball")), { shape: "sphere", size: 20, attached: false });
    assert.equal(spell("Fireball").level, 3);
    assert.equal(spell("Fireball").range, "150 feet");
    assert.equal(spell("Fireball").fromCaster, false);
    assert.equal(spell("Fireball").concentration, false);

    assert.deepEqual(area(spell("Burning Hands")), { shape: "cone", size: 15, attached: false });
    assert.equal(spell("Burning Hands").fromCaster, true);

    assert.deepEqual(area(spell("Lightning Bolt")), { shape: "line", size: 100, width: 5, attached: false });
    assert.equal(spell("Lightning Bolt").fromCaster, true);

    assert.deepEqual(area(spell("Spirit Guardians")), { shape: "emanation", size: 15, attached: true });
    assert.equal(spell("Spirit Guardians").concentration, true);
    assert.deepEqual(area(spell("Conjure Minor Elementals")), { shape: "emanation", size: 15, attached: true });

    assert.deepEqual(area(spell("Thunderwave")), { shape: "cube", size: 15, attached: false });
    assert.deepEqual(area(spell("Cone of Cold")), { shape: "cone", size: 60, attached: false });
    assert.deepEqual(area(spell("Moonbeam")), { shape: "cylinder", size: 5, height: 40, attached: false });
    assert.deepEqual(area(spell("Ice Storm")), { shape: "cylinder", size: 20, height: 40, attached: false });
    assert.deepEqual(area(spell("Sunbeam")), { shape: "line", size: 60, width: 5, attached: false });
    assert.deepEqual(area(spell("Gust of Wind")), { shape: "line", size: 60, width: 10, attached: false });
    assert.deepEqual(area(spell("Acid Splash")), { shape: "sphere", size: 5, attached: false });
    assert.equal(spell("Acid Splash").level, 0);
    // Immobile emanations do not follow the caster.
    assert.equal(spell("Tiny Hut").attached, false);
  });

  test("the spells that hit again on entering or at a turn's start or end say so, as their text does", () => {
    for (const s of AREA_SPELLS) {
      if (s.triggers === undefined) continue;
      assert.ok(s.triggers.length > 0 && new Set(s.triggers).size === s.triggers.length, s.name);
      assert.ok(s.triggers.every((t) => t === "enter" || t === "turnStart" || t === "turnEnd"), s.name);
    }
    // "whenever a creature enters the Emanation or ends its turn there"
    assert.deepEqual(spell("Spirit Guardians").triggers, ["enter", "turnEnd"]);
    assert.deepEqual(spell("Moonbeam").triggers, ["enter", "turnEnd"]);
    // "Each creature that starts its turn in the Sphere"
    assert.deepEqual(spell("Stinking Cloud").triggers, ["turnStart"]);
    // "The first time a creature enters the webs on a turn or starts its turn there"
    assert.deepEqual(spell("Web").triggers, ["enter", "turnStart"]);
    // "A creature that ends its turn in the Line"
    assert.deepEqual(spell("Gust of Wind").triggers, ["turnEnd"]);
    // "enters a space within 10 feet of the pack or ends its turn there", around a pack the caster moves.
    assert.deepEqual(area(spell("Conjure Animals")), { shape: "emanation", size: 10, attached: false });
    assert.deepEqual(spell("Conjure Animals").triggers, ["enter", "turnEnd"]);
    // "a Large pack of spectral, intangible animals": the saves are for creatures near it, not the pack.
    assert.equal(spell("Conjure Animals").target, "pack");
    assert.equal(spell("Conjure Animals").catchesTarget, false);
    assert.match(spell("Conjure Animals").note ?? "", /a Large pack of spectral, intangible animals/);
    assert.equal(spell("Ice Knife").catchesTarget, undefined);
    // Hits once, when cast.
    assert.equal(spell("Fireball").triggers, undefined);
    // In 2024 it adds damage to the caster's attacks, and hits nobody for being there.
    assert.equal(spell("Conjure Minor Elementals").triggers, undefined);
  });

  test("the spells that say a creature is hit only once per turn are marked so, and no others", () => {
    const once = AREA_SPELLS.filter((s) => s.oncePerTurn).map((s) => s.name);
    // Each reads "only once per turn" in SRD 5.2.1. Grease, Web, Sleet Storm, Zone of Truth, Spike Growth, Stinking Cloud and Gust of Wind do not.
    assert.deepEqual(once, ["Black Tentacles", "Cloudkill", "Conjure Animals", "Conjure Celestial", "Conjure Woodland Beings", "Incendiary Cloud", "Insect Plague", "Moonbeam", "Spirit Guardians", "Symbol"]);
    assert.ok(AREA_SPELLS.every((s) => !s.oncePerTurn || s.triggers !== undefined));
  });

  test("spells without an area of effect are left out", () => {
    for (const name of ["Wall of Fire", "Light", "Magic Missile", "Major Image", "Alarm"]) {
      assert.equal(AREA_SPELLS.find((s) => s.name === name), undefined, name);
    }
  });

  test("every preset's save and damage reads (docs/design-v1-roll-options.md 5.6): each part parses, with its type and its dice per slot", () => {
    for (const s of AREA_SPELLS) {
      for (const part of s.damage ?? []) {
        assert.ok(parseFormula(part.formula).ok, `${s.name}: ${part.formula}`);
        assert.ok((DAMAGE_TYPES as readonly string[]).includes(part.type), `${s.name}: ${part.type}`);
        if (part.perSlot) assert.ok(parseFormula(part.perSlot).ok, `${s.name}: ${part.perSlot}`);
      }
      if (s.save) assert.ok(s.onPass === "half" || s.onPass === "none", s.name);
      assert.ok(!(s.save && s.noSave), `${s.name}: a save and no save`);
    }
    assert.deepEqual(spell("Flame Strike").damage, [
      { formula: "5d6", type: "fire", perSlot: "1d6" },
      { formula: "5d6", type: "radiant", perSlot: "1d6" },
    ]);
    assert.deepEqual([spell("Fireball").save, spell("Fireball").onPass], ["dex", "half"]);
    assert.equal(spell("Spike Growth").noSave, true, "everyone takes it");
    assert.deepEqual(spell("Hypnotic Pattern").conditions, ["charmed", "incapacitated"]);
    assert.equal(spell("Acid Splash").cantrip, true);
    assert.deepEqual(spell("Sleep").lasts, { at: "end", of: "target" });
  });
});
