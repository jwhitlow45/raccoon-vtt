import assert from "node:assert/strict";
import { test } from "node:test";
import { entranceSide, fitLine, fogLine, makingLine, NO_FOG_WARNING, outcomeText, previewName, roomsHint, sizeLine, statusLine } from "./words.ts";

test("DG-C: the size line in the room's feet per square", () => {
  assert.equal(sizeLine(30, 30, 5), "30 × 30 squares (150 by 150 ft)");
  assert.equal(sizeLine(50, 20, 10), "50 × 20 squares (500 by 200 ft)");
  assert.equal(roomsHint(10), "2 to 10 on this size");
});

test("DG-C: the status line counts rooms, doors with the locked ones, and traps", () => {
  assert.equal(statusLine({ rooms: 12, asked: 12, doors: 18, locked: 3, traps: 4 }), "12 rooms, 18 doors (3 locked), 4 traps.");
  assert.equal(statusLine({ rooms: 2, asked: 2, doors: 1, locked: 0, traps: 0 }), "2 rooms, 1 door, no traps.");
  assert.equal(statusLine({ rooms: 3, asked: 3, doors: 3, locked: 1, traps: 1 }), "3 rooms, 3 doors (1 locked), 1 trap.");
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
  assert.equal(outcomeText({ k: "complete", checked: true }, "Crypt", true).text, "The connection dropped while making Crypt, but it is complete. Undo setup in Setup history takes it back.");
  assert.deepEqual(outcomeText({ k: "none", lost: false }, "Crypt", false), { text: "The server refused the dungeon, so no scene was made.", tone: "error" });
  assert.equal(outcomeText({ k: "none", lost: true }, "Crypt", false).text, "The connection dropped, and no scene was made. Try again.");
  assert.equal(
    outcomeText({ k: "partial" }, "Crypt", true).text,
    "The server refused part of Crypt, so it may be missing rooms, doors or traps. Use Undo setup in Setup history, or Delete it from the scene's menu once the players are on another scene.",
  );
  assert.equal(
    outcomeText({ k: "unconfirmed" }, "Crypt", false).text,
    "The connection dropped while making Crypt, and it could not be confirmed complete. To start again, Delete it from the scene's menu once the players are on another scene. Open it from the Scenes panel.",
  );
  for (const k of ["partial", "unconfirmed"] as const) assert.match(outcomeText({ k }, "Crypt", true).text, /once the players are on another scene/, "Delete is refused for the players' scene");
});
