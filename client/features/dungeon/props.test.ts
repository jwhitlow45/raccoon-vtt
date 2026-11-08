import assert from "node:assert/strict";
import { test } from "node:test";
import { STAMP_SOURCES } from "#shared/credits.ts";
import { STAMP_ART } from "#shared/stamps.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";
import { STARTER_STAMPS } from "#shared/starterStamps.ts";
import { BANNED_PROPS, DUNGEON_WOOD_PROPS, PROPS, stampSize, WALL_PIECES } from "./props.ts";
import { THEMES } from "./settings.ts";
import { THEME_SPECS } from "./themes.ts";
import { STATUE_STAMP } from "./trapSpots.ts";

/*
 * The props and light pictures (phase 2, 5.5 and 13): every key a shipped
 * or starter stamp with its size and its credit, none that reads as a
 * rule, and no new art.
 */

const credited = (key: string) => {
  const shipped = STAMP_ART.find((s) => s.key === key);
  if (shipped) return Object.hasOwn(STAMP_SOURCES, shipped.source);
  const starter = STARTER_STAMPS.find((s) => s.key === key);
  // A starter stamp's credit is its work's, in its pack's catalog entry.
  return starter !== undefined && STARTER_PACKS.some((p) => p.id === starter.pack && p.works.some((w) => w.stamp?.key === key && w.credit.license.length > 0));
};

test("DG2-A: every prop, light picture and the statue is a catalog stamp with its size and a credit, and none is banned", () => {
  const keys = new Set([...Object.values(PROPS).flat(), ...DUNGEON_WOOD_PROPS, ...THEMES.map((t) => THEME_SPECS[t].light.stamp), STATUE_STAMP.key, ...WALL_PIECES]);
  for (const key of keys) {
    const size = stampSize(key);
    assert.ok(size && size.w > 0 && size.h > 0, `${key} has no catalog size`);
    assert.ok(credited(key), `${key} has no credit`);
  }
  assert.deepEqual(stampSize(STATUE_STAMP.key), { w: STATUE_STAMP.w, h: STATUE_STAMP.h });
  for (const key of [...Object.values(PROPS).flat(), ...DUNGEON_WOOD_PROPS]) assert.ok(!BANNED_PROPS.includes(key), `${key} reads as a rule or a light`);
  for (const key of BANNED_PROPS) assert.ok(stampSize(key), `the banned ${key} is a real stamp`);
  assert.equal(stampSize("not-a-stamp"), null);
});

test("DG2-A: a Fire-Casting Statue's picture is among the props of exactly the themes that hold the trap", () => {
  assert.deepEqual(THEMES.filter((t) => PROPS[t].includes(STATUE_STAMP.key)), ["dungeon", "crypt"]);
  assert.ok(!DUNGEON_WOOD_PROPS.includes(STATUE_STAMP.key), "a Dungeon's wood rooms are furnished, not statued");
});
