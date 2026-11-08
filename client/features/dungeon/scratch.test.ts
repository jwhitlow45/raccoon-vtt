import assert from "node:assert/strict";
import { test } from "node:test";
import { groundAt } from "#shared/rules/heights.ts";
import { markIn } from "#shared/rules/heights.ts";
import { dialogScene, dressedRooms, HAND_SETTINGS, handKey, hundredPlan, twoRooms } from "./handPlans.ts";
import { buildOps, MAX_OPS, SCENE_PLACEHOLDER } from "./ops.ts";
import { landAll, landDungeon, previewOf, previewScene, scratchRoom } from "./scratch.ts";
import { DEFAULT_CONTEXT, DEFAULT_SETTINGS, SECRET_PRESETS, type DungeonSettings } from "./settings.ts";
import type { DungeonPlan } from "./plan.ts";

const SEED = "1K7QH2MXA9F3TWQ5";

function chunkOf(room: ReturnType<typeof scratchRoom>, x: number, y: number) {
  return room.buildChunks[`${SCENE_PLACEHOLDER}:${Math.floor(x / 16)},${Math.floor(y / 16)}`];
}

test("DG-B: a plan lands whole in a room holding only its scene, traps armed and unfound", () => {
  const plan = twoRooms();
  const landed = landDungeon(plan, previewScene(dialogScene(plan), plan), "1-4", null);
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  const room = landed.room;
  assert.deepEqual(Object.keys(room.scenes), [SCENE_PLACEHOLDER]);
  assert.equal(room.meta.playerSceneId, null);
  const scene = room.scenes[SCENE_PLACEHOLDER]!;
  assert.deepEqual(scene.bounds, { w: 30, h: 30 });
  assert.equal(scene.defaultView, undefined);
  assert.equal(chunkOf(room, 3, 3)?.cells["3,3"], "stone");
  assert.equal(chunkOf(room, 16, 4)?.cells["16,4"], "wood");
  assert.equal(chunkOf(room, 10, 5)?.cells["10,5"], "rubble");
  assert.deepEqual(chunkOf(room, 15, 5)?.edges["15,5,w"], { kind: "door", state: "locked", secret: false, discovered: false });
  assert.equal(groundAt(room.buildChunks, SCENE_PLACEHOLDER, 16, 4), 5);
  assert.equal(groundAt(room.buildChunks, SCENE_PLACEHOLDER, 14, 5), 5, "the near landing at the room's height");
  assert.equal(groundAt(room.buildChunks, SCENE_PLACEHOLDER, 13, 5), 0, "the stair at the foot of the run");
  assert.equal(markIn(chunkOf(room, 13, 5)!, 13, 5), "e");
  const traps = Object.values(room.traps);
  assert.deepEqual(traps.map((t) => [t.name, t.state, t.found, t.sceneId]), [["Hidden Pit", "armed", false, SCENE_PLACEHOLDER], ["Poisoned Needle", "armed", false, SCENE_PLACEHOLDER]]);
  assert.equal(traps[0]?.rig?.pit?.floor, -5, "the pit's floor 10 ft under the raised room's ground, read from the landed chunks");
  assert.equal(landed.ops.length, 10);
});

test("DG-B: a preview's scene is the dialog's under the placeholder id, square, on the plan's whole size", () => {
  const plan = twoRooms();
  const scene = previewScene({ ...dialogScene({ w: 12, h: 12 }), gridShape: "hexRows", defaultView: { x: 1, y: 1, zoom: 2 } }, plan);
  assert.equal(scene.id, SCENE_PLACEHOLDER);
  assert.deepEqual(scene.bounds, { w: 30, h: 30 });
  assert.equal("gridShape" in scene, false);
  assert.equal("defaultView" in scene, false);
  assert.equal(scene.name, "Crypt");
  assert.equal(scene.fogEnabled, true);
});

test("DG-B: a refusal names the op it stopped at, and nothing after it lands", () => {
  const plan = twoRooms();
  plan.traps = [{ preset: "hidden-pit", zone: { cells: [{ x: 29, y: 29, w: 2, h: 2 }] } }];
  const landed = landDungeon(plan, previewScene(dialogScene(plan), plan), "1-4", null);
  assert.ok(!landed.ok);
  assert.match(landed.why, /^op 8: trap.create refused: a trap's squares lie inside its scene/);
  const noDoor = twoRooms();
  noDoor.traps = [{ preset: "poisoned-needle", zone: { door: { edge: "20,20,w" } } }];
  const refused = landDungeon(noDoor, previewScene(dialogScene(noDoor), noDoor), "1-4", null);
  assert.ok(!refused.ok);
  assert.match(refused.why, /^op 8: trap.create refused/);
});

test("DG-B: an op that does not parse is a bug, named as such", () => {
  const plan = twoRooms();
  plan.heights = [{ ft: 500, cells: ["16,4"] }];
  const landed = landDungeon(plan, previewScene(dialogScene(plan), plan), "1-4", null);
  assert.ok(!landed.ok);
  assert.match(landed.why, /build.height does not parse/);
});

/** Lone squares two apart: every side of each is an automatic wall, and no two walls touch. */
function speckled(n: number): DungeonPlan {
  const cells: string[] = [];
  for (let y = 0; y < 100 && cells.length < n; y += 2) for (let x = 0; x < 100 && cells.length < n; x += 2) cells.push(`${x},${y}`);
  return { ...twoRooms(), w: 100, h: 100, paint: { stone: cells }, doors: [], heights: [], stairs: [], traps: [] };
}

test("DG-B: the sight cap is checked on each prefix, as if vision were on, since Players see is set only at Make", () => {
  const plan = speckled(2_000);
  const scene = previewScene(dialogScene(plan), plan);
  for (const vision of [undefined, { on: true, light: "dark" as const }, { on: false, light: "bright" as const }]) {
    const landed = landAll(scratchRoom(), buildOps(plan, { ...scene, ...(vision ? { vision } : {}) }));
    assert.ok(!landed.ok, JSON.stringify(vision));
    assert.equal(landed.at, 1);
    assert.match(landed.why, /over the sight cap: This scene has 8,000 wall pieces/);
  }
  const under = speckled(1_500);
  assert.ok(landAll(scratchRoom(), buildOps(under, previewScene(dialogScene(under), under))).ok, "6,000 pieces is at the cap, not over it");
});

test("DG-B: the room's limits are checked on each prefix", () => {
  const plan = twoRooms();
  const pillars: string[] = [];
  for (let y = 0; y < 60 && pillars.length < 1_001; y += 2) for (let x = 0; x < 60 && pillars.length < 1_001; x++) pillars.push(`${x},${y}`);
  const many = { ...plan, w: 60, h: 60, paint: { pillar: pillars }, doors: [], heights: [], stairs: [], traps: [] };
  const landed = landAll(scratchRoom(), buildOps(many, previewScene(dialogScene(many), many)));
  assert.ok(!landed.ok);
  assert.match(landed.why, /build.paint over a limit: this scene can hold at most 1,000 pillars/);
});

test("DG-B: a preview is the plan, its ops, the room they make and the foot's counts, and a dungeon under two rooms is the fit error", () => {
  const plan = twoRooms();
  const made = previewOf(DEFAULT_SETTINGS, SEED, dialogScene(plan), DEFAULT_CONTEXT, null, () => plan);
  assert.ok(made.ok);
  assert.equal(made.plan, plan);
  assert.deepEqual(made.summary, { rooms: 2, asked: 2, doors: 3, locked: 1, traps: 2, secretDoors: 0, secretRooms: 0, lights: 0 });
  assert.equal(made.ops.length, 10);
  assert.deepEqual(Object.keys(made.room.scenes), [SCENE_PLACEHOLDER]);
  const one = { ...plan, rooms: plan.rooms.slice(0, 1) };
  assert.deepEqual(previewOf(DEFAULT_SETTINGS, SEED, dialogScene(plan), DEFAULT_CONTEXT, null, () => one), { ok: false, error: "fit" });
});

test("DG-B: a generator that throws, or a plan the scratch room refuses, is the bug error", () => {
  const quiet = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const plan = twoRooms();
    assert.deepEqual(previewOf(DEFAULT_SETTINGS, SEED, dialogScene(plan), DEFAULT_CONTEXT, null, () => { throw new Error("boom"); }), { ok: false, error: "bug" });
    const bad = { ...plan, traps: [{ preset: "hidden-pit", zone: { cells: [{ x: 40, y: 40, w: 2, h: 2 }] } }] };
    assert.deepEqual(previewOf(DEFAULT_SETTINGS, SEED, dialogScene(plan), DEFAULT_CONTEXT, null, () => bad), { ok: false, error: "bug" });
    assert.equal(logged.length, 2, "each bug is logged for the console");
  } finally {
    console.error = quiet;
  }
});

test("DG2B: the ground, the stamps, the lights and the stones land, then the traps, then the key's page and its pins", () => {
  const plan = dressedRooms();
  const landed = landDungeon(plan, previewScene(dialogScene(plan), plan), HAND_SETTINGS.band, { input: handKey(), settings: HAND_SETTINGS });
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  const kinds = landed.ops.map((op) => op.t).filter((t, i, all) => all[i - 1] !== t);
  assert.deepEqual(kinds, ["scene.create", "build.paint", "build.edge", "build.height", "build.stairs", "build.stamps", "build.lights", "token.create", "trap.create", "journal.create", "pin.put"]);
  const room = landed.room;
  const on = <T extends { sceneId: string }>(r: Record<string, T>) => Object.values(r).filter((x) => x.sceneId === SCENE_PLACEHOLDER);
  assert.deepEqual([on(room.stamps).length, on(room.lights).length, on(room.tokens).length, on(room.traps).length, on(room.pins).length], [4, 1, 1, 5, 2]);
  assert.equal(Object.keys(room.journal).length, 1);
  const off = landDungeon(plan, previewScene(dialogScene(plan), plan), HAND_SETTINGS.band, null);
  assert.ok(off.ok);
  assert.equal(off.ops.some((op) => op.t === "journal.create" || op.t === "pin.put"), false, "no key without the key's room facts");
  const keyOff = landDungeon(plan, previewScene(dialogScene(plan), plan), HAND_SETTINGS.band, { input: handKey(), settings: { ...HAND_SETTINGS, key: false } });
  assert.ok(keyOff.ok);
  assert.equal(keyOff.ops.some((op) => op.t === "journal.create" || op.t === "pin.put"), false, "none with DM key off");
  // Never called: the types alone must refuse a key without the choices it was made with.
  const typeOnly = () =>
    // @ts-expect-error settings are required beside the key
    landDungeon(plan, previewScene(dialogScene(plan), plan), "1-4", { input: handKey() });
  assert.equal(typeof typeOnly, "function");
});

test("DG2B: a dungeon past MAX_OPS is refused as a bug, never sent past the cap", () => {
  const plan = hundredPlan();
  const scene = previewScene(dialogScene(plan), plan);
  assert.ok(landDungeon(plan, scene, HAND_SETTINGS.band, { input: handKey(), settings: HAND_SETTINGS }).ok);
  const over = { ...plan, traps: [...plan.traps, { preset: "hidden-pit", zone: { cells: [{ x: 4, y: 4, w: 1, h: 1 }] } }] };
  const refused = landDungeon(over, scene, HAND_SETTINGS.band, { input: handKey(), settings: HAND_SETTINGS });
  assert.deepEqual(refused, { ok: false, why: `${MAX_OPS + 1} ops, past ${MAX_OPS}` });
});

test("DG2B: the preview plans the DM's Secret doors as chosen, and the key says so", () => {
  const chosen: DungeonSettings = { ...DEFAULT_SETTINGS, secrets: SECRET_PRESETS.Many };
  const asked: number[] = [];
  const plan = dressedRooms();
  const made = previewOf(chosen, SEED, dialogScene(plan), DEFAULT_CONTEXT, handKey(), (s) => (asked.push(s.secrets), plan));
  assert.deepEqual(asked, [SECRET_PRESETS.Many]);
  assert.ok(made.ok);
  const page = made.ops.find((op) => op.t === "journal.create");
  assert.ok(page?.t === "journal.create" && page.page.blocks[0]!.text.includes("Secret doors Many"));
});
