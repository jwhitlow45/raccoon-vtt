import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { TRINKETS } from "#shared/srd/trinkets.ts";
import { dressedRooms, handKey, HAND_SETTINGS, hundredPlan, twoRooms } from "./handPlans.ts";
import { KEY_FOLDER, keyIntro, keyOps, keyTitle, madeWith, roomLine } from "./keyPage.ts";
import { PAGE_PLACEHOLDER, SCENE_PLACEHOLDER } from "./ops.ts";
import type { DungeonPlan, KeyRoom } from "./plan.ts";
import { DEFAULT_SETTINGS, type DungeonSettings } from "./settings.ts";

/*
 * The DM key's words and ops (dungeon generator phase 2, 5.6 and section
 * 6), read as the DM reads the page.
 */

const CRYPT: DungeonSettings = { ...DEFAULT_SETTINGS, theme: "crypt" };

test("DG2B: names of 76, 77 and 80 characters fit 80 with \" key\", cut back to a space in the last 20", () => {
  const name = (n: number) => "a".repeat(n);
  assert.equal(keyTitle(name(76)), `${name(76)} key`);
  assert.equal(keyTitle(name(77)), `${name(76)} key`, "no space: cut at 76");
  assert.equal(keyTitle(name(80)).length, 80);
  const words = `${"a".repeat(60)} ${"b".repeat(19)}`;
  assert.equal(words.length, 80);
  assert.equal(keyTitle(words), `${"a".repeat(60)} key`, "a word cut short is left out");
  const far = `${"a".repeat(50)} ${"b".repeat(29)}`;
  assert.equal(keyTitle(far), `${far.slice(0, 76)} key`, "a space past the last 20 is not looked for");
  for (const n of [1, 40, 76, 77, 78, 79, 80]) assert.ok(keyTitle(name(n)).length <= 80, `${n}`);
  assert.equal(keyTitle("Crypt of the north road"), "Crypt of the north road key");
  assert.equal(keyTitle("  "), "Dungeon key");
});

test("DG2B: an emoji at characters 76 and 77 is never split, and every title parses as a page title", () => {
  const dragon = "\u{1F409}";
  const at76 = `${"a".repeat(75)}${dragon}bbb`;
  assert.equal(at76.length, 80);
  assert.equal(keyTitle(at76), `${"a".repeat(75)} key`, "the cut backs off the pair whole");
  const whole = `${"a".repeat(74)}${dragon}bbbb`;
  assert.equal(keyTitle(whole), `${"a".repeat(74)}${dragon} key`, "a pair ending at 76 stays");
  for (const title of [keyTitle(at76), keyTitle(whole)]) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), "no lone high surrogate");
    const op = { t: "journal.create", page: { id: "p", title, access: "dm", blocks: [] } };
    assert.ok(clientOpSchema.safeParse(op).success, title);
  }
});

test("DG2B: the intro says what the dungeon is, the choices it was made with, and how to find a secret door only when it has one", () => {
  const plan: DungeonPlan = { ...twoRooms(), theme: "crypt", w: 50, h: 50 };
  plan.key = dressedRooms().key;
  assert.equal(
    keyIntro(plan, CRYPT, 5),
    "A generated Crypt of 2 rooms on 50 × 50 squares (250 by 250 ft). Room 1 is the way in. Each room's pin carries its number.\n\nMade with: Crypt, Medium, Normal, Bending, Narrow, extra ways around, dead ends, Heights Some, Traps Few at levels 1–4, Secret doors Few, Lit rooms Few, Dressing Some, 5 ft squares.",
  );
  plan.doors = [...plan.doors, { edge: "8,6,w", state: "secret" }];
  assert.equal(
    keyIntro(plan, CRYPT, 10).split("\n\n")[1],
    "Players see a secret door as plain wall until you mark it found: tap it with the Select tool. The Search action finds one with a DC 15 (Medium) Wisdom (Perception) check.",
  );
  assert.match(keyIntro(plan, CRYPT, 10), /^A generated Crypt of 2 rooms on 50 × 50 squares \(500 by 500 ft\)\./);
});

test("DG2B: Made with names each slider's mark, or its value off the marks, and leaves out what is off", () => {
  assert.equal(
    madeWith({ ...CRYPT, w: 30, h: 30, wide: true, loops: false, deadEnds: false, heights: 30, traps: 3, secrets: 5, lit: 35, dressing: "full", band: "17-20" }, 10),
    "Made with: Crypt, Small, Normal, Bending, Wide, Heights 30%, Traps 3 in 12 rooms at levels 17–20, Secret doors 5 in 12 rooms, Lit rooms 35%, Dressing Full, 10 ft squares.",
  );
  assert.equal(
    madeWith({ ...DEFAULT_SETTINGS, w: 80, h: 60, heights: 0, traps: 0, secrets: 0, lit: 0, dressing: "none", theme: "sewer", density: "dense", corridors: "winding" }, 5),
    "Made with: Sewer, Custom, Dense, Winding, Narrow, extra ways around, dead ends, Heights Flat, Traps None, Secret doors None, Lit rooms None, Dressing None, 5 ft squares.",
  );
});

/** A plan with one room of 6 by 8 squares raised 10 ft, for the design's example line. */
function exampleRoom(extra: Partial<KeyRoom> = {}): { plan: DungeonPlan; k: KeyRoom } {
  const plan = twoRooms();
  plan.rooms = [plan.rooms[0]!, { x: 15, y: 3, w: 6, h: 8, ground: 10, floor: "stone", pin: [18, 6] }];
  const k: KeyRoom = {
    n: 3,
    room: 1,
    doors: [
      { side: "n", to: 1, state: "locked" },
      { side: "e", to: 5, state: "secret" },
    ],
    light: "Candelabra",
    traps: ["Spiked Pit"],
    trinket: 0,
    dais: true,
    ...extra,
  };
  return { plan, k };
}

test("DG2B: a room's line is the design's example, every length in the room's feet per square", () => {
  const { plan, k } = exampleRoom();
  assert.equal(roomLine(plan, k, 5), `**3.** 6 × 8 squares (30 by 40 ft), 10 ft up. Doors: north to 1 (locked), east to 5 (secret). A dais 5 ft up. Lit by a candelabra. Trap: Spiked Pit. Trinket: ${TRINKETS[0]}.`);
  assert.match(roomLine(plan, k, 10), /^\*\*3\.\*\* 6 × 8 squares \(60 by 80 ft\), 10 ft up\./);
});

test("DG2B: the entrance, a secret room, a sunk room, a cave's openings, pits, cisterns and several traps each read as the design says, and a part with nothing to say is left out", () => {
  const { plan, k } = exampleRoom();
  const entrance = dressedRooms();
  assert.equal(roomLine(entrance, entrance.key![0]!, 5), `**1.** The way in, 5 × 5 squares (25 by 25 ft). Doors: west to the stairs at the map's edge, east to 2. Lit by a fire pit. Trinket: ${TRINKETS[0]}.`);
  assert.match(roomLine(plan, { ...k, secret: true }, 5), /^\*\*3\.\*\* A secret room, 6 × 8 squares/);
  plan.rooms[1]!.ground = -5;
  assert.match(roomLine(plan, k, 5), /\(30 by 40 ft\), 5 ft down\./);
  plan.rooms[1]!.ground = 0;
  const bare = roomLine(plan, { n: 4, room: 1, doors: [], traps: [], trinket: 1000 }, 5);
  assert.equal(bare, "**4.** 6 × 8 squares (30 by 40 ft).", "no doors, light, trap or trinket to name");
  const cave = { ...plan, theme: "cave" as const };
  assert.equal(roomLine(cave, { n: 2, room: 1, doors: [{ side: "s", to: 1, state: "open" }, { side: "w", to: 4, state: "open" }], traps: [], trinket: 1000, pit: true }, 5), "**2.** 6 × 8 squares (30 by 40 ft). Openings: south to 1, west to 4. A pit.");
  assert.equal(roomLine(plan, { n: 2, room: 1, doors: [], traps: ["Poisoned Darts", "Collapsing Roof"], trinket: 1000, cistern: true, light: "Old lantern" }, 5), "**2.** 6 × 8 squares (30 by 40 ft). A cistern. Lit by an old lantern. Traps: Poisoned Darts, Collapsing Roof.");
  assert.throws(() => roomLine(plan, { ...k, room: 9 }, 5), /room 9/);
});

test("DG2B: the key is one DM-only page in Dungeon keys, an intro and a block a room, and a DM-only pin in the DM's color in the middle of each room's pin square, linked to it", () => {
  const plan = dressedRooms();
  const ops = keyOps(plan, HAND_SETTINGS, { name: "Crypt of the north road", color: "#30a46c", feetPerCell: 5 }, SCENE_PLACEHOLDER);
  assert.deepEqual(ops.map((op) => op.t), ["journal.create", "pin.put", "pin.put"]);
  const page = ops[0]!.t === "journal.create" ? ops[0]!.page : null;
  assert.ok(page);
  assert.deepEqual({ id: page.id, title: page.title, folder: page.folder, access: page.access }, { id: PAGE_PLACEHOLDER, title: "Crypt of the north road key", folder: KEY_FOLDER, access: "dm" });
  assert.equal(page.blocks.length, 3);
  assert.ok(page.blocks.every((b) => b.secret === undefined), "the page is the DM's, so no block need be secret");
  const pins = ops.flatMap((op) => (op.t === "pin.put" ? [op.pin] : []));
  assert.deepEqual(
    pins.map(({ id: _id, ...p }) => p),
    [
      { sceneId: SCENE_PLACEHOLDER, x: 5.5, y: 5.5, label: "1", pageId: PAGE_PLACEHOLDER, color: "#30a46c", visibility: "dm" },
      { sceneId: SCENE_PLACEHOLDER, x: 18.5, y: 6.5, label: "2", pageId: PAGE_PLACEHOLDER, color: "#30a46c", visibility: "dm" },
    ],
  );
  for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success, op.t);
  assert.deepEqual(keyOps(plan, { ...HAND_SETTINGS, key: false }, handKey(), SCENE_PLACEHOLDER), [], "none with DM key off");
  assert.deepEqual(keyOps({ ...plan, key: null }, HAND_SETTINGS, handKey(), SCENE_PLACEHOLDER), [], "none for a plan without a key");
});

test("DG2B: forty rooms with the longest trinkets make 41 blocks well under a page's 32 KiB, and the page holds no seed", () => {
  const plan = hundredPlan();
  const longest = TRINKETS.reduce((best, t, i) => (t.length > TRINKETS[best]!.length ? i : best), 0);
  plan.key = plan.key!.map((k) => ({ ...k, trinket: longest, traps: ["Fire-Casting Statue", "Poisoned Darts", "Collapsing Roof"], secret: true, pit: true, cistern: true }));
  const ops = keyOps(plan, HAND_SETTINGS, { name: "x".repeat(80), color: "#30a46c", feetPerCell: 100 }, SCENE_PLACEHOLDER);
  const page = ops.find((op) => op.t === "journal.create");
  assert.ok(page?.t === "journal.create");
  assert.equal(page.page.blocks.length, 41);
  assert.ok(page.page.blocks.length <= LIMITS.journalBlocksPerPage);
  assert.ok(serializedBytes(page) <= LIMITS.journalPageBytes / 2, `${serializedBytes(page)} bytes`);
  assert.ok(clientOpSchema.safeParse(page).success);
  const seed = "1K7QH2MXA9F3TWQ5";
  assert.ok(!JSON.stringify(ops).includes(seed) && !/seed/i.test(JSON.stringify(ops)));
});
