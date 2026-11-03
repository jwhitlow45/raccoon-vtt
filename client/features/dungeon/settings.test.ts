import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampRooms, clampSettings, clampSide, DEFAULT_SETTINGS, defaultRooms, MAX_ROOMS, roomCap, SIZE_SIDES } from "./settings.ts";

describe("dungeon settings", () => {
  test("defaults: Dungeon, Medium, 12 rooms, Normal, Bending, Narrow, loops on, Heights Some, Traps Few at 1-4", () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      w: 50,
      h: 50,
      rooms: 12,
      density: "normal",
      corridors: "bending",
      wide: false,
      loops: true,
      theme: "dungeon",
      heights: "some",
      traps: "few",
      band: "1-4",
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
    const odd = clampSettings({ w: 500, h: -3, rooms: 99, density: "packed", corridors: 3, wide: "yes", loops: null, theme: "cave", heights: "lots", traps: "many", band: "21-30" });
    assert.deepEqual(odd, { ...DEFAULT_SETTINGS, w: 100, h: 20, rooms: roomCap(100, 20) });
    assert.deepEqual(clampSettings({ w: 30, h: 30 }), { ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 10 });
    const kept = { w: 64, h: 41, rooms: 9, density: "dense", corridors: "winding", wide: true, loops: false, theme: "crypt", heights: "flat", traps: "some", band: "17-20" } as const;
    assert.deepEqual(clampSettings(kept), kept);
  });
});
