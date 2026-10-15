import assert from "node:assert/strict";
import { test } from "node:test";
import { cellPxHint } from "#server/assets/kinds.ts";
import { exportFileName } from "./fileName.ts";

test("the name is the scene, its size in squares and the scale", () => {
  assert.equal(exportFileName("Crypt", { w: 30, h: 20 }, 70, "player"), "crypt-30x20-70px.png");
  assert.equal(exportFileName("The Owlbear's Den", { w: 40, h: 25 }, 100, "player"), "the-owlbear-s-den-40x25-100px.png");
});

test("the DM view is marked, so it is not handed out by mistake", () => {
  assert.equal(exportFileName("Crypt", { w: 30, h: 20 }, 70, "dm"), "crypt-30x20-70px-dm.png");
});

test("accents are folded, other symbols become dashes, and an empty name becomes map", () => {
  assert.equal(exportFileName("Château d'Été", { w: 10, h: 10 }, 50, "player"), "chateau-d-ete-10x10-50px.png");
  assert.equal(exportFileName("  Prep: the crypt!  ", { w: 20, h: 20 }, 70, "player"), "prep-the-crypt-20x20-70px.png");
  assert.equal(exportFileName("🐉🐉", { w: 5, h: 5 }, 70, "player"), "map-5x5-70px.png");
  assert.equal(exportFileName("", { w: 5, h: 5 }, 70, "player"), "map-5x5-70px.png");
});

test("a long scene name is shortened without a trailing dash", () => {
  const name = exportFileName(`${"a".repeat(47)} b c d`, { w: 9, h: 9 }, 70, "player");
  assert.equal(name, `${"a".repeat(47)}-9x9-70px.png`);
});

test("a size inside the scene's name is broken up so it cannot be read as the grid", () => {
  assert.equal(exportFileName("Room 3x3 trap", { w: 30, h: 20 }, 70, "player"), "room-3-x-3-trap-30x20-70px.png");
  assert.equal(exportFileName("2x3x4", { w: 30, h: 20 }, 70, "player"), "2-x-3-x-4-30x20-70px.png");
});

test("this app's map upload reads the scale back from every name", () => {
  const cases: [string, { w: number; h: number }, number][] = [
    ["Crypt", { w: 30, h: 20 }, 70],
    ["Room 3x3 trap", { w: 30, h: 20 }, 70],
    ["Level 2", { w: 24, h: 18 }, 50],
    ["12x34", { w: 7, h: 5 }, 100],
    [`${"9".repeat(30)}x${"9".repeat(30)}`, { w: 200, h: 200 }, 20],
    ["Big hall", { w: 1, h: 1 }, 70],
  ];
  for (const [scene, bounds, px] of cases) {
    for (const view of ["player", "dm"] as const) {
      const name = exportFileName(scene, bounds, px, view);
      assert.equal(cellPxHint(name, bounds.w * px, bounds.h * px), px, name);
    }
  }
});
