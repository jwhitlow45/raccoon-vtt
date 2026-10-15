import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = fileURLToPath(new URL("..", import.meta.url));

/** Konva's core registers these itself. Every other element must have its shape imported in konvaSetup.ts. */
const CORE = new Set(["Stage", "Layer", "FastLayer", "Group", "Shape"]);
/** Modules that register more than the shape they are named for. */
const ALSO = new Map([["Label", ["Tag"]]]);

test("every react-konva element the client uses has its Konva shape registered", () => {
  const setup = readFileSync(path.join(CLIENT, "canvas/konvaSetup.ts"), "utf8");
  const registered = new Set(CORE);
  for (const [, shape] of setup.matchAll(/^import "konva\/lib\/shapes\/(\w+)";$/gm)) {
    registered.add(shape!);
    for (const extra of ALSO.get(shape!) ?? []) registered.add(extra);
  }
  const files = readdirSync(CLIENT, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules"));
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(CLIENT, file), "utf8");
    for (const [, names] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"react-konva"/g)) {
      for (const name of names!.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!).filter(Boolean)) {
        if (!registered.has(name)) missing.push(`${name} (${file})`);
      }
    }
  }
  assert.deepEqual(missing, [], "import the shape in client/canvas/konvaSetup.ts");
});
