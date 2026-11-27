import assert from "node:assert/strict";
import { test } from "node:test";
import type { Light, WallFeature } from "#shared/model.ts";
import { effectiveEdges, indexBuild, sceneChunks } from "#shared/rules/walls.ts";
import { builderScene } from "../scenes/create.ts";
import { SCENE_PLACEHOLDER } from "../dungeon/ops.ts";
import { previewOf } from "../dungeon/scratch.ts";
import { newSeed } from "../dungeon/seed.ts";
import { DEFAULT_CONTEXT, DEFAULT_SETTINGS, THEMES } from "../dungeon/settings.ts";
import { importBack } from "./exportTestutil.ts";
import { checkExport } from "./steps.ts";
import { uvttGeometry } from "./write.ts";

/*
 * A generated dungeon through the export and back (docs/design/design-v1-uvtt-export.md
 * section 8): for a fixed seed in every theme, the DM view's file imports
 * with the same walls and doors, every door closed, and the same lights,
 * and the check finds no change.
 */

const kindOf = (f: WallFeature) => f.kind;
const seen = { doors: 0, lights: 0, pillars: 0 };

for (const [i, theme] of THEMES.entries()) {
  test(`a ${theme} dungeon's DM view comes back with its walls, doors and lights`, () => {
    const seed = newSeed((b) => {
      for (let k = 0; k < b.length; k++) b[k] = (i * 53 + k * 17 + 3) & 0xff;
    });
    const made = previewOf({ ...DEFAULT_SETTINGS, theme }, seed, builderScene({ id: "x", name: "Dungeon", w: 40, h: 40 }), DEFAULT_CONTEXT, null);
    assert.ok(made.ok, theme);
    const room = made.room;
    const scene = room.scenes[SCENE_PLACEHOLDER]!;
    const chunks = sceneChunks(room.buildChunks, scene.id);
    const lights = Object.values(room.lights).filter((l): l is Light => l?.sceneId === scene.id);
    const rule = scene.autoWalls ?? "all";
    const head = uvttGeometry({ scene, chunks, rule, lights, feetPerCell: 5, pxPerCell: 70 }, "dm");
    assert.deepEqual(checkExport(head.json, 5), { changes: false, portalCut: false });
    assert.ok(head.counts.walls > 0, "a dungeon has walls");
    seen.doors += head.counts.doors;
    seen.lights += head.counts.lights;
    seen.pillars += head.counts.walls - (head.json.line_of_sight as unknown[]).length;

    const plan = importBack(head);
    const want = new Set(effectiveEdges(indexBuild(chunks), rule).map((e) => `${e.x},${e.y},${e.side}:${kindOf(e.feature)}`));
    const got = new Set(plan.edges.map((e) => `${e.key}:${kindOf(e.feature)}`));
    assert.deepEqual([...got].sort(), [...want].sort(), "the same grid walls, doors and windows");
    for (const e of plan.edges) if (e.feature.kind === "door") assert.equal(e.feature.state, "closed");
    const pillars = chunks.reduce((n, c) => n + Object.values(c.cells).filter((t) => t === "pillar").length, 0);
    assert.equal(plan.walls.length, 4 * pillars, "each pillar as its four sides");

    const on = lights.filter((l) => l.on);
    assert.equal(plan.lights.length, on.length);
    const spot = (l: { x: number; y: number; bright: number; dim: number }) => `${l.x},${l.y},${l.bright + l.dim}`;
    assert.deepEqual(plan.lights.map(spot).sort(), on.map(spot).sort());
  });
}

test("the dungeons hold doors, lights and pillars between them, so each claim above was tested", () => {
  assert.ok(seen.doors > 0 && seen.lights > 0 && seen.pillars > 0, JSON.stringify(seen));
});
