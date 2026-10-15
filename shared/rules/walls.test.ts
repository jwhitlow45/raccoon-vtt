import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AutoWalls, BuildChunk, EdgeFeature, FreeWall, Scene, StairMark, TerrainId, WallFeature } from "../model.ts";
import { autoWallBetween, paintedAt } from "./autoWalls.ts";
import { encodeHeights } from "./heights.ts";
import { computeCoverage, creaturesInArea, defaultIncludeOrigin, type AreaContext, type AreaTemplateInput, type AreaToken } from "./aoe.ts";
import { AREAS, clipToBox, contact, CROSS, MOVEMENT, nearSegment, SIGHT, SIGHT_POTENTIAL } from "./segments.ts";
import {
  LEDGE,
  RAISED,
  blocksAreas,
  countChunksSplit,
  effectiveEdges,
  PILLAR_TAGS,
  sceneWalls,
  splitCheck,
  tagsOf,
  splitRefusal,
  cellId,
  crossingsAt,
  edgeId,
  deriveWalls,
  floodRoom,
  indexBuild,
  indexPolygon,
  insideCrossings,
  pointInPolygon,
  visibilityPolygon,
  type WallSet,
} from "./walls.ts";

function chunk(cells: string[], edges: Record<string, EdgeFeature> = {}): BuildChunk {
  return { sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges };
}

/** Floor cells for the rectangle [x, x + w) by [y, y + h). */
function rect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("deriveWalls", () => {
  test("a room's boundary is walled and merges into four segments", () => {
    const walls = deriveWalls(indexBuild([chunk(rect(2, 3, 3, 2))]), 1);
    assert.equal(walls.edges.length, 10);
    assert.ok(walls.edges.every((e) => e.auto && e.feature.kind === "wall"));
    assert.equal(walls.blockers.length, 16);
    assert.deepEqual(walls.blockerBounds, { x0: 2, y0: 3, x1: 5, y1: 5 });
  });

  test("edge features override the automatic walls", () => {
    const walls = deriveWalls(
      indexBuild([
        chunk(rect(0, 0, 2, 1), {
          "0,0,n": { kind: "none" },
          "1,0,w": { kind: "wall" },
          "2,0,w": { kind: "door", state: "open", secret: false, discovered: false },
          "0,1,n": { kind: "window" },
        }),
      ]),
      1,
    );
    const at = (k: string) => walls.edges.find((e) => `${e.x},${e.y},${e.side}` === k);
    assert.equal(at("0,0,n"), undefined);
    assert.equal(at("1,0,w")?.feature.kind, "wall");
    assert.equal(at("1,0,w")?.auto, false);
    assert.equal(at("2,0,w")?.feature.kind, "door");
    assert.equal(at("0,1,n")?.feature.kind, "window");
    // The open door leaves the east side open.
    assert.ok(!Array.from({ length: walls.blockers.length / 4 }, (_, i) => walls.blockers.slice(i * 4, i * 4 + 4).join(",")).includes("2,0,2,1"));
  });

  test("walls, windows and closed or locked doors block areas, open doors do not", () => {
    assert.equal(blocksAreas({ kind: "wall" }), true);
    assert.equal(blocksAreas({ kind: "window" }), true);
    assert.equal(blocksAreas({ kind: "none" }), false);
    for (const state of ["closed", "locked"] as const) {
      assert.equal(blocksAreas({ kind: "door", state, secret: true, discovered: false }), true);
    }
    assert.equal(blocksAreas({ kind: "door", state: "open", secret: false, discovered: false }), false);
  });

  test("merged walls never cross, even where two walls pass through each other", () => {
    // A plus sign of walls, plus random maps.
    const plus: Record<string, EdgeFeature> = {};
    for (let i = 0; i < 4; i++) {
      plus[`${i},2,n`] = { kind: "wall" };
      plus[`2,${i},w`] = { kind: "wall" };
    }
    const rand = mulberry32(3);
    const sets = [deriveWalls(indexBuild([chunk([], plus)]), 1), ...Array.from({ length: 30 }, () => randomWalls(rand, 20))];
    for (const walls of sets) {
      const b = walls.blockers;
      for (let i = 0; i < b.length; i += 4) {
        for (let j = i + 4; j < b.length; j += 4) {
          const [ax, ay, bx, by] = [b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!];
          const [cx, cy, dx, dy] = [b[j]!, b[j + 1]!, b[j + 2]!, b[j + 3]!];
          const horizontalA = ay === by;
          const horizontalC = cy === dy;
          if (horizontalA === horizontalC) continue;
          // One horizontal, one vertical: they cross if each passes strictly through the other's interior.
          const [h, v] = horizontalA ? [[ax, bx, ay], [cy, dy, cx]] : [[cx, dx, cy], [ay, by, ax]];
          const crosses = Math.min(h[0]!, h[1]!) < v[2]! && v[2]! < Math.max(h[0]!, h[1]!) && Math.min(v[0]!, v[1]!) < h[2]! && h[2]! < Math.max(v[0]!, v[1]!);
          assert.ok(!crosses, `segments ${[ax, ay, bx, by]} and ${[cx, cy, dx, dy]} cross`);
        }
      }
    }
  });

  test("malformed and out-of-range keys are ignored", () => {
    const bad = ["nope", "1.5,2", "-1,2", "2000,1", ",1", "1,", "1,2,", "1,2,3", " 1,2"];
    const badEdges = ["1,1,q", "1,1,", "1,1,nn", "1,1", "-1,1,n", "1,1,n "];
    const build = indexBuild([
      {
        sceneId: "s",
        cx: 0,
        cy: 0,
        rev: 1,
        cells: { "1,1": "stone", ...Object.fromEntries(bad.map((k) => [k, "stone" as const])) },
        edges: { "3,4,w": { kind: "wall" }, ...Object.fromEntries(badEdges.map((k) => [k, { kind: "wall" as const }])) },
      },
    ]);
    assert.deepEqual([...build.cells.keys()], [cellId(1, 1)]);
    assert.deepEqual([...build.edges.keys()], [edgeId(3, 4, "w")]);
  });

});

/** Whether the open segment from (ox, oy) to (px, py) properly crosses a blocker. */
function blocked(walls: WallSet, ox: number, oy: number, px: number, py: number): boolean {
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const b = walls.blockers;
  for (let i = 0; i < b.length; i += 4) {
    const [ax, ay, bx, by] = [b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!];
    const d1 = orient(ox, oy, px, py, ax, ay);
    const d2 = orient(ox, oy, px, py, bx, by);
    const d3 = orient(ax, ay, bx, by, ox, oy);
    const d4 = orient(ax, ay, bx, by, px, py);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

function randomWalls(rand: () => number, size: number): WallSet {
  const cells: string[] = [];
  for (let r = 0; r < 4; r++) {
    const w = 2 + Math.floor(rand() * 8);
    const h = 2 + Math.floor(rand() * 8);
    cells.push(...rect(Math.floor(rand() * (size - w)), Math.floor(rand() * (size - h)), w, h));
  }
  const edges: Record<string, EdgeFeature> = {};
  for (let e = 0; e < 25; e++) {
    const key = `${Math.floor(rand() * size)},${Math.floor(rand() * size)},${rand() < 0.5 ? "n" : "w"}`;
    const pick = rand();
    edges[key] =
      pick < 0.4
        ? { kind: "wall" }
        : pick < 0.6
          ? { kind: "none" }
          : pick < 0.8
            ? { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false }
            : { kind: "window" };
  }
  return deriveWalls(indexBuild([chunk(cells, edges)]), 1);
}

describe("visibilityPolygon", () => {
  test("an open room sees everything inside it and nothing outside", () => {
    const walls = deriveWalls(indexBuild([chunk(rect(2, 2, 4, 4))]), 1);
    const poly = visibilityPolygon(3.3, 4.1, walls.blockers, { x0: -1, y0: -1, x1: 11, y1: 11 });
    assert.ok(pointInPolygon(poly, 5.9, 5.9));
    assert.ok(pointInPolygon(poly, 2.1, 2.1));
    assert.ok(!pointInPolygon(poly, 6.1, 4));
    assert.ok(!pointInPolygon(poly, 0.5, 0.5));
  });

  test("matches ray casting against every wall on random maps", () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 40; trial++) {
      const walls = randomWalls(rand, 20);
      // Half the trials start on grid intersections, where rays run exactly
      // through wall endpoints and walls pass through the point itself.
      const onGrid = trial % 2 === 1;
      const ox = Math.floor(rand() * 20) + (onGrid ? 0 : 0.13 + rand() * 0.7);
      const oy = Math.floor(rand() * 20) + (onGrid ? 0 : 0.17 + rand() * 0.7);
      const poly = visibilityPolygon(ox, oy, walls.blockers, { x0: -1, y0: -1, x1: 21, y1: 21 });
      for (let k = 0; k < 400; k++) {
        const px = rand() * 21.8 - 0.9;
        const py = rand() * 21.8 - 0.9;
        assert.equal(pointInPolygon(poly, px, py), !blocked(walls, ox, oy, px, py), `trial ${trial} point ${px},${py} from ${ox},${oy}`);
      }
    }
  });

  test("a segment through the point blocks nothing", () => {
    const segs = Float64Array.from([5, 0, 5, 10]);
    const poly = visibilityPolygon(5, 5, segs, { x0: 0, y0: 0, x1: 10, y1: 10 });
    assert.ok(pointInPolygon(poly, 2, 5.5));
    assert.ok(pointInPolygon(poly, 8, 5.5));
  });

  test("row crossings agree with the point test", () => {
    const rand = mulberry32(7);
    const walls = randomWalls(rand, 20);
    const poly = visibilityPolygon(10.3, 9.7, walls.blockers, { x0: -1, y0: -1, x1: 21, y1: 21 });
    const index = indexPolygon(poly, 0, 20);
    for (let k = 0; k < 2000; k++) {
      const x = rand() * 22 - 1;
      const y = rand() * 22 - 1;
      assert.equal(insideCrossings(crossingsAt(index, y), x), pointInPolygon(poly, x, y));
    }
  });
});

describe("floodRoom", () => {
  // Two 3x3 rooms side by side, sharing the edge x = 3, with a door at (3, 1).
  const twoRooms = (door: EdgeFeature) => {
    const edges: Record<string, EdgeFeature> = { "3,0,w": { kind: "wall" }, "3,2,w": { kind: "wall" }, "3,1,w": door };
    return indexBuild([chunk([...rect(0, 0, 3, 3), ...rect(3, 0, 3, 3)], edges)]);
  };

  test("stops at walls and closed doors", () => {
    const build = twoRooms({ kind: "door", state: "closed", secret: false, discovered: false });
    const room = floodRoom(build, { x: 1.5, y: 1.5 });
    assert.equal(room.cells.length, 9);
    assert.ok(room.cells.every((k) => Number(k.split(",")[0]) < 3));
    assert.equal(room.truncated, false);
  });

  test("passes open doors and stops at windows and locked doors", () => {
    assert.equal(floodRoom(twoRooms({ kind: "door", state: "open", secret: false, discovered: false }), { x: 0, y: 0 }).cells.length, 18);
    assert.equal(floodRoom(twoRooms({ kind: "door", state: "locked", secret: false, discovered: false }), { x: 0, y: 0 }).cells.length, 9);
    assert.equal(floodRoom(twoRooms({ kind: "window" }), { x: 0, y: 0 }).cells.length, 9);
    assert.equal(floodRoom(twoRooms({ kind: "none" }), { x: 0, y: 0 }).cells.length, 18);
  });

  test("an empty cell has no room, and the fill stops at the limit", () => {
    const build = twoRooms({ kind: "door", state: "open", secret: false, discovered: false });
    assert.deepEqual(floodRoom(build, { x: 10, y: 10 }), { cells: [], truncated: false });
    const capped = floodRoom(build, { x: 0, y: 0 }, { maxCells: 5 });
    assert.equal(capped.cells.length, 5);
    assert.equal(capped.truncated, true);
    assert.equal(floodRoom(build, { x: 0, y: 0 }, { bounds: { w: 4, h: 3 } }).cells.length, 12);
  });
});

function buildChunk(cells: Record<string, TerrainId>, edges: Record<string, EdgeFeature> = {}, walls?: FreeWall[], at = { cx: 0, cy: 0 }): BuildChunk {
  return { sceneId: "s", cx: at.cx, cy: at.cy, rev: 1, cells, edges, ...(walls ? { walls } : {}) };
}

function free(id: string, ax: number, ay: number, bx: number, by: number, f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  return { id, a: [ax, ay], b: [bx, by], f };
}

const closedDoor: WallFeature = { kind: "door", state: "closed", secret: false, discovered: false };

function storedRows(walls: WallSet): number[][] {
  const s = walls.stored;
  return Array.from({ length: s.n }, (_, k) => [s.xy[4 * k]!, s.xy[4 * k + 1]!, s.xy[4 * k + 2]!, s.xy[4 * k + 3]!, s.tags[k]!, s.free[k]!]);
}

describe("automatic walls", () => {
  // A stone room at (2..4, 2..4) with a pillar on its west edge, stairs east of it and water south of it.
  const cells: Record<string, TerrainId> = {};
  for (const key of rect(2, 2, 3, 3)) cells[key] = "stone";
  cells["2,3"] = "pillar";
  cells["5,3"] = "stairs";
  cells["3,5"] = "water";
  const build = indexBuild([buildChunk(cells)]);
  const autoEdges = (rule: AutoWalls) =>
    new Set(
      effectiveEdges(build, rule)
        .filter((e) => e.auto)
        .map((e) => `${e.x},${e.y},${e.side}`),
    );
  /** Every edge between two cells whose painted kinds the predicate says to wall, by brute force. */
  const expected = (wall: (a: string, b: string) => boolean) => {
    const kind = (x: number, y: number) => {
      const t = cells[`${x},${y}`];
      return t === undefined ? "empty" : ["stone", "wood", "grass", "dirt", "cave"].includes(t) ? "floor" : "overlay";
    };
    const out = new Set<string>();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (wall(kind(x, y), kind(x - 1, y))) out.add(`${x},${y},w`);
        if (wall(kind(x, y), kind(x, y - 1))) out.add(`${x},${y},n`);
      }
    }
    return out;
  };

  test("'all' walls every painted cell from the unpainted ones, a stair corridor, pillar and water channel included", () => {
    const all = autoEdges("all");
    assert.deepEqual(all, expected((a, b) => (a === "empty") !== (b === "empty")));
    for (const edge of ["6,3,w", "5,3,n", "5,4,n", "2,3,w", "3,6,n", "3,5,w", "4,5,w"]) assert.ok(all.has(edge), edge);
    assert.ok(!all.has("5,3,w"), "stone to stairs is open");
  });

  test("'floor' walls only floor from unpainted, so it opens exactly the overlay edges", () => {
    const all = autoEdges("all");
    const floor = autoEdges("floor");
    assert.deepEqual(floor, expected((a, b) => (a === "floor" && b === "empty") || (a === "empty" && b === "floor")));
    const opened = [...all].filter((e) => !floor.has(e)).sort();
    assert.deepEqual(opened, ["2,3,w", "3,5,w", "3,6,n", "4,5,w", "5,3,n", "5,4,n", "6,3,w"]);
    assert.ok([...floor].every((e) => all.has(e)));
  });

  test("'off' makes no automatic walls, and drawn features stay", () => {
    const withDoor = indexBuild([buildChunk(cells, { "3,2,n": closedDoor, "4,2,n": { kind: "none" } })]);
    const edges = effectiveEdges(withDoor, "off");
    assert.deepEqual(
      edges.map((e) => `${e.x},${e.y},${e.side},${e.feature.kind},${e.auto}`),
      ["3,2,n,door,false"],
    );
  });

  test("a scene without the field reads as 'all', and the rule is part of the wall set", () => {
    const chunks = { c: { ...buildChunk(cells), sceneId: "auto-rule" } };
    const old = sceneWalls({ id: "auto-rule", bounds: { w: 10, h: 10 } }, chunks);
    const all = sceneWalls({ id: "auto-rule", bounds: { w: 10, h: 10 }, autoWalls: "all" }, chunks);
    const floor = sceneWalls({ id: "auto-rule", bounds: { w: 10, h: 10 }, autoWalls: "floor" }, chunks);
    assert.equal(all, old);
    assert.notEqual(floor, all);
    assert.notEqual(floor.version, all.version);
    assert.ok(floor.edges.length < all.edges.length);
  });
});

describe("free walls and pillars in the wall set", () => {
  test("free walls join the stored segments with what each feature blocks", () => {
    const walls = deriveWalls(
      indexBuild([
        buildChunk({}, {}, [
          free("a", 1, 1, 3.5, 2.25),
          free("b", 1, 5, 2, 5.5, { kind: "door", state: "open", secret: false, discovered: false }),
          free("c", 4, 4, 4.5, 6, { kind: "window" }),
          free("d", 6, 6, 7, 7, { kind: "door", state: "open", secret: true, discovered: false }),
        ]),
      ]),
      1,
    );
    assert.deepEqual(storedRows(walls), [
      [1, 1, 3.5, 2.25, AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL, 1],
      [4, 4, 4.5, 6, AREAS | MOVEMENT, 1],
      [1, 5, 2, 5.5, SIGHT_POTENTIAL, 1],
      [6, 6, 7, 7, MOVEMENT | SIGHT | SIGHT_POTENTIAL, 1],
    ]);
    assert.deepEqual(Array.from(walls.blockers), [1, 1, 3.5, 2.25, 4, 4, 4.5, 6]);
    assert.deepEqual(
      walls.free.map((f) => f.wall.id),
      ["a", "c", "b", "d"],
    );
  });

  test("bad free walls are dropped instead of trusted", () => {
    const bad = [
      free("off-lattice", 1, 1, 2.3, 1),
      free("no-length", 1, 1, 1, 1),
      free("too-long", 0, 0, 8.5, 0),
      free("negative", -1, 0, 1, 0),
      free("far", 1030, 0, 1031, 0),
      { id: "kind", a: [1, 1], b: [2, 2], f: { kind: "none" } } as unknown as FreeWall,
      { id: "shape", a: [1], b: [2, 2], f: { kind: "wall" } } as unknown as FreeWall,
    ];
    const build = indexBuild([buildChunk({}, {}, [...bad, free("ok", 0, 0, 8, 0)])]);
    assert.deepEqual(
      build.free.map((f) => f.wall.id),
      ["ok"],
    );
  });

  test("chunks in any order give the same stored segments", () => {
    const a = buildChunk({ "1,1": "stone", "2,2": "pillar" }, { "3,3,n": closedDoor }, [free("x", 1, 1, 5, 4), free("y", 2, 0, 2, 6)]);
    const b = buildChunk({ "17,1": "stone" }, {}, [free("z", 15, 1, 18, 3)], { cx: 1, cy: 0 });
    assert.deepEqual(storedRows(deriveWalls(indexBuild([a, b]), 1)), storedRows(deriveWalls(indexBuild([b, a]), 1)));
  });

  test("a pillar is a square inset 9/64 that blocks movement and sight but not areas", () => {
    const walls = deriveWalls(indexBuild([buildChunk({ "3,4": "pillar" })]), 1);
    const pillar = storedRows(walls).filter((r) => r[4] === PILLAR_TAGS);
    const lo = 9 / 64;
    const hi = 55 / 64;
    assert.deepEqual(pillar, [
      [3 + lo, 4 + lo, 3 + hi, 4 + lo, PILLAR_TAGS, 0],
      [3 + hi, 4 + lo, 3 + hi, 4 + hi, PILLAR_TAGS, 0],
      [3 + hi, 4 + hi, 3 + lo, 4 + hi, PILLAR_TAGS, 0],
      [3 + lo, 4 + hi, 3 + lo, 4 + lo, PILLAR_TAGS, 0],
    ]);
    assert.ok(!(PILLAR_TAGS & AREAS));
    // The pillar's cell gets the automatic walls around it. Its square adds nothing for areas.
    assert.equal(walls.blockers.length, 16);
  });

  test("what each feature blocks, a secret door not yet found as players see it", () => {
    const door = (state: "open" | "closed" | "locked", secret: boolean, discovered: boolean) => tagsOf({ kind: "door", state, secret, discovered });
    assert.equal(tagsOf({ kind: "wall" }), AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL);
    assert.equal(tagsOf({ kind: "window" }), AREAS | MOVEMENT);
    assert.equal(door("open", false, false), SIGHT_POTENTIAL);
    assert.equal(door("closed", false, false), AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL);
    assert.equal(door("locked", false, false), AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL);
    assert.equal(door("open", true, false), MOVEMENT | SIGHT | SIGHT_POTENTIAL);
    assert.equal(door("open", true, true), SIGHT_POTENTIAL);
    assert.equal(door("closed", true, false), AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL);
  });

  test("doors and windows stay single edges, so a door's state never changes the segments", () => {
    const row = (state: "open" | "closed") =>
      storedRows(deriveWalls(indexBuild([buildChunk({}, { "0,0,n": { kind: "wall" }, "1,0,n": { ...closedDoor, state }, "2,0,n": { kind: "wall" }, "3,0,n": { kind: "wall" } })]), 1)).map((r) => r.slice(0, 4));
    assert.deepEqual(row("open"), row("closed"));
    assert.deepEqual(row("open"), [
      [0, 0, 1, 0],
      [1, 0, 2, 0],
      [2, 0, 4, 0],
    ]);
  });
});

describe("the wall set caches", () => {
  const scene = (over: Partial<Pick<Scene, "autoWalls" | "bounds">> = {}) => ({ id: "cache-test", bounds: { w: 20, h: 20 }, ...over });
  const a = { ...buildChunk({ "1,1": "stone" }, {}, [free("a", 1, 1, 3, 3)]), sceneId: "cache-test" };
  const other = { ...buildChunk({ "1,1": "stone" }), sceneId: "elsewhere" };

  test("the same chunk objects give the same set, whatever collection holds them", () => {
    const first = sceneWalls(scene(), { a, other });
    assert.equal(sceneWalls(scene(), { a, other }), first);
    assert.equal(sceneWalls(scene(), { other, a, more: { ...other, cx: 1 } }), first);
  });

  test("a replaced chunk, a rule or a size gives a new set with a new version", () => {
    const first = sceneWalls(scene(), { a });
    const replaced = sceneWalls(scene(), { a: { ...a } });
    assert.notEqual(replaced, first);
    assert.notEqual(replaced.version, first.version);
    const floor = sceneWalls(scene({ autoWalls: "floor" }), { a });
    assert.notEqual(floor.version, first.version);
    const smaller = sceneWalls(scene({ bounds: { w: 10, h: 20 } }), { a });
    assert.notEqual(smaller.version, first.version);
    assert.deepEqual(smaller.bounds, { w: 10, h: 20 });
  });

  test("a committed and a staged state alternate without deriving again", () => {
    const committed = { a };
    const staged = { a: { ...a, walls: [free("a", 1, 1, 3, 3), free("b", 1, 3, 3, 1)] } };
    const c1 = sceneWalls(scene(), committed);
    const s1 = sceneWalls(scene(), staged);
    assert.equal(sceneWalls(scene(), committed), c1);
    assert.equal(sceneWalls(scene(), staged), s1);
  });

  test("a staged state the size guard refused never feeds the next one, though its walls version is reused", () => {
    const committed = { a };
    const refused = { a: { ...a, walls: [free("r", 0, 5, 5, 5)] } };
    const next = { a: { ...a, walls: [free("n", 5, 0, 5, 5)] } };
    sceneWalls(scene(), committed);
    const r = sceneWalls(scene(), refused);
    const n = sceneWalls(scene(), next);
    assert.notEqual(n, r);
    assert.deepEqual(n.free.map((f) => f.wall.id), ["n"]);
    const blockers = new Set(Array.from({ length: n.blockers.length / 4 }, (_, k) => Array.from(n.blockers.subarray(4 * k, 4 * k + 4)).join(",")));
    assert.ok(blockers.has("5,0,5,5") && !blockers.has("0,5,5,5"));
  });
});

describe("the split's caps", () => {
  /** A dense pile: 300 crossing walls in one cell. */
  const pile = (id: string) => Array.from({ length: 300 }, (_, k) => free(`${id}${k}`, 10 + (k % 64) / 64, 10, 10 + ((k * 7) % 64) / 64, 11));
  const room = (walls: FreeWall[], sceneId = "caps") => ({
    scenes: { [sceneId]: { id: sceneId, bounds: { w: 30, h: 30 }, autoWalls: "off" } as Scene },
    buildChunks: { c: { ...buildChunk({}, {}, walls), sceneId } },
  });

  test("a scene over a cap is refused with quota before any piece is built", () => {
    assert.deepEqual(splitCheck(room(pile("p")), "caps"), { ok: false, code: "quota", message: splitRefusal("pieces") });
    assert.equal(countChunksSplit([buildChunk({}, {}, pile("p"))], "off").over, "pieces");
  });

  test("a scene within the caps, one without free walls, and a missing scene pass", () => {
    assert.deepEqual(splitCheck(room(pile("p").slice(0, 20)), "caps"), { ok: true });
    assert.deepEqual(splitCheck(room([]), "caps"), { ok: true });
    assert.deepEqual(splitCheck(room([]), "missing"), { ok: true });
  });

  test("a set over the caps, as a refused staged state holds it, splits without its free walls", () => {
    const state = room(pile("q"), "caps-pieces");
    const walls = sceneWalls(state.scenes["caps-pieces"]!, state.buildChunks);
    assert.equal(walls.count.over, "pieces");
    assert.equal(walls.pieces.n, 0);
  });
});

describe("areas behind crossing free walls", () => {
  // A room of four free walls that overshoot each other at the corners, crossing off the lattice.
  const roomWalls = [free("n", 1.5, 2, 9, 2.5), free("s", 1.5, 8, 9, 7.5), free("w", 2, 1.5, 2.5, 9), free("e", 8, 1.5, 7.5, 9)];
  const walls = deriveWalls(indexBuild([buildChunk({}, {}, roomWalls)]), 1, { rule: "off", bounds: { w: 12, h: 12 } });
  const context = (w: WallSet | null): AreaContext => ({ settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell" }, bounds: { w: 12, h: 12 }, walls: w });
  const fireball: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 30, origin: { x: 5, y: 5, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("sphere") };
  const token = (id: string, x: number, y: number): AreaToken => ({ id, rev: 1, size: "medium", x, y, elevation: 0 });

  test("the crossings split the walls, and the area stays inside the room", () => {
    assert.equal(walls.count.pieces, 8);
    assert.equal(walls.pieces.n, 12);
    const inside = [token("in1", 3, 3), token("in2", 6, 6)];
    const outside = [token("north", 5, 0), token("west", 0, 5), token("east", 9, 4)];
    assert.deepEqual(creaturesInArea(fireball, [...inside, ...outside], context(null)).sort(), ["east", "in1", "in2", "north", "west"]);
    assert.deepEqual(creaturesInArea(fireball, [...inside, ...outside], context(walls)).sort(), ["in1", "in2"]);
    const cells = computeCoverage(fireball, context(walls)).cells;
    assert.ok(cells.length > 0);
    for (const c of cells) assert.ok(c.x >= 1 && c.x <= 8 && c.y >= 1 && c.y <= 8, `${c.x},${c.y} is outside the room`);
  });
});

describe("the split set against an independent ray cast", () => {
  function randomBuild(rand: () => number, size: number): BuildChunk {
    const cells: Record<string, TerrainId> = {};
    for (let r = 0; r < 3; r++) {
      const w = 2 + Math.floor(rand() * 5);
      const h = 2 + Math.floor(rand() * 5);
      for (const key of rect(Math.floor(rand() * (size - w)), Math.floor(rand() * (size - h)), w, h)) cells[key] = rand() < 0.1 ? "pillar" : rand() < 0.1 ? "water" : "stone";
    }
    const edges: Record<string, EdgeFeature> = {};
    for (let e = 0; e < 10; e++) {
      const pick = rand();
      edges[`${Math.floor(rand() * size)},${Math.floor(rand() * size)},${rand() < 0.5 ? "n" : "w"}`] =
        pick < 0.4 ? { kind: "wall" } : pick < 0.6 ? { kind: "window" } : { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: rand() < 0.3, discovered: false };
    }
    const walls: FreeWall[] = [];
    while (walls.length < 14) {
      const step = rand() < 0.5 ? 1 / 8 : 1 / 64;
      const q = (max: number) => Math.floor(rand() * (max / step + 1)) * step;
      const ax = q(size);
      const ay = q(size);
      const bx = Math.min(size, Math.max(0, ax + q(8) - 4));
      const by = Math.min(size, Math.max(0, ay + q(8) - 4));
      if ((ax === bx && ay === by) || (bx - ax) ** 2 + (by - ay) ** 2 > 64) continue;
      const f = rand();
      walls.push(free(`w${walls.length}`, ax, ay, bx, by, f < 0.6 ? { kind: "wall" } : f < 0.8 ? { kind: "window" } : closedDoor));
    }
    // One free wall along a grid line, over whatever is there.
    walls.push(free("on-grid", 0, 3, 5, 3));
    return buildChunk(cells, edges, walls);
  }

  function rows(xy: Float64Array): [number, number, number, number][] {
    return Array.from({ length: xy.length / 4 }, (_, k) => [xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!]);
  }

  test("visibility over the split pieces matches a ray cast against the unsplit walls, for whole-scene, culled and light boxes", () => {
    const rand = mulberry32(42);
    const size = 12;
    let checked = 0;
    for (let trial = 0; trial < 30; trial++) {
      const rule = (["all", "floor", "off"] as const)[trial % 3];
      const walls = deriveWalls(indexBuild([randomBuild(rand, size)]), trial, { rule, bounds: { w: size, h: size } });
      for (const mask of [AREAS, SIGHT, MOVEMENT]) {
        const stored = rows(walls.stored.xy).filter((_, k) => walls.stored.tags[k]! & mask);
        const pieces = walls.segmentsWith(mask);
        let ox = 0;
        let oy = 0;
        do {
          ox = 0.5 + rand() * (size - 1);
          oy = 0.5 + rand() * (size - 1);
        } while (stored.some((s) => nearSegment(ox, oy, ...s, 1e-3)));
        const lx0 = Math.floor((ox - 1 - rand() * 4) * 64) / 64;
        const ly0 = Math.floor((oy - 1 - rand() * 4) * 64) / 64;
        const reach = 1.3 + rand() * 3;
        const boxes = [
          { name: "whole", box: { x0: -1, y0: -1, x1: size + 1, y1: size + 1 }, clip: false },
          { name: "culled", box: { x0: lx0, y0: ly0, x1: Math.ceil((ox + 1 + rand() * 4) * 64) / 64, y1: Math.ceil((oy + 1 + rand() * 4) * 64) / 64 }, clip: true },
          { name: "light", box: { x0: ox - reach, y0: oy - reach, x1: ox + reach, y1: oy + reach }, clip: true },
        ];
        for (const { name, box, clip } of boxes) {
          const poly = visibilityPolygon(ox, oy, clip ? clipToBox(pieces, box) : pieces, box);
          for (let sample = 0; sample < 250; sample++) {
            const px = (Math.floor(rand() * size * 4) + 0.5) / 4;
            const py = (Math.floor(rand() * size * 4) + 0.5) / 4;
            if (px <= box.x0 + 1e-6 || px >= box.x1 - 1e-6 || py <= box.y0 + 1e-6 || py >= box.y1 - 1e-6) continue;
            // Points on a wall, and rays that graze a wall's end, have no single answer.
            if (stored.some((s) => nearSegment(px, py, ...s, 1e-6))) continue;
            if (stored.some((s) => nearSegment(s[0], s[1], ox, oy, px, py, 1e-7) || nearSegment(s[2], s[3], ox, oy, px, py, 1e-7))) continue;
            const blocked = stored.some((s) => contact(ox, oy, px, py, ...s) === CROSS);
            checked++;
            assert.equal(pointInPolygon(poly, px, py), !blocked, `trial ${trial} mask ${mask} ${name}: ${px},${py} from ${ox},${oy}`);
          }
        }
      }
    }
    assert.ok(checked > 10_000);
  });
});

/** A chunk of scene "s" with terrain, heights and stair marks per cell "x,y". */
function reliefChunk(spec: { cells?: Record<string, TerrainId>; edges?: Record<string, EdgeFeature>; walls?: FreeWall[]; heights?: Record<string, number>; marks?: Record<string, StairMark> }, at = { cx: 0, cy: 0 }): BuildChunk {
  const feet = new Array<number>(256).fill(0);
  const up = new Array<string>(256).fill(".");
  const index = (key: string) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    return (y - at.cy * 16) * 16 + (x - at.cx * 16);
  };
  for (const [key, v] of Object.entries(spec.heights ?? {})) feet[index(key)] = v;
  for (const [key, m] of Object.entries(spec.marks ?? {})) up[index(key)] = m;
  const heights = encodeHeights(feet);
  const marks = up.join("");
  return {
    ...buildChunk(spec.cells ?? {}, spec.edges ?? {}, spec.walls, at),
    ...(heights ? { heights } : {}),
    ...(marks !== ".".repeat(256) ? { up: marks } : {}),
  };
}

/** Cells of a rectangle, each at `feet`. */
function raise(x: number, y: number, w: number, h: number, feet: number): Record<string, number> {
  return Object.fromEntries(rect(x, y, w, h).map((k) => [k, feet]));
}

function storedWith(walls: WallSet, mask: number): [number, number, number, number, number, number][] {
  return storedRows(walls)
    .map((r, k) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, walls.storedTops[k]!] as [number, number, number, number, number, number])
    .filter((r) => r[4] & mask);
}

describe("raised edges (section 4.2)", () => {
  test("a platform's edges are ledges with its height as their top, merged into runs, and never block areas", () => {
    const walls = deriveWalls(indexBuild([reliefChunk({ heights: raise(2, 2, 3, 2, 10) })]), 1, { bounds: { w: 10, h: 10 } });
    assert.deepEqual(storedWith(walls, RAISED), [
      [2, 2, 5, 2, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
      [2, 4, 5, 4, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
      [2, 2, 2, 4, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
      [5, 2, 5, 4, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
    ]);
    assert.equal(walls.blockers.length, 0);
    assert.equal(walls.groundAt(3, 3), 10);
    assert.equal(walls.groundAt(6, 3), 0);
    assert.equal(walls.rangeGround({ x0: 4, y0: 3, x1: 6, y1: 5 }), 10);
  });

  test("the top is the higher ground, and edges between different heights and tops do not merge", () => {
    const walls = deriveWalls(indexBuild([reliefChunk({ heights: { "2,2": 5, "3,2": 10, "4,2": -10 } })]), 1, { bounds: { w: 10, h: 10 } });
    const north = storedWith(walls, RAISED).filter((r) => r[1] === 2 && r[3] === 2);
    assert.deepEqual(
      north.map((r) => [r[0], r[2], r[5]]),
      [
        [2, 3, 5],
        [3, 4, 10],
        [4, 5, 0],
      ],
    );
    const between = storedWith(walls, RAISED).filter((r) => r[0] === 4 && r[2] === 4);
    assert.deepEqual(between.map((r) => r[5]), [10]);
  });

  test("a directed stair connects the edges on its up and down sides, which then block only sight", () => {
    // A platform on row 2 to 3, a stair at (3, 4) below it pointing up north by the rule, and a second stair below that.
    // Drawn over a map image, so no automatic walls (under "all" the stairs would be walled toward unpainted cells).
    const walls = deriveWalls(indexBuild([reliefChunk({ heights: raise(2, 2, 3, 2, 10), marks: { "3,4": "a", "3,5": "a" } })]), 1, { rule: "floor", bounds: { w: 10, h: 10 } });
    assert.equal(walls.stairAt(3, 4), "n");
    assert.equal(walls.stairAt(3, 5), "n");
    assert.equal(walls.stairAt(2, 4), undefined);
    const south = storedWith(walls, RAISED).filter((r) => r[1] === 4 && r[3] === 4);
    assert.deepEqual(south, [
      [2, 4, 3, 4, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
      [3, 4, 4, 4, RAISED | SIGHT_POTENTIAL, 10],
      [4, 4, 5, 4, RAISED | LEDGE | SIGHT_POTENTIAL, 10],
    ]);
  });

  test("a stair's side edges and every edge of a stair with no direction stay ledges", () => {
    // A stair at (3, 4) raised to 5 beside ground at 0, with no higher neighbor: it has no direction.
    const walls = deriveWalls(indexBuild([reliefChunk({ heights: { "3,4": 5 }, marks: { "3,4": "a" } })]), 1, { rule: "off", bounds: { w: 10, h: 10 } });
    assert.equal(walls.stairAt(3, 4), null);
    assert.ok(storedWith(walls, RAISED).every((r) => r[4] & LEDGE));
    // Pointing east by hand: its west and east edges connect, its north and south ones do not.
    const east = deriveWalls(indexBuild([reliefChunk({ heights: { "3,4": 5 }, marks: { "3,4": "e" } })]), 1, { rule: "off", bounds: { w: 10, h: 10 } });
    const rows = storedWith(east, RAISED);
    assert.deepEqual(
      rows.filter((r) => !(r[4] & LEDGE)).map((r) => r.slice(0, 4)),
      [
        [3, 4, 3, 5],
        [4, 4, 4, 5],
      ],
    );
    assert.equal(rows.filter((r) => r[4] & LEDGE).length, 2);
  });

  test("a raised edge under a wall adds nothing, and one under a door or window joins it", () => {
    const edges: Record<string, EdgeFeature> = { "2,2,n": { kind: "wall" }, "3,2,n": { ...closedDoor, state: "open" }, "4,2,n": { kind: "window" } };
    const walls = deriveWalls(indexBuild([reliefChunk({ edges, heights: raise(2, 2, 3, 1, 10) })]), 1, { rule: "off", bounds: { w: 10, h: 10 } });
    const north = storedRows(walls).filter((r) => r[1] === 2 && r[3] === 2);
    assert.deepEqual(north, [
      [2, 2, 3, 2, AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL, 0],
      [3, 2, 4, 2, SIGHT_POTENTIAL | RAISED | LEDGE, 0],
      [4, 2, 5, 2, AREAS | MOVEMENT | RAISED | LEDGE | SIGHT_POTENTIAL, 0],
    ]);
    assert.deepEqual(walls.featureAt(storedRows(walls).findIndex((r) => r[0] === 3 && r[1] === 2 && r[3] === 2))?.ref, { edge: "3,2,n" });
    assert.equal(walls.featureAt(storedRows(walls).findIndex((r) => r[0] === 2 && r[1] === 2 && r[3] === 2)), null);
  });

  test("a cell outside the scene raises nothing, and without bounds every cell counts", () => {
    const chunkWithStale = reliefChunk({ heights: { "9,3": 10, "12,3": 10 } });
    const inScene = deriveWalls(indexBuild([chunkWithStale]), 1, { bounds: { w: 10, h: 10 } });
    assert.ok(storedWith(inScene, RAISED).every((r) => r[0] <= 10 && r[2] <= 10));
    // (9, 3) has three edges inside the scene, and its east edge lies on the border.
    assert.equal(storedWith(inScene, RAISED).length, 3);
    assert.equal(storedWith(deriveWalls(indexBuild([chunkWithStale]), 1), RAISED).length, 8);
  });

  test("raised runs crossing each other at grid points are cut, so no stored grid segments cross", () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 40; trial++) {
      const heights: Record<string, number> = {};
      for (let k = 0; k < 40; k++) heights[`${Math.floor(rand() * 12)},${Math.floor(rand() * 12)}`] = [5, 10, -5][Math.floor(rand() * 3)]!;
      const marks: Record<string, StairMark> = {};
      for (let k = 0; k < 6; k++) marks[`${Math.floor(rand() * 12)},${Math.floor(rand() * 12)}`] = (["a", "n", "e"] as const)[Math.floor(rand() * 3)]!;
      const cells: Record<string, TerrainId> = {};
      for (const key of rect(3, 3, 5, 5)) cells[key] = "stone";
      const walls = deriveWalls(indexBuild([reliefChunk({ cells, heights, marks })]), trial, { bounds: { w: 12, h: 12 } });
      const s = storedRows(walls);
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) assert.notEqual(contact(...(s[i]!.slice(0, 4) as [number, number, number, number]), ...(s[j]!.slice(0, 4) as [number, number, number, number])), CROSS, `trial ${trial}: ${s[i]} ${s[j]}`);
      // Every raised edge appears once: either as its own run or under the door, window or wall on it.
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
          const g = (cx: number, cy: number) => heights[`${cx},${cy}`] ?? 0;
          if (y > 0 && g(x, y) !== g(x, y - 1)) assert.ok(s.some((r) => r[1] === y && r[3] === y && Math.min(r[0]!, r[2]!) <= x && Math.max(r[0]!, r[2]!) >= x + 1 && (r[4]! & (RAISED | SIGHT))), `${x},${y},n`);
        }
      }
    }
  });

  test("a free wall crossing a raised run splits it, and both pieces keep its top", () => {
    const walls = deriveWalls(indexBuild([reliefChunk({ heights: raise(2, 2, 4, 2, 10), walls: [free("x", 3.5, 1, 3.5, 3)] })]), 1, { rule: "off", bounds: { w: 10, h: 10 } });
    const below5 = walls.sight(5).pieces;
    const rows = Array.from({ length: below5.length / 4 }, (_, k) => Array.from(below5.subarray(4 * k, 4 * k + 4)));
    assert.ok(rows.some((r) => r.join() === "2,2,3.5,2"));
    assert.ok(rows.some((r) => r.join() === "3.5,2,6,2"));
    // At 10 ft and above the eye sees over the platform's edges, and only the free wall's two pieces remain.
    assert.equal(walls.sight(10).pieces.length / 4, 2);
    assert.equal(walls.sight(25).pieces.length / 4, 2);
  });
});

describe("sight from an eye at a height (sections 4.2, 4.3.2)", () => {
  // A 5 ft ledge and a 10 ft platform, a wall, an open door and a window.
  const walls = deriveWalls(
    indexBuild([
      reliefChunk({
        heights: { ...raise(1, 1, 2, 2, 5), ...raise(6, 1, 2, 2, 10) },
        edges: { "1,6,n": { kind: "wall" }, "2,6,n": { ...closedDoor, state: "open" }, "3,6,n": { kind: "window" } },
      }),
    ]),
    1,
    { rule: "off", bounds: { w: 10, h: 10 } },
  );
  const tops = (eye: number) => {
    const p = walls.sight(eye).pieces;
    return Array.from({ length: p.length / 4 }, (_, k) => Array.from(p.subarray(4 * k, 4 * k + 4)).join());
  };

  test("a Medium creature on the ground sees over a 5 ft ledge but not onto a 10 ft platform", () => {
    const at5 = tops(5);
    assert.ok(!at5.some((r) => r === "1,1,3,1"), "the 5 ft ledge is below the eye");
    assert.ok(at5.includes("6,1,8,1"));
    assert.ok(at5.includes("1,6,2,6"), "the wall");
    assert.ok(!at5.includes("2,6,3,6") && !at5.includes("3,6,4,6"), "an open door and a window let sight through");
  });

  test("an eye below every top sees no raised edge as open, and one above them all sees past every one", () => {
    assert.ok(tops(4).includes("1,1,3,1"));
    assert.deepEqual(tops(10), ["1,6,2,6"]);
    assert.deepEqual(tops(200), ["1,6,2,6"]);
    // A creature inside the ground (below 0) is blocked by every raised edge, though it lends no sight anyway.
    assert.ok(tops(-20).length > 8);
  });

  test("eyes between the same two tops share one set", () => {
    assert.equal(walls.sight(5), walls.sight(9.5));
    assert.notEqual(walls.sight(4.9), walls.sight(5));
  });

  test("the stored segments for the step off a wall are those same blockers, all tagged SIGHT", () => {
    const set = walls.sight(5);
    assert.ok(set.stored.tags.every((t) => t === SIGHT));
    assert.equal(set.stored.xy.length, set.pieces.length);
  });

  test("every raised edge counts toward the sight cap, whatever its height", () => {
    assert.equal(walls.sightPotential, 8 + 3 - 1);
  });
});

describe("stair marks as Stairs cells (section 2.1)", () => {
  // A stone room (2..4, 2..4), a stair mark east of it on no terrain, and a stair mark over its own stone at (4, 3).
  const spec = { cells: Object.fromEntries(rect(2, 2, 3, 3).map((k) => [k, "stone" as const])), marks: { "5,3": "a" as const, "4,3": "e" as const } };
  const autoEdges = (rule: AutoWalls) =>
    new Set(
      deriveWalls(indexBuild([reliefChunk(spec)]), 1, { rule })
        .edges.filter((e) => e.auto)
        .map((e) => `${e.x},${e.y},${e.side}`),
    );

  test("under 'all' a marked cell is painted, so it gets walls toward unpainted cells", () => {
    const all = autoEdges("all");
    for (const e of ["6,3,w", "5,3,n", "5,4,n"]) assert.ok(all.has(e), e);
    assert.ok(!all.has("5,3,w"));
  });

  test("under 'floor' a marked cell is an overlay, so a stair drawn over the art is not walled in", () => {
    const floor = autoEdges("floor");
    for (const e of ["6,3,w", "5,3,n", "5,4,n", "5,3,w"]) assert.ok(!floor.has(e), e);
    // The stone cell with a mark is a Stairs cell too, so its edges toward nothing open.
    assert.ok(!floor.has("4,3,w"));
    assert.ok(floor.has("2,3,w"));
  });

  test("the shared predicate gives the same answer as the walls, across a chunk border", () => {
    const left = reliefChunk({ cells: { "15,4": "stone" } });
    const right = reliefChunk({ marks: { "16,4": "a" } }, { cx: 1, cy: 0 });
    const chunks = { "s:0,0": left, "s:1,0": right };
    assert.equal(paintedAt(chunks, "s", 16, 4), "overlay");
    assert.equal(paintedAt(chunks, "s", 15, 4), "floor");
    assert.equal(paintedAt(chunks, "s", 17, 4), "empty");
    assert.equal(paintedAt(chunks, "s", -1, 4), "empty");
    for (const rule of ["all", "floor", "off"] as const) {
      const edges = new Set(deriveWalls(indexBuild([left, right]), 1, { rule }).edges.filter((e) => e.auto).map((e) => `${e.x},${e.y},${e.side}`));
      for (const [x, y] of [
        [16, 4],
        [17, 4],
      ] as const) {
        assert.equal(edges.has(`${x},${y},w`), autoWallBetween(rule, paintedAt(chunks, "s", x, y), paintedAt(chunks, "s", x - 1, y)), `${rule} ${x},${y},w`);
      }
    }
  });
});

describe("sight sets with raised edges against an independent ray cast", () => {
  test("visibility over the pieces for an eye matches a ray cast against the unsplit walls and the raised edges above it", () => {
    const rand = mulberry32(99);
    const size = 12;
    let checked = 0;
    for (let trial = 0; trial < 24; trial++) {
      const heights: Record<string, number> = {};
      for (let r = 0; r < 3; r++) {
        const x = Math.floor(rand() * (size - 3));
        const y = Math.floor(rand() * (size - 3));
        Object.assign(heights, raise(x, y, 1 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 3), [5, 10, 20, -10][Math.floor(rand() * 4)]!));
      }
      const marks: Record<string, StairMark> = {};
      for (let k = 0; k < 4; k++) marks[`${Math.floor(rand() * size)},${Math.floor(rand() * size)}`] = "a";
      const cells: Record<string, TerrainId> = {};
      for (const key of rect(Math.floor(rand() * 6), Math.floor(rand() * 6), 4, 4)) cells[key] = rand() < 0.15 ? "pillar" : "stone";
      const walls: FreeWall[] = [];
      while (walls.length < 10) {
        const q = (max: number) => Math.floor(rand() * (max * 8 + 1)) / 8;
        const ax = q(size);
        const ay = q(size);
        const bx = Math.min(size, Math.max(0, ax + q(8) - 4));
        const by = Math.min(size, Math.max(0, ay + q(8) - 4));
        if ((ax === bx && ay === by) || (bx - ax) ** 2 + (by - ay) ** 2 > 64) continue;
        walls.push(free(`w${walls.length}`, ax, ay, bx, by, rand() < 0.7 ? { kind: "wall" } : { kind: "window" }));
      }
      // A free wall along a grid line, over a raised edge or not.
      walls.push(free("on-grid", 0, 4, 6, 4));
      const set = deriveWalls(indexBuild([reliefChunk({ cells, heights, marks, walls })]), trial, { rule: (["all", "floor", "off"] as const)[trial % 3], bounds: { w: size, h: size } });
      for (const eye of [-15, 0, 5, 10, 15, 25]) {
        const stored: [number, number, number, number][] = [];
        for (let k = 0; k < set.stored.n; k++) {
          const t = set.stored.tags[k]!;
          if (t & SIGHT || (t & RAISED && set.storedTops[k]! > eye)) stored.push([set.stored.xy[4 * k]!, set.stored.xy[4 * k + 1]!, set.stored.xy[4 * k + 2]!, set.stored.xy[4 * k + 3]!]);
        }
        let ox = 0;
        let oy = 0;
        do {
          ox = 0.5 + rand() * (size - 1);
          oy = 0.5 + rand() * (size - 1);
        } while (stored.some((s) => nearSegment(ox, oy, ...s, 1e-3)));
        const box = { x0: -1, y0: -1, x1: size + 1, y1: size + 1 };
        const poly = visibilityPolygon(ox, oy, set.sight(eye).pieces, box);
        for (let sample = 0; sample < 200; sample++) {
          const px = (Math.floor(rand() * size * 4) + 0.5) / 4;
          const py = (Math.floor(rand() * size * 4) + 0.5) / 4;
          if (stored.some((s) => nearSegment(px, py, ...s, 1e-6))) continue;
          if (stored.some((s) => nearSegment(s[0], s[1], ox, oy, px, py, 1e-7) || nearSegment(s[2], s[3], ox, oy, px, py, 1e-7))) continue;
          const blocked = stored.some((s) => contact(ox, oy, px, py, ...s) === CROSS);
          checked++;
          assert.equal(pointInPolygon(poly, px, py), !blocked, `trial ${trial} eye ${eye}: ${px},${py} from ${ox},${oy}`);
        }
      }
    }
    assert.ok(checked > 20_000, `${checked}`);
  });
});
