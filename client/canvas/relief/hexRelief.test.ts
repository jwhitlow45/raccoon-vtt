import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeHeights } from "#shared/rules/heights.ts";
import { CHUNK_CELLS, type BuildChunk, type FogTile, type FreeWall } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { occupiedHexes, occupiedRange } from "#shared/rules/footprint.ts";
import { type Grid } from "#shared/rules/grid.ts";
import { hexCenter, hexNeighbors, hexSubcells, type HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { cellAtPoint, cellCenter, cellPolygon, footprintCells, polygonSide, type GroundCell } from "../../lib/groundCells.ts";
import { depth, drawnBase, drawnHeights, type Turn } from "../../lib/view.ts";
import { groupWalls, ReliefIndex, type Item, type StandeeIn } from "./buckets.ts";
import { FogView } from "./fogView.ts";
import { cellPieces, facesOf, keyOf, localKeyOf, sortKey, wallItems, type CellPiece, type PieceSource } from "./pieces.ts";
import { wallPieces, type WallPiece } from "./runs.ts";
import { drawRun } from "./drawRelief.ts";
import { CellTints, hexLook, sideLook } from "./looks.ts";
import { standeeShape } from "./standee.ts";
import { splitTokens } from "./stand.ts";
import type { ViewToken } from "../../lib/scene.ts";

/*
 * Raised hexes in the depth list (docs/design-v1-iso-hex-relief.md 6 and
 * 10.3): six-sided cells, center-depth keys, actual footprints, host keys
 * for walls, connected pit regions and the buckets a hex scene rebuilds.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const TURNS: readonly Turn[] = [0, 1, 2, 3];
const EVERYTHING = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };

function source(grid: Grid, ground: Record<string, number>, bounds: { w: number; h: number }): PieceSource {
  return { ground: (x, y) => ground[`${x},${y}`] ?? 0, terrain: () => null, look: () => ({ texture: null, color: "#777" }), bounds, grid };
}

function index(grid: Grid, ground: Record<string, number>, walls: WallPiece[] = [], bounds = { w: 30, h: 30 }): ReliefIndex {
  const relief = new ReliefIndex();
  relief.sync({ sceneId: "s1", bounds, chunks: {}, tiles: null, walls: groupWalls(walls, null, bounds, grid), global: ground, src: source(grid, ground, bounds), grid });
  return relief;
}

function order(items: Item[]): string[] {
  return items.flatMap((i) => (i.kind === "run" ? i.pieces.map((p) => p.id) : [i.id]));
}

/** A standee on hexes: its stored box centered on `anchor`, standing on its actual hexes. */
function hexStandee(grid: HexGrid, id: string, size: "medium" | "large" | "huge" | "gargantuan", anchor: { x: number; y: number }, base: number, turn: Turn, extra: Partial<StandeeIn> = {}): StandeeIn {
  const w = { medium: 1, large: 2, huge: 3, gargantuan: 4 }[size];
  const token = { size, x: anchor.x - w / 2, y: anchor.y - w / 2, elevation: 0 };
  const cells = footprintCells(grid, token);
  const shape = standeeShape(turn, { x: token.x, y: token.y, w, h: w }, base, 0, 40, 800);
  return { id, x: anchor.x, y: anchor.y, cells, base, holder: null, bounds: shape.bounds, art: shape.art, ...extra };
}

describe("hex prisms (5.2)", () => {
  test("every turn, both orientations: exactly three sides face the viewer, a raised hex draws those down to lower neighbors, and equal plateaus have no inner side", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const ground: Record<string, number> = {};
      // A plateau of seven at 2, its middle hex at 3.
      const middle = { col: 6, row: 6 };
      ground["6,6"] = 3;
      for (const n of hexNeighbors(grid, middle)) ground[`${n.col},${n.row}`] = 2;
      const relief = index(grid, ground);
      for (const turn of TURNS) {
        const items = relief.layout(turn, EVERYTHING, []);
        const cells = items.flatMap((i) => (i.kind === "run" ? i.pieces : [])).filter((p): p is CellPiece => p.kind === "column");
        assert.equal(cells.length, 7);
        for (const c of cells) {
          const near = c.sides.filter((s) => depth(turn, s.out.x, s.out.y) > 0).length;
          assert.equal(near, 3, `${grid.orient} turn ${turn}: three sides face the viewer`);
          for (const f of facesOf(c, turn)) {
            const across = c.around[f.side]!;
            assert.ok(across < c.z, "a side stands only toward lower ground");
            assert.equal(f.z0, Math.max(0, across));
            assert.equal(f.z1, c.z);
          }
        }
        const top = cells.find((c) => c.x === 6 && c.y === 6)!;
        // The middle's three near sides fall to its 2 ft neighbors, never to 0.
        assert.deepEqual(
          facesOf(top, turn).map((f) => [f.z0, f.z1]),
          [
            [2, 3],
            [2, 3],
            [2, 3],
          ],
        );
      }
    }
  });

  test("a hex's corners are the canonical ones its neighbors share, and its sides run between corners d + 1 and d + 2", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const relief = index(grid, { "5,5": 1 });
      const c = relief.cellAt(5, 5)!;
      assert.equal(c.poly.length, 6);
      for (let d = 0; d < 6; d++) {
        const n = hexNeighbors(grid, { col: 5, row: 5 })[d]!;
        const side = c.sides[d]!;
        assert.deepEqual([side.a, side.b], [c.poly[(d + 1) % 6], c.poly[(d + 2) % 6]]);
        // The side's middle lies halfway between the two centers.
        const mid = { x: (side.a.x + side.b.x) / 2, y: (side.a.y + side.b.y) / 2 };
        const a = hexCenter(grid, { col: 5, row: 5 });
        const b = hexCenter(grid, n);
        assert.ok(Math.abs(mid.x - (a.x + b.x) / 2) < 0.02 && Math.abs(mid.y - (a.y + b.y) / 2) < 0.02, `${grid.orient} side ${d}`);
      }
    }
  });
});

describe("hex depth keys (6.1, 6.3)", () => {
  test("hex rows (1,0) and (0,1), which an offset sum ties, sort by their centers, and a tall near hex still sorts after a low far one", () => {
    const relief = index(ROWS, { "1,0": 1, "0,1": 1 });
    for (const turn of TURNS) {
      const names = order(relief.layout(turn, EVERYTHING, []));
      const a = sortKey(turn, hexCenter(ROWS, { col: 1, row: 0 }).x, hexCenter(ROWS, { col: 1, row: 0 }).y);
      const b = sortKey(turn, hexCenter(ROWS, { col: 0, row: 1 }).x, hexCenter(ROWS, { col: 0, row: 1 }).y);
      assert.notEqual(a, b);
      assert.deepEqual(names, a < b ? ["c1,0", "c0,1"] : ["c0,1", "c1,0"], `turn ${turn}`);
    }
    // Height is never in the key: a very tall near hex sorts after a low far one.
    const tall = index(ROWS, { "4,4": 1, "4,5": 40 });
    for (const turn of TURNS) {
      const names = order(tall.layout(turn, EVERYTHING, []));
      const far = depth(turn, hexCenter(ROWS, { col: 4, row: 4 }).x, hexCenter(ROWS, { col: 4, row: 4 }).y) < depth(turn, hexCenter(ROWS, { col: 4, row: 5 }).x, hexCenter(ROWS, { col: 4, row: 5 }).y);
      assert.deepEqual(names, far ? ["c4,4", "c4,5"] : ["c4,5", "c4,4"], `turn ${turn}`);
    }
  });

  test("a Large on three platform hexes of mixed heights draws after every hex it stands on, never one outside its triangle", () => {
    for (const grid of [ROWS, COLUMNS]) {
      for (const turn of TURNS) {
        const anchor = { x: 8, y: 8 };
        const token = { size: "large" as const, x: anchor.x - 1, y: anchor.y - 1, elevation: 0 };
        const own = occupiedHexes(grid, token);
        assert.equal(own.length, 3);
        const ground: Record<string, number> = {};
        own.forEach((h, i) => (ground[`${h.col},${h.row}`] = 1 + (i % 2)));
        // A 10 ft hex inside the Large's box but outside its three: its rectangle reaches it, its footprint does not.
        const r = occupiedRange(grid, token);
        let outside: GroundCell | null = null;
        for (let y = r.y0 - 1; y <= r.y1 && !outside; y++) {
          for (let x = r.x0 - 1; x <= r.x1 && !outside; x++) {
            const c = cellAtPoint(grid, { x: x + 0.5, y: y + 0.5 });
            if (!own.some((h) => h.col === c.col && h.row === c.row) && Math.abs(cellCenter(grid, c).x - anchor.x) < 1.4 && Math.abs(cellCenter(grid, c).y - anchor.y) < 1.4) outside = c;
          }
        }
        assert.ok(outside);
        ground[`${outside.col},${outside.row}`] = 20;
        const relief = index(grid, ground);
        const s = hexStandee(grid, "large", "large", anchor, 2, turn);
        assert.equal(s.cells.length, 3, "its actual hexes");
        const items = relief.layout(turn, EVERYTHING, [s]);
        const names = order(items);
        for (const h of own) assert.ok(names.indexOf(`c${h.col},${h.row}`) < names.indexOf("large"), `${grid.orient} turn ${turn}: own hex ${h.col},${h.row} after the Large: ${names}`);
        // The high hex outside its footprint neither raises its place nor redraws over it.
        const high = `c${outside.col},${outside.row}`;
        const lastHigh = names.lastIndexOf(high);
        const natural = sortKey(turn, anchor.x, anchor.y);
        const highKey = sortKey(turn, cellCenter(grid, outside).x, cellCenter(grid, outside).y);
        if (highKey > natural) assert.ok(lastHigh > names.indexOf("large"), "a nearer high hex draws after it");
        else assert.ok(names.indexOf(high) < names.indexOf("large") && names.filter((n) => n === high).length === 1, "a farther high hex is not drawn again over it");
      }
    }
  });

  test("a buried Medium is covered by its own higher hex, and its base follows its actual hex, not a box of cells", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const h = { col: 5, row: 5 };
      const c = hexCenter(grid, h);
      const relief = index(grid, { "5,5": 3 });
      for (const turn of TURNS) {
        const items = relief.layout(turn, EVERYTHING, [hexStandee(grid, "buried", "medium", c, 0, turn)]);
        const names = order(items);
        assert.ok(names.lastIndexOf("c5,5") > names.indexOf("buried"), `${grid.orient} turn ${turn}`);
        const item = items.find((i) => i.kind === "standee");
        assert.ok(item?.kind === "standee" && item.silhouette);
      }
    }
  });

  test("a rider draws after its holder on hexes too", () => {
    const relief = index(ROWS, {});
    for (const turn of TURNS) {
      const holder = hexStandee(ROWS, "a-horse", "large", { x: 6, y: 6 }, 0, turn);
      const rider = hexStandee(ROWS, "b-rider", "medium", hexCenter(ROWS, { col: 2, row: 2 }), 0, turn, { holder: "a-horse" });
      const names = order(relief.layout(turn, EVERYTHING, [rider, holder]));
      assert.ok(names.indexOf("b-rider") > names.indexOf("a-horse"), `turn ${turn}`);
    }
  });
});

/** A free wall on the 1/64 lattice. */
function free(id: string, a: [number, number], b: [number, number]): FreeWall {
  const lattice = (v: number) => Math.round(v * 64) / 64;
  return { id: id.padEnd(12, "x"), a: [lattice(a[0]), lattice(a[1])], b: [lattice(b[0]), lattice(b[1])], f: { kind: "wall" } };
}

function hexWalls(grid: HexGrid, walls: FreeWall[], bounds = { w: 30, h: 30 }): WallPiece[] {
  const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls } };
  const set = sceneWalls({ id: "s1", autoWalls: "off", bounds, gridShape: grid.orient === "rows" ? "hexRows" : "hexColumns" }, chunks);
  return wallPieces(set, new FogView(null, "s1", bounds), grid);
}

describe("hex walls (6.1)", () => {
  test("a wall across six hexes at three heights splits at every hex side, each run on its own host's ground", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const ground: Record<string, number> = {};
      const a: [number, number] = grid.orient === "rows" ? [2.1, 5.3] : [5.3, 2.1];
      const b: [number, number] = grid.orient === "rows" ? [8.05, 5.9] : [5.9, 8.05];
      const pieces = hexWalls(grid, [free("long", a, b)]);
      const hosts = new Set(pieces.map((p) => p.hosts!.map((h) => `${h.cell.col},${h.cell.row}`).join("|")));
      assert.ok(pieces.length >= 6, `${grid.orient}: ${pieces.length} runs`);
      assert.equal(hosts.size, pieces.length, "one run per host");
      pieces.forEach((p, i) => {
        for (const h of p.hosts!) ground[`${h.cell.col},${h.cell.row}`] = i % 3;
      });
      const items = wallItems({ ground: (x, y) => ground[`${x},${y}`] ?? 0 }, pieces);
      for (const w of items) {
        assert.equal(w.base, Math.max(...w.piece.hosts!.map((h) => ground[`${h.cell.col},${h.cell.row}`] ?? 0)), "its base is its host's");
        // Each run lies in its host: its middle reads that hex.
        const mid = { x: (w.piece.ax + w.piece.bx) / 2, y: (w.piece.ay + w.piece.by) / 2 };
        const at = cellAtPoint(grid, mid);
        assert.ok(w.piece.hosts!.some((h) => h.cell.col === at.col && h.cell.row === at.row));
        // And wholly inside it: a run never crosses a hex side.
        for (const end of [{ x: w.piece.ax, y: w.piece.ay }, { x: w.piece.bx, y: w.piece.by }]) {
          assert.ok(w.piece.hosts!.some((h) => polygonSide(cellPolygon(grid, h.cell), end, 1e-9) >= 0), `${grid.orient}: a run's end (${end.x}, ${end.y}) outside its host`);
        }
      }
      // Contiguous: the runs together are the whole wall, its ends on the 1/64 lattice.
      const wall = free("long", a, b);
      const len = pieces.reduce((t, p) => t + Math.hypot(p.bx - p.ax, p.by - p.ay), 0);
      assert.ok(Math.abs(len - Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])) < 1e-6);
    }
  });

  test("a wall exactly along a hex side has both hexes as hosts, stands on the higher, and sorts with the nearer at each turn", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const h = { col: 5, row: 5 };
      const relief0 = index(grid, {});
      const poly = relief0.cellAt(5, 5) ?? null;
      assert.equal(poly, null);
      const c = index(grid, { "5,5": 1 }).cellAt(5, 5)!;
      // Side 0, toward neighbor 0, between corners 1 and 2.
      const s = c.sides[0]!;
      const pieces = hexWalls(grid, [free("side", [s.a.x, s.a.y], [s.b.x, s.b.y])]);
      assert.equal(pieces.length, 1);
      const n = hexNeighbors(grid, h)[0]!;
      const names = pieces[0]!.hosts!.map((x) => `${x.cell.col},${x.cell.row}`).sort();
      assert.deepEqual(names, [`${h.col},${h.row}`, `${n.col},${n.row}`].sort());
      const [w] = wallItems({ ground: (x, y) => (x === 5 && y === 5 ? 1 : x === n.col && y === n.row ? 3 : 0) }, pieces);
      assert.equal(w!.base, 3);
      for (const turn of TURNS) {
        const nearer = Math.max(sortKey(turn, hexCenter(grid, h).x, hexCenter(grid, h).y), sortKey(turn, hexCenter(grid, n).x, hexCenter(grid, n).y));
        assert.equal(keyOf(w!, turn), nearer, `${grid.orient} turn ${turn}`);
      }
    }
  });

  test("rows turn 0: a perimeter run at (3.54, 8.6959375) outside raised hex (3,9) sorts after it, by its off-scene host at 0, mirrored on columns", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const swap = (x: number, y: number): [number, number] => (grid.orient === "rows" ? [x, y] : [y, x]);
      const bounds = grid.orient === "rows" ? { w: 8, h: 9 } : { w: 9, h: 8 };
      const key = grid.orient === "rows" ? "3,9" : "9,3";
      const pieces = hexWalls(grid, [free("edge", swap(3.5, 8.6828125), swap(3.578125, 8.7090625))], bounds);
      assert.ok(pieces.length >= 1);
      for (const p of pieces) {
        const host = p.hosts![0]!.cell;
        assert.ok(!(host.col === Number(key.split(",")[0]) && host.row === Number(key.split(",")[1])), "its host is not the raised hex");
      }
      const relief = index(grid, { [key]: 2 }, pieces, bounds);
      const names = order(relief.layout(0, EVERYTHING, []));
      const walls = names.filter((n) => n.startsWith("w"));
      assert.ok(walls.length >= 1);
      for (const w of walls) assert.ok(names.indexOf(w) > names.indexOf(`c${key}`), `${grid.orient}: ${names}`);
      const items = wallItems({ ground: () => 0 }, pieces);
      for (const w of items) assert.equal(w.base, 0, "off the scene its ground is 0");
    }
  });

  test("two runs in one host keep their own depth order inside it", () => {
    const pieces = hexWalls(ROWS, [free("a", [5.1, 5.0], [5.3, 5.05]), free("b", [5.2, 5.3], [5.4, 5.35])]);
    const items = wallItems({ ground: () => 0 }, pieces);
    for (const turn of TURNS) {
      const sorted = [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn) || localKeyOf(p, turn) - localKeyOf(q, turn));
      for (let i = 1; i < sorted.length; i++) {
        if (keyOf(sorted[i]!, turn) === keyOf(sorted[i - 1]!, turn)) assert.ok(localKeyOf(sorted[i]!, turn) >= localKeyOf(sorted[i - 1]!, turn));
      }
    }
  });
});

describe("connected pits (5.2)", () => {
  test("pits side by side form one region across buckets, and an edit that parts them reaches the pits of buckets it did not rebuild", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const swap = (col: number, row: number) => (grid.orient === "rows" ? `${col},${row}` : `${row},${col}`);
      const ground: Record<string, number> = {};
      for (let col = 10; col <= 40; col++) ground[swap(col, 5)] = -1;
      const bounds = { w: 70, h: 70 };
      const relief = new ReliefIndex();
      const sync = (g: Record<string, number>, chunks: Record<string, BuildChunk>) => relief.sync({ sceneId: "s1", bounds, chunks, tiles: null, walls: new Map(), global: null, src: source(grid, g, bounds), grid });
      const chunkOf = (c: number, rev: number): BuildChunk => (grid.orient === "rows" ? { sceneId: "s1", cx: c, cy: 0, rev, cells: {}, edges: {} } : { sceneId: "s1", cx: 0, cy: c, rev, cells: {}, edges: {} });
      const key = (c: number) => (grid.orient === "rows" ? `s1:${c},0` : `s1:0,${c}`);
      const kept = { [key(0)]: chunkOf(0, 1), [key(1)]: chunkOf(1, 1) };
      sync(ground, { ...kept, [key(2)]: chunkOf(2, 1) });
      const [x0, y0] = swap(10, 5).split(",").map(Number) as [number, number];
      const [x1, y1] = swap(40, 5).split(",").map(Number) as [number, number];
      const first = relief.cellAt(x0, y0)!;
      assert.ok(first.region && first.region === relief.cellAt(x1, y1)!.region && first.region.cells.length === 31, `${grid.orient}: one region over three buckets`);
      // Raising one pit in the third bucket parts the region. The first bucket is no neighbor of it and keeps its pieces.
      sync({ ...ground, [swap(35, 5)]: 0 }, { ...kept, [key(2)]: chunkOf(2, 2) });
      assert.equal(relief.rebuilt, 6, "the edited bucket and the five around it inside the scene");
      assert.equal(relief.cellAt(x0, y0), first, "the first bucket's pit is the same piece");
      assert.equal(first.region!.cells.length, 25, "and its region is the parted one");
    }
  });

  test("a creature in a pit is clipped by every opening of its region that meets it, a neighbor's included", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const ground: Record<string, number> = {};
      const mid = { col: 6, row: 6 };
      ground["6,6"] = -2;
      for (const n of hexNeighbors(grid, mid)) ground[`${n.col},${n.row}`] = -2;
      const relief = index(grid, ground);
      for (const turn of TURNS) {
        const s = hexStandee(grid, "in", "medium", hexCenter(grid, mid), -2, turn);
        const item = relief.layout(turn, EVERYTHING, [s]).find((i) => i.kind === "standee");
        assert.ok(item?.kind === "standee");
        assert.ok(item.pits.length > 1, `${grid.orient} turn ${turn}: ${item.pits.map((p) => p.id)}`);
        assert.ok(item.pits.some((p) => p.id === "c6,6"));
      }
    }
  });
});

describe("walls below 0 (5.2)", () => {
  test("a wall standing in a pit takes its region and draws inside the region's openings swept up, on hexes and squares", () => {
    for (const grid of [ROWS, COLUMNS, { shape: "squares" } as Grid]) {
      const hex = grid.shape === "hex";
      const ground: Record<string, number> = {};
      for (let row = 4; row <= 8; row++) for (let col = 4; col <= 8; col++) ground[`${col},${row}`] = -2;
      const c = hex ? hexCenter(grid, { col: 6, row: 6 }) : { x: 6.5, y: 6.5 };
      const piece: WallPiece = hex
        ? hexWalls(grid, [free("pitwall", [c.x - 0.2, c.y], [c.x + 0.2, c.y + 0.05])])[0]!
        : { id: "fpit", kind: "wall", ax: 6.2, ay: 6.5, bx: 6.8, by: 6.55, cx: 6, cy: 6, beside: null, auto: false };
      const relief = index(grid, ground, [piece]);
      const items = relief.layout(0, EVERYTHING, []);
      const all = items.flatMap((i) => (i.kind === "run" ? i.pieces : []));
      const wall = all.find((p) => p.kind === "wall");
      assert.ok(wall && wall.kind === "wall" && wall.base === -2, `${grid.shape}: the wall stands on the pit's floor`);
      const pit = relief.cellAt(6, 6)!;
      assert.equal(wall.region, pit.region, `${grid.shape}: in the pit's region`);
      const calls: string[] = [];
      const g = {
        save() {},
        restore() {},
        setTransform() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        clip: () => calls.push("clip"),
        fill: () => calls.push("fill"),
        stroke() {},
        createPattern: () => null,
        set fillStyle(_: string) {},
        set strokeStyle(_: string) {},
        set lineWidth(_: number) {},
      } as unknown as CanvasRenderingContext2D;
      drawRun(g, [wall], { turn: 0, camera: { x: 0, y: 0, scale: 40 }, pixelRatio: 1, ground: null, textures: {}, view: EVERYTHING, openings: (r, box, asker) => relief.openingsMeeting(r, 0, box, asker) });
      assert.equal(calls[0], "clip", `${grid.shape}: clipped before it fills`);
    }
  });
});

describe("a hex side's tint (D-261030-465)", () => {
  test("only pixels wholly inside the hex that touch its own sub-cells count, and a hex seen in part stays neutral", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const h = { col: 3, row: 3 };
      // 8 px a cell: inside the hex's polygon red, everywhere else blue, so any pixel read from outside shows.
      const size = { width: 128, height: 128 };
      const rect = { x: 0, y: 0, width: 16, height: 16 };
      const poly = cellPolygon(grid, h);
      const read = (r: { sx: number; sy: number; sw: number; sh: number }) => {
        const out: number[] = [];
        for (let j = 0; j < r.sh; j++) {
          for (let i = 0; i < r.sw; i++) {
            const corners = [0, 1].flatMap((dx) => [0, 1].map((dy) => ({ x: (r.sx + i + dx) / 8, y: (r.sy + j + dy) / 8 })));
            const red = corners.every((p) => polygonSide(poly, p, 0) >= 0);
            out.push(red ? 255 : 0, 0, red ? 0 : 255, 255);
          }
        }
        return out;
      };
      const tints = new CellTints(read, rect, size);
      assert.equal(tints.hexAt(grid, h), "rgb(255, 0, 0)", `${grid.orient}: no pixel from outside the hex`);
      const all = new FogView(null, "s1", { w: 16, h: 16 });
      assert.equal(hexLook(all, tints, grid, h, null).color, "rgb(255, 0, 0)");
      // One sub-cell of the hex fogged: neutral.
      const subs = hexSubcells(grid, h);
      const bits = new Uint8Array(TILE_BYTES).fill(0xff);
      const [sx, sy] = subs[0]!;
      const k = sy * TILE_SUB + sx;
      bits[k >> 3] = bits[k >> 3]! & ~(1 << (k & 7));
      const partly = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
      assert.equal(hexLook(partly, tints, grid, h, null).color, sideLook(null, null).color, `${grid.orient}: a hex seen in part stays neutral`);
      assert.equal(hexLook(all, tints, grid, h, "stairs").color, sideLook("stairs", null).color, "a stair wears its swatch");
    }
  });

  test("one cache asked by both orientations and fogs keeps each orientation's own polygon: a hex's tint never comes from the other's (review HXR1-ASTRA-4)", () => {
    // 8 px a cell: the rows polygon of (7,3) blue, everything else red, so the columns polygon of (7,3) reads red.
    const h = { col: 7, row: 3 };
    const size = { width: 160, height: 160 };
    const rect = { x: 0, y: 0, width: 20, height: 20 };
    const rowsPoly = cellPolygon(ROWS, h);
    const read = (r: { sx: number; sy: number; sw: number; sh: number }) => {
      const out: number[] = [];
      for (let j = 0; j < r.sh; j++) {
        for (let i = 0; i < r.sw; i++) {
          const mid = { x: (r.sx + i + 0.5) / 8, y: (r.sy + j + 0.5) / 8 };
          const blue = polygonSide(rowsPoly, mid, 0) >= 0;
          out.push(blue ? 0 : 255, 0, blue ? 255 : 0, 255);
        }
      }
      return out;
    };
    const fresh = (grid: HexGrid) => new CellTints(read, rect, size).hexAt(grid, h);
    assert.equal(fresh(ROWS), "rgb(0, 0, 255)");
    assert.equal(fresh(COLUMNS), "rgb(255, 0, 0)");
    const all = new FogView(null, "s1", { w: 20, h: 20 });
    const fogged = new FogView({}, "s1", { w: 20, h: 20 });
    const shared = new CellTints(read, rect, size);
    for (const [grid, fog] of [
      [ROWS, all],
      [COLUMNS, all],
      [ROWS, fogged],
      [COLUMNS, fogged],
      [COLUMNS, all],
      [ROWS, all],
    ] as const) {
      const want = fog === all ? fresh(grid) : sideLook(null, null).color;
      assert.equal(hexLook(fog, shared, grid, h, null).color, want, `${grid.orient}, ${fog === all ? "seen" : "fogged"}`);
    }
  });
});

describe("a hex bucket's inputs (9)", () => {
  /** Fog revealing every sub-cell of the tiles listed, the rest fogged. */
  function revealedTiles(keys: readonly [number, number][]): Record<string, FogTile> {
    const bits = new Uint8Array(TILE_BYTES).fill(0xff);
    void TILE_SUB;
    return Object.fromEntries(keys.map(([tx, ty]) => [tileKey("s1", tx, ty), { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) }]));
  }

  test("a fog tile is found by world position, so a change to a tile under a hex bucket's diagonal neighbor rebuilds the buckets it touches and no other", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 60, h: 60 };
      const relief = new ReliefIndex();
      const tiles = revealedTiles([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ]);
      const sync = (t: Record<string, FogTile>) => relief.sync({ sceneId: "s1", bounds, chunks: {}, tiles: t, walls: new Map(), global: null, src: source(grid, {}, bounds), grid });
      sync(tiles);
      // The tile at world 32..48 by 16..32: hex keys there are not chunk 2,1's.
      const changed = { ...tiles, [tileKey("s1", 2, 1)]: { ...tiles[tileKey("s1", 2, 1)]!, rev: 2 } };
      sync(changed);
      assert.ok(relief.rebuilt > 0 && relief.rebuilt < 9, `${grid.orient}: ${relief.rebuilt} rebuilt`);
      sync(changed);
      assert.equal(relief.rebuilt, 0, "nothing changed, nothing rebuilt");
    }
  });

  test("a 40 by 40 scene's hex keys fill a 3 by 3 grid of buckets on either orientation", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const relief = new ReliefIndex();
      relief.sync({ sceneId: "s1", bounds: { w: 40, h: 40 }, chunks: {}, tiles: null, walls: new Map(), global: null, src: source(grid, {}, { w: 40, h: 40 }), grid });
      assert.equal(relief.size, 9);
      assert.equal(relief.across, 3);
    }
  });
});

describe("drawn heights on hexes (5.4)", () => {
  function hexChunk(cells: Record<string, number>): BuildChunk {
    const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
    for (const [key, v] of Object.entries(cells)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      feet[y * CHUNK_CELLS + x] = v;
    }
    return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
  }

  test("one revealed sub-cell lets a hex's height stand, a fully fogged hex draws at 0, and two states differing only in hidden heights draw alike", () => {
    const grid = ROWS;
    const bounds = { w: 16, h: 16 };
    const h = { col: 4, row: 4 };
    const fogWith = (subs: readonly [number, number][]) => {
      const bits = new Uint8Array(TILE_BYTES);
      for (const [sx, sy] of subs) {
        const i = sy * TILE_SUB + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
      return { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
    };
    const c = hexCenter(grid, h);
    const one: [number, number] = [Math.floor(c.x * 4), Math.floor(c.y * 4)];
    const src = (feet: number, fog: Record<string, FogTile> | null) => ({ chunks: { "s1:0,0": hexChunk({ "4,4": feet, "6,6": feet }) }, sceneId: "s1", bounds, grid, fog, stand: true });
    const seen = drawnHeights(src(10, fogWith([one])), 5);
    assert.equal(seen.at(4, 4), 2, "one sub-cell revealed: its height stands");
    assert.equal(seen.at(6, 6), 0, "a fogged hex draws at 0");
    assert.equal(seen.atPoint(c), 2);
    assert.deepEqual([seen.low, seen.high], [0, 2]);
    // Hidden heights differ: everything a player reads stays the same.
    const a = drawnHeights({ ...src(10, fogWith([one])), chunks: { "s1:0,0": hexChunk({ "4,4": 10, "6,6": 30 }) } }, 5);
    const b = drawnHeights({ ...src(10, fogWith([one])), chunks: { "s1:0,0": hexChunk({ "4,4": 10, "6,6": -20 }) } }, 5);
    assert.deepEqual([a.low, a.high, a.at(6, 6)], [b.low, b.high, b.at(6, 6)]);
    const fp = [{ col: 6, row: 6 }];
    assert.equal(drawnBase(src(10, fogWith([one])), fp, 10), 10 - 0, "a creature on fogged ground stands at its lift over 0");
  });
});

describe("per player on hexes (10.3, review HXREL1-OPUS-9)", () => {
  test("two players' boards over one scene: each raises only the hexes its own fog shows, and a creature stands on one board and lies flat on the other", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const bounds = { w: 16, h: 16 };
      const ana = { col: 3, row: 4 };
      const ben = { col: 10, row: 9 };
      const feet = new Array<number>(256).fill(0);
      feet[ana.row * 16 + ana.col] = 10;
      feet[ben.row * 16 + ben.col] = 15;
      const chunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } as BuildChunk };
      // Each player has explored only their own hex and the ring round it.
      const explored = (h: GroundCell) => {
        const bits = new Uint8Array(TILE_BYTES);
        for (const [sx, sy] of [h, ...hexNeighbors(grid, { col: h.col, row: h.row })].flatMap((c) => hexSubcells(grid, { col: c.col, row: c.row }))) {
          const i = sy * TILE_SUB + sx;
          bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
        }
        return { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
      };
      const boardOf = (fog: Record<string, FogTile>) => {
        const heights = drawnHeights({ chunks, sceneId: "s1", bounds, grid, fog, stand: true }, 5);
        const relief = new ReliefIndex();
        relief.sync({ sceneId: "s1", bounds, chunks, tiles: fog, walls: new Map(), global: null, src: { ground: (x, y) => heights.at(x, y), terrain: () => null, look: () => ({ texture: null, color: "#777" }), bounds, grid }, grid });
        const raised = relief.layout(0, EVERYTHING, []).flatMap((i) => (i.kind === "run" ? i.pieces.filter((p) => p.kind === "column").map((p) => p.id) : []));
        return { heights, raised, fog: new FogView(fog, "s1", bounds) };
      };
      const anaBoard = boardOf(explored(ana));
      const benBoard = boardOf(explored(ben));
      assert.deepEqual(anaBoard.raised, [`c${ana.col},${ana.row}`], `${grid.orient}: Ana's board raises her hex alone`);
      assert.deepEqual(benBoard.raised, [`c${ben.col},${ben.row}`], `${grid.orient}: Ben's board raises his hex alone`);
      assert.equal(anaBoard.heights.atCell(ben), 0, `${grid.orient}: Ben's height is not Ana's to draw`);
      // A creature on Ana's hex: standing on her board, flat on Ben's, which has not seen that ground.
      const at = hexCenter(grid, ana);
      const goblin = { id: "g", x: at.x - 0.5, y: at.y - 0.5, size: "medium", kind: "monster" } as unknown as ViewToken;
      assert.equal(splitTokens(anaBoard.fog, grid, [goblin], () => false).standing.length, 1, `${grid.orient}: on Ana's board it stands`);
      assert.equal(splitTokens(benBoard.fog, grid, [goblin], () => false).flat.length, 1, `${grid.orient}: on Ben's it lies flat`);
    }
  });
});

describe("a stair on hexes, facing each of six sides (10.3, review HXREL1-OPUS-9)", () => {
  test("both orientations: its top copies its treads, its risers toward lower hexes stand in its swatch, the hex above shows its side over it, and the walls still say which way it faces", () => {
    for (const grid of [ROWS, COLUMNS]) {
      const stair = { col: 6, row: 6 };
      for (let d = 0; d < 6; d++) {
        const up = hexNeighbors(grid, stair)[d]!;
        // The stair 5 ft up, the hex it faces 10 ft up, every other hex at 0.
        const feet = new Array<number>(256).fill(0);
        feet[stair.row * 16 + stair.col] = 5;
        feet[up.row * 16 + up.col] = 10;
        const marks = new Array<string>(256).fill(".");
        marks[stair.row * 16 + stair.col] = String(d);
        const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet), up: marks.join("") };
        const z = (c: GroundCell) => (c.col >= 0 && c.col < 16 && c.row >= 0 && c.row < 16 ? feet[c.row * 16 + c.col]! / 5 : 0);
        const src: PieceSource = { ground: (x, y) => z({ col: x, row: y }), terrain: () => null, look: (_x, _y, t) => sideLook(t, null), bounds: { w: 16, h: 16 }, grid };
        const pieces = cellPieces(src, 0, 0, chunk);
        const s = pieces.find((p) => p.x === stair.col && p.y === stair.row)!;
        const above = pieces.find((p) => p.x === up.col && p.y === up.row)!;
        assert.ok(s.stair, `${grid.orient} facing ${d}: a stair, whose top copies the ground's treads`);
        assert.deepEqual(s.look, sideLook("stairs", null), `${grid.orient} facing ${d}: its risers wear the stair's swatch`);
        for (const turn of TURNS) {
          const faces = facesOf(s, turn);
          // Its risers: every near side toward lower ground, solid from 0 up to it, none toward the hex it climbs to.
          for (const f of faces) assert.ok(s.around[f.side]! < s.z && f.z0 === 0 && f.z1 === 1, `${grid.orient} facing ${d} turn ${turn}: a riser to lower ground`);
          assert.ok(!faces.some((f) => f.side === d), `${grid.orient} facing ${d} turn ${turn}: no riser toward the hex above`);
          const toward = hexNeighbors(grid, up).findIndex((n) => n.col === stair.col && n.row === stair.row);
          const showing = depth(turn, above.sides[toward]!.out.x, above.sides[toward]!.out.y) > 0;
          assert.equal(facesOf(above, turn).some((f) => f.side === toward && f.z0 === 1 && f.z1 === 2), showing, `${grid.orient} facing ${d} turn ${turn}: the hex above shows its side over the stair when it faces the viewer`);
        }
        const walls = sceneWalls({ id: "s1", autoWalls: "off", bounds: { w: 16, h: 16 }, gridShape: grid.orient === "rows" ? "hexRows" : "hexColumns" }, { [`s1:0,0`]: chunk });
        assert.equal(walls.stairAt(stair.col, stair.row), String(d), `${grid.orient}: the stair faces ${d}`);
      }
    }
  });
});
