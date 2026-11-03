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
 * rewrites the fixture, but never moves a plan under the version it was
 * pinned at, so a rewrite cannot stand in for the bump.
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

/**
 * Why a rewrite would hide a moved plan, or null when it may go ahead: a
 * plan kept under the same name, settings and seed whose hash changed
 * while the version did not. New cases and a bumped version may be written.
 */
export function rewriteRefused(old: Golden | null, now: Golden): string | null {
  if (!old || old.version !== now.version) return null;
  const pinned = new Map(old.plans.map((p) => [p.name, p]));
  const moved = now.plans.filter((p) => {
    const was = pinned.get(p.name);
    return was && was.seed === p.seed && JSON.stringify(was.settings) === JSON.stringify(p.settings) && was.sha256 !== p.sha256;
  });
  return moved.length === 0 ? null : `${moved.map((p) => p.name).join(", ")} moved at version ${now.version}: bump GENERATOR_VERSION, then rerun with UPDATE_FIXTURES=1`;
}

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
  test("DG-R1-04: a rewrite never moves a pinned plan under its version, and takes new cases or a bumped version", () => {
    const plan = (name: string, sha256: string) => ({ name, settings: clampSettings({}), seed: "1K7QH2MXA9F3TWQ5", sha256 });
    const old: Golden = { version: 1, plans: [plan("a", "x"), plan("b", "y")] };
    assert.match(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), plan("b", "z")] }) ?? "", /^b moved at version 1: bump GENERATOR_VERSION/);
    assert.equal(rewriteRefused(old, { version: 2, plans: [plan("a", "q"), plan("b", "z")] }), null, "a bumped version rewrites");
    assert.equal(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), plan("b", "y"), plan("c", "w")] }), null, "a new case is written");
    assert.equal(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), { ...plan("b", "z"), seed: "1ZZZZZZZZZZZZZZZ" }] }), null, "a case given another seed is a new pin");
    assert.equal(rewriteRefused(null, { version: 1, plans: [plan("a", "x")] }), null, "no fixture yet");
  });

  test("the fixture's version is the generator's", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.version, GENERATOR_VERSION);
  });

  test("twelve fixed seeds and choices make the plans they made", () => {
    const now = today();
    if (process.env.UPDATE_FIXTURES === "1") {
      const refused = rewriteRefused(JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden, now);
      assert.equal(refused, null, "the fixture is not rewritten");
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.plans.length, 12);
    assert.deepEqual(now, fixture, "a plan moved: bump GENERATOR_VERSION and rerun with UPDATE_FIXTURES=1");
  });
});
