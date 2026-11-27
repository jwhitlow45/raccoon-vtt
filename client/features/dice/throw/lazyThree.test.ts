import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { clientFiles, stripComments, type SourceFile } from "../../../../scripts/style-drift.ts";

/**
 * The dice chunk's lazy boundary (docs/design/design-v1-roll-animation.md 6),
 * read from the source as uiPassScan.test.ts reads it. three.js hardly
 * tree-shakes, so one stray import would put all of it in the Dice
 * panel's chunk, which every member preloads. Only the stage and the
 * modules only it imports may import three, and nothing else imports
 * them but by `import()`. The post-build check (scripts/three-chunk.ts)
 * then reads the chunks the build made.
 *
 * The model worker (docs/design/design-v1-token-models.md 5, D-261127-377)
 * is the other place three loads: its entry and its renderer join the
 * stage. Nothing imports the worker. Only client.ts makes it, and the 3D
 * model sheet reaches client.ts only by `import()`. The worker reads
 * three's core and renderer, never a loader (D-261127-479), and loads
 * nothing at all: no fetch and no URL of its own, so it runs under the
 * app's `connect-src 'self'`.
 */

const MODEL_WORKER = "client/features/models/worker.ts";
const MODEL_CLIENT = "client/features/models/client.ts";
const STAGE = ["client/features/dice/throw/stage.ts", "client/features/dice/throw/models.ts", "client/features/dice/throw/poses.ts", MODEL_WORKER, "client/features/models/render.ts"];

type Import = { from: string; to: string; dynamic: boolean; typeOnly?: boolean };

/** Every import in the files, static or `import()`, with relative specifiers resolved to a file path. */
function importsOf(files: readonly SourceFile[]): Import[] {
  const out: Import[] = [];
  for (const file of files) {
    const add = (spec: string, dynamic: boolean) => {
      const to = spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec)) : spec;
      out.push({ from: file.path, to, dynamic });
    };
    for (const m of file.text.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g)) {
      add(m[1]!, false);
      if (/^\s*(?:import|export)\s+type\b/.test(m[0].replace(/^[\n;]/, ""))) out.at(-1)!.typeOnly = true;
    }
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
    // A loader is a whole-file parse no cap bounds: the model worker reads three's core alone.
    if (three && i.from.startsWith("client/features/models/") && i.to !== "three") out.push(`${i.from} imports ${i.to}`);
    if (i.to === MODEL_CLIENT && !i.dynamic && !i.typeOnly) out.push(`${i.from} imports ${i.to} statically`);
  }
  // The worker is made by `new Worker(new URL("./worker.ts", import.meta.url))`, which only client.ts may write.
  for (const file of files) {
    for (const m of file.text.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), m[1]!));
      if (to === MODEL_WORKER && file.path !== MODEL_CLIENT) out.push(`${file.path} makes the model worker`);
    }
  }
  return out;
}

/** Ways a module could load something: a request, a script or worker by URL, a URL made for a blob. */
const LOADS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bimportScripts\b/, /\bcreateObjectURL\b/, /\bnew\s+Image\s*\(/, /\bWebSocket\b/, /\bEventSource\b/, /["'`]blob:/, /["'`]data:/, /\bimport\s*\(/];

/** The model worker's modules, the worker and all it imports in client/, that could load anything: none may. */
function workerLoads(files: readonly SourceFile[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const imports = importsOf(files);
  const seen = new Set<string>();
  const stack = [MODEL_WORKER];
  const out: string[] = [];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    const file = byPath.get(at);
    if (!file) continue;
    for (const re of LOADS) if (re.test(file.text)) out.push(`${at} matches ${re.source}`);
    for (const i of imports) if (i.from === at && !i.typeOnly && i.to.startsWith("client/")) stack.push(i.to);
  }
  return out;
}

describe("the dice chunk's lazy boundary", () => {
  test("only the stage and the modules only it imports reach three, and the rest reach the stage by import()", () => {
    assert.deepEqual(boundaryFaults(clientFiles()), []);
  });

  test("the model worker loads nothing: no fetch, no script, no blob or data URL, no import()", () => {
    const files = clientFiles();
    assert.ok(files.some((f) => f.path === MODEL_WORKER), "the scan finds the worker");
    assert.deepEqual(workerLoads(files), []);
  });

  test("the model worker's scans find what they look for", () => {
    const made = (p: string, text: string) => ({ path: p, text: stripComments(text) });
    const faults = boundaryFaults([
      made("client/features/models/client.ts", 'const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n'),
      made("client/features/models/ModelSheet.tsx", 'import { drawModel } from "./client.ts";\nimport type { DrawOptions } from "./client.ts";\nconst w = new URL("./worker.ts", import.meta.url);\n'),
      made("client/features/models/render.ts", 'import { WebGLRenderer } from "three";\nimport { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\n'),
      made("client/features/models/worker.ts", 'import { SheetDrawer } from "./render.ts";\n'),
      made("client/features/models/upload.ts", 'const c = () => import("./client.ts");\n'),
    ]);
    assert.deepEqual(faults, [
      "client/features/models/ModelSheet.tsx imports client/features/models/client.ts statically",
      "client/features/models/render.ts imports three/addons/loaders/GLTFLoader.js",
      "client/features/models/ModelSheet.tsx makes the model worker",
    ]);
    const loads = workerLoads([
      made("client/features/models/worker.ts", 'import { readModel } from "./read.ts";\nimport type { X } from "./types.ts";\n'),
      made("client/features/models/read.ts", 'const r = await fetch(url);\nconst u = URL.createObjectURL(blob);\n'),
      made("client/features/models/types.ts", 'export type X = 1;\nconst t = "blob:";\n'),
    ]);
    assert.deepEqual(loads, [String.raw`client/features/models/read.ts matches \bfetch\s*\(`, String.raw`client/features/models/read.ts matches \bcreateObjectURL\b`]);
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
