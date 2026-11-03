import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { generate } from "./plan.ts";
import { clampSettings, GENERATOR_VERSION, type DungeonSettings } from "./settings.ts";

/*
 * Twelve plans pinned by hash (docs/design/design-v1-dungeon-generator.md
 * 5.1). Replay never runs the generator, so it may change, but a change
 * that moves any plan bumps GENERATOR_VERSION and this fixture together:
 * an old seed then says it is from another version. UPDATE_FIXTURES=1
 * rewrites the fixture.
 */

const FIXTURE = new URL("./plan.golden.fixture.json", import.meta.url);

type Golden = { version: number; plans: { name: string; settings: DungeonSettings; seed: string; sha256: string }[] };

const CASES: { name: string; settings: Partial<DungeonSettings>; seed: string }[] = [
  { name: "the defaults", settings: {}, seed: "1K7QH2MXA9F3TWQ5" },
  { name: "Small", settings: { w: 30, h: 30, rooms: 6 }, seed: "1Q8V2DR4HJ0Y7ZB3" },
  { name: "Large", settings: { w: 80, h: 80, rooms: 20 }, seed: "1M3T9WCEX5PK2AGN" },
  { name: "a Crypt, Dense, Winding and Wide", settings: { theme: "crypt", density: "dense", corridors: "winding", wide: true }, seed: "1A0B1C2D3E4F5G6H" },
  { name: "Sparse and Straight, flat, no loops or traps", settings: { density: "sparse", corridors: "straight", loops: false, heights: "flat", traps: "none" }, seed: "1ZZZZZZZZZZZZZZZ" },
  { name: "a Dense Winding Crypt with many traps", settings: { theme: "crypt", density: "dense", corridors: "winding", traps: "some", band: "11-16" }, seed: "1000000000000001" },
  { name: "the largest Wide", settings: { w: 100, h: 100, rooms: 40, density: "dense", corridors: "winding", wide: true, traps: "some" }, seed: "1VVVVWWWWXXXXYYY" },
  { name: "the largest Narrow", settings: { w: 100, h: 100, rooms: 40, density: "sparse", corridors: "winding", traps: "some" }, seed: "1RS7TV8WX9YZ0123" },
  { name: "the smallest", settings: { w: 20, h: 20, rooms: 2 }, seed: "1HJKMNPQRST45678" },
  { name: "Custom and Wide", settings: { w: 37, h: 63, rooms: 11, wide: true, traps: "some", band: "17-20" }, seed: "1D6E7F8G9H0J1K2M" },
  { name: "a Large Straight Wide Crypt", settings: { w: 80, h: 80, rooms: 20, theme: "crypt", corridors: "straight", wide: true, loops: false }, seed: "1N3P4Q5R6S7T8V9W" },
  { name: "Bending with traps at 5 to 10", settings: { traps: "some", band: "5-10" }, seed: "1X0Y1Z2A3B4C5D6E" },
];

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function today(): Golden {
  return {
    version: GENERATOR_VERSION,
    plans: CASES.map(({ name, settings, seed }) => {
      const s = clampSettings(settings);
      return { name, settings: s, seed, sha256: hash(generate(s, seed)) };
    }),
  };
}

describe("golden dungeon plans", () => {
  test("the fixture's version is the generator's", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.version, GENERATOR_VERSION);
  });

  test("twelve fixed seeds and choices make the plans they made", () => {
    const now = today();
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.plans.length, 12);
    assert.deepEqual(now, fixture, "a plan moved: bump GENERATOR_VERSION and rerun with UPDATE_FIXTURES=1");
  });
});
