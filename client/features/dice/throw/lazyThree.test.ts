import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { clientFiles, stripComments, type SourceFile } from "../../../../scripts/style-drift.ts";

/**
 * The dice chunk's lazy boundary (docs/design-v1-roll-animation.md 6),
 * read from the source as uiPassScan.test.ts reads it. three.js hardly
 * tree-shakes, so one stray import would put all of it in the Dice
 * panel's chunk, which every member preloads. Only the stage and the
 * modules only it imports may import three, and nothing else imports
 * them but by `import()`. The post-build check (scripts/three-chunk.ts)
 * then reads the chunks the build made.
 */

const STAGE = ["client/features/dice/throw/stage.ts", "client/features/dice/throw/models.ts", "client/features/dice/throw/poses.ts"];

type Import = { from: string; to: string; dynamic: boolean };

/** Every import in the files, static or `import()`, with relative specifiers resolved to a file path. */
function importsOf(files: readonly SourceFile[]): Import[] {
  const out: Import[] = [];
  for (const file of files) {
    const add = (spec: string, dynamic: boolean) => {
      const to = spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec)) : spec;
      out.push({ from: file.path, to, dynamic });
    };
    for (const m of file.text.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g)) add(m[1]!, false);
    for (const m of file.text.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) add(m[1]!, false);
    for (const m of file.text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]!, true);
  }
  return out;
}

/** What breaks the boundary: a file outside the stage that imports three, or one that imports the stage's modules other than by `import()`. */
function boundaryFaults(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const i of importsOf(files)) {
    const three = i.to === "three" || i.to.startsWith("three/");
    if (three && !STAGE.includes(i.from)) out.push(`${i.from} imports ${i.to}`);
    if (STAGE.includes(i.to) && !STAGE.includes(i.from) && !i.dynamic) out.push(`${i.from} imports ${i.to} statically`);
  }
  return out;
}

describe("the dice chunk's lazy boundary", () => {
  test("only the stage and the modules only it imports reach three, and the rest reach the stage by import()", () => {
    assert.deepEqual(boundaryFaults(clientFiles()), []);
  });

  test("the scan finds what it looks for", () => {
    const made = (p: string, text: string) => ({ path: p, text: stripComments(text) });
    const faults = boundaryFaults([
      made("client/features/dice/Tray.tsx", 'import { Vector3 } from "three";\nimport type { Quaternion } from "three";\n// import { Box3 } from "three";\n'),
      made("client/features/dice/throw/store.ts", 'const stage = () => import("./stage.ts");\nimport { buildModel } from "./models.ts";\n'),
      made("client/features/dice/throw/stage.ts", 'import { WebGLRenderer } from "three";\nimport { landing } from "./models.ts";\n'),
      made("client/features/dice/x.ts", 'export { poseAt } from "./throw/poses.ts";\nconst t = import("three");\n'),
    ]);
    assert.deepEqual(faults, [
      "client/features/dice/Tray.tsx imports three",
      "client/features/dice/Tray.tsx imports three",
      "client/features/dice/throw/store.ts imports client/features/dice/throw/models.ts statically",
      "client/features/dice/x.ts imports client/features/dice/throw/poses.ts statically",
      "client/features/dice/x.ts imports three",
    ]);
  });
});
