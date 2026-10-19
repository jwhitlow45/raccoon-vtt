import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeRough } from "../heightCodec.ts";
import { chunkKey } from "../keys.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, apply, env, refused, room, scene, template } from "../testutil.ts";

/** Difficult ground marks and slowing areas as stored (docs/design-v1-movement.md 6.3, 6.4). */

describe("difficult ground marks (6.3)", () => {
  test("mark cells and clear them, the terrain untouched and no walls version moved", () => {
    const state = room();
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone" }, edges: {} };
    const walls = state.scenes.s1!.wallsVersion;
    let next = apply(state, { t: "build.rough", sceneId: "s1", cells: ["1,1", "2,1"], on: true });
    const chunk = next.buildChunks[chunkKey("s1", 0, 0)]!;
    assert.equal(chunk.rough!.length, 256);
    assert.deepEqual(chunk.cells, { "1,1": "stone" });
    assert.equal(decodeRough(chunk.rough)[16 + 2], true);
    assert.equal(next.scenes.s1!.wallsVersion, walls);
    next = apply(next, { t: "build.rough", sceneId: "s1", cells: ["1,1", "2,1"], on: false });
    assert.equal(next.buildChunks[chunkKey("s1", 0, 0)]!.rough, undefined);
    const bare = apply(room(), { t: "build.rough", sceneId: "s1", cells: ["4,4"], on: true });
    assert.deepEqual(Object.keys(bare.buildChunks), [chunkKey("s1", 0, 0)]);
    assert.deepEqual(apply(bare, { t: "build.rough", sceneId: "s1", cells: ["4,4"], on: false }).buildChunks, {}, "a chunk left with nothing goes");
  });

  test("erase takes a cell's mark with the rest of it, and Clear takes them all", () => {
    let state = apply(room(), { t: "build.rough", sceneId: "s1", cells: ["1,1", "3,3"], on: true });
    state = apply(state, { t: "build.erase", sceneId: "s1", cells: ["1,1"] });
    const marks = decodeRough(state.buildChunks[chunkKey("s1", 0, 0)]!.rough);
    assert.deepEqual([marks[16 + 1], marks[3 * 16 + 3]], [false, true]);
    assert.deepEqual(apply(state, { t: "build.clear", sceneId: "s1" }).buildChunks, {});
  });

  test("the DM's alone, cells inside the scene, and players see the marks with the map", () => {
    const state = room();
    assert.equal(canApply({ t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true }, P1, state, { canUseAsset: () => true }).ok, false);
    assert.equal(refused(state, { t: "build.rough", sceneId: "s1", cells: ["0,30"], on: true }).message, "cell outside the scene");
    const marked = apply(state, { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true });
    const seen = projectState(marked, P1, { sceneId: "s1" });
    assert.equal(decodeRough(seen.buildChunks[chunkKey("s1", 0, 0)]?.rough)[16 + 1], true);
  });

  test("a duplicate copies the marks as stored", () => {
    const state = apply(room(), { t: "build.rough", sceneId: "s1", cells: ["2,2"], on: true });
    const copied = applyOp(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } }, DM, env(2));
    assert.ok(copied.ok);
    assert.equal(copied.state.buildChunks[chunkKey("s9", 0, 0)]?.rough, state.buildChunks[chunkKey("s1", 0, 0)]!.rough);
  });
});

describe("slowing areas (6.4)", () => {
  test("an area keeps how it slows movement, and a patch of null makes it normal", () => {
    const state = room({ templates: { a1: template("a1") } });
    const slowed = apply(state, { t: "template.update", templateId: "a1", patch: { slows: { kind: "halfSpeed", foes: true } } });
    assert.deepEqual(slowed.templates.a1!.slows, { kind: "halfSpeed", foes: true });
    assert.equal(apply(slowed, { t: "template.update", templateId: "a1", patch: { slows: null } }).templates.a1!.slows, undefined);
    void scene;
  });
});
