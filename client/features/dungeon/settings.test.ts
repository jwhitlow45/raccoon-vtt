import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampContext, clampRooms, clampSettings, clampSide, DEFAULT_CONTEXT, DEFAULT_SETTINGS, defaultRooms, litCount, MAX_ROOMS, raisedCount, roomCap, secretCount, SIZE_SIDES } from "./settings.ts";

describe("dungeon settings", () => {
  test("defaults: Dungeon, Medium, 12 rooms, Normal, Bending, Narrow, loops on, Heights Some, Traps Few at 1-4, dead ends, Secret doors Few, Lit rooms Few, Dressing Some, DM key on", () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      w: 50,
      h: 50,
      rooms: 12,
      density: "normal",
      corridors: "bending",
      wide: false,
      loops: true,
      theme: "dungeon",
      heights: 25,
      traps: 2,
      band: "1-4",
      deadEnds: true,
      secrets: 1,
      lit: 25,
      dressing: "some",
      key: true,
    });
  });

  test("sides are whole squares from 20 to 100", () => {
    assert.equal(clampSide(19), 20);
    assert.equal(clampSide(101), 100);
    assert.equal(clampSide(33.4), 33);
    assert.equal(clampSide(Number.NaN), 20);
    assert.equal(clampSide(Infinity), 20);
  });

  test("rooms reach one per 90 squares, 2 to 40", () => {
    assert.equal(roomCap(30, 30), 10);
    assert.equal(roomCap(20, 20), 4);
    assert.equal(roomCap(50, 50), 27);
    assert.equal(roomCap(80, 80), MAX_ROOMS);
    assert.equal(roomCap(100, 100), MAX_ROOMS);
    assert.equal(clampRooms(1, 30, 30), 2);
    assert.equal(clampRooms(16, 30, 30), 10);
    assert.equal(clampRooms(7.6, 30, 30), 8);
  });

  test("rooms start at 6, 12 and 20 on the presets, and one per 200 squares on Custom", () => {
    assert.equal(defaultRooms("small", SIZE_SIDES.small, SIZE_SIDES.small), 6);
    assert.equal(defaultRooms("medium", SIZE_SIDES.medium, SIZE_SIDES.medium), 12);
    assert.equal(defaultRooms("large", SIZE_SIDES.large, SIZE_SIDES.large), 20);
    assert.equal(defaultRooms("custom", 40, 60), 12);
    assert.equal(defaultRooms("custom", 20, 20), 2);
    assert.equal(defaultRooms("custom", 100, 100), 40);
  });

  test("anything shaped like settings reads as settings, each bad field its default", () => {
    assert.deepEqual(clampSettings({}), DEFAULT_SETTINGS);
    assert.deepEqual(clampSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
    const odd = clampSettings({ w: 500, h: -3, rooms: 99, density: "packed", corridors: 3, wide: "yes", loops: null, theme: "lava", heights: "lots", traps: "many", band: "21-30", deadEnds: 1, secrets: "few", lit: "half", dressing: "lots", key: "yes" });
    assert.deepEqual(odd, { ...DEFAULT_SETTINGS, w: 100, h: 20, rooms: roomCap(100, 20) });
    assert.deepEqual(clampSettings({ w: 30, h: 30 }), { ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 10 });
    const kept = { w: 64, h: 41, rooms: 9, density: "dense", corridors: "winding", wide: true, loops: false, theme: "crypt", heights: 0, traps: 4, band: "17-20", deadEnds: false, secrets: 4, lit: 100, dressing: "full", key: false } as const;
    assert.deepEqual(clampSettings(kept), kept);
    for (const theme of ["cave", "mine", "sewer"] as const) assert.equal(clampSettings({ theme }).theme, theme);
  });

  test("Secret doors and Lit rooms read a number to the nearest step within their sliders", () => {
    const read = (secrets: unknown, lit: unknown) => {
      const s = clampSettings({ secrets, lit });
      return [s.secrets, s.lit];
    };
    assert.deepEqual(read(2.4, 23), [2, 25]);
    assert.deepEqual(read(9, 140), [6, 100]);
    assert.deepEqual(read(-1, -5), [0, 0]);
    assert.deepEqual(read(Number.NaN, null), [1, 25]);
  });

  test("Secret doors are its twelfths of the kept rooms rounded down, at least one above None, at most 12", () => {
    assert.equal(secretCount(0, 12), 0);
    assert.equal(secretCount(1, 12), 1);
    assert.equal(secretCount(1, 6), 1, "at least one");
    assert.equal(secretCount(2, 12), 2);
    assert.equal(secretCount(4, 40), 12, "13 held at 12");
    assert.equal(secretCount(6, 40), 12);
    assert.equal(secretCount(1, 0), 0);
  });

  test("Lit rooms lights its share of the kept rooms, the entrance among them, rounded, at least one above None", () => {
    assert.equal(litCount(0, 12), 0);
    assert.equal(litCount(25, 12), 3);
    assert.equal(litCount(5, 6), 1, "at least one");
    assert.equal(litCount(50, 5), 3, "half of five rounds up");
    assert.equal(litCount(100, 40), 40);
    assert.equal(litCount(100, 1), 1);
    assert.equal(litCount(25, 0), 0);
  });

  test("a plan's context is the room's feet per square, a whole number from 1 to 100, else 5", () => {
    assert.deepEqual(clampContext({ feetPerCell: 10 }), { feetPerCell: 10 });
    assert.deepEqual(clampContext({ feetPerCell: 0 }), { feetPerCell: 1 });
    assert.deepEqual(clampContext({ feetPerCell: 250 }), { feetPerCell: 100 });
    assert.deepEqual(clampContext({ feetPerCell: Number.NaN }), DEFAULT_CONTEXT);
    assert.deepEqual(clampContext(undefined), DEFAULT_CONTEXT);
  });

  test("Heights and Traps read old choices as the marks that replaced them, and a number to its slider's nearest step", () => {
    const read = (heights: unknown, traps: unknown) => {
      const s = clampSettings({ heights, traps });
      return [s.heights, s.traps];
    };
    assert.deepEqual(read("flat", "none"), [0, 0]);
    assert.deepEqual(read("some", "few"), [25, 2]);
    assert.deepEqual(read("flat", "some"), [0, 4]);
    assert.deepEqual(read(23, 2.4), [25, 2]);
    assert.deepEqual(read(77, 7), [75, 6]);
    assert.deepEqual(read(-5, -1), [0, 0]);
    assert.deepEqual(read("toString", "constructor"), [25, 2], "only an old choice's own words");
    assert.deepEqual(read(Number.NaN, null), [25, 2]);
  });

  test("Heights raises its share of the rooms but the entrance, rounded, and at least one for any share", () => {
    assert.equal(raisedCount(0, 12), 0);
    assert.equal(raisedCount(25, 12), 3);
    assert.equal(raisedCount(75, 12), 8);
    assert.equal(raisedCount(10, 6), 1);
    assert.equal(raisedCount(5, 6), 1, "at least one");
    assert.equal(raisedCount(50, 6), 3, "half of five rounds up");
    assert.equal(raisedCount(75, 2), 1);
    assert.equal(raisedCount(75, 1), 0, "the entrance alone");
  });
});
