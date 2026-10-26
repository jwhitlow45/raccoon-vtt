import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import type { BuildChunk, RoomState } from "#shared/model.ts";
import { room, scene, template, token, trap } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Hex grids' stored fields (docs/design-v1-hex-grids.md section 7, lane
 * HX-1): a scene's shape, the room's New scenes, a stationary emanation's
 * size and the stamps, and the import's hold on the shape's invariant.
 */
function hexRoom(): RoomState {
  const s = room();
  s.meta = { ...s.meta, settings: { ...s.meta.settings, newScenes: "hexColumns" } };
  s.scenes.s1 = scene("s1", { gridShape: "hexRows" });
  s.templates.a1 = template("a1", { sceneId: "s1", shape: "emanation", footprint: { w: 3, h: 3, elevation: 0, height: 15, size: "huge" } });
  return s;
}

const ROUGH = "d".padEnd(256, ".");

describe("roomStateSchema, hex grids (docs/design-v1-hex-grids.md section 7)", () => {
  test("a room with a hex scene, its New scenes and a stationary size loads as it was", () => {
    const parsed = parseRoomState(hexRoom());
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.state.scenes.s1!.gridShape, "hexRows");
    assert.equal(parsed.state.meta.settings.newScenes, "hexColumns");
    assert.equal(parsed.state.templates.a1!.footprint!.size, "huge");
  });

  test("a backup from before hex grids has none of them, and reads as squares", () => {
    const parsed = parseRoomState(room());
    assert.ok(parsed.ok);
    assert.equal(parsed.state.scenes.s1!.gridShape, undefined);
    assert.ok(!("newScenes" in parsed.state.meta.settings));
  });

  test("no shape but the two hex ones, and no custom stationary size", () => {
    for (const bad of [
      { ...hexRoom(), scenes: { s1: scene("s1", { gridShape: "squares" as never }) } },
      { ...hexRoom(), meta: { ...hexRoom().meta, settings: { ...hexRoom().meta.settings, newScenes: "squares" as never } } },
      { ...hexRoom(), templates: { a1: template("a1", { footprint: { w: 1, h: 1, elevation: 0, height: 5, size: "custom" as never } }) } },
    ]) {
      assert.equal(parseRoomState(bad).ok, false);
    }
  });

  test("in H1 a hex scene holds no grid-keyed content, whatever its stamp (D-261026-8)", () => {
    const kinds: [Partial<BuildChunk>, RegExp][] = [
      [{ cells: { "1,1": "stone" } }, /painted ground/],
      [{ edges: { "1,1,n": { kind: "wall" } } }, /walls and doors/],
      [{ rough: ROUGH }, /difficult ground/],
      [{ heights: "A".repeat(683) + "=" }, /heights/],
      [{ up: ".".repeat(256) }, /stairs/],
    ];
    for (const [content, words] of kinds) {
      const s = hexRoom();
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, ...content, grid: "hexRows" };
      const parsed = parseRoomState(s);
      assert.ok(!parsed.ok);
      assert.match(parsed.message, words);
      assert.match(parsed.message, /^scenes\.s1: .* can't stand on this scene's hexes$/);
    }
    const drafted = hexRoom();
    drafted.fogDrafts.s1 = { sceneId: "s1", rev: 1, grid: "hexRows", ops: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } }] };
    assert.equal((parseRoomState(drafted) as { message: string }).message, "scenes.s1: Reveal room in its fog draft can't stand on this scene's hexes");
    const trapped = hexRoom();
    trapped.traps.t1 = trap("t1", { grid: "hexRows" });
    assert.equal((parseRoomState(trapped) as { message: string }).message, "scenes.s1: a trap can't stand on this scene's hexes");
  });

  test("what carries no grid keys loads on a hex scene: a draft of rects, a chunk emptied", () => {
    const s = hexRoom();
    s.fogDrafts.s1 = { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 2, h: 2 } }] };
    s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
    const parsed = parseRoomState(s);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("an import with square cell data on a hex scene is refused, naming it", () => {
    const s = hexRoom();
    s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough: ROUGH };
    const parsed = parseRoomState(s);
    assert.ok(!parsed.ok);
    assert.equal(parsed.message, "scenes.s1: difficult ground on squares can't stand on this scene's hexes");
  });

  test("an import with hex data on a square scene is refused", () => {
    const s = room();
    s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough: ROUGH, grid: "hexRows" };
    assert.equal(parseRoomState(s).ok, false);
  });

  test("an import with what H1 leaves off hexes is refused: a trap, a free wall, a rider", () => {
    const withTrap = hexRoom();
    withTrap.traps.t1 = trap("t1", { grid: "hexRows" });
    assert.match((parseRoomState(withTrap) as { message: string }).message, /a trap/);
    const walled = hexRoom();
    walled.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "w00000000001", a: [1, 1], b: [3, 1], f: { kind: "wall" } }] };
    assert.match((parseRoomState(walled) as { message: string }).message, /walls and doors/);
    const ridden = hexRoom();
    ridden.tokens = { horse: token("horse", { size: "large" }), bree: token("bree", { attached: { to: "horse", kind: "ride" } }) };
    assert.match((parseRoomState(ridden) as { message: string }).message, /attached creature/);
  });

  test("an import refuses a hex scene that reads as having come with its own square grid (D-261026-8)", () => {
    const marked = hexRoom();
    marked.scenes.s1 = scene("s1", { gridShape: "hexRows", gridFromFile: true });
    assert.equal((parseRoomState(marked) as { message: string }).message, "scenes.s1: This scene came with its own square grid from its file.");
    const before = hexRoom();
    before.scenes.s1 = scene("s1", { gridShape: "hexColumns", map: { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: -10, y: 0 } } });
    assert.equal(parseRoomState(before).ok, false);
    const square = room();
    square.scenes.s1 = scene("s1", { gridFromFile: true, map: { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: -10, y: 0 } } });
    assert.ok(parseRoomState(square).ok, "a square import keeps its mark");
  });
});
