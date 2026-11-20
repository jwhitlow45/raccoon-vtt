import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

/*
 * Sight through openings (docs/design/design-v1-floors.md phase 4, 7.2):
 * every reader of a floor's sight asks `visionRules.sightFor` with the
 * class it reads, which joins the floor's own answer through its openings
 * class by class. A reader that asks `partySight` or `holderSight` itself
 * reads the floor's own answer alone, so a creature under a lit hole is
 * withheld from one projection and shown in another, or a class reads a
 * union it may not see. Only the rules themselves may ask them.
 */

const ROOT = join(import.meta.dirname, "..");
const FOLDERS = ["shared", "server", "client"];
/** The rules' own files: vision.ts computes the answers, ruleHooks.ts and openingSight.ts join them. */
const ALLOWED = new Set(["shared/rules/vision.ts", "shared/ruleHooks.ts", "shared/rules/openingSight.ts"]);
const READS = /\bvisionRules\s*\.\s*(partySight|holderSight)\b|(?<![.\w])(partySight|holderSight)\s*\(/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|itest|e2e)\.tsx?$/.test(name) && !/[Tt]estutil\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** A line's code, without what a comment says. */
function code(line: string): string {
  const t = line.trim();
  if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) return "";
  const at = line.indexOf("//");
  return at >= 0 ? line.slice(0, at) : line;
}

/** Every line outside the rules' own files that reads a floor's own answer directly. */
export function directReads(files: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    if (ALLOWED.has(path)) continue;
    text.split("\n").forEach((line, i) => {
      if (READS.test(code(line))) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("every sight reader asks sightFor (docs/design/design-v1-floors.md phase 4, 7.2)", () => {
  test("no source outside vision.ts, ruleHooks.ts and openingSight.ts asks partySight or holderSight", () => {
    const files = FOLDERS.flatMap((folder) => sources(join(ROOT, folder))).map((path) => ({ path: relative(ROOT, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
    assert.ok(files.some((f) => f.path === "shared/project.ts"), "the scan reads the projection");
    assert.deepEqual(directReads(files), []);
  });

  test("the scan finds a direct read, through visionRules or by name, and passes the allowed files and comments", () => {
    const found = directReads([
      { path: "shared/project.ts", text: "const a = visionRules.partySight(state, id);\n// visionRules.holderSight(state, id, null)\n * partySight(state, id)" },
      { path: "server/rooms/explore.ts", text: "const b = holderSight(state, id, null, WORLD);\nconst c = visionRules.sightFor(state, id, \"shared\");" },
      { path: "shared/ruleHooks.ts", text: "partySight: (state, sceneId) => partySight(state, sceneId, VISION_WORLD)," },
    ]);
    assert.deepEqual(found, ["shared/project.ts:1: const a = visionRules.partySight(state, id);", "server/rooms/explore.ts:1: const b = holderSight(state, id, null, WORLD);"]);
  });
});
