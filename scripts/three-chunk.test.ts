import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkThree, closure, staticImports, type Chunk } from "./three-chunk.ts";

/** The post-build check of the dice chunk (docs/design-v1-roll-animation.md 6), on made-up builds. */

const THREE = "../../node_modules/.pnpm/three@0.160.0/node_modules/three/build/three.module.js";

function chunk(file: string, sources: string[], code = ""): Chunk {
  return { file, code, sources, imports: staticImports(code) };
}

function build(chunks: Chunk[]) {
  return { entry: "index.js", chunks: new Map(chunks.map((c) => [c.file, c])) };
}

const base = [
  chunk("index.js", ["../../client/main.tsx"], 'import{a as b}from"./react.js";import"./theme.js";const r=()=>import("./Room.js");'),
  chunk("react.js", []),
  chunk("theme.js", []),
  chunk("Room.js", ["../../client/pages/Room.tsx"], 'import{x}from"./room.js";'),
  chunk("room.js", ["../../client/canvas/Stage.tsx"]),
  chunk("DicePanel.js", ["../../client/features/dice/DicePanel.tsx"], 'import{t}from"./theme.js";const s=()=>import("./stage.js");'),
];

describe("the dice chunk's post-build check", () => {
  test("reads static imports and never import()", () => {
    assert.deepEqual(staticImports('import{a as b}from"./react.js";import"./theme.js";export{c}from"./x.js";const r=()=>import("./Room.js");'), ["react.js", "theme.js", "x.js"]);
    assert.deepEqual([...closure(build(base).chunks, ["index.js"])].sort(), ["index.js", "react.js", "theme.js"]);
  });

  test("passes three in a chunk of its own that only import() reaches", () => {
    const result = checkThree(build([...base, chunk("stage.js", ["../../client/features/dice/throw/stage.ts", THREE])]));
    assert.deepEqual(result.problems, []);
    assert.equal(result.stage, "stage.js");
  });

  test("fails three in the Dice panel's chunk, in one it imports, in two chunks or in none", () => {
    const inPanel = base.map((c) => (c.file === "DicePanel.js" ? { ...c, sources: [...c.sources, THREE] } : c));
    assert.match(checkThree(build(inPanel)).problems.join("\n"), /loads with the Dice panel/);
    const imported = [...base.filter((c) => c.file !== "DicePanel.js"), chunk("DicePanel.js", ["../../client/features/dice/DicePanel.tsx"], 'import{t}from"./math.js";'), chunk("math.js", [THREE])];
    assert.match(checkThree(build(imported)).problems.join("\n"), /math\.js loads with/);
    assert.match(checkThree(build([...base, chunk("a.js", [THREE]), chunk("b.js", [THREE])])).problems.join("\n"), /in 2 chunks/);
    assert.match(checkThree(build(base)).problems.join("\n"), /in 0 chunks/);
  });
});
