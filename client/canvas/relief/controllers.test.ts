import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Both of the board's drawing trees stay mounted once Isometric has shown
 * (docs/design-v1-isometric-view.md 5.1, ISO-D15), so anything with effects
 * must mount once, outside both, or its sound, reminder, camera stream or
 * frame clock runs twice. Node cannot load the .tsx files, so these read
 * their source: the registry's lines, each renderer's own file, and where
 * the board mounts its controllers.
 */

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(CLIENT, path), "utf8");

type Entry = { id: string; iso: string; component: string };

function registry(): { layers: Entry[]; controllers: { id: string; component: string }[]; files: Map<string, string> } {
  const src = read("features/layers.ts");
  const files = new Map<string, string>();
  for (const m of src.matchAll(/import \{ ([^}]+) \} from "\.\/([^"]+)";/g)) {
    for (const name of m[1]!.split(",").map((n) => n.trim())) files.set(name, `features/${m[2]}`);
  }
  // The lazily loaded ones name their module in the loader.
  for (const m of src.matchAll(/const (\w+) = quietLazy<LayerProps>\(\(\) => import\("\.\/([^"]+)"\)/g)) files.set(m[1]!, `features/${m[2]}`);
  const list = (name: string) => src.slice(src.indexOf(`export const ${name}`), src.indexOf("];", src.indexOf(`export const ${name}`)));
  const layers = [...list("LAYERS").matchAll(/\{ id: "([^"]+)", layer: "\w+", order: \d+, iso: "(\w+)", Component: (\w+) \}/g)].map((m) => ({ id: m[1]!, iso: m[2]!, component: m[3]! }));
  const controllers = [...list("CONTROLLERS").matchAll(/\{ id: "([^"]+)", Component: (\w+) \}/g)].map((m) => ({ id: m[1]!, component: m[2]! }));
  return { layers, controllers, files };
}

describe("the board's controllers mount once", () => {
  test("every layer names its isometric place, and every renderer with effects stays out of the isometric tree", () => {
    const { layers, files } = registry();
    const src = read("features/layers.ts");
    const lines = src.slice(src.indexOf("export const LAYERS"), src.indexOf("export const CONTROLLERS")).match(/\{ id: "[^"]+", layer: /g) ?? [];
    assert.equal(layers.length, lines.length, "every LAYERS line parsed");
    assert.ok(layers.length >= 20);
    for (const l of layers) {
      assert.match(l.iso, /^(ground|moving|upright|off)$/);
      const file = files.get(l.component);
      assert.ok(file, `${l.component} has a file`);
      const body = read(file!);
      const effects = /\buse(Layout)?Effect\(|requestAnimationFrame\(|\.subscribe\(/.test(body) || /use\w*Reminders?\(/.test(body);
      if (effects) assert.equal(l.iso, "off", `${l.id} runs effects in its component (${file}), so it would run them in both trees`);
    }
  });

  test("the camera stream and the thumbnails are controllers, never layers", () => {
    const { layers, controllers } = registry();
    assert.deepEqual(
      controllers.map((c) => c.id),
      ["dm-camera", "scene-thumbnails"],
    );
    for (const id of ["dm-camera", "scene-thumbnails"]) assert.ok(!layers.some((l) => l.id === id), `${id} drawn in a tree`);
    assert.doesNotMatch(read("features/dm/CameraLayer.tsx"), /getStage\(|react-konva/, "the camera controller reads the camera it is given, not a stage");
  });

  test("the board mounts its controllers and the ghosts' clock once, outside both drawing trees", () => {
    const stage = read("canvas/Stage.tsx");
    const iso = read("canvas/relief/IsoBoard.tsx");
    assert.equal(stage.match(/CONTROLLERS\.map\(/g)?.length, 1);
    assert.equal(stage.match(/<RemoteDragClock /g)?.length, 1);
    // Both before the first drawing tree opens.
    const firstTree = stage.indexOf("<Frozen frozen=");
    assert.ok(stage.indexOf("CONTROLLERS.map(") < firstTree && stage.indexOf("<RemoteDragClock ") < firstTree);
    assert.doesNotMatch(iso, /CONTROLLERS|RemoteDragClock|CameraController|ThumbnailLayer/);
    // The ghosts read the clock's store in both trees, and keep no clock of their own.
    const drags = read("canvas/RemoteDrags.tsx");
    const clock = drags.indexOf("export function RemoteDragClock");
    const rest = drags.slice(0, clock) + drags.slice(drags.indexOf("\n}\n", clock));
    assert.doesNotMatch(rest, /requestAnimationFrame/);
  });
});
