import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { RoomState, Scene, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp, type ApplyResult } from "../reducer.ts";
import { HEX_R, HEX_S } from "../rules/hex.ts";
import { labelBox } from "../rules/labels.ts";
import { env, member, room, scene } from "../testutil.ts";

/*
 * The builder's cell data on a hex scene (docs/design-v1-hex-grids.md
 * phase H2): difficult ground and Erase by hex keys, in chunks of 16 by 16
 * hexes by key, each chunk stamped with its shape (HX-D14), and free walls
 * in the world chunk of their midpoint.
 */

const A: Viewer = { memberId: "dmA", role: "dm" };
const B: Viewer = { memberId: "dmB", role: "dm" };

function hexRoom(shape: "hexRows" | "hexColumns" = "hexRows", overrides: Partial<Scene> = {}): RoomState {
  return room({
    members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm"), p1: member("p1") },
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 30, h: 20 }, ...overrides }), s2: scene("s2", { order: 1 }) },
  });
}

let seq = 1;
function step(state: RoomState, op: Op, who: Viewer = A): ApplyResult {
  return applyOp(state, opSchema.parse(op), who, env(seq++));
}

function run(state: RoomState, op: Op, who: Viewer = A): { state: RoomState; inverse: RestoreEntry[] } {
  const r = step(state, op, who);
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

function refusal(state: RoomState, op: Op, who: Viewer = A): string {
  const r = step(state, op, who);
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

const rough = (cells: string[], on = true): Op => ({ t: "build.rough", sceneId: "s1", cells, on });
const erase = (cells: string[]): Op => ({ t: "build.erase", sceneId: "s1", cells });
const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });
/** A wall from a to b, its ends on the 1/64 lattice. */
const wall = (id: string, a: [number, number], b: [number, number]) => ({ id: id.padEnd(12, "0"), a, b, f: { kind: "wall" as const } });
const lat = (v: number) => Math.round(v * 64) / 64;

describe("difficult ground by hex under hex keys (H2)", () => {
  test("the last row of a 200 by 200 hex rows scene takes a mark, filed in chunk row 14, and the row past it is refused", () => {
    const big = hexRoom("hexRows", { bounds: { w: 200, h: 200 } });
    // Row 229 is odd, and odd rows hold one hex fewer: its last is 198.
    const marked = run(big, rough(["198,229"])).state;
    const chunk = marked.buildChunks[chunkKey("s1", 12, 14)]!;
    assert.equal(chunk.rough?.[(229 - 14 * 16) * 16 + (198 - 12 * 16)], "d");
    assert.equal(chunk.grid, "hexRows");
    assert.equal(refusal(big, rough(["199,229"])), "cell outside the scene");
    run(big, rough(["199,228"]));
    assert.equal(refusal(big, rough(["0,230"])), "cell outside the scene");
  });

  test("the last column of a 200 by 200 hex columns scene takes a mark, filed in chunk column 14", () => {
    const big = hexRoom("hexColumns", { bounds: { w: 200, h: 200 } });
    const marked = run(big, rough(["229,0"])).state;
    const chunk = marked.buildChunks[chunkKey("s1", 14, 0)]!;
    assert.equal(chunk.rough?.[229 - 14 * 16], "d");
    assert.equal(chunk.grid, "hexColumns");
    assert.equal(refusal(big, rough(["230,0"])), "cell outside the scene");
  });

  test("a hex past an odd row's end is outside the scene: 30 hexes in even rows, 29 in odd", () => {
    const state = hexRoom();
    run(state, rough(["29,0"]));
    assert.equal(refusal(state, rough(["29,1"])), "cell outside the scene");
    run(state, rough(["28,21"]));
    assert.equal(refusal(state, rough(["0,22"])), "cell outside the scene");
  });

  test("the stamp goes with the last grid-keyed content, and a chunk of free walls only carries none", () => {
    const walled = run(hexRoom(), { t: "build.walls", sceneId: "s1", put: [wall("w1", [1, 1], [3, 1])] }).state;
    assert.equal(walled.buildChunks[chunkKey("s1", 0, 0)]!.grid, undefined, "free walls are in world units");
    const marked = run(walled, rough(["4,4"])).state;
    assert.equal(marked.buildChunks[chunkKey("s1", 0, 0)]!.grid, "hexRows");
    const cleared = run(marked, rough(["4,4"], false)).state;
    const left = cleared.buildChunks[chunkKey("s1", 0, 0)]!;
    assert.equal(left.rough, undefined);
    assert.equal(left.grid, undefined, "dropped with the last of it");
    assert.equal(left.walls?.length, 1);
    const gone = run(run(hexRoom(), rough(["4,4"])).state, rough(["4,4"], false)).state;
    assert.equal(gone.buildChunks[chunkKey("s1", 0, 0)], undefined, "an empty chunk goes");
  });

  test("a square scene's chunks never carry a stamp", () => {
    const marked = run(room(), rough(["4,4"])).state;
    assert.equal("grid" in marked.buildChunks[chunkKey("s1", 0, 0)]!, false);
  });

  test("a mark's undo puts the chunk back as it was, stamp and all", () => {
    const marked = run(hexRoom(), rough(["4,4", "5,4"]));
    const undone = run(marked.state, undo(marked.inverse)).state;
    assert.equal(undone.buildChunks[chunkKey("s1", 0, 0)], undefined);
    const again = run(marked.state, rough(["4,4"], false));
    assert.equal(run(again.state, undo(again.inverse)).state.buildChunks[chunkKey("s1", 0, 0)]?.grid, "hexRows");
  });
});

describe("Erase by hexes (H2)", () => {
  // Hex 15,1 on rows: its center is (16, HEX_R + HEX_S), so it sits in key chunk 0,0 and spans world chunks 0 and 1.
  const cx = 16;
  const cy = HEX_R + HEX_S;
  function built(): RoomState {
    let state = run(hexRoom(), rough(["15,1", "14,1"])).state;
    state = run(state, {
      t: "build.walls",
      sceneId: "s1",
      put: [
        // Its midpoint (16.25, cy) lies in hex 15,1 and in world chunk 1,0.
        wall("east", [lat(cx), lat(cy)], [lat(cx + 0.5), lat(cy)]),
        // Its midpoint lies in hex 13,1, beside the erased ones.
        wall("west", [lat(cx - 3), lat(cy)], [lat(cx - 2.5), lat(cy)]),
      ],
    }).state;
    state = run(state, { t: "build.stamps", sceneId: "s1", put: [{ id: "st1", art: { key: "barrel" }, x: cx + 0.2, y: cy, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] }).state;
    state = run(state, { t: "build.lights", sceneId: "s1", put: [{ id: "lt1", x: lat(cx - 0.2), y: lat(cy), bright: 20, dim: 20, color: "#ffcc88", on: true, walls: true }] }).state;
    state = run(state, { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: cx, y: cy, text: "Crypt", size: 0.5 } }).state;
    state = run(state, { t: "build.label", sceneId: "s1", labelId: "l2", label: { x: 4, y: 12, text: "Far", size: 0.5 } }).state;
    return state;
  }

  test("takes the hex's difficult ground, the free walls whose midpoint is in it, wherever their chunk, and its stamps, lights and labels", () => {
    const state = built();
    assert.equal(state.buildChunks[chunkKey("s1", 1, 0)]?.walls?.length, 1, "the east wall's chunk is a world chunk past the hex's key chunk");
    const after = run(state, erase(["15,1"])).state;
    const keyed = after.buildChunks[chunkKey("s1", 0, 0)]!;
    assert.equal(keyed.rough?.[1 * 16 + 15], ".");
    assert.equal(keyed.rough?.[1 * 16 + 14], "d", "the hex beside keeps its mark");
    assert.equal(keyed.grid, "hexRows");
    assert.equal(after.buildChunks[chunkKey("s1", 1, 0)], undefined, "the east wall went, and its chunk with it");
    assert.deepEqual(keyed.walls?.map((w) => w.id), ["west00000000"]);
    assert.equal(after.stamps.st1, undefined);
    assert.equal(after.lights.lt1, undefined);
    assert.equal(after.labels.l1, undefined);
    assert.ok(after.labels.l2, "a label away from the hex stays");
  });

  test("a label whose box meets only the corner of the hex's box, outside the hex itself, stays", () => {
    // The box's top-left corner lies past the hex's north-west side.
    const base = labelBox({ x: 0, y: 0, text: "x", size: 0.3 });
    const corner = { x: cx - 0.5 + 0.05, y: cy - HEX_R + 0.05 };
    const at = { x: corner.x - base.x1, y: corner.y - base.y1 };
    const state = run(hexRoom(), { t: "build.label", sceneId: "s1", labelId: "l3", label: { ...at, text: "x", size: 0.3 } }).state;
    assert.ok(run(state, erase(["15,1"])).state.labels.l3, "outside the hex");
    const inside = { x: cx - base.x1 + 0.05, y: cy - base.y1 + 0.05 };
    const touching = run(hexRoom(), { t: "build.label", sceneId: "s1", labelId: "l4", label: { ...inside, text: "x", size: 0.3 } }).state;
    assert.equal(run(touching, erase(["15,1"])).state.labels.l4, undefined, "over the hex's middle");
  });

  test("an erase that finds nothing writes nothing, and the last of a chunk's marks takes its stamp", () => {
    const empty = run(hexRoom(), erase(["3,3"]));
    assert.deepEqual(empty.inverse, []);
    const marked = run(hexRoom(), rough(["3,3"])).state;
    assert.equal(run(marked, erase(["3,3"])).state.buildChunks[chunkKey("s1", 0, 0)], undefined);
  });

  test("an erase's undo puts back all it took", () => {
    const state = built();
    const erased = run(state, erase(["15,1"]));
    const undone = run(erased.state, undo(erased.inverse)).state;
    const unrevved = (chunks: RoomState["buildChunks"]) => Object.fromEntries(Object.entries(chunks).map(([k, { rev: _rev, ...c }]) => [k, c]));
    assert.deepEqual(unrevved(undone.buildChunks), unrevved(state.buildChunks));
    assert.deepEqual([undone.stamps, undone.lights, undone.labels], [state.stamps, state.lights, state.labels]);
  });

  test("a hex outside the scene is refused", () => {
    assert.equal(refusal(hexRoom(), erase(["29,1"])), "cell outside the scene");
  });

  test("on hex columns the same", () => {
    const state = run(hexRoom("hexColumns"), rough(["1,15"])).state;
    // Hex 1,15 on columns: its center is (HEX_R + HEX_S, 16).
    const walled = run(state, { t: "build.walls", sceneId: "s1", put: [wall("east", [lat(cy), lat(cx)], [lat(cy), lat(cx + 0.5)])] }).state;
    const after = run(walled, erase(["1,15"])).state;
    assert.equal(after.buildChunks[chunkKey("s1", 0, 0)], undefined);
    assert.equal(after.buildChunks[chunkKey("s1", 0, 1)], undefined);
  });
});

describe("the shape's invariant on H2's data (HX-D14)", () => {
  test("hex rows with difficult ground switched to hex columns: refused, naming difficult ground", () => {
    const marked = run(hexRoom(), rough(["4,4"])).state;
    assert.equal(
      refusal(marked, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexColumns" } }),
      "This scene has difficult ground on its hex rows, which can't stand on hex columns. Remove them to change the grid.",
    );
  });

  test("two DMs: A erases rows-era difficult ground, B switches to columns, A undoes: refused by the chunk's stamp", () => {
    const marked = run(hexRoom(), rough(["4,4"])).state;
    const erased = run(marked, erase(["4,4"]));
    const switched = run(erased.state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexColumns" } }, B).state;
    assert.equal(refusal(switched, undo(erased.inverse)), "Can't undo that: difficult ground on hex rows can't stand on this scene's hex columns.");
  });

  test("a free wall's undo goes through a rows-to-columns switch", () => {
    const drawn = run(hexRoom(), { t: "build.walls", sceneId: "s1", put: [wall("w1", [1, 1], [3, 1])] });
    const switched = run(drawn.state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexColumns" } }, B).state;
    assert.equal(run(switched, undo(drawn.inverse)).state.buildChunks[chunkKey("s1", 0, 0)], undefined);
  });
});
