import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { byCrThenName, fitsShapeLimit, shapeLimit } from "./shapeLevel.ts";

describe("a Druid's Beast Shapes limit", () => {
  test("the limit by level", () => {
    assert.deepEqual(shapeLimit(1), { maxCr: null, fly: false, label: "No Wild Shape before level 2." });
    assert.deepEqual([2, 3].map((l) => shapeLimit(l).label), ["Up to CR 1/4, no Fly Speed.", "Up to CR 1/4, no Fly Speed."]);
    assert.deepEqual([4, 7].map((l) => shapeLimit(l).maxCr), [0.5, 0.5]);
    assert.equal(shapeLimit(7).fly, false);
    assert.deepEqual([8, 20].map((l) => [shapeLimit(l).maxCr, shapeLimit(l).fly, shapeLimit(l).label]), [
      [1, true, "Up to CR 1."],
      [1, true, "Up to CR 1."],
    ]);
  });

  let SRD_MONSTERS: Awaited<ReturnType<typeof loadMonsters>> = [];
  before(async () => {
    SRD_MONSTERS = await loadMonsters();
  });
  const named = (name: string) => {
    const m = SRD_MONSTERS.find((x) => x.name === name);
    assert.ok(m, name);
    return m;
  };

  test("level 1 admits nothing", () => {
    assert.equal(SRD_MONSTERS.filter((m) => fitsShapeLimit(shapeLimit(1), m)).length, 0);
  });

  test("a flying beast is out below level 8 and in from 8 when its CR fits", () => {
    const owl = named("Owl");
    const wasp = named("Giant Wasp");
    for (const level of [2, 4, 7]) assert.equal(fitsShapeLimit(shapeLimit(level), owl), false, `Owl at ${level}`);
    assert.equal(fitsShapeLimit(shapeLimit(8), owl), true);
    assert.equal(fitsShapeLimit(shapeLimit(4), wasp), false);
    assert.equal(fitsShapeLimit(shapeLimit(8), wasp), true);
  });

  test("CR caps hold", () => {
    assert.equal(fitsShapeLimit(shapeLimit(3), named("Black Bear")), false);
    assert.equal(fitsShapeLimit(shapeLimit(4), named("Black Bear")), true);
    assert.equal(fitsShapeLimit(shapeLimit(7), named("Brown Bear")), false);
    assert.equal(fitsShapeLimit(shapeLimit(8), named("Brown Bear")), true);
    assert.equal(fitsShapeLimit(shapeLimit(20), named("Wolf")), true);
  });

  test("sorts by CR highest first, then name", () => {
    const names = ["Wolf", "Brown Bear", "Boar", "Black Bear"].map(named).sort(byCrThenName).map((m) => m.name);
    assert.deepEqual(names, ["Brown Bear", "Black Bear", "Boar", "Wolf"]);
  });
});
