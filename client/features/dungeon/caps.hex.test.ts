import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { withPitsCounted } from "#shared/rules/pitCount.ts";
import { splitCheck } from "#shared/rules/walls.ts";
import { sightPieces } from "#shared/visionLimits.ts";
import { builderScene } from "../scenes/create.ts";
import { MAX_OPS, SCENE_PLACEHOLDER, WALLS_PER_OP } from "./ops.ts";
import { previewOf } from "./scratch.ts";
import { newSeed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, HEIGHTS_MAX, LIT_MAX, MAX_HEX_CELLS, MAX_HEX_ROOMS, MAX_HEX_WALLS, SECRETS_MAX, THEMES, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * The caps on hexes (docs/design: dungeon generator phase 3, 2.5 and 8):
 * at the largest hex choices, over fixed seeds on rows and columns, every
 * dungeon that lands keeps at most 3,200 free walls, its sight pieces with
 * vision on and pits counted under the scene's cap, the split's check, its
 * ops within Make's 100 and each wall op within its count and a frame, and
 * a fit that gives up says why, never a bug.
 */

function seedOf(i: number): string {
  return newSeed((b) => {
    for (let k = 0; k < b.length; k++) b[k] = (i * 97 + k * 31 + 3) & 0xff;
  });
}

test("DG3: the largest hex choices stay within the wall budget, the sight cap, the split and Make's 100 ops, or say why they cannot fit", () => {
  let landed = 0;
  let most = 0;
  for (let i = 0; i < 12; i++) {
    const grid = i % 2 === 0 ? ("hexRows" as const) : ("hexColumns" as const);
    const s: DungeonSettings = clampSettings(
      {
        ...DEFAULT_SETTINGS,
        w: grid === "hexRows" ? 100 : MAX_HEX_CELLS,
        h: grid === "hexRows" ? MAX_HEX_CELLS : 100,
        rooms: MAX_HEX_ROOMS,
        density: i % 4 < 2 ? "dense" : "normal",
        corridors: "winding",
        wide: i % 3 === 0,
        loops: true,
        theme: THEMES[i % THEMES.length]!,
        heights: HEIGHTS_MAX,
        traps: TRAPS_MAX,
        band: "11-16",
        deadEnds: true,
        secrets: SECRETS_MAX,
        lit: LIT_MAX,
        dressing: "full",
        key: true,
      },
      grid,
    );
    const scene = builderScene({ id: "x", name: "Dungeon", w: s.w, h: s.h, gridShape: grid });
    const made = previewOf(s, seedOf(i), scene, { feetPerCell: 5, grid }, { name: "x".repeat(80), color: "#30a46c", feetPerCell: 5 });
    if (!made.ok) {
      assert.equal(made.error, "fit", `seed ${i}: a fit that gives up is never a bug`);
      assert.ok(made.why === "tooMany" || made.why === "underTwo", `seed ${i}: and says why`);
      continue;
    }
    landed++;
    const walls = made.plan.walls?.length ?? 0;
    most = Math.max(most, walls);
    assert.ok(walls > 0 && walls <= MAX_HEX_WALLS, `seed ${i}: ${walls} walls`);
    assert.ok(made.ops.length <= MAX_OPS, `seed ${i}: ${made.ops.length} ops`);
    for (const op of made.ops) if (op.t === "build.walls") assert.ok((op.put?.length ?? 0) <= WALLS_PER_OP && serializedBytes(op) <= LIMITS.freeWallsOpBytes);
    const counted = withPitsCounted(made.room, SCENE_PLACEHOLDER);
    const sceneNow = counted.scenes[SCENE_PLACEHOLDER]!;
    const pieces = sightPieces({ ...counted, scenes: { [SCENE_PLACEHOLDER]: { ...sceneNow, vision: { on: true, light: "dark" } } } }, SCENE_PLACEHOLDER);
    assert.ok(pieces <= LIMITS.sightPiecesPerScene, `seed ${i}: ${pieces} sight pieces`);
    assert.ok(splitCheck(counted, SCENE_PLACEHOLDER).ok, `seed ${i}: the split's check`);
  }
  assert.ok(landed >= 8, `${landed} of 12 landed`);
  assert.ok(most > 1_000, `not vacuous: the most walls were ${most}`);
});
