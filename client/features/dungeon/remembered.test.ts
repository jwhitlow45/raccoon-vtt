import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  bandFollows,
  bandTransition,
  DEFAULT_CHOICES,
  followedBand,
  keptSize,
  loadChoices,
  monstersHeld,
  parseChoices,
  partyBand,
  partyLevel,
  restocked,
  roomsDefault,
  rowChanged,
  saveChoices,
  settingsOf,
  sidesOf,
  startChoices,
  stockedShare,
  withSize,
  type Choices,
} from "./remembered.ts";
import { clampRooms, clampSettings, roomCap } from "./settings.ts";

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

/* Phase 3 (design 2.1, 2.5, 4.2): sizes and rooms on hexes, and settings as the planner compares them. */
test("DG3: on hexes Custom stops at 87 across the rows, the presets stand, and Rooms stop at 24", () => {
  const custom = { ...DEFAULT_CHOICES, size: "custom" as const, across: 100, down: 100, rooms: 40 };
  assert.deepEqual(sidesOf(custom, "hexRows"), { w: 100, h: 87 });
  assert.deepEqual(sidesOf(custom, "hexColumns"), { w: 87, h: 100 });
  assert.deepEqual(sidesOf(custom, "squares"), { w: 100, h: 100 });
  assert.deepEqual(sidesOf({ ...custom, size: "large" }, "hexRows"), { w: 80, h: 80 });
  assert.equal(settingsOf(custom, "hexRows").rooms, 24);
  assert.equal(settingsOf(custom, "squares").rooms, 40);
  assert.equal(roomsDefault({ size: "custom", across: 100, down: 87 }, "hexRows"), 24);
});

test("DG3: settings come in clampSettings' order, so the JSON an edit freezes is the planner's", () => {
  const s = settingsOf({ ...DEFAULT_CHOICES, rooms: 9 });
  assert.equal(JSON.stringify(s), JSON.stringify(clampSettings(s)));
});

/*
 * DSTOCK (docs/design/design-v1-dungeon-stock.md 4, D-261127-061, 219): the
 * Monsters choices are remembered beside the rest, and the Traps band
 * follows the party only at the DM's transitions and Held changes.
 */

test("DSTOCK-R: the Monsters choices and the DM's own band round trip, and an older device's band is its own pick", () => {
  const storage = memory();
  const c: Choices = { ...DEFAULT_CHOICES, monsters: 50, difficulty: "high", band: "5-10", ownBand: "11-16" };
  saveChoices("ROOMS", c, storage);
  assert.deepEqual(loadChoices("ROOMS", storage), c);
  const { monsters: _m, difficulty: _d, ownBand: _o, ...old } = { ...DEFAULT_CHOICES, band: "11-16" as const };
  storage.setItem("rvtt.dungeon.OLDER", JSON.stringify(old));
  assert.deepEqual(loadChoices("OLDER", storage), { ...DEFAULT_CHOICES, band: "11-16", ownBand: "11-16" });
  storage.setItem("rvtt.dungeon.ODD", JSON.stringify({ ...c, monsters: 33, difficulty: "deadly", ownBand: "9-12" }));
  const odd = loadChoices("ODD", storage)!;
  assert.deepEqual([odd.monsters, odd.difficulty, odd.ownBand], [35, "moderate", "5-10"]);
  // The settings the generator reads hold no stock, so the frozen layout of an edit never moves with it (D-261127-061).
  assert.deepEqual(settingsOf(c), settingsOf({ ...c, monsters: 0, difficulty: "low", ownBand: "1-4" }));
});

test("DSTOCK-R: the party's band is its mean level, weighted by count and rounded down", () => {
  assert.equal(partyBand([]), null);
  assert.equal(partyBand([{ count: 4, level: 3 }]), "1-4");
  assert.equal(partyBand([{ count: 3, level: 4 }, { count: 1, level: 5 }]), "1-4");
  assert.equal(partyBand([{ count: 2, level: 4 }, { count: 2, level: 6 }]), "5-10");
  assert.equal(partyBand([{ count: 1, level: 16 }, { count: 1, level: 17 }]), "11-16");
  assert.equal(partyBand([{ count: 1, level: 20 }]), "17-20");
  assert.equal(partyLevel([{ count: 3, level: 4 }, { count: 1, level: 6 }]), 4);
  assert.equal(monstersHeld([]), true);
  assert.equal(stockedShare({ monsters: 50 }, []), 0, "held at None without a level");
  assert.equal(stockedShare({ monsters: 50 }, [{ count: 1, level: 1 }]), 50);
});

const FOUR_3 = [{ count: 4, level: 3 }];
const FOUR_5 = [{ count: 4, level: 5 }];
const banded = (over: Partial<Choices> = {}): Choices => ({ ...DEFAULT_CHOICES, traps: 2, band: "1-4", ownBand: "1-4", ...over });

test("DSTOCK-R: Monsters None to Few with a party in another band moves the band and drops the edits, and back to None returns the DM's pick", () => {
  const c = banded();
  const on = restocked(c, { ...c, monsters: 25 }, FOUR_5, FOUR_5, false);
  assert.deepEqual([on.next.band, on.drop], ["5-10", true]);
  assert.equal(on.next.ownBand, "1-4", "the DM's own pick is kept");
  const off = restocked(on.next, { ...on.next, monsters: 0 }, FOUR_5, FOUR_5, false);
  assert.deepEqual([off.next.band, off.drop], ["1-4", true]);
  // In the party's own band the same crossing keeps the edits.
  assert.deepEqual(restocked(c, { ...c, monsters: 25 }, FOUR_3, FOUR_3, false), { next: { ...c, monsters: 25 }, drop: false });
});

test("DSTOCK-R: Monsters, Difficulty and party changes keep the edits while the band holds", () => {
  const c = banded({ monsters: 50 });
  assert.equal(restocked(c, { ...c, monsters: 75 }, FOUR_3, FOUR_3, false).drop, false, "a share above None to another");
  assert.equal(restocked(c, { ...c, difficulty: "high" }, FOUR_3, FOUR_3, false).drop, false, "Difficulty");
  assert.equal(restocked(c, c, FOUR_3, [{ count: 5, level: 3 }], true).drop, false, "a party edit in the same band");
  const across = restocked(c, c, FOUR_3, FOUR_5, true);
  assert.deepEqual([across.next.band, across.drop], ["5-10", true], "a party edit across a band moves it");
});

test("DSTOCK-R: a live level-up across a band is no transition: the band and the edits stay, and the next change moves it", () => {
  const c = banded({ monsters: 50 });
  assert.equal(bandTransition(c, c, FOUR_3, FOUR_5, false), false);
  assert.deepEqual(restocked(c, c, FOUR_3, FOUR_5, false), { next: c, drop: false });
  assert.deepEqual(restocked(c, { ...c, difficulty: "low" }, FOUR_5, FOUR_5, false), { next: { ...c, difficulty: "low" }, drop: false }, "Difficulty is no transition either");
  assert.equal(restocked(c, { ...c, monsters: 0 }, FOUR_5, FOUR_5, false).next.band, "1-4");
});

test("DSTOCK-R: Traps at None follows nothing, Traps crossing None while Monsters is on follows, and a band pick is the DM's own", () => {
  const c = banded({ traps: 0, monsters: 50 });
  assert.equal(bandFollows(c, FOUR_5), false);
  assert.equal(rowChanged(c, { theme: "crypt" }, FOUR_5).band, "1-4");
  const traps = rowChanged(c, { traps: 2 }, FOUR_5);
  assert.equal(traps.band, "5-10", "Traps crossing None while Monsters is on");
  assert.equal(rowChanged(traps, { traps: 0 }, FOUR_5).band, "1-4", "and back to the DM's pick");
  const pick = rowChanged(banded(), { band: "11-16" }, FOUR_5);
  assert.deepEqual([pick.band, pick.ownBand], ["11-16", "11-16"]);
});

test("DSTOCK-R: Monsters' Held state changing is a transition, both ways", () => {
  const c = banded({ monsters: 50 });
  assert.equal(bandTransition(c, c, [], FOUR_5, false), true);
  assert.deepEqual(restocked(c, c, [], FOUR_5, false), { next: { ...c, band: "5-10" }, drop: true });
  const held = restocked({ ...c, band: "5-10" }, { ...c, band: "5-10" }, FOUR_5, [], false);
  assert.deepEqual([held.next.band, held.drop], ["1-4", true]);
  assert.equal(followedBand(c, []), "1-4");
});
