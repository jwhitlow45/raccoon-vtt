import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunksOf, fogRoom, heights, lift, paint, stairs, wall } from "../discoveryTestutil.ts";
import type { BuildChunk, PlayerChunk, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { P1 } from "../testutil.ts";
import { encodeTile } from "./fog.ts";
import { ownWalk, legBlocker, sweptTouches } from "./movement.ts";
import { contact, PIECE } from "./segments.ts";
import { indexBuild, isPiece, LEDGE, pieceBlocks, pieceTouches, PIECE_BAND, sceneWalls, type WallSet } from "./walls.ts";
import { token } from "../testutil.ts";

/*
 * A player's device reading its held chunks (docs/design-v1-map-discovery.md
 * 5.2): `known`, `auto` and `upDir` in place of what it would derive from
 * cells it may not hold, the piece path for the server's cut walls, and the
 * device's two tests of a piece, with section 10's walls rows.
 */

function view(state: RoomState): RoomState {
  return projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
}

function wallsOf(state: RoomState): WallSet {
  return sceneWalls(state.scenes.s1!, state.buildChunks);
}

/** The stored segments of a set, as strings, with their tags, sorted. */
function stored(w: WallSet, mask = 0xff): string[] {
  const out: string[] = [];
  for (let k = 0; k < w.stored.n; k++) if (w.stored.tags[k]! & mask) out.push(`${[...w.stored.xy.subarray(4 * k, 4 * k + 4)].join(",")}:${w.stored.tags[k]}`);
  return out.sort();
}

describe("a held chunk's own facts (5.2)", () => {
  test("automatic walls come from `auto` alone, whatever the cells the device holds would make", () => {
    const state = fogRoom();
    paint(state, { x: 10, y: 2, w: 6, h: 3 });
    lift(state, "dm", { x: 0, y: 0, w: 16, h: 8 });
    const theirs = view(state);
    // The copy's rule is "off", and the walls round the room are there: the east one from the stub past the border.
    assert.equal(theirs.scenes.s1!.autoWalls, "off");
    const edges = wallsOf(theirs).edges.filter((e) => e.auto).map((e) => `${e.x},${e.y},${e.side}`);
    for (let y = 2; y < 5; y++) assert.ok(edges.includes(`16,${y},w`) && edges.includes(`10,${y},w`), `the room's sides at y = ${y}`);
    assert.deepEqual(stored(wallsOf(theirs)), stored(wallsOf(state)));
    // Cells the device holds that would make a wall by a rule make none: only what `auto` says stands.
    const bare = { ...(theirs.buildChunks["s1:0,0"] as PlayerChunk) };
    delete bare.auto;
    const without = { ...theirs, buildChunks: { ...theirs.buildChunks, "s1:0,0": bare } };
    assert.ok(wallsOf(without).edges.every((e) => !(e.auto && e.x < 16)));
  });

  test("a device raises no edge beside a cell outside `known`, nor at a position with no chunk", () => {
    const state = fogRoom({ scene: { blockMovement: true } });
    heights(state, { x: 4, y: 4, w: 1, h: 1 }, 10);
    lift(state, "dm", { x: 4, y: 4, w: 1, h: 1 });
    const raised = stored(wallsOf(view(state)), LEDGE);
    assert.deepEqual(raised, [], "every cell beside the raised one is unknown");
    lift(state, "dm", { x: 5, y: 4, w: 1, h: 1 });
    assert.deepEqual(stored(wallsOf(view(state)), LEDGE), ["5,4,5,5:56"], "the edge to the held cell east of it");
    assert.ok(stored(wallsOf(state), LEDGE).length === 4, "the server's walls raise all four");
  });

  test("stairs point as `upDir` says, though the rule would read cells the device does not hold", () => {
    const state = fogRoom({ scene: { blockMovement: true } });
    stairs(state, [[3, 3]], "a");
    heights(state, { x: 3, y: 2, w: 1, h: 1 }, 10);
    lift(state, "dm", { x: 3, y: 3, w: 1, h: 1 });
    const theirs = view(state);
    assert.equal((theirs.buildChunks["s1:0,0"] as PlayerChunk).upDir![3 * 16 + 3], "n");
    assert.equal(wallsOf(theirs).stairAt(3, 3), "n");
    assert.equal(wallsOf(state).stairAt(3, 3), "n");
  });

  test("a malformed `known` holds nothing, and a malformed `auto` or `upDir` carries none", () => {
    const chunk = (over: Partial<PlayerChunk>): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: {}, known: "!!", ...over }) as PlayerChunk;
    const held = indexBuild([chunk({})]).held!;
    assert.equal(held.known.size, 0);
    assert.equal(indexBuild([chunk({ auto: "AAAA" })]).held!.auto.size, 0);
    assert.equal(indexBuild([chunk({ upDir: "x".repeat(256) })]).held!.dirs.size, 0);
    // A stored chunk carries none of it.
    assert.equal(indexBuild([{ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} }]).held, undefined);
  });
});

describe("the piece path (5.2, ASTRA-10, LK-30)", () => {
  const held = (walls: BuildChunk["walls"]): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls, known: encodeTile(new Uint8Array(32)) }) as PlayerChunk;

  test("a piece with four of the longest coordinates, and one ending on the scene's side, pass with no slack", () => {
    const longest = { id: "aaaaaaaaaaaa", a: [123.4567, 156.7891] as [number, number], b: [125.6789, 158.9123] as [number, number], f: { kind: "wall" as const } };
    const side = { id: "bbbbbbbbbbbb", a: [0, 7.5] as [number, number], b: [2.0001, 7.5] as [number, number], f: { kind: "window" as const } };
    assert.equal(indexBuild([held([longest, side])]).free.length, 2);
    // The same off the lattice in a stored chunk is bad data.
    assert.equal(indexBuild([{ ...held([longest]), known: undefined } as BuildChunk]).free.length, 0);
  });

  test("a piece longer than 8 cells, of no length, or past the build's range is dropped", () => {
    const at = (a: [number, number], b: [number, number]) => ({ id: "cccccccccccc", a, b, f: { kind: "wall" as const } });
    assert.equal(indexBuild([held([at([0, 0], [8.0001, 0]), at([1, 1], [1, 1]), at([1025, 1], [1026, 1]), at([1, Number.NaN], [2, 1])])]).free.length, 0);
    assert.equal(indexBuild([held([at([0, 0], [8, 0])])]).free.length, 1);
  });

  test("pieces are marked as pieces in the stored segments, and the split leaves no crossing among them", () => {
    const state = fogRoom();
    wall(state, "aaaaaaaaaaaa", [1.25, 1.25], [7.25, 2.25]);
    wall(state, "bbbbbbbbbbbb", [3.5, 0.25], [3.5, 3.75]);
    lift(state, "dm", { x: 0, y: 0, w: 8, h: 4 });
    const w = wallsOf(view(state));
    let n = 0;
    for (let k = 0; k < w.stored.n; k++) if (isPiece(w, k)) n++;
    assert.ok(n >= 3);
    assert.equal(w.stored.free.filter((f) => f === PIECE).length, n);
    const p = w.pieces;
    for (let i = 0; i < p.n; i++) {
      for (let j = i + 1; j < p.n; j++) {
        const c = contact(p.xy[4 * i]!, p.xy[4 * i + 1]!, p.xy[4 * i + 2]!, p.xy[4 * i + 3]!, p.xy[4 * j]!, p.xy[4 * j + 1]!, p.xy[4 * j + 2]!, p.xy[4 * j + 3]!);
        assert.notEqual(c, 2, `pieces ${i} and ${j} cross`);
      }
    }
  });
});

describe("the device's two tests of a piece (ASTRA-30, ASTRA-34)", () => {
  test("one contact inside a piece's band: the conservative test blocks, the permissive test passes", () => {
    // A piece along y = 1 from x = 0 to 4, and a path that ends a hair short of it.
    const piece = [0, 1, 4, 1] as const;
    const short = [2, 0, 2, 1 - PIECE_BAND / 2] as const;
    assert.equal(pieceTouches(...short, 0, 0, ...piece), true);
    assert.equal(pieceBlocks(...short, 0, 0, ...piece), false);
    // Clear through the band, well inside its ends: both block. Past its end: neither.
    assert.equal(pieceBlocks(2, 0, 2, 2, 0, 0, ...piece), true);
    assert.equal(pieceTouches(2, 0, 2, 2, 0, 0, ...piece), true);
    assert.equal(pieceBlocks(4.0003, 0, 4.0003, 2, 0, 0, ...piece), false);
    assert.equal(pieceTouches(4.0003, 0, 4.0003, 2, 0, 0, ...piece), false);
    // Through the band within 4/10000 cell of an end: the permissive test lets it go, the server's landing decides.
    assert.equal(pieceBlocks(3.9998, 0, 3.9998, 2, 0, 0, ...piece), false);
    assert.equal(pieceTouches(3.9998, 0, 3.9998, 2, 0, 0, ...piece), true);
  });

  test("astra's case: wall (1.25, 1.25) to (7.25, 2.25), a branch ending on it at (2.75, 1.5): TOUCH on the device after the split at x = 4 rounds", () => {
    const state = fogRoom();
    wall(state, "aaaaaaaaaaaa", [1.25, 1.25], [7.25, 2.25]);
    lift(state, "dm", { x: 0, y: 0, w: 8, h: 4 });
    const w = wallsOf(view(state));
    const pieces: number[][] = [];
    for (let k = 0; k < w.stored.n; k++) if (isPiece(w, k)) pieces.push([...w.stored.xy.subarray(4 * k, 4 * k + 4)]);
    const first = pieces.find((p) => p[0] === 1.25)!;
    assert.ok(first[2]! > 4, `split at x = 4 and rounded outward: ${first}`);
    // The branch's end lies on the exact wall, off the rounded piece, so exact contact misses it and the device's test does not.
    assert.equal(contact(2.75, 0.5, 2.75, 1.5, first[0]!, first[1]!, first[2]!, first[3]!), 0);
    assert.equal(pieceTouches(2.75, 0.5, 2.75, 1.5, 0, 0, first[0]!, first[1]!, first[2]!, first[3]!), true);
  });

  test("astra's case: wall (2.765625, 4.984375) to (9.015625, 0) through held cell (3, 3) still blocks inside that cell after rounding", () => {
    const state = fogRoom({ scene: { blockMovement: true } });
    wall(state, "aaaaaaaaaaaa", [2.765625, 4.984375], [9.015625, 0]);
    lift(state, "dm", { x: 3, y: 3, w: 1, h: 1 });
    const w = wallsOf(view(state));
    const pieces: number[][] = [];
    for (let k = 0; k < w.stored.n; k++) if (isPiece(w, k)) pieces.push([...w.stored.xy.subarray(4 * k, 4 * k + 4)]);
    assert.equal(pieces.length, 1, JSON.stringify(pieces));
    // The wall clips the cell's south-east corner by a hair, from about (3.99996, 4) to (4, 3.99997): rounded outward, the
    // piece still crosses the corner, so a step through it, which the exact wall stops, meets the piece.
    const [ax, ay, bx, by] = pieces[0] as [number, number, number, number];
    assert.ok(ax < 4 && ay > 4 && bx > 4 && by < 4, JSON.stringify(pieces[0]));
    assert.equal(sweptTouches(3.99, 3.99, 4.01, 4.01, 0, 0, 2.765625, 4.984375, 9.015625, 0), true, "the exact wall stops the step");
    assert.equal(sweptTouches(3.99, 3.99, 4.01, 4.01, 0, 0, ax, ay, bx, by), true);
    assert.equal(pieceTouches(3.99, 3.99, 4.01, 4.01, 0, 0, ax, ay, bx, by), true);
    // Within 4/10000 cell of its ends the gate test sends the step, and the server's landing decides.
    assert.equal(pieceBlocks(3.99, 3.99, 4.01, 4.01, 0, 0, ax, ay, bx, by), false);
  });

  test("a diagonal with no interior lattice point, cut at a held side, reaches the device rounded outward and stops a walk there", () => {
    const state = fogRoom({ scene: { blockMovement: true } });
    // From (1.015625, 1.03125) to (3.984375, 3.96875): no lattice point strictly between its ends, crossing x = 2 off the lattice.
    wall(state, "aaaaaaaaaaaa", [1.015625, 1.03125], [3.984375, 3.96875]);
    lift(state, "dm", { x: 0, y: 0, w: 2, h: 5 });
    const w = wallsOf(view(state));
    const pieces: number[][] = [];
    for (let k = 0; k < w.stored.n; k++) if (isPiece(w, k)) pieces.push([...w.stored.xy.subarray(4 * k, 4 * k + 4)]);
    assert.equal(pieces.length, 1);
    const [, , bx, by] = pieces[0]!;
    assert.ok(bx! > 2 && bx! <= 2.0001 && Number.isInteger(Math.round(by! * 1e4)), `cut at x = 2, rounded outward: ${pieces[0]}`);
    // A creature walking across it inside the held cells is stopped there, on the device as on the server.
    const walker = ownWalk({ ...token("t", { x: 1, y: 1.5, size: "tiny" }), sceneId: "s1" });
    assert.equal(legBlocker(view(state), walker, { x: 1.75, y: 1.0, elevation: 0 }), "wall");
    assert.equal(legBlocker(state, walker, { x: 1.75, y: 1.0, elevation: 0 }), "wall");
    assert.ok(sweptTouches(1.125, 1.75, 1.875, 1.25, 0, 0, ...(pieces[0] as [number, number, number, number])));
  });
});
