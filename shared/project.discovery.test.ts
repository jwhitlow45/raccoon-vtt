import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autoAt, chunksOf, edge, fogRoom, heights, knownAt, lift, liftSubs, paint, remember, stairs, wall, wallsOf } from "./discoveryTestutil.ts";
import { keys } from "./keys.ts";
import type { FreeWall, Label, PlayerChunk, RoomState, Scene, Stamp } from "./model.ts";
import { allKeys, dependents, heldChunks, pieceId, playerChunk, projectEntity, projectState, stableStringify } from "./project.ts";
import { encodeTile, fullTileBits } from "./rules/fog.ts";
import { groundOf, PIECE_GRID, wallSpans } from "./rules/held.ts";
import { sceneGrid } from "./rules/grid.ts";
import { hexSubcells, parseHexKey, type HexGrid } from "./rules/hex.ts";
import { indexBuild, sceneWalls } from "./rules/walls.ts";
import { DM, P1, P2, deepClone } from "./testutil.ts";
import { markFinished, markWritable } from "./writable.ts";

/*
 * The map as players discover it (docs/design-v1-map-discovery.md 5.1 and
 * 5.2, section 10's rows for the projection): what a player's chunks hold
 * of the build on a scene with fog on.
 */

const DISPLAY = { memberId: "display:abcdefghijkl", role: "player" } as const;

/** The pieces a player holds, as `[ax, ay, bx, by, kind]`, in the order the chunks file them. */
function pieces(state: RoomState, viewer = P1): [number, number, number, number, string][] {
  return wallsOf(state, viewer).map((w) => [w.a[0], w.a[1], w.b[0], w.b[1], w.f.kind]);
}

/** Whether every coordinate is a multiple of 1/10000 cell, as a cut end is, or of 1/64, as a stored one is. */
function onGrid(v: number): boolean {
  return Number.isInteger(Math.round(v * PIECE_GRID * 1e6) / 1e6) || Number.isInteger(v * 64);
}

describe("what a player holds of the build (5.1, 5.2)", () => {
  test("a room the party never saw: no cell, wall, door, height, label or stamp of it in a player's data (MX1)", () => {
    const state = fogRoom({ vision: true });
    paint(state, { x: 2, y: 2, w: 6, h: 4 });
    paint(state, { x: 30, y: 20, w: 8, h: 6 }, "wood");
    edge(state, "33,20,n", { kind: "door", state: "closed", secret: false, discovered: false });
    wall(state, "abcdefghijkl", [31.25, 22.5], [36.75, 22.5]);
    heights(state, { x: 31, y: 21, w: 2, h: 2 }, 10);
    state.labels.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 33, y: 23, text: "Treasury", size: 1 };
    state.stamps.st1 = { id: "st1", rev: 0, sceneId: "s1", art: { key: "chest" }, x: 34.5, y: 24.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 10 });
    for (const viewer of [P1, DISPLAY]) {
      const p = projectState(state, viewer, { sceneId: "s1" });
      const text = JSON.stringify(p.buildChunks);
      for (const word of ["wood", "door", "abcdefghijkl"]) assert.ok(!text.includes(word), `${word} reached ${viewer.memberId}`);
      assert.equal(p.labels.l1, undefined);
      assert.equal(p.stamps.st1, undefined);
      // The held room is there, live.
      assert.equal(p.buildChunks["s1:0,0"]!.cells["2,2"], "stone");
      // Nothing of the far chunks at all: no stub where nothing is held.
      assert.deepEqual(Object.keys(p.buildChunks).sort(), ["s1:0,0"]);
    }
  });

  test("a corridor running on into darkness has no wall at the edge of their map", () => {
    const state = fogRoom();
    paint(state, { x: 0, y: 5, w: 30, h: 1 });
    lift(state, "dm", { x: 0, y: 4, w: 8, h: 3 });
    const c = chunksOf(state, P1)["0,0"]!;
    // The corridor's long walls reach as far as they hold it, and no wall stands across it where their ground ends.
    assert.ok(autoAt(c, "3,5,n") && autoAt(c, "3,6,n"));
    // Its west end is the scene's west side, walled as any painted cell beside nothing.
    assert.ok(autoAt(c, "0,5,w"));
    for (let x = 1; x <= 9; x++) assert.ok(!autoAt(c, `${x},5,w`), `a wall across the corridor at x = ${x}`);
    assert.deepEqual(c.edges, {});
    assert.ok(knownAt(c, 7, 5) && !knownAt(c, 8, 5));
  });

  test("a room's east wall on a chunk border reaches them in a stub, the next chunk unbuilt or unheld", () => {
    for (const reveal of [20, 16]) {
      const state = fogRoom();
      paint(state, { x: 10, y: 2, w: 6, h: 3 });
      lift(state, "dm", { x: 0, y: 0, w: reveal, h: 8 });
      const chunks = chunksOf(state, P1);
      const stub = chunks["1,0"];
      assert.ok(stub, `a stub at 1,0 when ${reveal} cells are lifted`);
      assert.deepEqual([stub.cells, stub.edges, stub.walls], [{}, {}, undefined]);
      for (let y = 2; y < 5; y++) assert.ok(autoAt(stub, `16,${y},w`), `the east wall at y = ${y}`);
      assert.equal(knownAt(stub, 16, 2), reveal > 16);
    }
  });

  test("a 16 x 16 scene, painted cell (15, 15): its east and south automatic walls reach players past the bounds", () => {
    const state = fogRoom({ bounds: { w: 16, h: 16 } });
    paint(state, { x: 15, y: 15, w: 1, h: 1 });
    lift(state, "dm", { x: 0, y: 0, w: 16, h: 16 });
    const chunks = chunksOf(state, P1);
    assert.ok(autoAt(chunks["1,0"], "16,15,w"), "the east wall, in the stub past the east side");
    assert.ok(autoAt(chunks["0,1"], "15,16,n"), "the south wall, in the stub past the south side");
    assert.ok(autoAt(chunks["0,0"], "15,15,n") && autoAt(chunks["0,0"], "15,15,w"));
    assert.ok(!knownAt(chunks["1,0"], 16, 15), "no cell past the side is held");
  });

  test("a ledge beside a held empty cell in an unbuilt chunk reaches them, and the device's walls and the server's agree", () => {
    const state = fogRoom({ scene: { blockMovement: true } });
    heights(state, { x: 15, y: 2, w: 1, h: 1 }, 10);
    lift(state, "dm", { x: 12, y: 0, w: 6, h: 6 });
    const chunks = chunksOf(state, P1);
    assert.ok(knownAt(chunks["1,0"], 16, 2), "the empty cell past the border is held, so the ledge is known");
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const ledge = (s: RoomState) => {
      const w = sceneWalls(s.scenes.s1!, s.buildChunks);
      const out: string[] = [];
      for (let k = 0; k < w.stored.n; k++) if (w.stored.tags[k]! & 32) out.push(w.stored.xy.subarray(4 * k, 4 * k + 4).join(","));
      return out.sort();
    };
    assert.deepEqual(ledge(view), ledge(state));
    // Unheld past it: the device raises no edge it cannot know, and holds no ground there.
    const dark = fogRoom({ scene: { blockMovement: true } });
    heights(dark, { x: 15, y: 2, w: 1, h: 1 }, 10);
    lift(dark, "dm", { x: 12, y: 2, w: 4, h: 1 });
    const theirs = projectState(dark, P1, { sceneId: "s1" }) as unknown as RoomState;
    const raised = ledge(theirs);
    assert.ok(!raised.some((s) => s.startsWith("16,")), `no ledge at the edge of their map: ${raised}`);
  });

  test("a hidden secret door on an automatic-wall edge is an automatic wall to players, no gap", () => {
    const hidden = { kind: "door", state: "closed", secret: true, discovered: false } as const;
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 4, h: 3 });
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 10 });
    const before = chunksOf(state, P1)["0,0"]!;
    edge(state, "3,2,n", hidden);
    const after = chunksOf(state, P1)["0,0"]!;
    assert.ok(autoAt(after, "3,2,n"));
    assert.equal(after.edges["3,2,n"], undefined);
    assert.equal(stableStringify(after), stableStringify(before));
    // Inside the room, where the rule puts no wall, it is the wall players think it is.
    edge(state, "4,3,w", hidden);
    assert.deepEqual(chunksOf(state, P1)["0,0"]!.edges["4,3,w"], { kind: "wall" });
  });

  test("equal chunk content written in different orders is the same bytes, and a stub and a masked chunk holding the same are too", () => {
    const a = fogRoom();
    const b = fogRoom();
    for (const key of ["2,2", "3,2", "4,2"]) a.buildChunks["s1:0,0"] = { ...(a.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} }), cells: { ...a.buildChunks["s1:0,0"]?.cells, [key]: "stone" } };
    for (const key of ["4,2", "2,2", "3,2"]) b.buildChunks["s1:0,0"] = { ...(b.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} }), cells: { ...b.buildChunks["s1:0,0"]?.cells, [key]: "stone" } };
    edge(a, "2,2,w", { kind: "window" });
    edge(a, "5,2,w", { kind: "window" });
    edge(b, "5,2,w", { kind: "window" });
    edge(b, "2,2,w", { kind: "window" });
    for (const s of [a, b]) lift(s, "dm", { x: 0, y: 0, w: 20, h: 20 });
    assert.equal(JSON.stringify(chunksOf(a, P1)["0,0"]), JSON.stringify(chunksOf(b, P1)["0,0"]));
    // A stored chunk past the held ground with nothing held in it, and none at all: the same stub.
    const c = fogRoom();
    paint(c, { x: 10, y: 2, w: 6, h: 3 });
    lift(c, "dm", { x: 0, y: 0, w: 16, h: 8 });
    const d = deepClone(c);
    paint(d, { x: 30, y: 2, w: 1, h: 1 }, "wood");
    assert.ok(d.buildChunks["s1:1,0"] && !c.buildChunks["s1:1,0"]);
    assert.equal(JSON.stringify(chunksOf(c, P1)["1,0"]), JSON.stringify(chunksOf(d, P1)["1,0"]));
  });

  test("a scene with fog off reaches players whole, as before (MX6)", () => {
    const state = fogRoom({ scene: { fogEnabled: false } });
    paint(state, { x: 30, y: 20, w: 3, h: 3 });
    wall(state, "abcdefghijkl", [31.25, 22.5], [36.75, 22.5]);
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.ok(p.buildChunks["s1:1,1"]!.cells["30,20"]);
    assert.equal(p.buildChunks["s1:2,1"]!.walls![0]!.id, "abcdefghijkl");
    assert.equal(p.scenes.s1!.autoWalls, undefined);
    assert.equal((p.buildChunks["s1:1,1"] as PlayerChunk).known, undefined);
  });

  test("a fog-only scene withholds unrevealed ground and shows revealed ground live, memory or not", () => {
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 4, h: 4 });
    paint(state, { x: 20, y: 2, w: 4, h: 4 });
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 10 });
    // Memory never shows on a scene without vision, even one left from before it went off.
    remember(state, null, 0, 0, { cells: { "2,2": "wood" } });
    const c = chunksOf(state, P1);
    assert.equal(c["0,0"]!.cells["2,2"], "stone");
    assert.equal(c["1,0"], undefined);
  });

  test("the DM gets every stored chunk as it is, and no stub", () => {
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 4, h: 4 });
    const p = projectState(state, DM, { sceneId: "s1" });
    assert.equal(p.buildChunks["s1:0,0"], state.buildChunks["s1:0,0"]);
    assert.deepEqual(Object.keys(p.buildChunks), ["s1:0,0"]);
    assert.equal(p.scenes.s1, state.scenes.s1);
  });

  test("projectEntity gives every position what projectState holds, stubs included, and allKeys names them all", () => {
    const state = fogRoom({ vision: true });
    paint(state, { x: 10, y: 2, w: 6, h: 3 });
    wall(state, "abcdefghijkl", [12.25, 3.5], [19.75, 3.5]);
    lift(state, "dm", { x: 0, y: 0, w: 18, h: 8 });
    const p = projectState(state, P1, { sceneId: "s1" });
    const all = allKeys(state).filter((k) => k.startsWith("chunk:"));
    assert.ok(all.length >= 12, `every position of a 48 x 32 scene: ${all.length}`);
    for (const key of all) {
      const one = projectEntity(key, state, P1, { sceneId: "s1" });
      const [, sceneId, at] = key.split(":");
      assert.equal(stableStringify(one), stableStringify(p.buildChunks[`${sceneId}:${at}`] ?? null), key);
    }
    assert.deepEqual(heldChunks(state, "s1", null), p.buildChunks);
  });

  test("players are projected by fog class: a holder alone, everyone else together", () => {
    const state = fogRoom({ vision: true, perPlayer: true });
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    paint(state, { x: 2, y: 2, w: 4, h: 4 });
    paint(state, { x: 20, y: 2, w: 4, h: 4 }, "wood");
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    lift(state, { holder: "p1" }, { x: 18, y: 0, w: 8, h: 8 });
    assert.equal(chunksOf(state, P1)["1,0"]!.cells["20,2"], "wood");
    for (const other of [P2, DISPLAY]) assert.equal(chunksOf(state, other)["1,0"], undefined, other.memberId);
    assert.equal(chunksOf(state, P2)["0,0"]!.cells["2,2"], "stone");
  });
});

describe("free walls cut at held cells (decision 2)", () => {
  test("a free wall crossing held and unheld cells: only its held pieces, a hidden door's and a window's cut as a wall's", () => {
    for (const f of [{ kind: "wall" }, { kind: "window" }, { kind: "door", state: "closed", secret: true, discovered: false }] as const) {
      const state = fogRoom();
      wall(state, "abcdefghijkl", [1.25, 1.5], [6.75, 1.5], f);
      lift(state, "dm", { x: 0, y: 0, w: 5, h: 5 });
      const kind = f.kind === "window" ? "window" : "wall";
      assert.deepEqual(pieces(state), [
        [1.25, 1.5, 4.0001, 1.5, kind],
        [3.9999, 1.5, 5.0001, 1.5, kind],
      ]);
      assert.ok(!JSON.stringify(projectState(state, P1, { sceneId: "s1" })).includes("abcdefghijkl"), "no real id");
    }
  });

  test("a door players see stays whole under its real id and chunk", () => {
    const state = fogRoom();
    const door = { kind: "door", state: "locked", secret: false, discovered: false } as const;
    wall(state, "abcdefghijkl", [3.25, 1.5], [6.75, 1.5], door);
    lift(state, "dm", { x: 0, y: 0, w: 5, h: 5 });
    assert.deepEqual(wallsOf(state, P1), [{ id: "abcdefghijkl", a: [3.25, 1.5], b: [6.75, 1.5], f: { ...door, state: "closed" }, at: "0,0" }]);
  });

  test("two worlds, the same held piece and different unseen continuations: the same bytes, ids and positions", () => {
    const worlds = [6.75, 3, 4.5, 12].map((end) => {
      const state = fogRoom();
      wall(state, end === 12 ? "zzzzzzzzzzzz" : "abcdefghijkl", [1.25, 1.5], [end, 1.5]);
      lift(state, "dm", { x: 0, y: 0, w: 3, h: 5 });
      return JSON.stringify(projectState(state, P1, { sceneId: "s1" }).buildChunks);
    });
    for (const w of worlds) assert.equal(w, worlds[0]);
    // Every end on a cell's side moves as a cut end does, between two held cells too (D-261026-29 item 16), and one inside a cell stays.
    const state = fogRoom();
    wall(state, "abcdefghijkl", [1.25, 1.5], [3, 1.5]);
    lift(state, "dm", { x: 0, y: 0, w: 5, h: 5 });
    assert.deepEqual(pieces(state), [[1.25, 1.5, 3.0001, 1.5, "wall"]]);
  });

  test("a live wall that stops on the side of a remembered cell and one the DM ran on into it out of sight: the same bytes (Fable's sliver)", () => {
    // Cells 0 to 3 of row 1 live, cell 4 only remembered, no creature to see it.
    const world = (extended: boolean) => {
      const s = fogRoom({ vision: true });
      lift(s, "party", { x: 0, y: 0, w: 5, h: 3 });
      lift(s, "dm", { x: 0, y: 0, w: 4, h: 3 });
      if (!extended) wall(s, "abcdefghijkl", [1.5, 1.5], [4, 1.5]);
      else {
        wall(s, "abcdefghijkl", [1.5, 1.5], [4.5, 1.5]);
        // The map step's version over cell (4, 1): the wall as it was, which touched that cell at a point only.
        remember(s, null, 0, 0, { walls: { abcdefghijkl: [{ wall: { id: "abcdefghijkl", a: [1.5, 1.5], b: [4, 1.5], f: { kind: "wall" } }, cells: ["4,1"] }] } });
      }
      return s;
    };
    assert.deepEqual(wallsOf(world(true), P1), wallsOf(world(false), P1));
    assert.deepEqual(pieces(world(false)), [[1.5, 1.5, 4.0001, 1.5, "wall"]]);
  });

  test("an end on the scene's own side: a wall that runs off the scene and one that stops there read the same, on the grid (LK-6, MD2-O-7)", () => {
    const at = (b: [number, number]) => {
      const state = fogRoom();
      wall(state, "abcdefghijkl", [46.5, 1.5], b);
      lift(state, "dm", { x: 40, y: 0, w: 8, h: 5 });
      return pieces(state);
    };
    // Off the scene at the corner of cells (47, 1) and (47, 2), and on the side of (47, 1) alone.
    assert.deepEqual(at([49.5, 2.5]), [[46.5, 1.5, 48, 2.0001, "wall"]]);
    assert.deepEqual(at([48, 2]), at([49.5, 2.5]));
    assert.deepEqual(at([49.5, 1.75]), [[46.5, 1.5, 48, 1.6251, "wall"]]);
    assert.deepEqual(at([48, 1.625]), at([49.5, 1.75]));
    // A crossing off the lattice clamps its whole coordinate to the side and rounds the other, never the exact ratio.
    const [[, , x, y]] = at([49.5, 1.5 + 1 / 64]) as [[number, number, number, number, string]];
    assert.deepEqual([x, y], [48, 1.5079]);
  });

  test("astra's six-piece diagonal, and its pair split inside an unheld cell: every held piece in both, the same bytes", () => {
    const held = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [4, 6],
    ];
    const world = (split: boolean) => {
      const state = fogRoom();
      if (split) {
        wall(state, "aaaaaaaaaaaa", [0.125, 0.25], [2.625, 3.25]);
        wall(state, "bbbbbbbbbbbb", [2.9375, 3.625], [5.125, 6.25]);
      } else wall(state, "cccccccccccc", [0.125, 0.25], [5.125, 6.25]);
      for (const [x, y] of held) lift(state, "dm", { x: x!, y: y!, w: 1, h: 1 });
      return state;
    };
    const one = world(false);
    assert.equal(pieces(one).length, 6, JSON.stringify(pieces(one)));
    assert.equal(JSON.stringify(projectState(one, P1, { sceneId: "s1" }).buildChunks), JSON.stringify(projectState(world(true), P1, { sceneId: "s1" }).buildChunks));
  });

  test("astra's pair at y = 1.5: one wall 1.25 to 6.75 against two, cells 1, 2, 5 and 6 held, 1 and 6 live: the same bytes, no real id", () => {
    const world = (one: boolean) => {
      const state = fogRoom({ vision: true });
      if (one) {
        wall(state, "cccccccccccc", [1.25, 1.5], [6.75, 1.5]);
        // The two walls the party saw before the DM joined them out of their sight, and the joined wall absent then.
        remember(state, null, 0, 0, {
          walls: {
            aaaaaaaaaaaa: [{ wall: { id: "aaaaaaaaaaaa", a: [1.25, 1.5], b: [2.75, 1.5], f: { kind: "wall" } }, cells: ["2,1"] }],
            bbbbbbbbbbbb: [{ wall: { id: "bbbbbbbbbbbb", a: [5.25, 1.5], b: [6.75, 1.5], f: { kind: "wall" } }, cells: ["5,1"] }],
            cccccccccccc: [{ wall: null, cells: ["2,1", "5,1"] }],
          },
        });
      } else {
        wall(state, "aaaaaaaaaaaa", [1.25, 1.5], [2.75, 1.5]);
        wall(state, "bbbbbbbbbbbb", [5.25, 1.5], [6.75, 1.5]);
      }
      for (const x of [1, 2, 5, 6]) lift(state, "party", { x, y: 1, w: 1, h: 1 });
      for (const x of [1, 6]) lift(state, "dm", { x, y: 1, w: 1, h: 1 });
      return state;
    };
    const a = world(true);
    const b = world(false);
    assert.deepEqual(pieces(a), [
      [1.25, 1.5, 2.75, 1.5, "wall"],
      [5.25, 1.5, 6.75, 1.5, "wall"],
    ]);
    const text = JSON.stringify(projectState(a, P1, { sceneId: "s1" }).buildChunks);
    assert.equal(text, JSON.stringify(projectState(b, P1, { sceneId: "s1" }).buildChunks));
    for (const id of ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]) assert.ok(!text.includes(id));
  });

  test("a wall a player once held whole, extended by the DM through the dark: its pieces carry ids nobody can link to it or to each other", () => {
    const state = fogRoom();
    wall(state, "abcdefghijkl", [1.25, 1.5], [3.75, 1.5]);
    lift(state, "dm", { x: 0, y: 0, w: 5, h: 5 });
    lift(state, "dm", { x: 9, y: 0, w: 5, h: 5 });
    const before = wallsOf(state, P1);
    assert.deepEqual(before.map((w) => [w.a, w.b]), [[[1.25, 1.5], [3.75, 1.5]]]);
    wall(state, "abcdefghijkl", [1.25, 1.5], [9.25, 1.5]);
    const after = wallsOf(state, P1);
    assert.ok(after.length >= 2);
    const ids = after.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const w of after) {
      assert.notEqual(w.id, "abcdefghijkl");
      // The id is the piece's own geometry and nothing else: anyone holding the piece gets it, and nothing more.
      assert.equal(w.id, pieceId("s1", { a: w.a, b: w.b, kind: w.f.kind as "wall" }));
    }
  });

  test("remembered 0.25 to 8.25 on cells 0 to 7, live 7.25 to 15.25 on cells 8 to 15: split at x = 4, 8 and 12", () => {
    const state = fogRoom({ vision: true });
    wall(state, "bbbbbbbbbbbb", [7.25, 1.5], [15.25, 1.5]);
    remember(state, null, 0, 0, {
      walls: {
        aaaaaaaaaaaa: [{ wall: { id: "aaaaaaaaaaaa", a: [0.25, 1.5], b: [8.25, 1.5], f: { kind: "wall" } }, cells: ["0,1", "1,1", "2,1", "3,1", "4,1", "5,1", "6,1", "7,1", "8,1"] }],
        bbbbbbbbbbbb: [{ wall: null, cells: ["7,1"] }],
      },
    });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 3 });
    lift(state, "dm", { x: 8, y: 0, w: 8, h: 3 });
    assert.deepEqual(pieces(state), [
      [0.25, 1.5, 4.0001, 1.5, "wall"],
      [3.9999, 1.5, 8.0001, 1.5, "wall"],
      [7.9999, 1.5, 12.0001, 1.5, "wall"],
      [11.9999, 1.5, 15.25, 1.5, "wall"],
    ]);
    // Every piece passes the device's piece path.
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.equal(indexBuild(Object.values(view.buildChunks)).free.length, 4);
  });

  test("a crossing just inside a held cell's corner: every coordinate on the grid, within the scene, at most 2/10000 cell past held cells", () => {
    const state = fogRoom({ bounds: { w: 16, h: 16 } });
    // Through cell (3, 3) by a hair at its south-east corner: x + y = 7.984375.
    wall(state, "abcdefghijkl", [3.5, 4.484375], [4.484375, 3.5]);
    wall(state, "bbbbbbbbbbbb", [0, 7.5], [5.5, 7.5]);
    lift(state, "dm", { x: 3, y: 3, w: 1, h: 1 });
    lift(state, "dm", { x: 0, y: 7, w: 2, h: 1 });
    const held = groundOf(state, "s1", null)!;
    const all = wallsOf(state, P1);
    assert.ok(all.length >= 2, JSON.stringify(all));
    for (const w of all) {
      for (const v of [...w.a, ...w.b]) {
        assert.ok(onGrid(v), `${v} on the grid`);
        assert.ok(v >= 0 && v <= 16, `${v} within the scene`);
      }
      // Each end lies in a held cell or within 2/10000 cell of one.
      for (const [x, y] of [w.a, w.b]) {
        let near = false;
        for (const [dx, dy] of [[0, 0], [2e-4, 0], [-2e-4, 0], [0, 2e-4], [0, -2e-4], [2e-4, 2e-4], [-2e-4, -2e-4], [2e-4, -2e-4], [-2e-4, 2e-4]]) {
          const cx = Math.floor(x! + dx!);
          const cy = Math.floor(y! + dy!);
          if (held.held(cx, cy)) near = true;
        }
        assert.ok(near, `${x},${y} near held ground`);
      }
    }
    // The wall on the scene's west side keeps its end there.
    assert.ok(all.some((w) => w.a[0] === 0 && w.a[1] === 7.5));
  });
});

describe("free walls on hexes (5.5, ASTRA-29, ASTRA-33)", () => {
  test("astra's hex wall, alternate hexes held, rows and columns, both selections: 9 held runs, 10 final pieces, within its bound of 11", () => {
    for (const gridShape of ["hexRows", "hexColumns"] as const) {
      for (const live of [true, false]) {
        const state = fogRoom({ vision: !live, bounds: { w: 24, h: 24 }, scene: { gridShape } });
        // Hex columns are hex rows mirrored across the diagonal (docs/design-v1-hex-grids.md 4.1), so the wall is too, and its split lines are x = 8 and 12.
        const w = gridShape === "hexRows" ? wall(state, "abcdefghijkl", [5.1875, 5.375], [1.203125, 12.296875]) : wall(state, "abcdefghijkl", [5.375, 5.1875], [12.296875, 1.203125]);
        const grid = sceneGrid(state.scenes.s1!) as HexGrid;
        const crossed = wallSpans(grid, w).map((span) => span.cell);
        assert.equal(new Set(crossed).size, 18, `${gridShape}: the wall crosses 18 hexes`);
        // Every other hex the wall crosses, from its first: 9 runs, held in the DM's fog (live) or only explored (remembered).
        const held = crossed.filter((_, i) => i % 2 === 0);
        liftSubs(state, live ? "dm" : "party", held.flatMap((key) => hexSubcells(grid, parseHexKey(key)!)));
        const all = pieces(state);
        assert.equal(all.length, 10, `${gridShape}, ${live ? "live" : "remembered"}: a split line splits one run: ${JSON.stringify(all)}`);
        assert.ok(all.length <= 11, "within the bound the size guard counts it at");
        const major = gridShape === "hexRows" ? 1 : 0;
        for (const p of all) assert.ok(Math.abs((p[major + 2] as number) - (p[major] as number)) <= 4 + 2e-4, "each piece spans at most 4 cells along its major axis");
      }
    }
  });
});

describe("memory in the projection (5.3, decision 6)", () => {
  test("party leaves, the DM adds a wall and removes a door: their map shows the room as before; back in sight, live", () => {
    const state = fogRoom({ vision: true });
    paint(state, { x: 2, y: 2, w: 6, h: 4 });
    lift(state, "party", { x: 0, y: 0, w: 10, h: 10 });
    // The DM's change, out of their sight, and what the map step remembers of it.
    edge(state, "4,4,w", { kind: "wall" });
    remember(state, null, 0, 0, { edges: { "4,4,w": null, "8,3,w": { kind: "door", state: "closed", secret: false, discovered: false } } });
    const c = chunksOf(state, P1)["0,0"]!;
    assert.equal(c.edges["4,4,w"], undefined);
    assert.deepEqual(c.edges["8,3,w"], { kind: "door", state: "closed", secret: false, discovered: false });
    assert.ok(!autoAt(c, "8,3,w"), "the door they remember, not the automatic wall there now");
    // Revealed by the DM: live again, whatever memory holds.
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 10 });
    const live = chunksOf(state, P1)["0,0"]!;
    assert.deepEqual(live.edges["4,4,w"], { kind: "wall" });
    assert.ok(autoAt(live, "8,3,w"));
  });

  test("a holder reads their own memory where their own layer holds the cell, the party's elsewhere", () => {
    const state = fogRoom({ vision: true, perPlayer: true });
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    paint(state, { x: 0, y: 0, w: 10, h: 1 });
    lift(state, "party", { x: 0, y: 0, w: 5, h: 1 });
    lift(state, { holder: "p1" }, { x: 3, y: 0, w: 7, h: 1 });
    remember(state, null, 0, 0, { cells: { "1,0": "wood", "4,0": "wood" } });
    remember(state, "p1", 0, 0, { cells: { "4,0": "grass", "8,0": "grass" } });
    const mine = chunksOf(state, P1)["0,0"]!.cells;
    assert.deepEqual([mine["1,0"], mine["4,0"], mine["8,0"]], ["wood", "grass", "grass"]);
    const theirs = chunksOf(state, P2)["0,0"]!.cells;
    assert.deepEqual([theirs["1,0"], theirs["4,0"], theirs["8,0"]], ["wood", "wood", undefined]);
  });

  test("a wall seen at one end, remembered at the other, the DM extends it: the far piece stays as remembered", () => {
    const state = fogRoom({ vision: true });
    wall(state, "abcdefghijkl", [1.5, 1.5], [9.5, 1.5]);
    // The map step's version: the wall as they saw it, over every cell it touched before or after that they remember out of sight.
    remember(state, null, 0, 0, { walls: { abcdefghijkl: [{ wall: { id: "abcdefghijkl", a: [1.5, 1.5], b: [5.5, 1.5], f: { kind: "wall" } }, cells: ["3,1", "4,1", "5,1", "6,1", "7,1"] }] } });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 3 });
    lift(state, "dm", { x: 0, y: 0, w: 3, h: 3 });
    assert.deepEqual(pieces(state), [
      [1.5, 1.5, 4.0001, 1.5, "wall"],
      [3.9999, 1.5, 5.5, 1.5, "wall"],
    ]);
  });

  test("a wall over two islands made a window out of sight, one island seen: that island a window, the other a wall", () => {
    const state = fogRoom({ vision: true });
    wall(state, "abcdefghijkl", [0.5, 1.5], [7.5, 1.5], { kind: "window" });
    remember(state, null, 0, 0, { walls: { abcdefghijkl: [{ wall: { id: "abcdefghijkl", a: [0.5, 1.5], b: [7.5, 1.5], f: { kind: "wall" } }, cells: ["5,1", "6,1", "7,1"] }] } });
    lift(state, "party", { x: 0, y: 0, w: 2, h: 3 });
    lift(state, "party", { x: 5, y: 0, w: 3, h: 3 });
    lift(state, "dm", { x: 0, y: 0, w: 2, h: 3 });
    assert.deepEqual(pieces(state), [
      [0.5, 1.5, 2.0001, 1.5, "window"],
      [4.9999, 1.5, 7.5, 1.5, "wall"],
    ]);
  });

  test("a corridor wall held over 8 cells, one in sight, the DM removes cells 5 to 8 out of sight: cells 5 to 8 stay as remembered", () => {
    const state = fogRoom({ vision: true });
    wall(state, "abcdefghijkl", [0, 1], [4, 1]);
    remember(state, null, 0, 0, { walls: { abcdefghijkl: [{ wall: { id: "abcdefghijkl", a: [0, 1], b: [8, 1], f: { kind: "wall" } }, cells: ["4,0", "5,0", "6,0", "7,0", "4,1", "5,1", "6,1", "7,1"] }] } });
    lift(state, "party", { x: 0, y: 1, w: 8, h: 1 });
    lift(state, "dm", { x: 0, y: 1, w: 1, h: 1 });
    // Its real end at x = 8 borders ground they do not hold, so it is moved as a cut end is. Its end on the scene's west side stays.
    assert.deepEqual(pieces(state), [
      [0, 1, 4.0001, 1, "wall"],
      [3.9999, 1, 8.0001, 1, "wall"],
    ]);
  });

  test("a label moved out of sight from in sight: gone from where they saw it, not shown where it went", () => {
    const state = fogRoom({ vision: true });
    lift(state, "party", { x: 0, y: 0, w: 30, h: 10 });
    lift(state, "dm", { x: 0, y: 0, w: 5, h: 5 });
    const was: Label = { id: "l1", rev: 0, sceneId: "s1", x: 2, y: 2, text: "Hall", size: 1 };
    state.labels.l1 = { ...was, x: 20, y: 5 };
    remember(state, null, 0, 0, { labels: { l1: null } });
    assert.equal(projectState(state, P1, { sceneId: "s1" }).labels.l1, undefined);
    // Remembered where it stood, off their live ground: there it shows, as they last saw it.
    remember(state, null, 0, 0, { labels: { l1: { ...was, x: 10, y: 8 } } });
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).labels.l1, { ...was, x: 10, y: 8 });
    assert.deepEqual(projectEntity(keys.label("l1"), state, P1, { sceneId: "s1" }), { ...was, x: 10, y: 8 });
  });

  test("a label or stamp only memory names still reaches the players who remember it, and allKeys and dependents name it", () => {
    const state = fogRoom({ vision: true });
    lift(state, "party", { x: 0, y: 0, w: 10, h: 10 });
    const gone: Stamp = { id: "st1", rev: 0, sceneId: "s1", art: { key: "chest" }, x: 3.5, y: 3.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    remember(state, null, 0, 0, { stamps: { st1: gone } });
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).stamps.st1, gone);
    assert.ok(allKeys(state).includes(keys.stamp("st1")));
    assert.ok(dependents(state, [keys.memory("s1", 0, 0)]).includes(keys.stamp("st1")));
  });

  test("a stamp set DM-only out of sight leaves their map", () => {
    const state = fogRoom({ vision: true });
    lift(state, "party", { x: 0, y: 0, w: 10, h: 10 });
    const stamp: Stamp = { id: "st1", rev: 0, sceneId: "s1", art: { key: "chest" }, x: 3.5, y: 3.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    state.stamps.st1 = { ...stamp, visibility: "dm" };
    remember(state, null, 0, 0, { stamps: { st1: stamp } });
    assert.equal(projectState(state, P1, { sceneId: "s1" }).stamps.st1, undefined);
  });

  test("a stair run edited chunks away, out of sight: upDir stays as remembered", () => {
    const state = fogRoom({ vision: true });
    stairs(state, [[3, 3]], "a");
    heights(state, { x: 3, y: 2, w: 1, h: 1 }, 10);
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    const c = chunksOf(state, P1)["0,0"]!;
    assert.equal(c.upDir![3 * 16 + 3], "n");
    remember(state, null, 0, 0, { upDir: { "3,3": "e" } });
    assert.equal(chunksOf(state, P1)["0,0"]!.upDir![3 * 16 + 3], "e");
  });
});

/*
 * The chunk memo keys every input a position reads (5.6, MD2-O-4,
 * MD2-O-11): each case warms it with a projection, changes one input the
 * position's own objects do not show, and asks again.
 */
/*
 * One position's cut (piecesNear, what the fan-out asks for a key) reads
 * only the cells whose stretches can be filed there, and gives each piece
 * there the bytes the whole scene's cut (heldChunks, what a snapshot
 * reads) does (the performance pass).
 */
describe("one position's pieces and the whole scene's", () => {
  const same = (state: RoomState, cx: number, cy: number, view: string | null = null) => {
    const one = playerChunk(state, { sceneId: "s1", cx, cy }, view);
    const all = heldChunks(JSON.parse(JSON.stringify(state)) as RoomState, "s1", view)[`s1:${cx},${cy}`] ?? null;
    assert.equal(stableStringify(one), stableStringify(all));
    return one;
  };

  test("a piece filed at a position that reaches nearly 2 cells past its side", () => {
    const state = fogRoom({ bounds: { w: 48, h: 48 } });
    lift(state, "dm", { x: 0, y: 0, w: 48, h: 48 });
    // At 45 degrees in the band x = 12 to 16, its middle at y = 15.9375 in position 0,0, its end at y = 17.9375.
    wall(state, "abcdefghijkl", [12, 13.9375], [16, 17.9375]);
    const here = same(state, 0, 0);
    assert.ok(here?.walls?.some((w) => Math.max(w.a[1], w.b[1]) > 17.9), JSON.stringify(here?.walls));
    same(state, 0, 1);
  });

  test("a door whose live place a position's cut would skip, and whose remembered place lies there", () => {
    const state = fogRoom({ vision: true, bounds: { w: 48, h: 32 } });
    lift(state, "party", { x: 0, y: 0, w: 48, h: 32 });
    lift(state, "dm", { x: 20, y: 0, w: 10, h: 32 });
    const closed = { kind: "door" as const, state: "closed" as const, secret: false, discovered: false };
    // Stored in position 1,0 and seen there now; the party remembers it at x = 8, in position 0,0.
    const live = wall(state, "abcdefghijkl", [24, 5], [24, 6], closed);
    remember(state, null, 1, 0, { walls: { [live.id]: [{ wall: { ...live, a: [8, 5], b: [8, 6] }, cells: ["7,5", "8,5"] }] } });
    assert.equal(same(state, 0, 0)?.walls?.some((w) => w.id === live.id) ?? false, false, "the live door wins where it is live");
    assert.ok(same(state, 1, 0)?.walls?.some((w) => w.id === live.id));
  });

  test("a wall a holder remembers in their own layer, beside the party's memory of it", () => {
    const state = fogRoom({ vision: true, perPlayer: true });
    state.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] };
    lift(state, "party", { x: 0, y: 0, w: 48, h: 32 });
    lift(state, { holder: "p1" }, { x: 0, y: 0, w: 16, h: 16 });
    lift(state, "dm", { x: 20, y: 0, w: 10, h: 32 });
    // Stored in position 1,0 and seen there now; p1 remembers it at x = 8 and the party at x = 9, both in position 0,0.
    const live = wall(state, "abcdefghijkl", [24, 5], [24, 6]);
    remember(state, "p1", 1, 0, { walls: { [live.id]: [{ wall: { ...live, a: [8, 5], b: [8, 6] }, cells: ["7,5", "8,5"] }] } });
    remember(state, null, 1, 0, { walls: { [live.id]: [{ wall: { ...live, a: [9, 5], b: [9, 6] }, cells: ["8,5", "9,5"] }] } });
    const xs = (same(state, 0, 0, "p1")?.walls ?? []).map((w) => Math.round(w.a[0]));
    assert.ok(xs.includes(8) && !xs.includes(9), `p1 reads their own memory where their own layer holds the cells: ${xs.join(" ")}`);
    assert.ok((same(state, 0, 0, null)?.walls ?? []).some((w) => Math.round(w.a[0]) === 9), "the shared class reads the party's");
  });
});

describe("the players' chunk memo", () => {
  test("a stair run's far end raised two chunks away turns a held stair's upDir", () => {
    const state = fogRoom({ vision: true, bounds: { w: 64, h: 16 } });
    const run: [number, number][] = [];
    for (let x = 3; x < 40; x++) run.push([x, 3]);
    stairs(state, run, "a");
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    assert.equal(chunksOf(state, P1)["0,0"]!.upDir![3 * 16 + 3], ".");
    heights(state, { x: 40, y: 3, w: 1, h: 1 }, 10);
    assert.equal(chunksOf(state, P1)["0,0"]!.upDir![3 * 16 + 3], "e");
  });

  test("the scene's automatic walls rule changed: a held room's automatic walls go", () => {
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 2, h: 2 });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    assert.ok(autoAt(chunksOf(state, P1)["0,0"], "2,2,w"));
    state.scenes = { ...state.scenes, s1: { ...state.scenes.s1!, autoWalls: "off" } };
    assert.ok(!autoAt(chunksOf(state, P1)["0,0"], "2,2,w"));
  });

  test("the Sight switch turned off: a remembered cell shows live", () => {
    const state = fogRoom({ vision: true });
    paint(state, { x: 3, y: 3, w: 1, h: 1 }, "stone");
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    remember(state, null, 0, 0, { cells: { "3,3": "wood" } });
    assert.equal(chunksOf(state, P1)["0,0"]!.cells["3,3"], "wood");
    const { vision: _, ...off } = state.scenes.s1!;
    state.scenes = { ...state.scenes, s1: off };
    assert.equal(chunksOf(state, P1)["0,0"]!.cells["3,3"], "stone");
  });

  test("a holder's own layer reaching a cell the party already holds: the cell reads their own memory now", () => {
    const state = fogRoom({ vision: true, perPlayer: true });
    state.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] };
    paint(state, { x: 3, y: 3, w: 1, h: 1 }, "stone");
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    lift(state, { holder: "p1" }, { x: 6, y: 6, w: 1, h: 1 });
    remember(state, null, 0, 0, { cells: { "3,3": "wood" } });
    remember(state, "p1", 0, 0, { cells: { "3,3": "grass" } });
    assert.equal(chunksOf(state, P1)["0,0"]!.cells["3,3"], "wood");
    // Held already by the party's layer, so only the own bits of the cell change.
    lift(state, { holder: "p1" }, { x: 3, y: 3, w: 1, h: 1 });
    assert.equal(chunksOf(state, P1)["0,0"]!.cells["3,3"], "grass");
  });

  test("fresh tile objects over cells that are held as before: the very same chunk", () => {
    const state = fogRoom();
    paint(state, { x: 3, y: 3, w: 2, h: 2 });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    const before = chunksOf(state, P1)["0,0"];
    // The party's tile written again as the reducer writes it: a new object, and every cell held as it was.
    liftSubs(state, "party", [[1, 1]]);
    assert.equal(chunksOf(state, P1)["0,0"], before);
  });

  test("a chunk read again between two other answers: the very same chunk, as the slot keeps the answers read last", () => {
    const state = fogRoom();
    paint(state, { x: 3, y: 3, w: 2, h: 2 });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    const first = chunksOf(state, P1)["0,0"];
    // One more cell held, then the same cells again on fresh tile objects, as a step off and back writes them.
    for (const x of [8, 9]) {
      lift(state, "party", { x, y: 0, w: 1, h: 1 });
      assert.notEqual(chunksOf(state, P1)["0,0"], first, `cell ${x},0 held too`);
      lift(state, "party", { x, y: 0, w: 1, h: 1 }, "s1", false);
      assert.equal(chunksOf(state, P1)["0,0"], first, `back from cell ${x},0`);
    }
  });

  test("two scenes' chunks at the same position, one changed: the other's key is its own", () => {
    const state = fogRoom();
    state.scenes.s2 = { ...state.scenes.s1!, id: "s2" };
    paint(state, { x: 3, y: 3, w: 1, h: 1 }, "stone");
    state.buildChunks = { ...state.buildChunks, "s2:0,0": { sceneId: "s2", cx: 0, cy: 0, rev: 1, cells: { "3,3": "wood" }, edges: {} } };
    lift(state, "dm", { x: 0, y: 0, w: 8, h: 8 });
    lift(state, "dm", { x: 0, y: 0, w: 8, h: 8 }, "s2");
    const cell = (sceneId: string) => playerChunk(state, { sceneId, cx: 0, cy: 0 }, null)?.cells["3,3"];
    assert.deepEqual([cell("s1"), cell("s2")], ["stone", "wood"]);
    state.buildChunks = { ...state.buildChunks, "s2:0,0": { sceneId: "s2", cx: 0, cy: 0, rev: 2, cells: { "3,3": "grass" }, edges: {} } };
    assert.deepEqual([cell("s1"), cell("s2")], ["stone", "grass"]);
  });

  test("a class's ground and a scene's fields while an op still writes them: read as they are now", () => {
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 2, h: 2 });
    lift(state, "party", { x: 0, y: 0, w: 8, h: 8 });
    markWritable(state.fogTiles);
    assert.equal(groundOf(state, "s1", null)!.held(20, 20), false);
    // A transaction writes into the collection it copied.
    state.fogTiles["s1:1,1"] = { sceneId: "s1", tx: 1, ty: 1, rev: 1, bits: encodeTile(fullTileBits()) };
    assert.equal(groundOf(state, "s1", null)!.held(20, 20), true, "the tile written since is read");
    markFinished(state.fogTiles);
    const scene: Scene = (state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "all" });
    markWritable(scene);
    assert.ok(autoAt(playerChunk(state, { sceneId: "s1", cx: 0, cy: 0 }, null) ?? undefined, "2,2,w"));
    scene.autoWalls = "off";
    assert.ok(!autoAt(playerChunk(state, { sceneId: "s1", cx: 0, cy: 0 }, null) ?? undefined, "2,2,w"), "the rule written since is read");
    markFinished(scene);
  });

  test("a build stroke replaces the scene object, and positions it never reached hand back the very same chunk", () => {
    const state = fogRoom({ bounds: { w: 64, h: 16 } });
    paint(state, { x: 40, y: 3, w: 1, h: 1 });
    lift(state, "party", { x: 0, y: 0, w: 64, h: 16 });
    const before = chunksOf(state, P1)["0,0"];
    paint(state, { x: 41, y: 3, w: 1, h: 1 });
    state.scenes = { ...state.scenes, s1: { ...state.scenes.s1!, wallsVersion: state.scenes.s1!.wallsVersion + 1 } };
    assert.equal(chunksOf(state, P1)["0,0"], before);
  });
});

describe("dependents of the held build (5.6)", () => {
  test("a wall added across a chunk border, its held piece filed west: the west position comes again", () => {
    const state = fogRoom();
    lift(state, "dm", { x: 0, y: 0, w: 17, h: 4 });
    const before = deepClone(state);
    // Stored in chunk 1,0 by its midpoint, held only west of x = 17, so its piece is filed at 0,0.
    const w: FreeWall = wall(state, "abcdefghijkl", [13.25, 1.5], [21.25, 1.5]);
    assert.ok(state.buildChunks["s1:1,0"]?.walls?.includes(w));
    const key = keys.chunk("s1", 1, 0);
    const near = new Set([...dependents(before, [key]), ...dependents(state, [key]), key]);
    for (const at of ["0,0", "1,0"]) {
      const k = keys.chunk("s1", ...(at.split(",").map(Number) as [number, number]));
      assert.ok(near.has(k), `${at} is projected again`);
    }
    assert.ok(wallsOf(state, P1).some((p) => p.at === "0,0"), JSON.stringify(wallsOf(state, P1)));
  });

  test("touching walls from x = 1.25 to 100, then 0.25 to 1.25 added: pieces past x = 4 unchanged, a fresh projection equal to the old one there", () => {
    const state = fogRoom({ bounds: { w: 120, h: 8 } });
    for (let x = 1.25; x < 100; x += 6) wall(state, `w${String(Math.round(x * 4)).padStart(11, "0")}`, [x, 1.5], [Math.min(x + 6, 100), 1.5]);
    lift(state, "dm", { x: 0, y: 0, w: 120, h: 8 });
    const before = pieces(state).filter((p) => p[0] > 4);
    wall(state, "zzzzzzzzzzzz", [0.25, 1.5], [1.25, 1.5]);
    assert.deepEqual(pieces(state).filter((p) => p[0] > 4), before);
  });
});

describe("players' chunks kept while nothing they read changes", () => {
  test("the same objects come back from an unchanged room, and a changed fog makes new ones", () => {
    const state = fogRoom();
    paint(state, { x: 2, y: 2, w: 4, h: 4 });
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 10 });
    const a = playerChunk(state, { sceneId: "s1", cx: 0, cy: 0 }, null);
    assert.equal(playerChunk(state, { sceneId: "s1", cx: 0, cy: 0 }, null), a);
    const moved = { ...state, fogTiles: { ...state.fogTiles } };
    lift(moved, "dm", { x: 0, y: 0, w: 12, h: 10 });
    assert.notEqual(playerChunk(moved, { sceneId: "s1", cx: 0, cy: 0 }, null), a);
  });
});
