import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { optionsPlace, RAIL_WIDTH, railAllowed, wrapRecord, wrapsLines } from "./optionsPlace.ts";

/** A window at an interface size, as the layout reads it, with its side insets and the side panel's 360 px while it shows. */
function layout(w: number, h: number, scale: number, side: number, sidePanel = false) {
  const width = w / scale;
  return { width, height: h / scale, mapWidth: width - (sidePanel ? 360 : 0), safeLeft: side };
}

describe("whether the screen allows the rail", () => {
  test("every row of the worked sizes", () => {
    const rows: [string, ReturnType<typeof layout>, boolean][] = [
      ["844 x 390 at 100%", layout(844, 390, 1, 47), true],
      ["844 x 390 at 130%", layout(844, 390, 1.3, 47), true],
      ["667 x 375 at 100%", layout(667, 375, 1, 0), true],
      ["667 x 375 at 130%", layout(667, 375, 1.3, 0), true],
      ["932 x 430, side panel hidden", layout(932, 430, 1, 59), true],
      ["932 x 430, side panel shown", layout(932, 430, 1, 59, true), false],
      ["932 x 430 at 130%", layout(932, 430, 1.3, 59), true],
      ["568 x 320 at 100%", layout(568, 320, 1, 0), true],
      ["480 x 320 at 100%", layout(480, 320, 1, 47), false],
      ["480 x 320 at 130%", layout(480, 320, 1.3, 47), false],
    ];
    for (const [name, l, allowed] of rows) assert.equal(railAllowed(l), allowed, name);
  });

  test("the rail and its inset may take exactly half the map, and not a pixel more", () => {
    const half = 2 * (RAIL_WIDTH + 47);
    assert.equal(railAllowed({ width: half, height: 390, mapWidth: half, safeLeft: 47 }), true);
    assert.equal(railAllowed({ width: half - 1, height: 390, mapWidth: half - 1, safeLeft: 47 }), false);
  });

  test("short means under 500 px tall: 499 is, 500 is not", () => {
    assert.equal(railAllowed({ width: 1032, height: 499, mapWidth: 1032, safeLeft: 0 }), true);
    assert.equal(railAllowed({ width: 1032, height: 500, mapWidth: 1032, safeLeft: 0 }), false);
  });

  test("upright and square layouts, tablets and computers keep the foot", () => {
    assert.equal(railAllowed({ width: 400, height: 400, mapWidth: 400, safeLeft: 0 }), false, "a square layout is not sideways");
    assert.equal(railAllowed(layout(390, 844, 1, 0)), false);
    assert.equal(railAllowed(layout(1180, 820, 1.3, 0)), false, "an iPad sideways at 130% lays out 631 tall");
    assert.equal(railAllowed(layout(1280, 800, 1, 0, true)), false);
    assert.equal(railAllowed(layout(1280, 480, 1, 0)), true, "a computer window 480 tall with the side panel hidden");
  });
});

describe("where a tool's options go", () => {
  const multiRow = ["ruler", "area", "draw", "fog", "build", "grid"];

  test("each multi-row tool takes the rail where it is allowed, and the foot elsewhere", () => {
    for (const toolId of multiRow) {
      assert.equal(optionsPlace({ allowed: true, toolId, footWidth: 844, wrappedAt: null }), "rail", toolId);
      assert.equal(optionsPlace({ allowed: false, toolId, footWidth: 480, wrappedAt: null }), "foot", toolId);
    }
  });

  test("Ping, Pin and Add token stay at the foot until their row wraps, then take the rail up to that width", () => {
    for (const toolId of ["ping", "pin", "add-token"]) {
      assert.equal(optionsPlace({ allowed: true, toolId, optionsAt: "foot", footWidth: 844, wrappedAt: null }), "foot", toolId);
      assert.equal(optionsPlace({ allowed: true, toolId, optionsAt: "foot", footWidth: 649, wrappedAt: 649 }), "rail", `${toolId} where it wrapped`);
      assert.equal(optionsPlace({ allowed: true, toolId, optionsAt: "foot", footWidth: 513, wrappedAt: 649 }), "rail", `${toolId} narrower`);
      assert.equal(optionsPlace({ allowed: true, toolId, optionsAt: "foot", footWidth: 650, wrappedAt: 649 }), "foot", `${toolId} wider than the record`);
      assert.equal(optionsPlace({ allowed: false, toolId, optionsAt: "foot", footWidth: 369, wrappedAt: 649 }), "foot", `${toolId} where the rail is not allowed`);
    }
  });

  test("Select several stays at the foot always, a record or not", () => {
    assert.equal(optionsPlace({ allowed: true, toolId: "select", optionsAt: "foot", footWidth: 513, wrappedAt: null }), "foot");
    assert.equal(optionsPlace({ allowed: true, toolId: "select", optionsAt: "foot", footWidth: 513, wrappedAt: 900 }), "foot");
  });

  test("the record keeps the widest foot a row wrapped at", () => {
    assert.equal(wrapRecord(null, 649), 649);
    assert.equal(wrapRecord(649, 513), 649);
    assert.equal(wrapRecord(513, 649), 649);
  });

  test("the record is made from the controls' boxes as drawn: on one line or more", () => {
    // Pin's swatches (36 px) and DM only (44 px) on one line, centered: the tops differ, the line does not.
    assert.equal(wrapsLines([{ top: 4, bottom: 48 }, { top: 8, bottom: 44 }, { top: 8, bottom: 44 }]), false);
    assert.equal(wrapsLines([{ top: 4, bottom: 48 }, { top: 52, bottom: 96 }]), true, "a second line");
    assert.equal(wrapsLines([]), false);
    assert.equal(wrapsLines([{ top: 4, bottom: 48 }]), false);
  });
});
