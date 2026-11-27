import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkThree, closure, dynamicImports, modelWorkerBundle, staticImports, type Chunk } from "./three-chunk.ts";

/** The post-build check of the dice chunk (docs/design/design-v1-roll-animation.md 6), on made-up builds. */

const THREE = "../../node_modules/.pnpm/three@0.186.1/node_modules/three/build/three.module.js";
const THREE_CORE = THREE.replace("three.module.js", "three.core.js");

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
  chunk("TokenPanel.js", ["../../client/panels/TokenPanel.tsx"], 'import{t}from"./theme.js";'),
  chunk("CharactersPanel.js", ["../../client/features/tokens/CharactersPanel.tsx"], 'import{t}from"./theme.js";'),
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

  test("finds three by its core build alone, which holds the renderer's classes since r171", () => {
    const result = checkThree(build([...base, chunk("stage.js", ["../../client/features/dice/throw/stage.ts", THREE_CORE])]));
    assert.deepEqual(result.problems, []);
    assert.equal(result.stage, "stage.js");
    const inPanel = base.map((c) => (c.file === "DicePanel.js" ? { ...c, sources: [...c.sources, THREE_CORE] } : c));
    assert.match(checkThree(build(inPanel)).problems.join("\n"), /loads with the Dice panel/);
  });

  test("fails three in the Dice panel's chunk, in one it imports, in two chunks or in none", () => {
    const inPanel = base.map((c) => (c.file === "DicePanel.js" ? { ...c, sources: [...c.sources, THREE] } : c));
    assert.match(checkThree(build(inPanel)).problems.join("\n"), /loads with the Dice panel/);
    const imported = [...base.filter((c) => c.file !== "DicePanel.js"), chunk("DicePanel.js", ["../../client/features/dice/DicePanel.tsx"], 'import{t}from"./math.js";'), chunk("math.js", [THREE])];
    assert.match(checkThree(build(imported)).problems.join("\n"), /math\.js loads with/);
    assert.match(checkThree(build([...base, chunk("a.js", [THREE]), chunk("b.js", [THREE])])).problems.join("\n"), /in 2 chunks/);
    assert.match(checkThree(build(base)).problems.join("\n"), /in 0 chunks/);
  });

  test("fails three in the Token or Characters panel's chunk, or in one they import, and either chunk missing", () => {
    for (const [file, name] of [["TokenPanel.js", "Token panel"], ["CharactersPanel.js", "Characters panel"]] as const) {
      const inPanel = base.map((c) => (c.file === file ? { ...c, sources: [...c.sources, THREE] } : c));
      assert.match(checkThree(build(inPanel)).problems.join("\n"), new RegExp(`loads with the ${name}`), name);
      const imported = base.map((c) => (c.file === file ? chunk(file, c.sources, 'import{t}from"./math.js";') : c));
      assert.match(checkThree(build([...imported, chunk("math.js", [THREE])])).problems.join("\n"), /math\.js loads with/, name);
      assert.match(checkThree(build([...base.filter((c) => c.file !== file), chunk("stage.js", [THREE])])).problems.join("\n"), new RegExp(`no ${name} chunk found`), name);
    }
  });

  test("passes three in the model worker's bundle too, entry or a chunk it imports, and reports the bundle", () => {
    const stage = chunk("stage.js", ["../../client/features/dice/throw/stage.ts", THREE]);
    const inEntry = checkThree(build([...base, stage, chunk("worker-a.js", ["../../client/features/models/worker.ts", "../../client/features/models/render.ts", THREE_CORE])]));
    assert.deepEqual(inEntry.problems, []);
    assert.equal(inEntry.stage, "stage.js");
    assert.deepEqual([...inEntry.worker], ["worker-a.js"]);
    const split = [stage, chunk("worker-b.js", ["../../client/features/models/worker.ts"], 'import{r}from"./render.js";const t=()=>import("./later.js");'), chunk("render.js", [THREE]), chunk("later.js", [])];
    const inChunk = checkThree(build([...base, ...split]));
    assert.deepEqual(inChunk.problems, []);
    assert.deepEqual([...inChunk.worker].sort(), ["later.js", "render.js", "worker-b.js"]);
  });

  test("fails three in another worker, as a second chunk, and passes a build with no model worker", () => {
    const stage = chunk("stage.js", ["../../client/features/dice/throw/stage.ts", THREE]);
    const other = chunk("worker-c.js", ["../../client/features/uvtt/worker.ts", THREE]);
    assert.match(checkThree(build([...base, stage, other])).problems.join("\n"), /in 2 chunks outside the model worker/);
    assert.deepEqual(checkThree(build([...base, stage])).worker.size, 0);
  });

  test("still fails three in the page beside a model worker that holds it too", () => {
    const worker = chunk("worker-a.js", ["../../client/features/models/worker.ts", THREE]);
    const inPanel = base.map((c) => (c.file === "DicePanel.js" ? { ...c, sources: [...c.sources, THREE] } : c));
    assert.match(checkThree(build([...inPanel, worker])).problems.join("\n"), /loads with the Dice panel/);
    assert.match(checkThree(build([...base, worker])).problems.join("\n"), /in 0 chunks outside the model worker/);
  });

  test("reads import() apart from static imports, and the model worker's bundle through both", () => {
    assert.deepEqual(dynamicImports('const a=()=>import("./x.js");import"./y.js";const b=import(`./z.js`)'), ["x.js", "z.js"]);
    const chunks = build([chunk("w.js", ["../../client/features/models/worker.ts"], 'import"./a.js";'), chunk("a.js", [], 'const l=()=>import("./b.js")'), chunk("b.js", []), chunk("c.js", [])]).chunks;
    assert.deepEqual([...modelWorkerBundle(chunks)].sort(), ["a.js", "b.js", "w.js"]);
  });
});
