import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState, Scene } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { apply, room } from "#shared/testutil.ts";
import { importScene, placeMap, severalFilesOps, type FileFloor } from "./batch.ts";
import { convertUvtt, type ImportPlan } from "./convert.ts";
import { addingText, dialogTitle, fileError, filesRefusal, floorNamesOf, moveRow, readingText, rowName, rowsOf, SCENE_NAME_CHARS, sceneNameOf, scenesFull, willBeText, severalOutcomeText, tooManyFiles, uploadFailed, uploadingText } from "./floorsImport.ts";
import { readUvtt } from "./schema.ts";
import { uvttFile, type FileInput } from "./synthetic.ts";
import { withPlayersSee } from "../scenes/create.ts";

/*
 * A new scene from several Universal VTT files (docs/design/design-v1-floors.md
 * phase 4, 9.5): the rows' order and names, the refusals asked before any
 * upload, the dialog's words, and the one Setup group, sent through the
 * client schema and the reducer into one scene of floors.
 */

const file = (name: string) => new File(["{}"], name);
const names = (files: string[]) => rowsOf(files.map(file)).map((r) => r.file.name);
const p = (x: number, y: number) => ({ x, y });

function plan(input: FileInput): ImportPlan {
  const read = readUvtt(uvttFile(input));
  assert.ok(read.ok, read.ok ? "" : read.error);
  const result = convertUvtt(read.map, { objects: true, portals: "window", feetPerCell: 5 });
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.plan;
}

/** One file of the scene as the dialog builds it once its image is up: the file's own size, walls and lights, on a preset. */
function fileFloor(id: string, floor: string, input: FileInput, scene = "Tower"): FileFloor {
  const made = plan(input);
  const map = placeMap(made, { assetId: `asset-${id}`, width: made.frame.w * 50, height: made.frame.h * 50, fileImageWidth: made.frame.w * 50 });
  assert.ok(map);
  const lit = made.lights.length > 0;
  const built = withPlayersSee(importScene(made, map, { id, name: scene, light: lit ? "dark" : "bright" }), { preset: lit ? "explore" : "reveal" }, lit ? "dark" : "bright");
  return { scene: built, plan: made, floor };
}

const CELLAR: FileInput = { size: p(10, 8), ppg: 50, walls: [[p(1, 1), p(9, 1), p(9, 7)]] };
const HALL: FileInput = { size: p(12, 9), ppg: 50, walls: [[p(1, 1), p(11, 1)]], portals: [{ a: p(5, 1), b: p(6, 1) }], lights: [{ at: p(4, 4), range: 4 }] };
const ROOF: FileInput = { size: p(10, 8), ppg: 50, walls: [[p(2, 2), p(8, 2)]] };

describe("a new scene from several files: the rows", () => {
  test("stack lowest first by file name, numbers compared as numbers, letters by their base", () => {
    assert.deepEqual(names(["Level 10.dd2vtt", "Level 2.dd2vtt", "level 3.uvtt", "Level 1.df2vtt"]), ["Level 1.df2vtt", "Level 2.dd2vtt", "level 3.uvtt", "Level 10.dd2vtt"]);
    assert.deepEqual(names(["crypt_b2.dd2vtt", "crypt_b10.dd2vtt", "Crypt_B1.dd2vtt"]), ["Crypt_B1.dd2vtt", "crypt_b2.dd2vtt", "crypt_b10.dd2vtt"]);
    // Names that sort alike keep the order they were picked in.
    assert.deepEqual(names(["Map.uvtt", "map.uvtt"]), ["Map.uvtt", "map.uvtt"]);
  });

  test("each take its file's name as the floor's, cut to 40 characters, and the scene the first file's cut the same way", () => {
    const rows = rowsOf([file("The_Sunken_Temple_of_the_Serpent_Lord_Level_2.dd2vtt"), file("The_Sunken_Temple_of_the_Serpent_Lord_Level_1.dd2vtt")]);
    assert.deepEqual(
      rows.map((r) => r.floor),
      ["The Sunken Temple of the Serpent Lord Le", "The Sunken Temple of the Serpent Lord 2"],
    );
    assert.ok(rows.every((r) => Array.from(r.floor).length <= LIMITS.floorNameChars));
    assert.equal(sceneNameOf(rows), "The Sunken Temple of the Serpent Lord Le");
    assert.ok(Array.from(sceneNameOf(rows)).length <= LIMITS.floorNameChars);
    assert.equal(rowName({ ...rows[0]!, floor: "  " }), "The Sunken Temple of the Serpent Lord Level 1", "an emptied name reads as its file's");
  });

  test("names that collide after the cut read as the floors will be named, so each row and move button has its own", () => {
    const base = "The_Sunken_Cathedral_of_Saint_Varnholm_Level_";
    const rows = rowsOf([`${base}10_Belfry.dd2vtt`, `${base}1_Undercroft.dd2vtt`, `${base}2_Nave.dd2vtt`].map(file));
    assert.deepEqual(
      rows.map((r) => r.floor),
      ["The Sunken Cathedral of Saint Varnholm L", "The Sunken Cathedral of Saint Varnholm 2", "The Sunken Cathedral of Saint Varnholm 3"],
    );
    assert.equal(new Set(rows.map(rowName)).size, 3);
    assert.ok(rows.every((r) => Array.from(r.floor).length <= LIMITS.floorNameChars));
  });

  test("typed names that collide read as the floors will be named, over the rows as they stand", () => {
    const rows = rowsOf(["a.uvtt", "b.uvtt", "c.uvtt"].map(file)).map((r, i) => ({ ...r, floor: i === 1 ? "Nave" : "Crypt" }));
    assert.deepEqual(floorNamesOf(rows), ["Crypt", "Nave", "Crypt 2"]);
    const moved = moveRow(rows, rows[2]!.key, true)!;
    assert.deepEqual(floorNamesOf(moved), ["Crypt", "Crypt 2", "Nave"]);
    assert.deepEqual(floorNamesOf(rows.map((r) => ({ ...r, floor: "Nave" }))), ["Nave", "Nave 2", "Nave 3"]);
    assert.deepEqual(floorNamesOf(rows.map((r, i) => (i === 0 ? { ...r, floor: "  " } : r))), ["a", "Nave", "Crypt"], "an emptied name reads as its file's");
    const long = "x".repeat(LIMITS.floorNameChars);
    const cut = floorNamesOf(rows.map((r) => ({ ...r, floor: long })));
    assert.equal(new Set(cut).size, 3);
    assert.ok(cut.every((n) => Array.from(n).length <= LIMITS.floorNameChars));
  });

  test("the scene name field takes 80 characters, more than the 40 it starts cut to", () => {
    assert.equal(SCENE_NAME_CHARS, 80);
    assert.ok(SCENE_NAME_CHARS > LIMITS.floorNameChars);
  });

  test("move up toward the first, lowest floor and down, keeping each row's key, and not past either end", () => {
    const rows = rowsOf(["A.uvtt", "B.uvtt", "C.uvtt"].map(file));
    const down = moveRow(rows, rows[0]!.key, false)!;
    assert.deepEqual(
      down.map((r) => r.file.name),
      ["B.uvtt", "A.uvtt", "C.uvtt"],
    );
    assert.equal(down[1]!.key, rows[0]!.key);
    assert.deepEqual(
      moveRow(down, rows[2]!.key, true)!.map((r) => r.file.name),
      ["B.uvtt", "C.uvtt", "A.uvtt"],
    );
    assert.equal(moveRow(rows, rows[0]!.key, true), null);
    assert.equal(moveRow(rows, rows[2]!.key, false), null);
  });
});

describe("a new scene from several files: the refusals before any upload", () => {
  test("more files than a scene's floors", () => {
    assert.equal(tooManyFiles(LIMITS.floorsPerScene), null);
    assert.equal(tooManyFiles(LIMITS.floorsPerScene + 1), "A scene holds at most 8 floors. Pick 8 files or fewer.");
  });

  test("more floors than the room has scenes left, each floor being a scene", () => {
    assert.equal(scenesFull(47, 3), null);
    assert.equal(scenesFull(49, 3), "A room holds at most 50 scenes, and these 3 floors would make 52. Delete a scene first.");
    const full = room();
    for (let i = 0; Object.keys(full.scenes).length < 49; i++) full.scenes[`x${i}`] = { ...full.scenes.s1!, id: `x${i}` } as Scene;
    assert.equal(Object.keys(full.scenes).length, 49);
    assert.equal(filesRefusal(full, 2), "A room holds at most 50 scenes, and these 2 floors would make 51. Delete a scene first.");
    assert.equal(filesRefusal(full, 1), null);
    assert.equal(filesRefusal(full, 9), "A scene holds at most 8 floors. Pick 8 files or fewer.", "the floors first");
  });
});

describe("a new scene from several files: the words", () => {
  test("of each step, a file's error, a failed upload and the ending", () => {
    assert.equal(dialogTitle(3), "New scene from 3 files");
    assert.equal(readingText("Level 2", 2, 3), "Reading Level 2 (2 of 3)…");
    assert.equal(uploadingText("Level 2", 2, 3), "Uploading Level 2 (2 of 3)…");
    assert.equal(addingText(3, 12, "Level 2"), "Adding walls 3 of 12 on Level 2");
    assert.equal(fileError("Level 2.dd2vtt", "This file has no map image."), "Level 2.dd2vtt: This file has no map image.");
    assert.equal(uploadFailed("Level 2"), "Level 2 could not be uploaded, so no scene was made.");
    assert.deepEqual(severalOutcomeText({ k: "complete", checked: false }, "Tower", 3, true), { text: "Tower is made with 3 floors, with every wall, door and light. Undo in Setup history.", tone: "info" });
    assert.equal(severalOutcomeText({ k: "complete", checked: false }, "Tower", 3, false).text, "Tower is made with 3 floors, with every wall, door and light. Open it from the Scenes panel. Undo in Setup history.");
    assert.match(severalOutcomeText({ k: "partial" }, "Tower", 3, true).text, /^The server refused part of the import/);
    assert.match(severalOutcomeText({ k: "none", lost: false }, "Tower", 3, true).text, /no scene was made/);
  });
});

describe("a new scene from several files: the one Setup group", () => {
  function sent(files: FileFloor[]): { state: RoomState; ops: ReturnType<typeof severalFilesOps> } {
    let n = 0;
    const made = severalFilesOps(files, () => `light-${++n}`);
    let state = room();
    let seq = 1;
    for (const op of made.ops) {
      const parsed = clientOpSchema.safeParse(op);
      assert.ok(parsed.success, parsed.success ? "" : `${op.t}: ${parsed.error.message}`);
      state = apply(state, parsed.data, undefined, ++seq);
    }
    return { state, ops: made };
  }

  test("makes the first file's scene, then each next file's floor above the one before, named and sized by its file, with its walls and lights", () => {
    const files = [fileFloor("cellar", "Cellar", CELLAR), fileFloor("hall", "Great hall", HALL), fileFloor("roof", "Roof", ROOF)];
    const { state, ops } = sent(files);
    const floors = floorsOf(state, "cellar");
    assert.deepEqual(
      floors.map((f) => [f.id, f.floor?.name, f.floor?.level, f.name]),
      [
        ["cellar", "Cellar", 0, "Tower"],
        ["hall", "Great hall", 1, "Tower"],
        ["roof", "Roof", 2, "Tower"],
      ],
    );
    assert.equal(floors[0]!.floor?.of, "cellar", "the first file's scene is the main floor");
    for (const [i, f] of floors.entries()) {
      assert.deepEqual(f.bounds, files[i]!.scene.bounds, `${f.id}'s size is its file's`);
      assert.equal(f.map?.assetId, `asset-${f.id}`);
      assert.equal(f.gridFromFile, true);
      assert.equal(f.autoWalls, "off");
    }
    // Each floor starts as its file would alone: the hall brings a light, so it starts dark under party vision.
    assert.deepEqual([floors[1]!.fogEnabled, floors[1]!.vision?.on, floors[1]!.vision?.light], [true, true, "dark"]);
    assert.notEqual(floors[0]!.vision?.on, true);
    const edgesOn = (id: string) => Object.values(state.buildChunks).filter((c) => c?.sceneId === id).reduce((n, c) => n + Object.keys(c!.edges).length + (c!.walls?.length ?? 0), 0);
    for (const [i, f] of files.entries()) assert.equal(edgesOn(f.scene.id), f.plan.edges.length + f.plan.walls.length, `${f.scene.id}'s walls`);
    assert.equal(Object.values(state.lights).filter((l) => l?.sceneId === "hall").length, 1);
    // Every op is the file's whose floor the dialog names beside its step.
    assert.equal(ops.floorAt.length, ops.ops.length);
    ops.ops.forEach((op, i) => {
      const id = op.t === "scene.create" ? op.scene.id : (op as { sceneId: string }).sceneId;
      assert.equal(id, files[ops.floorAt[i]!]!.scene.id, `op ${i}`);
    });
    assert.deepEqual(
      ops.ops.filter((op) => op.t === "scene.create").map((op) => (op.t === "scene.create" ? [op.floor?.beside, op.floor?.besideName] : null)),
      [
        [undefined, undefined],
        ["cellar", "Cellar"],
        ["hall", undefined],
      ],
      "only the first add names the floor beside",
    );
  });

  test("the names the dialog shows are the names the floors are made with, for emptied, typed and file-name repeats", () => {
    const inputs = [CELLAR, ROOF, HALL, CELLAR];
    const cases: { what: string; files: string[]; typed: (string | undefined)[] }[] = [
      { what: "an emptied name", files: ["a.uvtt", "b.uvtt", "c.uvtt"], typed: ["", undefined, ""] },
      { what: "typed repeats", files: ["a.uvtt", "b.uvtt", "c.uvtt", "d.uvtt"], typed: ["Crypt", "Crypt", "Nave", "Crypt"] },
      { what: "file names that repeat after the cut", files: ["The_Sunken_Cathedral_of_Saint_Varnholm_Level_1.uvtt", "The_Sunken_Cathedral_of_Saint_Varnholm_Level_2.uvtt", "The_Sunken_Cathedral_of_Saint_Varnholm_Level_3.uvtt"], typed: [undefined, undefined, undefined] },
      { what: "a later row typed Ground floor while the first is emptied", files: ["a.uvtt", "b.uvtt", "c.uvtt"], typed: ["", "Ground floor", "Ground floor"] },
      { what: "a first row typed Ground floor and an emptied later row", files: ["a.uvtt", "b.uvtt"], typed: ["Ground floor", ""] },
    ];
    for (const { what, files, typed } of cases) {
      const rows = rowsOf(files.map(file)).map((r, i) => (typed[i] === undefined ? r : { ...r, floor: typed[i]! }));
      const shown = floorNamesOf(rows);
      const { state } = sent(rows.map((r, i) => fileFloor(`f${i}`, shown[i]!, inputs[i % inputs.length]!)));
      assert.deepEqual(
        floorsOf(state, "f0").map((f) => f.floor?.name),
        shown,
        what,
      );
      assert.equal(new Set(shown).size, shown.length, `${what}: every shown name is its own`);
    }
  });

  test("a line under the field says what the floor will be called only where that differs from the field", () => {
    const [row] = rowsOf([file("Crypt.uvtt")]);
    assert.equal(willBeText({ ...row!, floor: "Crypt" }, "Crypt"), null);
    assert.equal(willBeText({ ...row!, floor: "  Crypt " }, "Crypt"), null, "spaces round it are cut either way");
    assert.equal(willBeText({ ...row!, floor: "Crypt" }, "Crypt 2"), "Will be Crypt 2.");
    assert.equal(willBeText({ ...row!, floor: "" }, "Crypt"), "Will be Crypt.");
  });

  test("an emptied floor name leaves the reducer's, and a name taken twice is numbered", () => {
    const { state } = sent([fileFloor("a", "", CELLAR), fileFloor("b", "Crypt", ROOF), fileFloor("c", "Crypt", CELLAR)]);
    assert.deepEqual(
      floorsOf(state, "a").map((f) => f.floor?.name),
      ["Ground floor", "Crypt", "Crypt 2"],
    );
  });
});
