import assert from "node:assert/strict";
import { test } from "node:test";
import { entranceSide, fitLine, fogLine, makingLine, NO_FOG_WARNING, outcomeText, previewName, roomsHint, sizeLine, statusLine } from "./words.ts";

test("DG-C: the size line in the room's feet per square", () => {
  assert.equal(sizeLine(30, 30, 5), "30 × 30 squares (150 by 150 ft)");
  assert.equal(sizeLine(50, 20, 10), "50 × 20 squares (500 by 200 ft)");
  assert.equal(roomsHint(10), "2 to 10 on this size. Fewer fit when the layout is tight.");
});

test("DG-C: the status line counts rooms, doors with the locked ones, and traps", () => {
  assert.equal(statusLine({ rooms: 12, asked: 12, doors: 18, locked: 3, traps: 4, secretDoors: 0, secretRooms: 0, lights: 0 }), "12 rooms, 18 doors (3 locked), 4 traps.");
  assert.equal(statusLine({ rooms: 2, asked: 2, doors: 1, locked: 0, traps: 0, secretDoors: 0, secretRooms: 0, lights: 0 }), "2 rooms, 1 door, no traps.");
  assert.equal(statusLine({ rooms: 3, asked: 3, doors: 3, locked: 1, traps: 1, secretDoors: 0, secretRooms: 0, lights: 0 }), "3 rooms, 3 doors (1 locked), 1 trap.");
});

test("DG-C: fewer rooms than asked says how many fit, and all of them says nothing", () => {
  assert.equal(fitLine({ rooms: 14, asked: 16 }), "Fit 14 of 16 rooms. A larger size or fewer rooms fits them all.");
  assert.equal(fitLine({ rooms: 16, asked: 16 }), null);
});

test("DG-C: the fog warning shows only where the form's Players see leaves fog off", () => {
  assert.equal(fogLine({ preset: "all" }), NO_FOG_WARNING);
  assert.equal(fogLine({ preset: "explore" }), null);
  assert.equal(fogLine({ preset: "reveal" }), null);
  assert.equal(fogLine({ like: { fogEnabled: false, blockMovement: false } }), NO_FOG_WARNING);
  assert.equal(fogLine({ like: { fogEnabled: true, blockMovement: false } }), null);
});

test("DG-C: the entrance's side is the nearest edge, ties going west, north, east, south", () => {
  const plan = (x: number, y: number, w = 4, h = 4) => ({ w: 30, h: 30, entrance: { x, y, w, h } });
  assert.equal(entranceSide(plan(2, 12)), "west");
  assert.equal(entranceSide(plan(12, 2)), "north");
  assert.equal(entranceSide(plan(24, 12)), "east");
  assert.equal(entranceSide(plan(12, 24)), "south");
  assert.equal(entranceSide(plan(2, 2)), "west", "west before north");
  assert.equal(entranceSide(plan(24, 2)), "north", "north before east");
  assert.equal(entranceSide(plan(24, 24)), "east", "east before south");
  assert.equal(previewName({ rooms: 12 }, "west"), "Preview of the dungeon: 12 rooms, entrance on the west side.");
});

test("DG-C: Make's progress and every outcome in its sentence", () => {
  assert.equal(makingLine(18, 30), "Making the dungeon… 18 of 30");
  assert.deepEqual(outcomeText({ k: "complete", checked: false }, "Crypt", true), { text: "Made Crypt.", tone: "info" });
  assert.deepEqual(outcomeText({ k: "complete", checked: false }, "Crypt", false), { text: "Made Crypt. Open it from the Scenes panel.", tone: "info" });
  assert.equal(outcomeText({ k: "complete", checked: true }, "Crypt", true).text, "The connection dropped while making Crypt, but it is complete. Undo setup in Setup history usually takes it back, and Delete in the scene's menu always does, once the players are on another scene.");
  assert.deepEqual(outcomeText({ k: "none", lost: false }, "Crypt", false), { text: "The server refused the dungeon, so no scene was made.", tone: "error" });
  assert.equal(outcomeText({ k: "none", lost: true }, "Crypt", false).text, "The connection dropped, and no scene was made. Try again.");
  assert.equal(
    outcomeText({ k: "partial" }, "Crypt", true).text,
    "The server refused part of Crypt, so it may be missing rooms, doors or traps. Once the players are on another scene, Undo setup in Setup history or Delete in the scene's menu takes it back.",
  );
  assert.equal(
    outcomeText({ k: "unconfirmed" }, "Crypt", false).text,
    "The connection dropped while making Crypt, and it could not be confirmed complete. To start again, Delete it from the scene's menu once the players are on another scene. Open it from the Scenes panel.",
  );
  // DG-R1-03: Undo setup and Delete are both refused for the players' scene, so every way back names moving them.
  for (const o of [{ k: "partial" }, { k: "unconfirmed" }, { k: "complete", checked: true }] as const) assert.match(outcomeText(o, "Crypt", true).text, /once the players are on another scene/i, `${o.k}: Undo setup and Delete are refused for the players' scene`);
});

/*
 * Phase 2's words (design-phase2 4.1): the status line with secrets, the
 * secret-room fog warning, the two rows' words, the light line and the
 * scene Make sends.
 */
const {
  fogLine: fogLine2,
  lightLine,
  litWords,
  NO_FOG_SECRET_WARNING,
  previewName: previewName2,
  secretsWords,
  startScene,
  statusLine: statusLine2,
} = await import("./words.ts");

const counts = { rooms: 12, asked: 12, doors: 18, locked: 3, traps: 4, secretDoors: 2, secretRooms: 1, lights: 3 };

test("the status line names secret rooms and secret doors, and a cave says no doors", () => {
  assert.equal(statusLine2(counts), "12 rooms (1 secret), 18 doors (3 locked, 2 secret), 4 traps.");
  assert.equal(statusLine2({ ...counts, locked: 0 }), "12 rooms (1 secret), 18 doors (2 secret), 4 traps.");
  assert.equal(statusLine2({ ...counts, secretDoors: 0, secretRooms: 0 }), "12 rooms, 18 doors (3 locked), 4 traps.");
  assert.equal(statusLine2({ ...counts, doors: 0, locked: 0, secretDoors: 0, secretRooms: 0 }), "12 rooms, no doors, 4 traps.");
});

test("the fog warning adds secret rooms only when the plan has one", () => {
  assert.equal(fogLine2({ preset: "all" }, true), NO_FOG_SECRET_WARNING);
  assert.equal(NO_FOG_SECRET_WARNING, "Players see this scene without fog, so every room shows at once, secret rooms too. Explore or Reveal by hand keeps rooms dark until found.");
  assert.equal(fogLine2({ preset: "all" }, false), NO_FOG_WARNING);
  assert.equal(fogLine2({ preset: "explore" }, true), null);
});

test("the sliders say their value in words, for the rooms asked", () => {
  assert.equal(secretsWords(0, 12), "No secret doors");
  assert.equal(secretsWords(1, 12), "About 1 secret door");
  assert.equal(secretsWords(2, 12), "About 2 secret doors");
  assert.equal(litWords(0, 12), "No lights");
  assert.equal(litWords(25, 12), "About 3 of 12 rooms lit");
  assert.equal(litWords(5, 2), "About 1 of 2 rooms lit");
});

test("the light line flips between its two states and keeps the import's words", () => {
  assert.deepEqual(lightLine(false), { text: "The scene starts dark with party vision on, so its lights light it for the party.", action: "Keep it lit" });
  assert.deepEqual(lightLine(true), { text: "Start the scene dark with party vision on, so its lights light it for the party.", action: "Start it dark" });
});

test("the preview's name adds secret doors and lit rooms when there are any", () => {
  assert.equal(previewName2(counts, "west"), "Preview of the dungeon: 12 rooms, 2 secret doors, 3 lit rooms, entrance on the west side.");
  assert.equal(previewName2({ rooms: 12, secretDoors: 1, lights: 1 }, "east"), "Preview of the dungeon: 12 rooms, 1 secret door, 1 lit room, entrance on the east side.");
  assert.equal(previewName2({ rooms: 12, secretDoors: 0, lights: 0 }, "north"), "Preview of the dungeon: 12 rooms, entrance on the north side.");
});

test("Make starts the scene dark under party vision for lit rooms, and Keep it lit puts back the form's pick and Bright", () => {
  const scene = { id: "s", name: "n", bounds: { w: 30, h: 30 }, background: "#000", fogEnabled: false, autoWalls: "floor", blockMovement: true } as unknown as Parameters<typeof startScene>[0];
  for (const pick of [{ preset: "all" }, { preset: "reveal" }, { preset: "explore" }] as const) {
    const dark = startScene(scene, pick, true);
    assert.equal(dark.fogEnabled, true, pick.preset);
    assert.deepEqual(dark.vision, { on: true, light: "dark" }, pick.preset);
  }
  const lit = startScene(scene, { preset: "reveal" }, false);
  assert.equal(lit.fogEnabled, true);
  assert.equal(lit.vision, undefined, "Reveal by hand keeps no party vision");
  assert.deepEqual(startScene(scene, { preset: "explore" }, false).vision, { on: true, light: "bright" });
  assert.equal(startScene(scene, { preset: "all" }, false).fogEnabled, false);
});
