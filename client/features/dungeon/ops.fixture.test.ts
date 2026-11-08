import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import { builderScene } from "../scenes/create.ts";
import { dialogScene, hundredOps, hundredPlan } from "./handPlans.ts";
import { SCENE_PLACEHOLDER, trapPlaceholder, withIds } from "./ops.ts";
import type { DungeonPlan } from "./plan.ts";
import { parseSeed, versionChar } from "./seed.ts";
import { previewOf, summarize } from "./scratch.ts";
import { DEFAULT_CONTEXT, DEFAULT_SETTINGS, GENERATOR_VERSION, HEIGHTS_MAX, LIT_MAX, roomCap, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * The op fixture between the client and the server's tests (docs/design/design-v1-dungeon-generator.md
 * section 10, D-261102-389): the ops of two fixed seeds as the worker
 * writes them, placeholder ids and all, so server/rooms/dungeon.itest.ts
 * lands real dungeons without importing a client module, and the 100-op
 * hand plan's (phase 2, section 6) with its plan and counts, which
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
  secrets: 0,
  lit: LIT_MAX,
  dressing: "full",
  key: true,
};

// Secret doors stay at None here until drules lane B's `cover` lands (phase 2 section 7): before it, a hidden secret door reaches players as a drawn wall.
const CASES: { name: string; seed: string; settings: DungeonSettings }[] = [
  { name: "medium", seed: `${versionChar()}K7Q-H2MX-A9F3-TWQ5`, settings: { ...DEFAULT_SETTINGS, secrets: 0 } },
  { name: "largest", seed: `${versionChar()}G3N-ERAT-0R5E-ED00`, settings: LARGEST },
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

function today() {
  const hundred = hundredPlan();
  return {
    generatorVersion: GENERATOR_VERSION,
    dungeons: [
      ...CASES.map(({ name, seed, settings }) => {
        const parsed = parseSeed(seed);
        assert.ok(parsed.ok && !parsed.otherVersion, seed);
        const made = previewOf(settings, parsed.seed, builderScene({ id: "fixture", name: "Dungeon", w: settings.w, h: settings.h }), DEFAULT_CONTEXT, null);
        assert.ok(made.ok, `${name} makes a dungeon`);
        return { ...entry(name, made.plan, made.ops), seed: parsed.seed, settings };
      }),
      { ...entry("hundred", hundred, hundredOps({ ...dialogScene(hundred), id: SCENE_PLACEHOLDER })), plan: hundred, summary: summarize(hundred) },
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
