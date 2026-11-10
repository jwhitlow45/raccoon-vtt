import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { DEFAULT_CHOICES, keptSize, loadChoices, parseChoices, roomsDefault, saveChoices, settingsOf, sidesOf, startChoices, withSize, type Choices } from "./remembered.ts";
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

/*
 * Generate a dungeon aimed at a floor (docs/design/design-v1-floors.md
 * phase 3, 3.7, D-261110-185): Custom at the floor beside's size over the
 * remembered choices, and an autosave that writes every choice but the size.
 */
test("FL3S: on a floor 140 by 60 with a remembered Large crypt, the dialog opens on Custom 100 by 60 with the crypt, and its saves leave Large remembered", () => {
  const storage = memory();
  const large: Choices = withSize({ ...DEFAULT_CHOICES, theme: "crypt", dressing: "full" }, { size: "large" });
  saveChoices("ROOM1", large, storage);
  const saved = loadChoices("ROOM1", storage);
  const open = startChoices(saved, { w: 30, h: 30 }, { w: 140, h: 60 });
  assert.deepEqual([open.size, open.across, open.down, open.theme, open.dressing], ["custom", 100, 60, "crypt", "full"]);
  assert.deepEqual(sidesOf(open), { w: 100, h: 60 });
  assert.equal(open.rooms, roomsDefault(open), "rooms left at Large's default move to the floor's");
  const kept = keptSize(saved, open.rooms);
  // The dialog saves as it opens, so a Cancel at once leaves this.
  saveChoices("ROOM1", open, storage, kept);
  assert.equal(loadChoices("ROOM1", storage)!.rooms, large.rooms, "rooms at the floor's default are saved as Large's (review FL3-OPUS-1)");
  // The DM changes the size and the theme, each change saved, then cancels.
  const changed = { ...withSize(open, { across: 80 }), theme: "mine" as const };
  saveChoices("ROOM1", changed, storage, kept);
  const after = loadChoices("ROOM1", storage)!;
  assert.deepEqual([after.size, after.across, after.down], [large.size, large.across, large.down], "the remembered size stays Large");
  assert.equal(after.theme, "mine", "every other choice is remembered");
  assert.equal(after.rooms, large.rooms, "and the rooms still at the default stay Large's");
  const typed = { ...changed, rooms: 7 };
  saveChoices("ROOM1", typed, storage, kept);
  assert.equal(loadChoices("ROOM1", storage)!.rooms, 7, "a typed count is remembered as typed");
  saveChoices("ROOM1", changed, storage, kept);
  const next = startChoices(after, { w: 30, h: 30 });
  assert.equal(next.size, "large", "the next New scene dungeon opens on Large");
});

test("FL3S: a floor with nothing remembered opens on Custom at its size, clamped, and keeps the defaults' size", () => {
  const open = startChoices(null, { w: 30, h: 30 }, { w: 12, h: 300 });
  assert.deepEqual([open.size, open.across, open.down, open.theme], ["custom", 20, 100, DEFAULT_CHOICES.theme]);
  assert.deepEqual(keptSize(null, open.rooms), { size: DEFAULT_CHOICES.size, across: DEFAULT_CHOICES.across, down: DEFAULT_CHOICES.down, rooms: DEFAULT_CHOICES.rooms, opened: open.rooms });
});

test("FL3S: a typed 30 rooms on Large, clamped on a 30 by 30 floor, stays 30 beside Large unless the DM types another count (FL3-OPUS-7)", () => {
  const storage = memory();
  saveChoices("ROOM1", { ...withSize(DEFAULT_CHOICES, { size: "large" }), rooms: 30 }, storage);
  const saved = loadChoices("ROOM1", storage)!;
  assert.equal(saved.rooms, 30);
  const open = startChoices(saved, { w: 30, h: 30 }, { w: 30, h: 30 });
  assert.ok(open.rooms < 30, "the floor's dialog shows the count clamped to its cap");
  const kept = keptSize(saved, open.rooms);
  saveChoices("ROOM1", open, storage, kept);
  assert.equal(loadChoices("ROOM1", storage)!.rooms, 30, "opened and cancelled: still 30");
  saveChoices("ROOM1", { ...open, rooms: open.rooms - 1 }, storage, kept);
  assert.equal(loadChoices("ROOM1", storage)!.rooms, open.rooms - 1, "a count typed in the dialog is remembered");
});
