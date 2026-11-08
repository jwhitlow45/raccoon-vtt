import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { DEFAULT_CHOICES, loadChoices, parseChoices, roomsDefault, saveChoices, settingsOf, sidesOf, startChoices, withSize, type Choices } from "./remembered.ts";
import { clampRooms, roomCap } from "./settings.ts";

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test("DG-C: the defaults are Dungeon, Medium, 12 rooms, Normal, Bending, Narrow, loops on, Heights Some, Traps Few at 1-4", () => {
  const s = settingsOf(DEFAULT_CHOICES);
  assert.deepEqual(s, { theme: "dungeon", w: 50, h: 50, rooms: 12, density: "normal", corridors: "bending", wide: false, loops: true, heights: 25, traps: 2, band: "1-4", deadEnds: true, secrets: 1, lit: 25, dressing: "some", key: true });
});

test("DG-C: a size's rooms start at 6, 12, 20 or one per 200 squares", () => {
  assert.deepEqual(["small", "medium", "large"].map((size) => roomsDefault({ size: size as Choices["size"], across: 0, down: 0 })), [6, 12, 20]);
  assert.equal(roomsDefault({ size: "custom", across: 60, down: 40 }), 12);
  assert.equal(roomsDefault({ size: "custom", across: 20, down: 20 }), 2);
});

test("DG-C: a size change moves untouched rooms to the new default and clamps a typed count", () => {
  const medium = DEFAULT_CHOICES;
  assert.equal(withSize(medium, { size: "small" }).rooms, 6);
  assert.equal(withSize(medium, { size: "large" }).rooms, 20);
  const typed = { ...medium, rooms: 25 };
  assert.equal(withSize(typed, { size: "small" }).rooms, 10, "clamped to Small's limit");
  assert.equal(withSize({ ...medium, rooms: 15 }, { size: "large" }).rooms, 15, "a typed count is kept");
});

test("DG-C: Custom starts at the form's size, clamped to 20 to 100, until a choice is kept", () => {
  const c = startChoices(null, { w: 140, h: 12 });
  assert.equal(c.size, "medium");
  assert.deepEqual(sidesOf({ ...c, size: "custom" }), { w: 100, h: 20 });
  const kept = { ...DEFAULT_CHOICES, size: "custom" as const, across: 64, down: 40 };
  assert.deepEqual(startChoices(kept, { w: 30, h: 20 }), kept);
});

test("DG-C: choices round trip through storage per room, and no seed or other field is written", () => {
  const storage = memory();
  const c: Choices = { ...DEFAULT_CHOICES, theme: "crypt", size: "custom", across: 70, down: 45, rooms: 18, wide: true, heights: 50, traps: 6, band: "11-16" };
  saveChoices("ROOM1", { ...c, seed: "1K7Q-H2MX-A9F3-TWQ5" } as Choices, storage);
  assert.deepEqual(loadChoices("ROOM1", storage), c);
  assert.equal(loadChoices("ROOM2", storage), null);
  const raw = storage.data.get("rvtt.dungeon.ROOM1")!;
  assert.doesNotMatch(raw, /seed|1K7Q/i);
});

test("DG-C: a stored Custom size out of range comes back clamped, as its fields show it", () => {
  const c = parseChoices(JSON.stringify({ size: "custom", across: 500, down: 3, rooms: 99 }))!;
  assert.deepEqual([c.across, c.down, c.rooms], [100, 20, 22]);
});

test("DG-C: a storage that throws loses only the convenience", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(loadChoices("ROOM1", broken), null);
  assert.doesNotThrow(() => saveChoices("ROOM1", DEFAULT_CHOICES, broken));
  assert.equal(loadChoices("ROOM1", null), null);
});

test("DG-C: whatever storage holds parses to valid choices or nothing", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json(), fc.dictionary(fc.constantFrom("theme", "size", "across", "down", "rooms", "density", "corridors", "wide", "loops", "heights", "traps", "band"), fc.jsonValue()).map((o) => JSON.stringify(o))), (raw) => {
      const c = parseChoices(raw);
      if (c === null) return;
      assert.ok(c.across >= 20 && c.across <= 100 && c.down >= 20 && c.down <= 100, "Custom's fields show sides in range");
      const s = settingsOf(c);
      assert.ok(s.w >= 20 && s.w <= 100 && s.h >= 20 && s.h <= 100);
      assert.ok(s.rooms >= 2 && s.rooms <= roomCap(s.w, s.h));
      assert.equal(clampRooms(s.rooms, s.w, s.h), s.rooms);
      assert.ok(["dungeon", "crypt"].includes(s.theme));
      assert.ok(["1-4", "5-10", "11-16", "17-20"].includes(s.band));
      assert.equal(typeof s.wide, "boolean");
    }),
  );
});

test("DGOPTS: choices kept before the sliders read as the marks that replaced them", () => {
  const storage = memory();
  storage.setItem("rvtt.dungeon.OLD", JSON.stringify({ ...DEFAULT_CHOICES, heights: "flat", traps: "some" }));
  assert.deepEqual(loadChoices("OLD", storage), { ...DEFAULT_CHOICES, heights: 0, traps: 4 });
  storage.setItem("rvtt.dungeon.OLD", JSON.stringify({ ...DEFAULT_CHOICES, heights: "some", traps: "none" }));
  assert.deepEqual(loadChoices("OLD", storage), { ...DEFAULT_CHOICES, heights: 25, traps: 0 });
});
