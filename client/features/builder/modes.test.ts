import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUILD_MODES } from "./store.ts";

const { ICON_NAMES } = await import("../../components/Icon.tsx");

/*
 * The builder's mode picker (D-261026-3): two modes that are one tool for
 * two things read "x/y", and every mode has an icon of its own, which its
 * tile and the chip that shows it draw.
 */

describe("the builder's modes", () => {
  test("Walls/doors and Heights/stairs by those names, with their short words kept", () => {
    const named = (value: string) => BUILD_MODES.find((m) => m.value === value)!;
    assert.deepEqual([named("edge").label, named("edge").short], ["Walls/doors", "Walls"]);
    assert.deepEqual([named("height").label, named("height").short], ["Heights/stairs", "Heights"]);
  });

  test("each mode has an icon the app draws, and no two modes share one", () => {
    for (const m of BUILD_MODES) assert.ok(ICON_NAMES.includes(m.icon), `${m.label}: ${String(m.icon)} draws nothing`);
    assert.equal(new Set(BUILD_MODES.map((m) => m.icon)).size, BUILD_MODES.length);
  });
});
