import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lightCaption, lightReach } from "../builder/lightTap.ts";
import { lightText, PLACED_LIGHTS } from "./presets.ts";
import { lightOnGrid, radiusCapFt, senseFeetText, senseOnGrid } from "./reach.ts";
import { parseSenses, sensesLines, sensesShort } from "./senses.ts";

const daylight = PLACED_LIGHTS.find((p) => p.name === "Daylight")!;

describe("what senses and lights reach on the room's grid", () => {
  test("a grid of 5 ft or more cuts nothing short, so the words are as they were", () => {
    for (const fpc of [5, 10, 100]) {
      assert.equal(senseOnGrid(150, fpc), null);
      assert.equal(lightOnGrid({ bright: 120, dim: 120 }, fpc), null);
      assert.equal(senseFeetText(60, fpc), "60 ft");
      assert.equal(lightText(daylight, fpc), "60 ft bright, dim to 120 ft");
      assert.equal(radiusCapFt(fpc), 120);
    }
    assert.deepEqual(sensesLines(parseSenses("Darkvision 60 ft."), 5), ["Sees in the dark to 60 ft"]);
  });

  test("at 1 ft per cell a 60 ft darkvision reaches 30 ft, and the panel and the settings say so", () => {
    assert.equal(senseOnGrid(60, 1), 30);
    assert.equal(senseFeetText(60, 1), "60 ft (reaches 30 ft on this grid)");
    assert.deepEqual(sensesLines(parseSenses("Darkvision 60 ft."), 1), ["Sees in the dark to 60 ft (reaches 30 ft on this grid)"]);
    assert.equal(sensesShort(parseSenses("Darkvision 60 ft, blindsight 10 ft"), 1), "darkvision 60 ft (reaches 30 ft on this grid), blindsight 10 ft");
    // Under the cap in cells, a sense reads as written on any grid.
    assert.equal(senseFeetText(30, 1), "30 ft");
    // At 2 ft per cell, 30 cells are 60 ft.
    assert.equal(senseFeetText(150, 2), "150 ft (reaches 60 ft on this grid)");
    assert.equal(senseFeetText(60, 2), "60 ft");
  });

  test("a light's radii stop at 24 cells each: what it reaches is written beside what it was set to", () => {
    assert.deepEqual(lightOnGrid(daylight, 1), { bright: 24, dim: 24 });
    assert.equal(lightText(daylight, 1), "60 ft bright, dim to 120 ft (reaches 24 ft bright, dim to 48 ft on this grid)");
    // A Lamp's 30 ft dim band passes 24 cells at 1 ft, its bright radius does not.
    assert.equal(lightText({ bright: 15, dim: 30 }, 1), "15 ft bright, dim to 45 ft (reaches 15 ft bright, dim to 39 ft on this grid)");
    // A torch fits under the cap even at 1 ft per cell.
    assert.equal(lightText({ bright: 20, dim: 20 }, 1), "20 ft bright, dim to 40 ft");
    assert.equal(lightText(daylight, 3), "60 ft bright, dim to 120 ft");
    assert.equal(lightText(daylight, 2), "60 ft bright, dim to 120 ft (reaches 48 ft bright, dim to 96 ft on this grid)");
    assert.equal(lightText(daylight), "60 ft bright, dim to 120 ft", "without the grid, the light as set");
    assert.equal(radiusCapFt(1), 24);
    assert.equal(radiusCapFt(4), 96);
  });

  test("the builder's rings and caption show the reach sight uses", () => {
    assert.deepEqual(lightReach(daylight, 1), { bright: 24, dim: 48 });
    assert.deepEqual(lightReach(daylight, 5), { bright: 12, dim: 24 });
    assert.equal(lightCaption({ ...daylight, on: true, label: "Daylight" }, 1), "Daylight: 60 ft bright, dim to 120 ft (reaches 24 ft bright, dim to 48 ft on this grid)");
    assert.equal(lightCaption({ ...daylight, on: false, label: "Daylight" }, 5), "Daylight: 60 ft bright, dim to 120 ft, off");
  });
});
