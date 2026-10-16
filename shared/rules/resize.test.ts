import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type CreatureSize, type EdgeFeature, type FreeWall, type RoomState, type TerrainId, type WallFeature } from "../model.ts";
import { room } from "../testutil.ts";
import { encodeHeights } from "./heights.ts";
import { footprintSize } from "./footprint.ts";
import type { MovingToken } from "./movement.ts";
import {
  LEDGE_IN_THE_WAY,
  NO_ROOM_TO_GROW,
  RESIZE_KEEPS_PLACE,
  SIX_SIZES,
  WALL_IN_THE_WAY,
  resizeBase,
  resizeCandidates,
  resizeRefusal,
  resizeSpot,
  sizeChange,
  type NextSize,
  type ResizeSpot,
} from "./resize.ts";

type Spec = { edges?: Record<string, EdgeFeature>; walls?: FreeWall[]; cells?: Record<string, TerrainId>; heights?: Record<string, number>; blockMovement?: boolean; w?: number; h?: number };

/** Scene s1 of a test room with the walls, cells and heights of `spec` stored in its chunks, blocking moves unless it says not. */
function walled(spec: Spec = {}): RoomState {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: spec.w ?? 40, h: spec.h ?? 30 }, autoWalls: "off", blockMovement: spec.blockMovement ?? true };
  const at = (x: number, y: number): BuildChunk => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    return (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
  };
  const split = (key: string) => key.split(",").map(Number) as [number, number];
  for (const [key, f] of Object.entries(spec.edges ?? {})) at(...split(key)).edges[key] = f;
  for (const [key, t] of Object.entries(spec.cells ?? {})) at(...split(key)).cells[key] = t;
  for (const wall of spec.walls ?? []) (at(Math.floor((wall.a[0] + wall.b[0]) / 2), Math.floor((wall.a[1] + wall.b[1]) / 2)).walls ??= []).push(wall);
  const feet = new Map<BuildChunk, number[]>();
  for (const [key, v] of Object.entries(spec.heights ?? {})) {
    const [x, y] = split(key);
    const chunk = at(x, y);
    if (!feet.has(chunk)) feet.set(chunk, new Array(CHUNK_CELLS * CHUNK_CELLS).fill(0));
    feet.get(chunk)![(y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS)] = v;
  }
  for (const [chunk, f] of feet) chunk.heights = encodeHeights(f);
  return state;
}

function free(id: string, ax: number, ay: number, bx: number, by: number, f: WallFeature = { kind: "wall" }): FreeWall {
  return { id, a: [ax, ay], b: [bx, by], f };
}

const creature = (size: Exclude<CreatureSize, "custom">, x: number, y: number, over: Partial<MovingToken> = {}): MovingToken => ({ sceneId: "s1", size, x, y, elevation: 0, ...over });
const to = (size: CreatureSize, w?: number, h?: number): NextSize => ({ size, ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}) });
const owner = { checked: true };
const spot = (x: number, y: number, shifted = false): ResizeSpot => ({ x, y, shifted });

/**
 * The guarantee 8.2 and 8.3 rest on: for a growth the search allows, the
 * square it grew from lies inside the grown footprint and passes rule 4 as
 * a shrink back, so the device's remembered return and the growth's undo
 * are always spots a resize may take.
 */
function returnsInside(state: RoomState, token: MovingToken, grown: ResizeSpot, size: CreatureSize): void {
  assert.ok(!("refused" in grown));
  const big = { ...token, size, x: grown.x, y: grown.y };
  assert.notEqual(resizeRefusal(state, big, { size: token.size, x: token.x, y: token.y }), RESIZE_KEEPS_PLACE, `back from ${size} at ${grown.x},${grown.y}`);
  assert.ok(resizeCandidates(big, { size: token.size }, state.scenes.s1!).some((p) => p.x === token.x && p.y === token.y));
}

describe("the base spot (8.2)", () => {
  const scene = { bounds: { w: 40, h: 30 } };

  test("growing covers the old footprint, centered where the grid allows, ties to the old top-left corner", () => {
    const medium = creature("medium", 4, 4);
    assert.deepEqual(resizeBase(medium, to("large"), scene), { x: 4, y: 4 }, "spreading right and down as today");
    assert.deepEqual(resizeBase(medium, to("huge"), scene), { x: 3, y: 3 }, "centered on the old square");
    assert.deepEqual(resizeBase(medium, to("gargantuan"), scene), { x: 3, y: 3 });
    assert.deepEqual(resizeBase(creature("large", 4, 4), to("huge"), scene), { x: 4, y: 4 });
    assert.deepEqual(resizeBase(creature("large", 4, 4), to("gargantuan"), scene), { x: 3, y: 3 });
  });

  test("shrinking lies inside the old footprint, ties to its top-left", () => {
    assert.deepEqual(resizeBase(creature("large", 4, 4), to("medium"), scene), { x: 4, y: 4 }, "its top-left square");
    assert.deepEqual(resizeBase(creature("huge", 3, 3), to("medium"), scene), { x: 4, y: 4 }, "its middle square");
    assert.deepEqual(resizeBase(creature("gargantuan", 2, 2), to("medium"), scene), { x: 3, y: 3 });
    assert.deepEqual(resizeBase(creature("large", 4, 4), to("tiny"), scene), { x: 4.5, y: 4.5 });
  });

  test("Tiny takes half cells, and a Tiny anywhere in a square becomes a Medium in that square", () => {
    assert.deepEqual(resizeBase(creature("medium", 4, 4), to("tiny"), scene), { x: 4, y: 4 });
    for (const [x, y] of [[4, 4], [4.5, 4], [4, 4.5], [4.5, 4.5]] as const) {
      assert.deepEqual(resizeBase(creature("tiny", x, y), to("medium"), scene), { x: 4, y: 4 }, `a Tiny at ${x},${y}`);
    }
  });

  test("Small and Medium are one footprint, so between them nothing moves", () => {
    assert.equal(sizeChange(creature("small", 4, 4), to("medium")), "same");
    assert.deepEqual(resizeBase(creature("small", 4, 4), to("medium"), scene), { x: 4, y: 4 });
    const state = walled();
    assert.deepEqual(resizeSpot(state, creature("medium", 4, 4), to("small"), owner), spot(4, 4));
    assert.deepEqual(resizeSpot(state, creature("large", 4.5, 4, { squeeze: true }), to("large"), owner), spot(4.5, 4), "a patch naming its size keeps its place, even off the grid");
  });

  test("between every pair of the six sizes, from whole and half cell spots, growing covers and shrinking lies inside", () => {
    for (const from of SIX_SIZES) {
      const spots = from === "tiny" ? [[4, 4], [4.5, 4], [4, 4.5], [4.5, 4.5], [7, 2.5]] : [[4, 4], [7, 2], [11, 9]];
      for (const [x, y] of spots as [number, number][]) {
        const token = creature(from, x, y);
        const old = footprintSize(token);
        for (const size of SIX_SIZES) {
          const base = resizeBase(token, to(size), scene);
          const { w, h } = footprintSize({ size, x: 0, y: 0 });
          const step = Math.min(w, h) < 1 ? 0.5 : 1;
          const label = `${from} at ${x},${y} to ${size}`;
          assert.ok(Number.isInteger(base.x / step) && Number.isInteger(base.y / step), `${label}: on its grid`);
          const change = sizeChange(token, to(size));
          if (change === "same") assert.deepEqual(base, { x, y }, label);
          else if (change === "grow") assert.ok(base.x <= x && base.y <= y && base.x + w >= x + old.w && base.y + h >= y + old.h, `${label}: covers`);
          else assert.ok(base.x >= x && base.y >= y && base.x + w <= x + old.w && base.y + h <= y + old.h, `${label}: inside`);
        }
      }
    }
  });

  test("a Custom size takes the nearest middle, and an odd width with no centered spot ties to the old corner", () => {
    const medium = creature("medium", 4, 4);
    assert.deepEqual(resizeBase(medium, to("custom", 3, 1), scene), { x: 3, y: 4 }, "3 wide keeps the middle");
    assert.deepEqual(resizeBase(medium, to("custom", 2, 3), scene), { x: 4, y: 3 });
    assert.deepEqual(resizeBase(medium, to("custom", 1.5, 1.5), scene), { x: 4, y: 4 }, "the nearest middle on whole cells");
    assert.deepEqual(resizeBase(creature("large", 4, 4), to("custom", 3, 3), scene), { x: 4, y: 4 });
  });

  test("the scene's edge moves it the least to lie inside, on each axis the scene is big enough for", () => {
    assert.deepEqual(resizeBase(creature("medium", 0, 0), to("huge"), scene), { x: 0, y: 0 });
    assert.deepEqual(resizeBase(creature("medium", 39, 29), to("huge"), scene), { x: 37, y: 27 });
    assert.deepEqual(resizeBase(creature("tiny", 39.5, 29.5), to("medium"), scene), { x: 39, y: 29 });
    assert.deepEqual(resizeBase(creature("medium", 2, 1), to("gargantuan"), { bounds: { w: 3, h: 30 } }), { x: 1, y: 0 }, "a scene narrower than the footprint leaves that axis be");
  });

  test("a squeezed creature's middle is its full footprint's", () => {
    const squeezed = creature("large", 4.5, 4, { squeeze: true });
    assert.deepEqual(resizeBase(squeezed, to("huge"), scene), { x: 4, y: 4 });
    assert.deepEqual(resizeBase(squeezed, to("medium"), scene), { x: 5, y: 4 });
  });
});

describe("an owner's growth on a scene that blocks moves (8.3)", () => {
  test("with no wall near, the base spot, and nothing shifts", () => {
    const state = walled();
    const medium = creature("medium", 4, 4);
    assert.deepEqual(resizeSpot(state, medium, to("large"), owner), spot(4, 4));
    assert.deepEqual(resizeSpot(state, medium, to("huge"), owner), spot(3, 3));
    assert.deepEqual(resizeSpot(state, medium, to("gargantuan"), owner), spot(3, 3));
    for (const size of SIX_SIZES) {
      for (const from of SIX_SIZES) {
        const token = creature(from, 6, 6);
        if (sizeChange(token, to(size)) === "grow") returnsInside(state, token, resizeSpot(state, token, to(size), owner), size);
      }
    }
  });

  test("a wall on each side: it grows away from it", () => {
    const sides: [string, [number, number]][] = [
      ["4,4,w", [4, 3]],
      ["5,4,w", [2, 3]],
      ["4,4,n", [3, 4]],
      ["4,5,n", [3, 2]],
    ];
    for (const [edge, [x, y]] of sides) {
      const state = walled({ edges: { [edge]: { kind: "wall" } } });
      const grown = resizeSpot(state, creature("medium", 4, 4), to("huge"), owner);
      assert.deepEqual(grown, spot(x, y, true), edge);
      returnsInside(state, creature("medium", 4, 4), grown, "huge");
    }
  });

  test("a corner: Large fits as it is, Huge grows right and down, away from both walls", () => {
    const state = walled({ edges: { "4,4,w": { kind: "wall" }, "4,4,n": { kind: "wall" } } });
    const medium = creature("medium", 4, 4);
    assert.deepEqual(resizeSpot(state, medium, to("large"), owner), spot(4, 4));
    const huge = resizeSpot(state, medium, to("huge"), owner);
    assert.deepEqual(huge, spot(4, 4, true));
    assert.equal(resizeRefusal(state, medium, { size: "huge", x: 3, y: 3 }), NO_ROOM_TO_GROW, "the base puts its core over both walls");
    returnsInside(state, medium, huge, "huge");
    returnsInside(state, medium, resizeSpot(state, medium, to("large"), owner), "large");
  });

  test("round 1's short wall: Gargantuan takes (3, 2), the nearest middle, not (4, 3)", () => {
    const state = walled({ walls: [free("short", 3.75, 6.25, 3.75, 6.5)] });
    const medium = creature("medium", 4, 4);
    const grown = resizeSpot(state, medium, to("gargantuan"), owner);
    assert.deepEqual(grown, spot(3, 2, true));
    for (const [x, y] of [[3, 3], [2, 3]]) assert.equal(resizeRefusal(state, medium, { size: "gargantuan", x: x!, y: y! }), NO_ROOM_TO_GROW, `${x},${y} is blocked`);
    assert.equal(resizeRefusal(state, medium, { size: "gargantuan", x: 2, y: 2 }), null, "(2, 2) passes as near, but shifts more across");
    assert.equal(resizeRefusal(state, medium, { size: "gargantuan", x: 4, y: 3 }), null, "(4, 3) passes too, 1.58 cells away");
    returnsInside(state, medium, grown, "gargantuan");
  });

  test("round 2's two pairs of short walls: a Large to Huge has no room, and never takes (5, 4)", () => {
    const cases = [
      [free("a", 5.75, 3.5, 5.75, 4), free("b", 4.75, 5.75, 4.75, 6.5)],
      [free("a", 4.625, 4.25, 4.625, 4.375), free("b", 4.625, 5.625, 4.625, 5.75)],
    ];
    for (const walls of cases) {
      const state = walled({ walls });
      const large = creature("large", 4, 4);
      assert.deepEqual(resizeSpot(state, large, to("huge"), owner), { refused: NO_ROOM_TO_GROW });
      assert.deepEqual(resizeCandidates(large, to("huge"), state.scenes.s1!), [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 3 }, { x: 3, y: 3 }]);
      assert.equal(resizeRefusal(state, large, { size: "huge", x: 5, y: 4 }), RESIZE_KEEPS_PLACE, "it would leave the Large's left squares");
    }
  });

  test("corridors: a Large needs 10 ft, a Gargantuan more, and none grows by squeezing", () => {
    const five = walled({ edges: { ...row(4, 0, 20), ...row(5, 0, 20) } });
    assert.deepEqual(resizeSpot(five, creature("medium", 8, 4), to("large"), owner), { refused: NO_ROOM_TO_GROW }, "a Large could squeeze here, but never grows into a squeeze");
    const ten = walled({ edges: { ...row(4, 0, 20), ...row(6, 0, 20) } });
    const grown = resizeSpot(ten, creature("medium", 8, 4), to("large"), owner);
    assert.deepEqual(grown, spot(8, 4));
    returnsInside(ten, creature("medium", 8, 4), grown, "large");
    assert.deepEqual(resizeSpot(ten, creature("medium", 8, 4), to("gargantuan"), owner), { refused: NO_ROOM_TO_GROW });
  });

  test("closed, locked and unfound secret doors, windows and pillars count, an open door and a found one do not", () => {
    const door = (state: "open" | "closed" | "locked", secret = false, discovered = false): WallFeature => ({ kind: "door", state, secret, discovered });
    const medium = creature("medium", 4, 4);
    const blocks = (state: RoomState) => {
      const grown = resizeSpot(state, medium, to("large"), owner);
      if (!("refused" in grown)) returnsInside(state, medium, grown, "large");
      return grown;
    };
    // An edge right of the square: the Large base's core reaches over it, the spot to its left does not.
    for (const f of [door("closed"), door("locked"), door("open", true, false), { kind: "window" } as const, { kind: "wall" } as const]) {
      assert.deepEqual(blocks(walled({ edges: { "5,4,w": f } })), spot(3, 4, true), JSON.stringify(f));
    }
    for (const f of [door("open"), door("open", true, true)]) assert.deepEqual(blocks(walled({ edges: { "5,4,w": f } })), spot(4, 4), JSON.stringify(f));
    assert.deepEqual(blocks(walled({ cells: { "5,5": "pillar" } })), spot(3, 4, true), "a pillar");
  });

  test("a ledge stops a creature on the ground beside it, and not one flying above it", () => {
    const ledge = walled({ heights: Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`${5 + (k % 5)},${Math.floor(k / 5)}`, 10])) });
    assert.deepEqual(resizeSpot(ledge, creature("medium", 4, 4), to("large"), owner), spot(3, 4, true));
    returnsInside(ledge, creature("medium", 4, 4), spot(3, 4, true), "large");
    assert.deepEqual(resizeSpot(ledge, creature("medium", 4, 4, { elevation: 20 }), to("large"), owner), spot(4, 4));
    assert.equal(resizeRefusal(ledge, creature("medium", 4, 4), { size: "large", x: 4, y: 4 }), NO_ROOM_TO_GROW);
  });

  test("the candidates cover the old footprint and lie inside the scene, nearest middle first, then the base, the smaller vertical and horizontal shifts, up and left", () => {
    const scene = { bounds: { w: 40, h: 30 } };
    assert.deepEqual(resizeCandidates(creature("medium", 4, 4), to("huge"), scene), [
      { x: 3, y: 3 },
      { x: 2, y: 3 },
      { x: 4, y: 3 },
      { x: 3, y: 2 },
      { x: 3, y: 4 },
      { x: 2, y: 2 },
      { x: 4, y: 2 },
      { x: 2, y: 4 },
      { x: 4, y: 4 },
    ]);
    assert.equal(resizeCandidates(creature("medium", 4, 4), to("gargantuan"), scene).length, 16, "a Medium growing to Gargantuan has 4 spots each way");
    assert.deepEqual(resizeCandidates(creature("medium", 0, 1), to("huge"), scene), [{ x: 0, y: 0 }, { x: 0, y: 1 }], "never outside the scene");
    assert.deepEqual(resizeCandidates(creature("large", 4.5, 4, { squeeze: true }), to("huge"), scene), [{ x: 4, y: 4 }, { x: 4, y: 3 }], "a squeezed creature's full footprint");
    assert.deepEqual(resizeCandidates(creature("medium", 1, 1), to("gargantuan"), { bounds: { w: 3, h: 3 } }), [], "no room in a scene smaller than it");
    const tight = walled({ w: 3, h: 3, blockMovement: false });
    assert.deepEqual(resizeSpot(tight, creature("medium", 1, 1), to("gargantuan"), owner), { refused: NO_ROOM_TO_GROW });
  });

  test("on a scene that does not block moves, an owner's growth takes the base spot whatever the walls", () => {
    const state = walled({ blockMovement: false, edges: { "4,4,w": { kind: "wall" }, "4,4,n": { kind: "wall" } } });
    assert.deepEqual(resizeSpot(state, creature("medium", 4, 4), to("huge"), owner), spot(3, 3));
    assert.equal(resizeRefusal(state, creature("medium", 4, 4), { size: "huge", x: 3, y: 3 }), null);
  });

  test("the DM takes the base spot, unchecked, over walls too", () => {
    const state = walled({ edges: { "4,4,w": { kind: "wall" }, "4,4,n": { kind: "wall" } } });
    assert.deepEqual(resizeSpot(state, creature("medium", 4, 4), to("huge"), { checked: false }), spot(3, 3));
    assert.deepEqual(resizeSpot(state, creature("medium", 4, 4), to("custom", 2, 3), { checked: false }), spot(4, 3));
  });
});

describe("an owner's shrink (8.3)", () => {
  test("takes the base spot where its middle crosses nothing", () => {
    const state = walled();
    assert.deepEqual(resizeSpot(state, creature("large", 4, 4), to("medium"), owner), spot(4, 4));
    assert.deepEqual(resizeSpot(state, creature("huge", 3, 3), to("medium"), owner), spot(4, 4));
  });

  test("a free wall at x 4.375 sends a Medium's Tiny to (4.5, 4), on its middle's side, and refuses (4, 4)", () => {
    const state = walled({ walls: [free("w", 4.375, 4, 4.375, 5)] });
    const medium = creature("medium", 4, 4);
    assert.deepEqual(resizeSpot(state, medium, to("tiny"), owner), spot(4.5, 4, true));
    assert.equal(resizeRefusal(state, medium, { size: "tiny", x: 4, y: 4 }), WALL_IN_THE_WAY);
    assert.equal(resizeRefusal(walled({ blockMovement: false, walls: [free("w", 4.375, 4, 4.375, 5)] }), medium, { size: "tiny", x: 4, y: 4 }), null);
  });

  test("the remembered square is taken where it applies, and a wall drawn since across the middle's way sends the search on", () => {
    const state = walled();
    const huge = creature("huge", 4, 4);
    assert.deepEqual(resizeSpot(state, huge, to("medium"), owner), spot(5, 5), "the base, its middle square");
    assert.deepEqual(resizeSpot(state, huge, to("medium"), { checked: true, remembered: { x: 4, y: 4 } }), spot(4, 4), "back to the square it grew from");
    assert.deepEqual(resizeSpot(state, huge, to("medium"), { checked: false, remembered: { x: 4, y: 4 } }), spot(4, 4), "for the DM too");
    assert.deepEqual(resizeSpot(state, huge, to("medium"), { checked: true, remembered: { x: 9, y: 9 } }), spot(5, 5), "a square outside the footprint is no return");
    assert.deepEqual(resizeSpot(state, huge, to("large"), { checked: true, remembered: { x: 4, y: 4 } }), spot(4, 4));
    const cut = walled({ walls: [free("cut", 4.75, 5.25, 5.25, 4.75)] });
    assert.deepEqual(resizeSpot(cut, huge, to("medium"), { checked: true, remembered: { x: 4, y: 4 } }), spot(5, 5, true));
    assert.deepEqual(resizeSpot(state, creature("medium", 4, 4), to("large"), { checked: true, remembered: { x: 3, y: 3 } }), spot(4, 4), "a growth has no remembered square");
  });

  test("walls inside the footprint that cut every spot off from its middle refuse the shrink in a move's words", () => {
    const ring = [free("n", 4.75, 4.75, 5.25, 4.75), free("e", 5.25, 4.75, 5.25, 5.25), free("s", 5.25, 5.25, 4.75, 5.25), free("w", 4.75, 5.25, 4.75, 4.75)];
    const state = walled({ walls: ring });
    assert.deepEqual(resizeSpot(state, creature("large", 4, 4), to("medium"), owner), { refused: WALL_IN_THE_WAY });
    assert.deepEqual(resizeSpot(state, creature("large", 4, 4), to("medium"), { checked: false }), spot(4, 4), "the DM still shrinks it");
  });

  test("a ledge in the way answers in a move's words", () => {
    const ledge = walled({ heights: Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`${5 + (k % 10)},${Math.floor(k / 10)}`, 10])) });
    const huge = creature("huge", 3, 3, { elevation: 10 });
    assert.equal(resizeRefusal(ledge, huge, { size: "medium", x: 5, y: 4 }), LEDGE_IN_THE_WAY);
    assert.deepEqual(resizeSpot(ledge, huge, to("medium"), owner), spot(4, 4), "the base keeps its middle");
  });

  test("a wall through the old middle lets the middle step off on either side, as a move may", () => {
    const state = walled({ walls: [free("mid", 5, 4, 5, 6)] });
    assert.deepEqual(resizeSpot(state, creature("large", 4, 4), to("medium"), owner), spot(4, 4));
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "medium", x: 5, y: 5 }), null);
  });
});

describe("rule 4: the spots a resize patch may name", () => {
  const state = walled({ blockMovement: false });

  test("keeping its size keeps its place", () => {
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "large", x: 3, y: 4 }), RESIZE_KEEPS_PLACE);
    assert.equal(resizeRefusal(state, creature("medium", 4, 4), { size: "small", x: 5, y: 4 }), RESIZE_KEEPS_PLACE);
    assert.equal(resizeRefusal(state, creature("medium", 4, 4), { size: "small", x: 4, y: 4 }), null);
  });

  test("a growth on its grid, inside the scene, covering every old square, and a shrink inside the old footprint", () => {
    const medium = creature("medium", 4, 4);
    assert.equal(resizeRefusal(state, medium, { size: "large", x: 3.5, y: 4 }), RESIZE_KEEPS_PLACE, "off the grid");
    assert.equal(resizeRefusal(state, creature("medium", 39, 29), { size: "large", x: 39, y: 29 }), RESIZE_KEEPS_PLACE, "outside the scene");
    assert.equal(resizeRefusal(state, medium, { size: "huge", x: 4, y: 2 }), null);
    assert.equal(resizeRefusal(state, medium, { size: "huge", x: 4, y: 1 }), RESIZE_KEEPS_PLACE, "holding nothing of the old square");
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "huge", x: 4, y: 3 }), null);
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "huge", x: 5, y: 3 }), RESIZE_KEEPS_PLACE, "holding its middle but not its left squares");
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "medium", x: 5, y: 5 }), null);
    assert.equal(resizeRefusal(state, creature("large", 4, 4), { size: "medium", x: 6, y: 5 }), RESIZE_KEEPS_PLACE, "outside the old footprint");
    assert.equal(resizeRefusal(state, medium, { size: "tiny", x: 4.5, y: 4.5 }), null, "Tiny on half cells");
    assert.equal(resizeRefusal(state, medium, { size: "tiny", x: 4.25, y: 4 }), RESIZE_KEEPS_PLACE);
  });
});

/** Edge walls along the north edges of row `y` from column `from` to `to`. */
function row(y: number, from: number, to: number): Record<string, EdgeFeature> {
  const out: Record<string, EdgeFeature> = {};
  for (let x = from; x < to; x++) out[`${x},${y},n`] = { kind: "wall" };
  return out;
}
