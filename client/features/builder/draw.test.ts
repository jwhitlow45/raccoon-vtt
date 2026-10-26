import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, FreeWall, TerrainId } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { buildPaths, drawBuild, freeFrame, type PathSink } from "./draw.ts";

/** Records what a path is given, in place of a Path2D, which Node lacks. */
class Recorder implements PathSink {
  readonly ops: (string | number)[][] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(["M", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(["L", x, y]);
  }
  closePath(): void {
    this.ops.push(["Z"]);
  }
  arc(x: number, y: number, r: number, from: number, to: number, ccw?: boolean): void {
    this.ops.push(["A", x, y, r, from, to, ccw ? 1 : 0]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["R", x, y, w, h]);
  }
  /** The points the path moves or draws to, in order. */
  points(): [number, number][] {
    return this.ops.filter((o) => o[0] === "M" || o[0] === "L").map((o) => [o[1] as number, o[2] as number]);
  }
}

const door = (state: "open" | "closed" | "locked", secret = false, discovered = false) => ({ kind: "door", state, secret, discovered }) as const;

function chunk(opts: { walls?: FreeWall[]; edges?: BuildChunk["edges"]; cells?: Record<string, TerrainId> }): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: opts.cells ?? {}, edges: opts.edges ?? {}, ...(opts.walls ? { walls: opts.walls } : {}) };
}

function paths(c: BuildChunk, role: "dm" | "player" = "player") {
  return buildPaths([c], role, {}, () => new Recorder());
}

function close(a: readonly [number, number][], b: readonly [number, number][]): void {
  assert.equal(a.length, b.length);
  a.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - b[i]![0]) < 1e-9 && Math.abs(p[1] - b[i]![1]) < 1e-9, `${p} should be ${b[i]}`);
  });
}

describe("free walls on the board", () => {
  test("a free wall draws as one stroke from end to end, in the walls' own pass", () => {
    const p = paths(chunk({ walls: [{ id: "aaaaaaaaaaaa", a: [1.5, 2], b: [4, 3.25], f: { kind: "wall" } }] }));
    assert.deepEqual(p.freeWalls.ops, [
      ["M", 1.5, 2],
      ["L", 4, 3.25],
    ]);
    assert.deepEqual(p.walls.ops, []);
    assert.deepEqual(p.leaves.ops, []);
  });

  test("a free door on a grid line draws exactly the edge door's symbol", () => {
    const edge = paths(chunk({ edges: { "2,3,n": door("closed") } }));
    const free = paths(chunk({ walls: [{ id: "bbbbbbbbbbbb", a: [2, 3], b: [3, 3], f: door("closed") }] }));
    close(free.leaves.points(), edge.leaves.points());
    close(free.freeWalls.points(), edge.walls.points());
    // Drawn either way round, the same door.
    const reversed = paths(chunk({ walls: [{ id: "bbbbbbbbbbbb", a: [3, 3], b: [2, 3], f: door("closed") }] }));
    assert.deepEqual(new Set(reversed.leaves.points().map(String)), new Set(edge.leaves.points().map(String)));
  });

  test("the edge symbols keep their place: a closed door's slab and its stubs", () => {
    const p = paths(chunk({ edges: { "3,4,n": door("closed") } }));
    close(p.leaves.points(), [
      [3.15, 3.9],
      [3.85, 3.9],
      [3.85, 4.1],
      [3.15, 4.1],
    ]);
    close(p.walls.points(), [
      [3, 4],
      [3.15, 4],
      [3.85, 4],
      [4, 4],
    ]);
  });

  test("a slanted free door turns its slab to the segment", () => {
    const a: [number, number] = [1, 1];
    const b: [number, number] = [4, 5];
    const p = paths(chunk({ walls: [{ id: "cccccccccccc", a, b, f: door("closed") }] }));
    const pts = p.leaves.points();
    assert.equal(pts.length, 4);
    // Each corner sits 0.1 cell to one side of the door's line, the slab being 0.2 thick.
    const len = 5;
    for (const [x, y] of pts) {
      const across = ((x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])) / len;
      assert.ok(Math.abs(Math.abs(across) - 0.1) < 1e-9, `corner ${x},${y} is ${across} off the line`);
    }
    // The opening is the door less a 0.15 cell stub at each end.
    const along = pts.map(([x, y]) => ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len);
    assert.ok(Math.abs(Math.min(...along) - 0.15) < 1e-9 && Math.abs(Math.max(...along) - 4.85) < 1e-9);
  });

  test("an open free door swings into floor, and to the south or east when both sides are alike", () => {
    const vertical: FreeWall = { id: "dddddddddddd", a: [5, 2], b: [5, 3], f: door("open") };
    const westFloor = paths(chunk({ walls: [vertical], cells: { "4,2": "stone" } }));
    assert.ok(westFloor.openLeaves.points().every(([x]) => x <= 5), "the leaf swings west, into the floor");
    const bothFloor = paths(chunk({ walls: [vertical], cells: { "4,2": "stone", "5,2": "stone" } }));
    assert.ok(bothFloor.openLeaves.points().every(([x]) => x >= 5), "the leaf swings east");
    const noFloor = paths(chunk({ walls: [vertical] }));
    assert.ok(noFloor.openLeaves.points().every(([x]) => x >= 5), "the leaf swings east");
    assert.equal(noFloor.swings.ops.filter((o) => o[0] === "A").length, 1);
    assert.deepEqual(noFloor.leaves.ops, []);
  });

  test("a free window draws its stubs with the free walls and its pane across the opening", () => {
    const p = paths(chunk({ walls: [{ id: "eeeeeeeeeeee", a: [0, 0.5], b: [2, 0.5], f: { kind: "window" } }] }));
    close(p.freeWalls.points(), [
      [0, 0.5],
      [0.15, 0.5],
      [1.85, 0.5],
      [2, 0.5],
    ]);
    close(p.panes.points(), [
      [0.15, 0.44],
      [1.85, 0.44],
      [1.85, 0.56],
      [0.15, 0.56],
    ]);
  });

  test("a free door shorter than a cell keeps stubs in proportion", () => {
    const p = paths(chunk({ walls: [{ id: "ffffffffffff", a: [0, 0], b: [0.5, 0], f: door("closed") }] }));
    close(p.freeWalls.points(), [
      [0, 0],
      [0.075, 0],
      [0.425, 0],
      [0.5, 0],
    ]);
  });

  test("a hidden secret free door is a wall to everyone, and only the DM sees it marked", () => {
    const hidden: FreeWall = { id: "gggggggggggg", a: [1, 1], b: [2.5, 1.5], f: door("closed", true, false) };
    const player = paths(chunk({ walls: [hidden] }), "player");
    assert.deepEqual(player.freeWalls.ops, [
      ["M", 1, 1],
      ["L", 2.5, 1.5],
    ]);
    assert.deepEqual(player.leaves.ops, []);
    const dm = paths(chunk({ walls: [hidden] }), "dm");
    assert.deepEqual(dm.freeWalls.ops, player.freeWalls.ops);
    assert.equal(dm.secrets.points().length, 4);
    close(dm.secretMarks.map((m) => [m.x, m.y]), [[1.75, 1.25]]);
  });

  test("locks and found secret doors are marked for the DM only", () => {
    const locked: FreeWall = { id: "hhhhhhhhhhhh", a: [1, 1], b: [2, 2], f: door("locked") };
    const found: FreeWall = { id: "iiiiiiiiiiii", a: [4, 1], b: [5, 1], f: door("closed", true, true) };
    const dm = paths(chunk({ walls: [locked, found] }), "dm");
    assert.equal(dm.locks.ops.length, 1);
    close(dm.secretMarks.map((m) => [m.x, m.y]), [[4.5, 1]]);
    const player = paths(chunk({ walls: [locked, found] }), "player");
    assert.equal(player.locks.ops.length, 0);
    assert.deepEqual(player.secretMarks, []);
    assert.equal(player.leaves.points().length, 8);
  });

  test("a free wall with no length draws nothing", () => {
    assert.equal(freeFrame({ a: [1, 1], b: [1, 1] }), null);
    const p = paths(chunk({ walls: [{ id: "jjjjjjjjjjjj", a: [1, 1], b: [1, 1], f: door("closed") }] }));
    assert.deepEqual(p.freeWalls.ops, []);
    assert.deepEqual(p.leaves.ops, []);
  });

  test("a wall on the scene's east border draws like any other", () => {
    const p = paths(chunk({ edges: { "16,3,w": { kind: "wall" } } }));
    close(p.walls.points(), [
      [16, 3],
      [16, 4],
    ]);
  });
});

describe("automatic walls on the board", () => {
  const build = chunk({ cells: { "1,1": "stone", "2,1": "water" }, edges: { "5,5,n": { kind: "wall" } } });
  /** The unit edges the walls path covers, as "x,y,n" or "x,y,w". */
  function wallEdges(autoWalls?: "all" | "floor" | "off"): string[] {
    const p = buildPaths([build], "player", { autoWalls }, () => new Recorder()).walls.points();
    const out: string[] = [];
    for (let i = 0; i < p.length; i += 2) {
      const [[ax, ay], [bx, by]] = [p[i]!, p[i + 1]!];
      if (ay === by) for (let x = ax; x < bx; x++) out.push(`${x},${ay},n`);
      else for (let y = ay; y < by; y++) out.push(`${ax},${y},w`);
    }
    return out.sort();
  }

  test("around every painted cell, the rule of scenes from before wave 3, walls the water too", () => {
    const all = ["1,1,n", "1,1,w", "1,2,n", "2,1,n", "2,2,n", "3,1,w", "5,5,n"];
    assert.deepEqual(wallEdges(), all);
    assert.deepEqual(wallEdges("all"), all);
  });

  test("around floor only, the water painted over a map is not walled in", () => {
    assert.deepEqual(wallEdges("floor"), ["1,1,n", "1,1,w", "1,2,n", "5,5,n"]);
  });

  test("off draws only the walls drawn by hand", () => {
    assert.deepEqual(wallEdges("off"), ["5,5,n"]);
  });
});

describe("stairs and heights on the board", () => {
  /** A stair mark per cell over the first chunk's row-major cells. */
  function marks(at: Record<number, string>): string {
    return Array.from({ length: 256 }, (_, k) => at[k] ?? ".").join("");
  }

  test("stairs over floor sit on the slab, and stair marks over the map image draw only their treads", () => {
    // Stairs terrain at 1,1, a mark on stone at 2,1, and a mark with no floor at 3,1, all pointing north.
    const c: BuildChunk = { ...chunk({ cells: { "1,1": "stairs", "2,1": "stone" } }), up: marks({ 17: "n", 18: "n", 19: "n" }) };
    const p = buildPaths([c], "player", { bounds: { w: 8, h: 8 } }, () => new Recorder());
    assert.deepEqual(
      p.stairs.ops.map((o) => o.slice(1, 3)),
      [
        [1.08, 1.08],
        [2.08, 1.08],
      ],
    );
    const lows = (paths: typeof p.floorStairs) => paths.treads[0]!.points().map(([x]) => Math.floor(x));
    assert.deepEqual([...new Set(lows(p.floorStairs))], [1, 2]);
    assert.deepEqual([...new Set(lows(p.artStairs))], [3]);
  });

  test("the scene's size reaches the stairs: ground left past a shrunk scene's border gives a stair no direction", () => {
    // A mark at 3,0 beside ground painted at 10 ft at 4,0, which lies outside a scene 4 cells wide.
    const c: BuildChunk = { ...chunk({}), up: marks({ 3: "a" }), heights: encodeHeights(Array.from({ length: 256 }, (_, k) => (k === 4 ? 10 : 0)))! };
    const wide = buildPaths([c], "player", {}, () => new Recorder());
    assert.equal(wide.artStairs.steps.ops.length, 0, "without bounds it points east");
    const narrow = buildPaths([c], "player", { bounds: { w: 4, h: 4 } }, () => new Recorder());
    assert.equal(narrow.artStairs.steps.points().length, 10, "within the scene: no direction, five lines across");
  });
});

describe("difficult ground (docs/design-v1-movement.md 3.4)", () => {
  test("each marked square is a rect of the hatch's path, inside a box around them all, players' and the DM's alike", () => {
    const c: BuildChunk = { ...chunk({}), rough: "d" + ".".repeat(16) + "d" + ".".repeat(238) };
    for (const role of ["player", "dm"] as const) {
      const p = paths(c, role);
      assert.deepEqual((p.rough as Recorder).ops, [
        ["R", 0, 0, 1, 1],
        ["R", 1, 1, 1, 1],
      ]);
      assert.deepEqual(p.roughBox, { x0: 0, y0: 0, x1: 2, y1: 2 });
    }
    assert.equal(paths(chunk({})).roughBox, null);
  });
});

describe("the isometric view's ground stage (docs/design-v1-isometric-view.md 5.3 and 5.5)", () => {
  /** A stand-in for a 2D context that records which path each fill and stroke draws. */
  function recorder() {
    const calls: { op: string; path: unknown }[] = [];
    const g = new Proxy(
      {},
      {
        get: (_t, name) => (name === "fill" || name === "stroke" || name === "clip" ? (path?: unknown) => calls.push({ op: String(name), path }) : () => undefined),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    return { g, calls, drew: (path: unknown) => calls.some((c) => c.path === path && c.op !== "clip") };
  }

  const build = () => {
    const heights = Array.from({ length: 256 }, (_, i) => (i === 3 * 16 + 3 ? 10 : 0));
    const c = { ...chunk({ cells: { "1,1": "stone", "2,1": "stone", "5,5": "pillar" }, edges: { "1,1,n": { kind: "wall" }, "2,1,n": door("closed"), "1,2,n": door("open"), "2,2,n": { kind: "window" }, "4,4,n": door("locked", true) } }), heights: encodeHeights(heights) };
    return buildPaths([c], "dm", {}, () => new Recorder()) as unknown as Parameters<typeof drawBuild>[1];
  };
  const opts = { role: "dm" as const, scale: 40, grid: { show: false, color: "#fff", opacity: 0.2, lineWidth: 1 } as never, textures: {}, labels: [] };

  test("Top-down draws its walls, doors, windows, pillars and relief as it always has", () => {
    const p = build();
    const r = recorder();
    drawBuild(r.g, p, opts);
    for (const path of [p.walls, p.panes, p.leaves, p.openLeaves, p.pillars, p.secrets]) assert.ok(r.drew(path));
    assert.ok(Object.values(p.relief).some((path) => r.drew(path)), "the relief's tints and shadows");
  });

  test("with heights standing, walls, closed doors, windows, standing pillars and the relief are left to the relief layer, and open doors stay flat", () => {
    const p = build();
    const r = recorder();
    const flatPillars = new Recorder() as unknown as Path2D;
    const flatShine = new Recorder() as unknown as Path2D;
    drawBuild(r.g, p, { ...opts, standing: { pillars: flatPillars, pillarShine: flatShine } });
    for (const path of [p.walls, p.freeWalls, p.panes, p.leaves, p.pillars, p.pillarShine, p.secrets]) assert.ok(!r.drew(path));
    assert.ok(!Object.values(p.relief).some((path) => r.drew(path)), "no relief tint under a column");
    for (const path of [p.openLeaves, p.swings, flatPillars, flatShine, p.locks]) assert.ok(r.drew(path));
    assert.ok(r.calls.some((c) => c.op === "fill" && c.path === p.openLeaves), "an open door's leaf is filled as in Top-down");
  });
});
