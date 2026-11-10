import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { CellRect, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { groundAt } from "#shared/rules/heights.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import { builderScene } from "../scenes/create.ts";
import { dialogScene, dressedRooms, HAND_SETTINGS, handKey, hundredOps, hundredPlan } from "./handPlans.ts";
import { endsKey, hexSide, NO_SPACE } from "./hexWalls.ts";
import { SCENE_PLACEHOLDER, trapPlaceholder, wingIds, withIds } from "./ops.ts";
import { planFitted, type DungeonPlan, type Planned, type WingBase } from "./plan.ts";
import { parseSeed, versionChar } from "./seed.ts";
import { landAll, landDungeon, previewOf, scratchRoom, summarize, wingPreviewOf } from "./scratch.ts";
import { clampSettings, DEFAULT_CONTEXT, DEFAULT_SETTINGS, GENERATOR_VERSION, HEIGHTS_MAX, LIT_MAX, roomCap, SECRETS_MAX, TRAPS_MAX, type DungeonSettings } from "./settings.ts";
import { wingHash } from "./wing.ts";

/*
 * The op fixture between the client and the server's tests (docs/design/design-v1-dungeon-generator.md
 * section 10, D-261102-389): the ops of two fixed seeds as the worker
 * writes them, placeholder ids and all, so server/rooms/dungeon.itest.ts
 * lands real dungeons without importing a client module, then two hand
 * plans of phase 2's: twoRooms dressed, with a stone and the key, and the
 * 100-op plan (section 6) with its plan and counts, which
 * e2e/dungeonsend.e2e.ts hands the dialog in place of the worker's answer.
 * `placeholders` lists every id but the scene's that Make gives a fresh
 * one, so a test that sends a dungeon twice in one room replaces each.
 * `UPDATE_FIXTURES=1`
 * writes it, and every other run fails when today's ops differ from it, so
 * a generator change that moves either dungeon updates the fixture in the
 * same commit.
 */

const FIXTURE = new URL("../../../server/rooms/dungeon.fixture.json", import.meta.url);

/** The largest choices section 8 names: the biggest map and Rooms' cap, Dense, Winding and Wide, with heights and the most traps. */
const LARGEST: DungeonSettings = {
  w: 100,
  h: 100,
  rooms: roomCap(100, 100),
  density: "dense",
  corridors: "winding",
  wide: true,
  loops: true,
  theme: "dungeon",
  heights: HEIGHTS_MAX,
  traps: TRAPS_MAX,
  band: "5-10",
  deadEnds: true,
  secrets: SECRETS_MAX,
  lit: LIT_MAX,
  dressing: "full",
  key: true,
};

/**
 * Phase 1's two without the key, so their ops stay the six kinds the
 * server's phase 1 tests read, then phase 2's (section 16): a Cave, a Sewer
 * on Wide and a Dungeon with secret doors, each with the key, and a Wide
 * Dungeon with secret doors, whose Wide doorways the server's secret door
 * gate takes (server/rooms/dungeon.secret.test.ts).
 */
const CASES: { name: string; seed: string; settings: DungeonSettings; key: boolean }[] = [
  { name: "medium", seed: `${versionChar()}K7Q-H2MX-A9F3-TWQ5`, settings: DEFAULT_SETTINGS, key: false },
  { name: "largest", seed: `${versionChar()}G3N-ERAT-0R5E-ED00`, settings: LARGEST, key: false },
  { name: "cave", seed: `${versionChar()}C4V-R0CK-5H4D-0W00`, settings: { ...DEFAULT_SETTINGS, theme: "cave" }, key: true },
  { name: "sewer-wide", seed: `${versionChar()}5EW-RW1D-E0CH-ANE1`, settings: { ...DEFAULT_SETTINGS, theme: "sewer", wide: true, band: "11-16" }, key: true },
  { name: "secrets", seed: `${versionChar()}5EC-RE7D-00R5-KEY1`, settings: { ...DEFAULT_SETTINGS, secrets: SECRETS_MAX, lit: LIT_MAX, dressing: "full" }, key: true },
  { name: "secrets-wide", seed: `${versionChar()}0DT-7M1E-V8N2-FW9P`, settings: { ...DEFAULT_SETTINGS, wide: true, secrets: SECRETS_MAX }, key: false },
];

/** Every id Make gives a fresh one but the scene's, in the order it does. */
function placeholders(ops: ClientOp[]): string[] {
  let n = 0;
  return [...withIds(ops, () => `x${++n}`).ids.keys()].filter((id) => id !== SCENE_PLACEHOLDER);
}

function entry(name: string, plan: DungeonPlan, ops: ClientOp[]) {
  return {
    name,
    sceneId: SCENE_PLACEHOLDER,
    trapIds: plan.traps.map((_, i) => trapPlaceholder(i)),
    placeholders: placeholders(ops),
    rooms: plan.rooms.map(({ x, y, w, h }) => ({ x, y, w, h })),
    entrance: plan.entrance,
    ops,
  };
}

/**
 * Phase 3's hex dungeons (dungeon generator phase 3, 9 and 6): Hex rows and
 * Hex columns of one seed, each with a Narrow secret room and a pit, for
 * server/rooms/dungeon.hexsecret.test.ts. Besides the ops each names, in
 * the scene's hex keys, the secret room's leaf and the hexes either side
 * of it, the room's hexes and every placeholder of what stands in it (its
 * walls but the leaf, stamps, lights, pins and traps), the dungeon's floor
 * hexes, and its way in's edge hexes.
 */
const HEX_CASES: { name: string; seed: string; grid: "hexRows" | "hexColumns" }[] = [
  { name: "hex-secret", seed: `${versionChar()}000-0000-0000-0004`, grid: "hexRows" },
  { name: "hex-columns", seed: `${versionChar()}000-0000-0000-0004`, grid: "hexColumns" },
];
const HEX_SETTINGS = (grid: "hexRows" | "hexColumns") => clampSettings({ ...DEFAULT_SETTINGS, traps: TRAPS_MAX, secrets: SECRETS_MAX, dressing: "full", lit: LIT_MAX, key: true, heights: 40 }, grid);

function hexSecret(planned: Planned, ops: ClientOp[]) {
  const { plan, lattice: L, space, kept } = planned;
  const leafAt = (plan.walls ?? []).findIndex((w, i) => {
    if (w.f !== "secret") return false;
    // A secret room's only doorway, between the room and the corridor: Narrow, one leaf.
    const doorway = planned.leaves.find((l) => l.includes(i));
    return doorway !== undefined && doorway.length === 1;
  });
  assert.ok(leafAt >= 0, "a Narrow secret leaf");
  const leaf = plan.walls![leafAt]!;
  let sides: [number, number] | null = null;
  for (let k = 0; k < space.length && !sides; k++) {
    for (let d = 0; d < 6; d++) {
      const n = L.step(k, d, 1);
      if (n !== null && endsKey(...hexSide(L, k, d)) === endsKey(leaf.a, leaf.b)) sides = [k, n];
    }
  }
  assert.ok(sides, "the leaf lies between two hexes");
  const secretRoom = (k: number) => space[k]! >= 0 && plan.rooms[kept.indexOf(space[k]!)]?.secret === true;
  const [inside, outside] = secretRoom(sides[0]) ? sides : sides.reverse();
  assert.ok(secretRoom(inside!) && !secretRoom(outside!), "a secret room behind the leaf");
  const room = new Set<number>();
  for (let k = 0; k < space.length; k++) if (space[k] === space[inside!]) room.add(k);
  const roomKeys = new Set([...room].map((k) => L.keyOf(k)));
  // The room's own walls: those between its hexes and rock or the scene's edge. A wall it shares with a corridor or another room stays theirs.
  const own = new Set<string>();
  for (const k of room) {
    for (let d = 0; d < 6; d++) {
      const n = L.step(k, d, 1);
      if (n === null || space[n] === NO_SPACE) own.add(endsKey(...hexSide(L, k, d)));
    }
  }
  const touches = (a: readonly [number, number], b: readonly [number, number]) => own.has(endsKey(a, b));
  const walls = ops.flatMap((op) => (op.t === "build.walls" ? (op.put ?? []) : []));
  const leafId = walls.find((w) => endsKey(w.a, w.b) === endsKey(leaf.a, leaf.b))!.id;
  const hexOf = (x: number, y: number) => {
    for (const k of room) {
      const [px, py] = L.pointOf(k % L.W, Math.floor(k / L.W));
      if (Math.hypot(px - x, py - y) < 0.5) return true;
    }
    return false;
  };
  const stamps = ops.flatMap((op) => (op.t === "build.stamps" ? (op.put ?? []) : [])).filter((st) => hexOf(st.x, st.y)).map((st) => st.id);
  const lights = ops.flatMap((op) => (op.t === "build.lights" ? (op.put ?? []) : [])).filter((l) => hexOf(l.x, l.y)).map((l) => l.id);
  const pins = ops.flatMap((op) => (op.t === "pin.put" && hexOf(op.pin.x, op.pin.y) ? [op.pin.id] : []));
  const traps = ops.flatMap((op) => (op.t === "trap.create" && "cells" in op.trap.zone && op.trap.zone.cells.some((r) => roomKeys.has(`${r.x},${r.y}`)) ? [op.trap.id] : []));
  const floor: string[] = [];
  const wayIn: string[] = [];
  for (let k = 0; k < space.length; k++) {
    if (space[k] === NO_SPACE) continue;
    floor.push(L.keyOf(k));
    if (L.border(k, 0) || L.border(k, 3)) wayIn.push(L.keyOf(k));
  }
  return {
    secret: {
      leaf: leafId,
      inside: L.keyOf(inside!),
      outside: L.keyOf(outside!),
      room: [...roomKeys].sort(),
      walls: walls.filter((w) => w.id !== leafId && touches(w.a, w.b)).map((w) => w.id),
      stamps,
      lights,
      pins,
      traps,
    },
    floor: floor.sort(),
    wayIn: wayIn.sort(),
  };
}

/**
 * A wing onto the Medium fixture (phase 3, 9): Medium's dungeon on a scene
 * widened to 96 by 50, and a wing in the empty ground east of it joined to
 * the first raised room's automatic wall a wing can be planned from, so
 * its join gets a run, for server/rooms/dungeon.wing.itest.ts. It names the
 * scene's bounds, the area and join, its asks' clear, and its ops with the
 * key's, each placeholder but the join's.
 */
const WING_SEED = `${versionChar()}W1N-G0N7-0MED-1000`;
const WING_FIXTURE_SETTINGS: DungeonSettings = clampSettings({ ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 4, traps: 12, dressing: "full", lit: 100, key: true, heights: 0 });
const WING_BOUNDS = { w: 96, h: 50 };

function wingOnMedium(mediumOps: ClientOp[]) {
  const widened = mediumOps.map((op) => (op.t === "scene.create" ? { ...op, scene: { ...op.scene, bounds: WING_BOUNDS } } : op));
  const landed = landAll(scratchRoom(), widened.filter((op) => op.t !== "trap.create"));
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  const state: RoomState = landed.room;
  const scene = state.scenes[SCENE_PLACEHOLDER]!;
  const area: CellRect = { x: 54, y: 2, w: 40, h: 46 };
  const parsed = parseSeed(WING_SEED);
  assert.ok(parsed.ok);
  const painted = (x: number, y: number) => Object.values(state.buildChunks).some((c) => c?.cells[`${x},${y}`] !== undefined);
  const ground = (x: number, y: number) => groundAt(state.buildChunks, SCENE_PLACEHOLDER, x, y);
  for (let y = 1; y < 49; y++) {
    for (let x = 49; x > 1; x--) {
      if (!painted(x - 1, y) || painted(x, y) || ground(x - 1, y) === 0) continue;
      const join: JoinExpect = { grid: "squares", edges: [{ key: `${x},${y},w`, feature: null, ground: ground(x - 1, y) }] };
      const raw: Omit<WingBase, "hash"> = { scene, state, area, join };
      const base: WingBase = { ...raw, hash: wingHash(raw, WING_FIXTURE_SETTINGS) };
      const preview = wingPreviewOf(WING_FIXTURE_SETTINGS, parsed.seed, base, DEFAULT_CONTEXT, { ...handKey("Dungeon"), wing: { from: 0, titles: [], pins: 100 } });
      if (!preview.ok) continue;
      let n = 0;
      const placeholders = [...wingIds(preview.ops, SCENE_PLACEHOLDER, SCENE_PLACEHOLDER, () => `x${++n}`).ids.keys()];
      return { name: "wing", base: "medium", seed: parsed.seed, settings: WING_FIXTURE_SETTINGS, sceneId: SCENE_PLACEHOLDER, bounds: WING_BOUNDS, area, join, clear: preview.clear, trapIds: preview.plan.traps.map((_, i) => trapPlaceholder(i)), placeholders, rooms: preview.plan.rooms.map(({ x, y, w, h }) => ({ x, y, w, h })), ops: preview.ops };
    }
  }
  throw new Error("no raised room of Medium takes a wing");
}

function today() {
  const hundred = hundredPlan();
  const dressed = dressedRooms();
  return {
    generatorVersion: GENERATOR_VERSION,
    dungeons: [
      ...CASES.map(({ name, seed, settings, key }) => {
        const parsed = parseSeed(seed);
        assert.ok(parsed.ok && !parsed.otherVersion, seed);
        const made = previewOf(settings, parsed.seed, builderScene({ id: "fixture", name: "Dungeon", w: settings.w, h: settings.h }), DEFAULT_CONTEXT, key ? handKey("Dungeon") : null);
        assert.ok(made.ok, `${name} makes a dungeon`);
        return { ...entry(name, made.plan, made.ops), seed: parsed.seed, settings };
      }),
      (() => {
        const landed = landDungeon(dressed, { ...dialogScene(dressed), id: SCENE_PLACEHOLDER }, HAND_SETTINGS.band, { input: handKey(), settings: HAND_SETTINGS });
        assert.ok(landed.ok, landed.ok ? "" : landed.why);
        return { ...entry("dressed", dressed, landed.ops), stones: dressed.stones, pins: dressed.rooms.map((r) => r.pin) };
      })(),
      { ...entry("hundred", hundred, hundredOps({ ...dialogScene(hundred), id: SCENE_PLACEHOLDER })), plan: hundred, summary: summarize(hundred) },
      ...HEX_CASES.map(({ name, seed, grid }) => {
        const parsed = parseSeed(seed);
        assert.ok(parsed.ok && !parsed.otherVersion, seed);
        const settings = HEX_SETTINGS(grid);
        const scene = builderScene({ id: "fixture", name: "Dungeon", w: settings.w, h: settings.h, gridShape: grid });
        const made = previewOf(settings, parsed.seed, scene, { feetPerCell: 5, grid }, handKey("Dungeon"));
        assert.ok(made.ok, `${name} makes a dungeon`);
        const planned = planFitted(settings, parsed.seed, { feetPerCell: 5, grid });
        return { ...entry(name, made.plan, made.ops), seed: parsed.seed, settings, grid, ...hexSecret(planned, made.ops) };
      }),
      (() => {
        const medium = CASES[0]!;
        const parsed = parseSeed(medium.seed);
        assert.ok(parsed.ok);
        const made = previewOf(medium.settings, parsed.seed, builderScene({ id: "fixture", name: "Dungeon", w: medium.settings.w, h: medium.settings.h }), DEFAULT_CONTEXT, null);
        assert.ok(made.ok);
        return wingOnMedium(made.ops);
      })(),
    ],
  };
}

test("DG-B: the server's dungeon fixture is today's ops of its seeds and hand plans", () => {
  const ops = today();
  if (process.env.UPDATE_FIXTURES === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(ops, null, 1)}\n`);
    return;
  }
  const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
  assert.deepEqual(stored, JSON.parse(JSON.stringify(ops)), "the generator changed a fixed dungeon: run UPDATE_FIXTURES=1 pnpm test and commit the fixture with the change");
});
