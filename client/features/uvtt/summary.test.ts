import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Summary } from "./convert.ts";
import { foundLine, imageNote, notes, sizeText } from "./summary.ts";

const NONE: Summary = { gridWalls: 0, freeWalls: 0, doors: 0, windows: 0, lights: 0, lightsLeftOut: 0, lightsMoved: 0, welded: 0, clipped: 0, tolerance: 0.05 };

describe("the summary sheet", () => {
  test("says what the file holds, as the design words it", () => {
    assert.equal(foundLine({ ...NONE, gridWalls: 380, freeWalls: 32, doors: 14, windows: 3, lights: 9 }), "412 walls (380 on the grid, 32 free), 14 doors, 3 windows, 9 lights.");
    assert.equal(foundLine({ ...NONE, gridWalls: 1, doors: 1, windows: 1, lights: 1 }), "1 wall, 1 door, 1 window, 1 light.");
    assert.equal(foundLine({ ...NONE, freeWalls: 4000 }), "4,000 walls, 0 doors, 0 windows, 0 lights.");
  });

  test("notes what the import changed, and nothing when it changed nothing", () => {
    assert.deepEqual(notes(NONE), []);
    const all = notes({ ...NONE, welded: 12, clipped: 1, lightsLeftOut: 20, lightsMoved: 1, tolerance: 0.2 });
    assert.equal(all.length, 5);
    assert.match(all[0]!, /^Joined 12 wall ends/);
    assert.match(all[2]!, /20 smallest lights: a scene holds 100/);
  });

  test("says an image is drawn down only when it is over 8,192 px, and encoded again when only its file is too big", () => {
    assert.equal(imageNote({ width: 4000, height: 2800 }, false), "");
    assert.equal(imageNote({ width: 9000, height: 6300 }, true), ", drawn down to 8,192 pixels on its long side before it uploads");
    assert.equal(imageNote({ width: 4000, height: 2800 }, true), ", encoded again at this size before it uploads, since the image is over 32 MB");
  });

  test("sizes read in KB and MB", () => {
    assert.equal(sizeText(800 * 1024), "800 KB");
    assert.equal(sizeText(24 * 1024 * 1024), "24 MB");
  });
});
