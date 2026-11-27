import assert from "node:assert/strict";
import { test } from "node:test";
import { cellPxHint } from "#server/assets/kinds.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { exportFileName, MAX_NAME_BYTES, vttFileName, vttZipNames } from "./fileName.ts";

test("the name is the scene, its size in squares and the scale", () => {
  assert.equal(exportFileName(SQUARES, "Crypt", { w: 30, h: 20 }, 70, "player"), "crypt-30x20-70px.png");
  assert.equal(exportFileName(SQUARES, "The Owlbear's Den", { w: 40, h: 25 }, 100, "player"), "the-owlbear-s-den-40x25-100px.png");
});

test("the DM view is marked, so it is not handed out by mistake", () => {
  assert.equal(exportFileName(SQUARES, "Crypt", { w: 30, h: 20 }, 70, "dm"), "crypt-30x20-70px-dm.png");
});

test("accents are folded, other symbols become dashes, and an empty name becomes map", () => {
  assert.equal(exportFileName(SQUARES, "Château d'Été", { w: 10, h: 10 }, 50, "player"), "chateau-d-ete-10x10-50px.png");
  assert.equal(exportFileName(SQUARES, "  Prep: the crypt!  ", { w: 20, h: 20 }, 70, "player"), "prep-the-crypt-20x20-70px.png");
  assert.equal(exportFileName(SQUARES, "🐉🐉", { w: 5, h: 5 }, 70, "player"), "map-5x5-70px.png");
  assert.equal(exportFileName(SQUARES, "", { w: 5, h: 5 }, 70, "player"), "map-5x5-70px.png");
});

test("a long scene name is shortened without a trailing dash", () => {
  const name = exportFileName(SQUARES, `${"a".repeat(47)} b c d`, { w: 9, h: 9 }, 70, "player");
  assert.equal(name, `${"a".repeat(47)}-9x9-70px.png`);
});

test("a size inside the scene's name is broken up so it cannot be read as the grid", () => {
  assert.equal(exportFileName(SQUARES, "Room 3x3 trap", { w: 30, h: 20 }, 70, "player"), "room-3-x-3-trap-30x20-70px.png");
  assert.equal(exportFileName(SQUARES, "2x3x4", { w: 30, h: 20 }, 70, "player"), "2-x-3-x-4-30x20-70px.png");
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
      const name = exportFileName(SQUARES, scene, bounds, px, view);
      assert.equal(cellPxHint(name, bounds.w * px, bounds.h * px), px, name);
    }
  }
});

test("a hex scene's name says hex where a square one has its size, and the upload reads no size from it (docs/design/design-v1-hex-grids.md HX-D13)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g = { shape: "hex", orient } as const;
    assert.equal(exportFileName(g, "Crypt", { w: 30, h: 20 }, 70, "player"), "crypt-hex-70px.png");
    assert.equal(exportFileName(g, "Crypt", { w: 30, h: 20 }, 70, "dm"), "crypt-hex-70px-dm.png");
    for (const scene of ["Crypt", "Room 3x3 trap", "12x34"]) {
      const name = exportFileName(g, scene, { w: 30, h: 20 }, 70, "player");
      assert.equal(cellPxHint(name, 30 * 70, 20 * 70), undefined, name);
    }
  }
});

test("a floor's name follows the scene's, before the size (docs/design/design-v1-floors.md 7.8)", () => {
  assert.equal(exportFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "player", "Upper floor"), "tower-upper-floor-30x20-70px.png");
  assert.equal(exportFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "dm", "Roof"), "tower-roof-30x20-70px-dm.png");
  // A floor name with nothing a file name can hold, and a scene without floors, add nothing.
  assert.equal(exportFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "player", "🐉"), "tower-30x20-70px.png");
  assert.equal(exportFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "player"), "tower-30x20-70px.png");
  // A size inside a floor's name cannot win over the grid's, and the upload still reads the scale back.
  const name = exportFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "player", "Room 3x3");
  assert.equal(name, "tower-room-3-x-3-30x20-70px.png");
  assert.equal(cellPxHint(name, 30 * 70, 20 * 70), 70);
});

const bytes = (name: string) => new TextEncoder().encode(name).byteLength;

test("a VTT file keeps the scene's and floor's names as written, with (DM) for the DM view", () => {
  assert.equal(vttFileName("Crypt of Doom", "player"), "Crypt of Doom.dd2vtt");
  assert.equal(vttFileName("Crypt of Doom", "dm"), "Crypt of Doom (DM).dd2vtt");
  assert.equal(vttFileName("Tower", "player", "Upper floor"), "Tower - Upper floor.dd2vtt");
});

test("a VTT file's name has only the characters a path forbids replaced: a slash becomes _, Japanese stays", () => {
  assert.equal(vttFileName("Keep/Vault: 地下室?", "player"), "Keep_Vault_ 地下室_.dd2vtt");
  assert.equal(vttFileName('a\\b*c"d<e>f|g\u0007', "player"), "a_b_c_d_e_f_g_.dd2vtt");
});

test("80-character Japanese scene and floor names stay under 200 bytes, the scene cut first on a code point boundary", () => {
  const scene = "地".repeat(80);
  const floor = "屋".repeat(40);
  for (const view of ["player", "dm"] as const) {
    const name = vttFileName(scene, view, floor);
    assert.ok(bytes(name) <= MAX_NAME_BYTES, `${bytes(name)} bytes`);
    assert.ok(name.includes(` - ${floor}`), "the floor part is whole");
    assert.match(name, /^地+ - /u, "the scene part is cut between characters");
    const alone = vttFileName(scene, view);
    assert.ok(bytes(alone) <= MAX_NAME_BYTES);
  }
  // Four-byte characters cut whole too.
  const emoji = vttFileName("🐉".repeat(80), "dm");
  assert.ok(bytes(emoji) <= MAX_NAME_BYTES);
  assert.ok(!emoji.includes("\ufffd"));
  assert.equal(Array.from(emoji.replace(" (DM).dd2vtt", "")).every((c) => c === "🐉"), true);
});

test("a zip with a short and a long floor name under a long scene name carries one scene part in every entry", () => {
  const scene = "Château ".repeat(12).trim();
  const { zip, entries } = vttZipNames(scene, "dm", ["Ground floor", "屋".repeat(40)]);
  const parts = entries.map((e) => /^(.+) - (\d{2}) - (.+)\.dd2vtt$/.exec(e)?.[1]);
  assert.equal(new Set(parts).size, 1, entries.join(" | "));
  for (const e of entries) assert.ok(bytes(e) <= MAX_NAME_BYTES, e);
  assert.deepEqual(entries.map((e) => e.slice(parts[0]!.length)), [" - 01 - Ground floor.dd2vtt", ` - 02 - ${"屋".repeat(40)}.dd2vtt`]);
  assert.equal(zip, `${parts[0]} (DM).zip`);
  assert.deepEqual(vttZipNames("Tower", "player", ["Ground floor", "Upper floor"]), { zip: "Tower.zip", entries: ["Tower - 01 - Ground floor.dd2vtt", "Tower - 02 - Upper floor.dd2vtt"] });
});
