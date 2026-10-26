import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GridShape, PathStop, RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { occupiedHexes, placedOnHex, tokenRefHex, type PlacedToken } from "../rules/footprint.ts";
import { rasterizeFogOps } from "../rules/fog.ts";
import { gridOfShape, SQUARES } from "../rules/grid.ts";
import { holderTileKey } from "../keys.ts";
import { projectState } from "../project.ts";
import { hexDistance, hexKey, hexSubcells, type Hex, type HexGrid } from "../rules/hex.ts";
import { ownWalk } from "../rules/movement.ts";
import { routeWalk } from "../rules/route.ts";
import { DM, env, room, scene, token } from "../testutil.ts";

/**
 * A turn's path on a hex scene (docs/design-v1-hex-grids.md 4.2 and 4.3):
 * each leg records the hex steps between its ends' reference hexes, with
 * the room's rule only for height.
 */

const START: Op = { t: "encounter.start", entries: [{ id: "n1", tokenId: "ogre", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] };
const NEXT: Op = { t: "encounter.next" };

function at(g: HexGrid, size: PlacedToken["size"], hex: Hex): { x: number; y: number } {
  return placedOnHex(g, { size, x: 0, y: 0 }, hex);
}

function fight(shape: GridShape, size: PlacedToken["size"], from: Hex, setup?: (s: RoomState) => void) {
  const g = gridOfShape(shape) as HexGrid;
  let state = room({
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 30, h: 20 } }), s2: scene("s2") },
    tokens: { ogre: token("ogre", { size, ...at(g, size, from) }), gob: token("gob", { x: 20, y: 10 }) },
  });
  setup?.(state);
  let seq = 0;
  const run = (op: Op, who: Viewer = DM) => {
    const r = applyOp(state, op, who, env(++seq));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
  };
  run(START);
  run(NEXT);
  return {
    g,
    move: (hex: Hex, extra: Partial<Extract<Op, { t: "token.move" }>> = {}) => run({ t: "token.move", tokenId: "ogre", ...at(g, state.tokens.ogre!.size, hex), ...extra }),
    stops: (): PathStop[] => state.tokens.ogre!.path!.stops,
    state: () => state,
  };
}

for (const shape of ["hexRows", "hexColumns"] as const) {
  describe(`${shape}: a turn's legs`, () => {
    test("a drag of 4 hexes on the active creature's turn records 20 ft", () => {
      const f = fight(shape, "medium", { col: 3, row: 3 });
      f.move({ col: 7, row: 3 });
      assert.deepEqual([f.stops()[1]!.moved, f.stops()[1]!.cost], [20, 20]);
    });

    test("a Large creature moved 3 hexes moved 15 ft, counted between its top hexes", () => {
      const f = fight(shape, "large", { col: 4, row: 4 });
      f.move({ col: 7, row: 4 });
      assert.equal(hexDistance(f.g, { col: 4, row: 4 }, { col: 7, row: 4 }), 3);
      assert.equal(f.stops()[1]!.moved, 15);
    });

    test("a flier rising 10 ft a leg over one hex a leg carries its vertical count under 5-10-5", () => {
      const f = fight(shape, "medium", { col: 3, row: 3 }, (s) => (s.meta.settings.diagonal = "fiveTen"));
      f.move({ col: 4, row: 3 }, { elevation: 10 });
      f.move({ col: 5, row: 3 }, { elevation: 20 });
      assert.deepEqual(
        f.stops().slice(1).map((s) => [s.moved, s.diag]),
        [
          [10, [0, 1]],
          [15, [0, 1]],
        ],
      );
    });
  });
}

describe("a leg through one fogged hex (section 9)", () => {
  /** Fog on, every sub-cell revealed but those of `hex`. */
  function allBut(state: RoomState, g: HexGrid, hex: Hex): void {
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    const ops = [
      { id: "all", mode: "reveal" as const, shape: { kind: "rect" as const, x: 0, y: 0, w: 30, h: 20 } },
      ...hexSubcells(g, hex).map(([sx, sy], i) => ({ id: `h${i}`, mode: "hide" as const, shape: { kind: "rect" as const, x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 } })),
    ];
    for (const [key, tile] of Object.entries(rasterizeFogOps(state.fogTiles, "s1", state.scenes.s1.bounds, ops))) {
      if (tile === null) delete state.fogTiles[key];
      else state.fogTiles[key] = tile;
    }
  }

  test("is not routeSeen, though its ends are seen, and the square samples of the same leg miss that hex", () => {
    // Two rows straight down on hex rows: the line passes hex 4,3 of the odd row between, by its nudge.
    const f = fight("hexRows", "medium", { col: 4, row: 2 }, (s) => allBut(s, gridOfShape("hexRows") as HexGrid, { col: 4, row: 3 }));
    f.move({ col: 4, row: 4 });
    const stop = f.stops()[1]!;
    assert.deepEqual([f.stops()[0]!.seen, stop.seen, stop.routeSeen], [true, true, undefined]);
    // Without the hex line, the leg's top-left samples stand on hex 3,3 between, so every spot would read as seen.
    const from = ownWalk({ ...token("o", { size: "medium" }), ...placedOnHex(f.g, { size: "medium", x: 0, y: 0 }, { col: 4, row: 2 }) });
    const to = { ...from, ...placedOnHex(f.g, from, { col: 4, row: 4 }) };
    const squares = routeWalk(SQUARES, [from, to], { buildChunks: {} }).map((p) => hexKey(tokenRefHex(f.g, { size: "medium", x: p.x, y: p.y })));
    assert.ok(!squares.includes("4,3"), squares.join(" "));
  });

  test("a leg beside it is routeSeen", () => {
    const f = fight("hexRows", "medium", { col: 4, row: 2 }, (s) => allBut(s, gridOfShape("hexRows") as HexGrid, { col: 8, row: 3 }));
    f.move({ col: 4, row: 4 });
    assert.equal(f.stops()[1]!.routeSeen, true);
  });
});

describe("on a per-player scene with fog, a leg's every spot stands on shared ground (docs/design-v1-per-player-vision.md 6.5)", () => {
  /** A per-player scene with fog alone, every sub-cell revealed in the shared fog but those of `hidden`. */
  function sharedBut(state: RoomState, g: HexGrid, hidden: Hex | null): void {
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
    state.holders = { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } };
    const ops = [
      { id: "all", mode: "reveal" as const, shape: { kind: "rect" as const, x: 0, y: 0, w: 30, h: 20 } },
      ...(hidden ? hexSubcells(g, hidden) : []).map(([sx, sy], i) => ({ id: `h${i}`, mode: "hide" as const, shape: { kind: "rect" as const, x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 } })),
    ];
    for (const [key, tile] of Object.entries(rasterizeFogOps(state.fogTiles, "s1", state.scenes.s1.bounds, ops))) {
      if (tile === null) delete state.fogTiles[key];
      else state.fogTiles[key] = tile;
    }
  }

  test("a Large whose middle spot has one hex wholly under the shared fog is not routeSeen, though it is seen there", () => {
    const g = gridOfShape("hexRows") as HexGrid;
    const from = ownWalk({ ...token("o", { size: "large" }), ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 6, row: 6 }) });
    const to = { ...from, ...placedOnHex(g, from, { col: 8, row: 6 }) };
    const spots = routeWalk(g, [from, to], { buildChunks: {} });
    assert.equal(spots.length, 3);
    const ends = new Set([spots[0]!, spots[2]!].flatMap((p) => occupiedHexes(g, { size: "large", x: p.x, y: p.y }).map(hexKey)));
    const hidden = occupiedHexes(g, { size: "large", x: spots[1]!.x, y: spots[1]!.y }).find((h) => !ends.has(hexKey(h)))!;
    const f = fight("hexRows", "large", { col: 6, row: 6 }, (s) => sharedBut(s, g, hidden));
    f.move({ col: 8, row: 6 });
    assert.deepEqual([f.stops()[0]!.seen, f.stops()[1]!.seen, f.stops()[1]!.routeSeen], [true, true, undefined]);
    const open = fight("hexRows", "large", { col: 6, row: 6 }, (s) => sharedBut(s, g, null));
    open.move({ col: 8, row: 6 });
    assert.equal(open.stops()[1]!.routeSeen, true);
  });
});

describe("a private leg joined once the path is full keeps its corners for a co-owner only over hexes their fog reveals (review HX2-ASTRA-01)", () => {
  const g = gridOfShape("hexRows") as HexGrid;
  const P1: Viewer = { memberId: "p1", role: "player" };
  const P2: Viewer = { memberId: "p2", role: "player" };

  /** A per-player hex rows scene with fog alone, p1 holding sight: the shared fog reveals every sub-cell but those of `hidden`, and p1's own explored layer those of `own`. */
  function scene43(state: RoomState, hidden: Hex | null, own: Hex | null): void {
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
    state.holders = { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } };
    const hide = (hidden ? hexSubcells(g, hidden) : []).map(([sx, sy], i) => ({ id: `h${i}`, mode: "hide" as const, shape: { kind: "rect" as const, x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 } }));
    const all = [{ id: "all", mode: "reveal" as const, shape: { kind: "rect" as const, x: 0, y: 0, w: 30, h: 20 } }, ...hide];
    for (const [key, tile] of Object.entries(rasterizeFogOps(state.fogTiles, "s1", state.scenes.s1.bounds, all))) {
      if (tile === null) delete state.fogTiles[key];
      else state.fogTiles[key] = tile;
    }
    if (own) {
      const ops = hexSubcells(g, own).map(([sx, sy], i) => ({ id: `o${i}`, mode: "reveal" as const, shape: { kind: "rect" as const, x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 } }));
      for (const tile of Object.values(rasterizeFogOps({}, "s1", state.scenes.s1.bounds, ops))) {
        if (tile) state.exploredBy[holderTileKey("s1", "p1", tile.tx, tile.ty)] = { ...tile, memberId: "p1" };
      }
    }
    state.tokens.ogre = { ...state.tokens.ogre!, kind: "pc", ownerIds: ["p1", "p2"] };
  }

  /** A Medium both players own walked from 4,2 two rows down across 4,3, then 52 short moves more, so the path compacts and its first stop past the start holds 4,4 as a corner. */
  function walked(hidden: Hex | null, own: Hex | null) {
    const f = fight("hexRows", "medium", { col: 4, row: 2 }, (s) => scene43(s, hidden, own));
    f.move({ col: 4, row: 4 });
    for (let i = 0; i < 52; i++) f.move(i % 2 === 0 ? { col: 10, row: 10 } : { col: 11, row: 10 });
    const stored = f.stops();
    assert.equal(stored.length, 50);
    assert.deepEqual(stored[1]!.via!.slice(0, 2), [at(g, "medium", { col: 4, row: 4 }).x, at(g, "medium", { col: 4, row: 4 }).y]);
    const via = (viewer: Viewer) => projectState(f.state(), viewer, { sceneId: "s1" }).tokens.ogre!.path!.stops[1]!.via;
    return { stored, via };
  }

  test("with every sub-cell of 4,3 under the shared fog, neither co-owner gets the joined leg's corners", () => {
    const w = walked({ col: 4, row: 3 }, null);
    assert.equal(w.stored[1]!.routeSeen, undefined);
    assert.equal(w.via(P2), undefined);
    assert.equal(w.via(P1), undefined);
  });

  test("the holder whose own explored layer reveals 4,3 keeps them, and the other co-owner still does not", () => {
    const w = walked({ col: 4, row: 3 }, { col: 4, row: 3 });
    assert.deepEqual(w.via(P1), w.stored[1]!.via);
    assert.equal(w.via(P2), undefined);
  });

  test("with 4,3 revealed to everyone, every owner keeps them", () => {
    const w = walked(null, null);
    assert.deepEqual(w.via(P1), w.stored[1]!.via);
    assert.deepEqual(w.via(P2), w.stored[1]!.via);
  });
});
