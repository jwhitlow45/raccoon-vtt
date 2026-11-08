import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

/*
 * The board draws the floor shown, so every reader of a floor-scoped
 * collection in its folders reads `floorView`, the cut, and not `view`, which
 * holds every floor of the scene (docs/design/design-v1-floors.md 10). A reader
 * that stays on `view` draws another floor's creature, which only a scene
 * with floors shows, so this test names the readers that must switch.
 */

const CLIENT = join(import.meta.dirname, "..");
const FOLDERS = [
  "canvas",
  "features/areas",
  "features/attach",
  "features/builder",
  "features/doors",
  "features/drawings",
  "features/fog",
  "features/grid",
  "features/lights",
  "features/measure",
  "features/movement",
  "features/pings",
  "features/select",
  "features/vision",
  "features/mapexport",
  "features/outliner",
  "features/weather",
  "features/animmap",
];
/** Readers that mean every floor. */
const SKIPPED = new Set(["features/areas/reminders.ts", "features/attach/turns.ts", "features/areas/useAreaReminders.ts"]);
const FLOOR_SCOPED = "tokens|buildChunks|fogTiles|exploredTiles|labels|stamps|lights|pins|traps|templates|drawings|fogDrafts|holders|exploredBy|memory|memoryBy";
const OFFENDING = new RegExp(`\\b(?:s|v)\\.view\\??\\.(?:${FLOOR_SCOPED})\\b|getState\\(\\)\\.view\\b`);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|itest)\.|testutil|Testing/.test(name) ? [path] : [];
  });
}

function boardFiles(): string[] {
  const layers = readdirSync(join(CLIENT, "features")).flatMap((dir) => {
    const full = join(CLIENT, "features", dir);
    return statSync(full).isDirectory() ? sources(full).filter((p) => p.endsWith("Layer.tsx")) : [];
  });
  const all = new Set([...FOLDERS.flatMap((f) => sources(join(CLIENT, f))), ...layers, join(CLIENT, "features/encounters/drop.ts")]);
  return [...all].filter((p) => !SKIPPED.has(relative(CLIENT, p))).sort();
}

describe("the board reads the floor cut", () => {
  test("no board reader takes a floor-scoped collection from the whole view", () => {
    const hits: string[] = [];
    for (const file of boardFiles()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (OFFENDING.test(line) && !/dragNotes/.test(file)) hits.push(`${relative(CLIENT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(hits, []);
  });

  test("the scan finds the files it is meant to guard", () => {
    const names = boardFiles().map((p) => relative(CLIENT, p));
    for (const expected of ["canvas/Stage.tsx", "features/fog/FogLayer.tsx", "features/movement/stageHooks.ts", "features/encounters/drop.ts"]) assert.ok(names.includes(expected), expected);
  });
});
