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

  test("in H3 a hex scene holds no grid-keyed content but its own difficult ground, heights, stairs, Reveal room cells and traps with pits, whatever its stamp (D-261026-8)", () => {
    const rough = hexRoom();
    rough.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough: ROUGH, grid: "hexRows" };
    const loaded = parseRoomState(rough);
    assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
    const kinds: [Partial<BuildChunk>, RegExp][] = [
      [{ cells: { "1,1": "stone" } }, /painted ground/],
      [{ edges: { "1,1,n": { kind: "wall" } } }, /walls and doors/],
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
    const roomFog = parseRoomState(drafted);
    assert.ok(roomFog.ok, roomFog.ok ? "" : roomFog.message);
    drafted.fogDrafts.s1 = { ...drafted.fogDrafts.s1, grid: "hexColumns" };
    assert.equal((parseRoomState(drafted) as { message: string }).message, "scenes.s1: Reveal room in its fog draft on hex columns can't stand on this scene's hex rows");
    // From H3 heights, stairs and a pit of the scene's own shape load, and another shape's are refused (HX-8).
    const raised = hexRoom();
    raised.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: "A".repeat(683) + "=", up: "2".padEnd(256, "."), grid: "hexRows" };
    raised.traps.t1 = trap("t1", { grid: "hexRows" });
    raised.traps.t1.rig = { ...raised.traps.t1.rig!, pit: { floor: -10 } };
    const own = parseRoomState(raised);
    assert.ok(own.ok, own.ok ? "" : own.message);
    raised.buildChunks[chunkKey("s1", 0, 0)] = { ...raised.buildChunks[chunkKey("s1", 0, 0)]!, grid: "hexColumns" };
    assert.equal((parseRoomState(raised) as { message: string }).message, "scenes.s1: heights and stairs on hex columns can't stand on this scene's hex rows");
    const turned = hexRoom();
    turned.traps.t1 = { ...raised.traps.t1, grid: "hexColumns" };
    assert.equal((parseRoomState(turned) as { message: string }).message, "scenes.s1: a trap on hex columns can't stand on this scene's hex rows");
  });

  test("a chunk's stair marks face by its stamp: compass letters on squares, six sides from 0 to 5 on hexes (HX-8)", () => {
    const marks = (mark: string) => mark.padEnd(256, ".");
    const onSquares = (up: string) => {
      const s = room();
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, up };
      return parseRoomState(s);
    };
    const onHexRows = (up: string) => {
      const s = room();
      s.scenes.s1 = scene("s1", { gridShape: "hexRows" });
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, up, grid: "hexRows" };
      return parseRoomState(s);
    };
    for (const mark of ["a", "n", "e", "s", "w"]) assert.equal(onSquares(marks(mark)).ok, true, mark);
    for (const mark of ["0", "3", "5"]) {
      const parsed = onSquares(marks(mark));
      assert.ok(!parsed.ok, mark);
      assert.match(parsed.message, /a stair on squares faces n, e, s or w/);
    }
    for (const mark of ["n", "e", "s", "w"]) assert.equal(onHexRows(marks(mark)).ok, false, mark);
    assert.equal(onSquares(marks("6")).ok, false);
    assert.equal(onHexRows(marks("6")).ok, false);
  });

  test("what carries no grid keys loads on a hex scene: a draft of rects, a chunk emptied", () => {
    const s = hexRoom();
    s.fogDrafts.s1 = { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 2, h: 2 } }] };
    s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
    const parsed = parseRoomState(s);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("in H2 an import with free walls on a hex scene loads: they are in world units", () => {
    const walled = hexRoom();
    walled.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "w00000000001", a: [1, 1], b: [3, 1], f: { kind: "wall" } }] };
    const parsed = parseRoomState(walled);
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

  test("in H2 an import with a trap of the scene's shape or a rider on a hex scene loads, and a square trap there is refused", () => {
    const withTrap = hexRoom();
    withTrap.traps.t1 = trap("t1", { grid: "hexRows" });
    const loaded = parseRoomState(withTrap);
    assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
    const squareTrap = hexRoom();
    squareTrap.traps.t1 = trap("t1");
    assert.match((parseRoomState(squareTrap) as { message: string }).message, /a trap on squares/);
    const ridden = hexRoom();
    ridden.tokens = { horse: token("horse", { size: "large" }), bree: token("bree", { attached: { to: "horse", kind: "ride" } }) };
    const rode = parseRoomState(ridden);
    assert.ok(rode.ok, rode.ok ? "" : rode.message);
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
