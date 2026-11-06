import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, EdgeFeature, FogTile, FreeWall, TerrainId, WallFeature } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { rng } from "#shared/testutil.ts";
import type { Turn } from "../../lib/view.ts";
import { groupWalls } from "./buckets.ts";
import { drawRun, type DrawContext } from "./drawRelief.ts";
import { FogView } from "./fogView.ts";
import { boundsOf, frameParts, keyOf, LEAF_RISE, sortKey, WALL_RISE, wallItems, type FramePart, type WallItem } from "./pieces.ts";
import { floorOf, leafDoorKey, samePiece, wallPieces, type WallPiece } from "./runs.ts";

/*
 * Doors and windows in frames, and the open leaf upright on its hinge
 * (docs/design/design-v1-iso-depth.md 5.5, 6 and 8): one frame from the
 * whole door whatever splits it, the leaf at its hinge's base, its own stand
 * rule and depth key, and every drawn vertex inside its bounds.
 */

const SCENE = { id: "s1", autoWalls: "off" as const, bounds: { w: 16, h: 16 } };
const TURNS: readonly Turn[] = [0, 1, 2, 3];
const door = (state: "open" | "closed" | "locked", secret = false, discovered = false): WallFeature => ({ kind: "door", state, secret, discovered });

/** Every cell of the 16 by 16 chunk painted stone, so a leaf swings to the south or east as both sides are floor. */
const FLOOR: Record<string, TerrainId> = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`${i % 16},${Math.floor(i / 16)}`, "stone" as TerrainId]));

function build(edges: Record<string, EdgeFeature>, walls: FreeWall[] = [], cells: Record<string, TerrainId> = FLOOR): Record<string, BuildChunk> {
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells, edges, ...(walls.length ? { walls } : {}) } };
}

function free(id: string, a: [number, number], b: [number, number], f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  const lattice = (v: number) => Math.round(v * 64) / 64;
  return { id: id.padEnd(12, "x"), a: [lattice(a[0]), lattice(a[1])], b: [lattice(b[0]), lattice(b[1])], f };
}

/** Fog revealing exactly the sub-cells listed, as [sx, sy]. */
function fogOf(subcells: readonly (readonly [number, number])[]): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (const [sx, sy] of subcells) {
    const i = sy * TILE_SUB + sx;
    bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
  }
  const tiles: Record<string, FogTile> = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
  return new FogView(tiles, "s1", SCENE.bounds);
}

/** The sub-cells of a box of cells. */
function subs(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let sy = y0 * 4; sy < y1 * 4; sy++) for (let sx = x0 * 4; sx < x1 * 4; sx++) out.push([sx, sy]);
  return out;
}

const ALL = new FogView(null, "s1", SCENE.bounds);

function pieces(chunks: Record<string, BuildChunk>, fog: FogView = ALL, grid?: HexGrid): WallPiece[] {
  const scene = grid ? { ...SCENE, bounds: { w: 30, h: 30 }, gridShape: grid.orient === "rows" ? ("hexRows" as const) : ("hexColumns" as const) } : SCENE;
  return wallPieces(sceneWalls(scene, chunks), fog, grid, floorOf(chunks, "s1"));
}

function items(ps: readonly WallPiece[], ground: (x: number, y: number) => number = () => 0, detail = true): WallItem[] {
  return wallItems({ ground, detail }, ps);
}

/** A frame part's span along its door, from its door's a end, in cells. */
const along = (w: WallItem, q: FramePart) => {
  const f = w.piece.frame!;
  const len = Math.hypot(f.bx - f.ax, f.by - f.ay);
  const at = (p: { x: number; y: number }) => Math.hypot(p.x - f.ax, p.y - f.ay) / len;
  return [at(q.a) * len, at(q.b) * len].map((v) => Math.round(v * 1e6) / 1e6);
};

describe("one frame for one door (5.5, D-261102-885)", () => {
  test("a door split by fog into two stretches keeps one frame: posts at its two ends only, its leaf's parts in the stretches", () => {
    // The edge from 3, 4 to 4, 4, its first and last quarters seen from the north, its middle under fog on both sides.
    const fog = fogOf([
      [12, 15],
      [15, 15],
    ]);
    const list = items(pieces(build({ "3,4,n": door("closed") }), fog));
    assert.equal(list.length, 2);
    const parts = list.flatMap((w) => frameParts(w).map((q) => ({ look: q.look, span: along(w, q) })));
    assert.deepEqual(
      parts.filter((p) => p.look === "post").map((p) => p.span),
      [
        [0, 0.15],
        [0.85, 1],
      ],
    );
    assert.deepEqual(
      parts.filter((p) => p.look === "leaf").map((p) => p.span),
      [
        [0.15, 0.25],
        [0.75, 0.85],
      ],
    );
  });

  test("a free door crossed by another free wall, and a long free door, keep posts only at their ends and one leaf between them with no gap", () => {
    for (const [a, b, cross] of [
      [[2, 3], [6, 3], free("c", [4, 2], [4, 4])],
      [[1, 1.5], [9, 1.5], null],
      [[2.2, 2.1], [7.4, 6.3], free("c", [3, 5], [6, 2])],
    ] as const) {
      const walls = [free("d", [...a], [...b], door("closed")), ...(cross ? [cross] : [])];
      const list = items(pieces(build({}, walls))).filter((w) => w.piece.id.startsWith("f0,0:d"));
      assert.ok(list.length > 1, "split into pieces");
      const f = list[0]!.piece.frame!;
      const len = Math.hypot(f.bx - f.ax, f.by - f.ay);
      const parts = list.flatMap((w) => frameParts(w).map((q) => ({ look: q.look, span: along(w, q) }))).sort((p, q) => p.span[0]! - q.span[0]!);
      const posts = parts.filter((p) => p.look === "post").map((p) => p.span);
      // A post cut by a piece's end is still one post: its parts tile the first and last 0.15 cell.
      assert.ok(posts.every(([lo, hi]) => hi! <= 0.15 + 1e-6 || lo! >= len - 0.15 - 1e-6), `posts ${JSON.stringify(posts)}`);
      const leaf = parts.filter((p) => p.look === "leaf").map((p) => p.span);
      assert.ok(Math.abs(leaf[0]![0]! - 0.15) < 1e-6 && Math.abs(leaf.at(-1)![1]! - (len - 0.15)) < 1e-5, `leaf ${JSON.stringify(leaf)}`);
      for (let i = 1; i < leaf.length; i++) assert.ok(Math.abs(leaf[i]![0]! - leaf[i - 1]![1]!) < 1e-5, "no gap between the leaf's parts");
    }
  });

  test("on hexes a door cut at the hex sides it crosses keeps one frame", () => {
    for (const grid of [{ shape: "hex", orient: "rows" }, { shape: "hex", orient: "columns" }] as HexGrid[]) {
      const list = items(pieces(build({}, [free("d", [2.1, 5.3], [8.05, 5.9], { kind: "window" })], {}), ALL, grid));
      assert.ok(list.length > 2, "cut at hex sides");
      const posts = list.flatMap((w) => frameParts(w).filter((q) => q.look === "post").map((q) => along(w, q)));
      const len = Math.hypot(8.05 - 2.1, 5.9 - 5.3);
      assert.ok(posts.every(([lo, hi]) => hi! <= 0.15 + 1e-4 || lo! >= len - 0.15 - 1e-4), `posts ${JSON.stringify(posts)}`);
      assert.ok(list.some((w) => frameParts(w).some((q) => q.look === "pane")));
    }
  });

  test("a window is two posts and a pane, an open door two posts and nothing between them, and a closed leaf a little lower than its posts", () => {
    const list = items(pieces(build({ "1,1,n": { kind: "window" }, "3,1,n": door("open"), "5,1,n": door("locked") })));
    const looks = (x: number) => frameParts(list.find((w) => w.piece.ax === x && w.piece.kind !== "leaf")!).map((q) => q.look);
    assert.deepEqual(looks(1), ["post", "pane", "post"]);
    assert.deepEqual(looks(3), ["post", "post"]);
    assert.deepEqual(looks(5), ["post", "leaf", "post"]);
    const closed = frameParts(list.find((w) => w.piece.ax === 5)!);
    assert.equal(closed[0]!.z1, WALL_RISE);
    assert.ok(Math.abs(closed[1]!.z1 - WALL_RISE * LEAF_RISE) < 1e-12);
  });

  test("groupWalls keeps a bucket's pieces only while their frames and leaves are the same", () => {
    const one = pieces(build({}, [free("d", [2, 3], [6, 3], door("open"))]));
    const longer = pieces(build({}, [free("d", [2, 3], [6.5, 3], door("open"))]));
    // The first piece keeps its ends when the door grows at its far end, but not its share of the frame.
    const first = (ps: WallPiece[]) => ps.find((p) => p.kind === "open")!;
    assert.deepEqual([first(one).ax, first(one).bx], [first(longer).ax, first(longer).bx]);
    assert.equal(samePiece(first(one), first(longer)), false);
    assert.equal(samePiece(first(one), { ...first(one) }), true);
    const kept = groupWalls(one, null, SCENE.bounds);
    assert.notEqual(groupWalls(longer, kept, SCENE.bounds).get("0,0"), kept.get("0,0"));
    assert.equal(groupWalls(one.map((p) => ({ ...p })), kept, SCENE.bounds).get("0,0"), kept.get("0,0"));
  });
});

describe("the open leaf (5.5)", () => {
  test("an open door's leaf hangs from the first post's inner end and swings into floor, never into rock, its length the opening's", () => {
    // Floor only north of the edge at 4, 2: the leaf swings north.
    const north = { ...FLOOR };
    for (let x = 0; x < 16; x++) for (let y = 2; y < 16; y++) delete north[`${x},${y}`];
    const leaf = (cells: Record<string, TerrainId>) => pieces(build({ "4,2,n": door("open") }, [], cells)).find((p) => p.kind === "leaf")!;
    const south = leaf(FLOOR);
    assert.deepEqual([south.ax, south.ay, south.bx, Math.round(south.by * 1e9) / 1e9], [4.15, 2, 4.15, 2.7]);
    const up = leaf(north);
    assert.deepEqual([up.ax, up.ay, up.bx, Math.round(up.by * 1e9) / 1e9], [4.15, 2, 4.15, 1.3]);
    assert.equal(leafDoorKey(up), "e4,2n");
    // A free door eight cells long: its leaf runs almost the whole length.
    const long = pieces(build({}, [free("d", [1, 5], [9, 5], door("open"))])).find((p) => p.kind === "leaf")!;
    assert.ok(Math.abs(Math.hypot(long.bx - long.ax, long.by - long.ay) - 7.7) < 1e-9);
    assert.equal(leafDoorKey(long), `f0,0:${"d".padEnd(12, "x")}`);
  });

  test("an open door on a ledge stands its leaf at its hinge's base, the frame's, clear of the lower floor it swings over, the same base open and closed", () => {
    // 10 ft north of the edge at 4, 2, 0 ft south, where the leaf swings.
    const ground = (x: number, y: number) => (y < 2 ? 2 : 0);
    const open = items(pieces(build({ "4,2,n": door("open") })), ground);
    const closed = items(pieces(build({ "4,2,n": door("closed") })), ground);
    const leaf = open.find((w) => w.piece.kind === "leaf")!;
    assert.ok(leaf.piece.by > 2, "it swings over the lower floor");
    assert.equal(leaf.base, 2);
    assert.equal(open.find((w) => w.piece.kind === "open")!.base, 2);
    assert.equal(closed[0]!.base, 2);
    // A free door stands its leaf on its hinge's own cell.
    // Its leaf, 1.7 cells long, swings south from 3.15, 6.5 into the cell below, which is lower.
    const freeLeaf = items(pieces(build({}, [free("d", [3, 6.5], [5, 6.5], door("open"))])), (_x, y) => (y === 6 ? 1 : 0)).find((w) => w.piece.kind === "leaf")!;
    assert.ok(freeLeaf.piece.by > 7);
    assert.equal(freeLeaf.base, 1);
  });

  test("security: a leaf stands only where every sub-cell under the leaf itself is revealed, whatever its door's line shows, and then lies flat on the ground stage", () => {
    const chunks = build({ "4,2,n": door("open") });
    // Both sides of the line seen, but not the square it swings into.
    const line = fogOf([...subs(4, 1, 5, 2), ...subs(4, 2, 5, 2.25)]);
    const ps = pieces(chunks, line);
    assert.ok(ps.some((p) => p.kind === "open"), "the frame stands by its line");
    assert.ok(!ps.some((p) => p.kind === "leaf"), "the leaf lies flat");
    const seen = pieces(chunks, fogOf(subs(4, 1, 5, 3)));
    assert.ok(seen.some((p) => p.kind === "leaf"), "the swing square seen, the leaf stands");
    // Every sub-cell the leaf's box touches, one at a time taken away, lays it flat.
    const leafSubs: [number, number][] = [
      [16, 8],
      [16, 9],
      [16, 10],
    ];
    for (const gone of leafSubs) {
      const fog = fogOf(subs(4, 1, 5, 3).filter(([sx, sy]) => sx !== gone[0] || sy !== gone[1]));
      assert.ok(!pieces(chunks, fog).some((p) => p.kind === "leaf"), `sub-cell ${gone} fogged`);
    }
  });

  test("a secret door not yet found has no leaf, and without the floor reader nothing swings", () => {
    assert.ok(!pieces(build({ "4,2,n": door("open", true, false) })).some((p) => p.kind === "leaf"));
    assert.ok(pieces(build({ "4,2,n": door("open", true, true) })).some((p) => p.kind === "leaf"), "found, it opens as any door");
    assert.ok(!wallPieces(sceneWalls(SCENE, build({ "4,2,n": door("open") })), ALL).some((p) => p.kind === "leaf"));
  });

  test("the leaf sorts by its own middle, apart from its frame's, on squares and on hexes", () => {
    const list = items(pieces(build({ "4,2,n": door("open") })));
    const leaf = list.find((w) => w.piece.kind === "leaf")!;
    const frame = list.find((w) => w.piece.kind === "open")!;
    for (const turn of TURNS) {
      assert.equal(keyOf(leaf, turn), sortKey(turn, 4.15, 2.35));
      assert.equal(keyOf(frame, turn), sortKey(turn, 4.5, 2));
    }
    // On hexes a frame's pieces sort with their host hexes, and the leaf by its own middle, whatever hex its hinge is in.
    const hex = items(pieces(build({}, [free("d", [2.1, 5.3], [6.05, 5.3], door("open"))], {}), ALL, { shape: "hex", orient: "rows" }));
    const hexLeaf = hex.find((w) => w.piece.kind === "leaf")!;
    assert.equal(hexLeaf.hosts, null);
    assert.ok(hex.filter((w) => w.piece.kind === "open").every((w) => w.hosts !== null));
    for (const turn of TURNS) assert.equal(keyOf(hexLeaf, turn), sortKey(turn, (hexLeaf.piece.ax + hexLeaf.piece.bx) / 2, (hexLeaf.piece.ay + hexLeaf.piece.by) / 2));
  });

  test("below the detail level an open door stands nothing, and a closed door or a window stands as one plane", () => {
    const ps = pieces(build({ "1,1,n": { kind: "window" }, "3,1,n": door("open"), "5,1,n": door("closed") }));
    const flat = items(ps, () => 0, false);
    assert.deepEqual(flat.map((w) => w.piece.kind).sort(), ["door", "window"]);
    assert.ok(flat.every((w) => !w.framed));
    const detailed = items(ps, () => 0, true);
    assert.deepEqual(detailed.map((w) => w.piece.kind).sort(), ["door", "leaf", "open", "window"]);
    assert.ok(detailed.every((w) => w.framed));
  });
});

/** A canvas that writes down every vertex it is given, in view units, and each fill. */
function recording(): { g: CanvasRenderingContext2D; points: { x: number; y: number }[]; fills: string[] } {
  const points: { x: number; y: number }[] = [];
  const fills: string[] = [];
  let style = "";
  const g = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === "moveTo" || name === "lineTo") return (x: number, y: number) => points.push({ x, y });
        if (name === "fill") return () => fills.push(style);
        if (name === "createPattern") return () => ({ setTransform() {} });
        return () => undefined;
      },
      set: (_t, name, v) => {
        if (name === "fillStyle") style = typeof v === "string" ? v : "pattern";
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { g, points, fills };
}

function dc(turn: Turn, textures: DrawContext["textures"] = {}): DrawContext {
  return { turn, camera: { x: 0, y: 0, scale: 1 }, pixelRatio: 1, ground: null, textures, view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 } };
}

describe("drawing frames", () => {
  test("property: every vertex a door, window or leaf draws lies inside its bounds, at every turn, with the detail on and off", () => {
    const random = rng(26115);
    for (let round = 0; round < 40; round++) {
      const edges: Record<string, EdgeFeature> = {};
      const kinds: EdgeFeature[] = [door("open"), door("closed"), door("locked"), { kind: "window" }];
      for (let i = 0; i < 8; i++) edges[`${1 + Math.floor(random() * 13)},${1 + Math.floor(random() * 13)},${random() < 0.5 ? "n" : "w"}`] = kinds[Math.floor(random() * 4)]!;
      const walls: FreeWall[] = [];
      for (let i = 0; i < 3; i++) {
        const a: [number, number] = [1 + random() * 13, 1 + random() * 13];
        const len = 0.3 + random() * 7;
        const ang = random() * Math.PI * 2;
        const b: [number, number] = [Math.min(15, Math.max(0, a[0] + Math.cos(ang) * len)), Math.min(15, Math.max(0, a[1] + Math.sin(ang) * len))];
        walls.push(free(`w${i}`, a, b, kinds[Math.floor(random() * 4)]! as FreeWall["f"]));
      }
      const heights = Array.from({ length: 256 }, () => Math.floor(random() * 5) - 2);
      const ground = (x: number, y: number) => (x >= 0 && y >= 0 && x < 16 && y < 16 ? heights[y * 16 + x]! / 2 : 0);
      const ps = pieces(build(edges, walls));
      for (const detail of [true, false]) {
        for (const w of items(ps, ground, detail)) {
          for (const turn of TURNS) {
            const b = boundsOf(w, turn);
            const r = recording();
            drawRun(r.g, [w], dc(turn));
            // An open door's piece between its posts has nothing to draw.
            assert.equal(r.points.length > 0, !w.framed || frameParts(w).length > 0, `${w.id} draws`);
            for (const p of r.points) assert.ok(p.x >= b.x0 - 1e-9 && p.x <= b.x1 + 1e-9 && p.y >= b.y0 - 1e-9 && p.y <= b.y1 + 1e-9, `round ${round}, ${w.id}, turn ${turn}, detail ${detail}: ${JSON.stringify(p)} outside ${JSON.stringify(b)}`);
          }
        }
      }
    }
  });

  test("a closed door draws its posts in one flat tone a face and its leaf in wood, twelve fills at most with textures loaded, an open frame its posts alone, a window its posts and pane", () => {
    const g = globalThis as { DOMMatrix?: unknown };
    const had = g.DOMMatrix;
    g.DOMMatrix = class {};
    try {
      const wood = { naturalWidth: 256 } as HTMLImageElement;
      const list = items(pieces(build({ "1,1,n": door("closed"), "3,1,n": door("open"), "5,1,w": { kind: "window" } })));
      const fillsOf = (x: number, turn: Turn) => {
        const r = recording();
        drawRun(r.g, [list.find((w) => w.piece.ax === x && w.piece.kind !== "leaf")!], dc(turn, { wood, stone: wood }));
        return r.fills;
      };
      for (const turn of TURNS) {
        const closed = fillsOf(1, turn);
        assert.ok(closed.length <= 12, `turn ${turn}: ${closed.length} fills`);
        assert.ok(closed.includes("pattern"), "the leaf in its texture");
        // Each post: two sides and a cap, each one flat fill.
        assert.equal(closed.filter((c) => c !== "pattern" && !c.startsWith("rgba")).length, 2 * 3 + 1, `turn ${turn}: the posts' six faces and the leaf's cap`);
        assert.equal(fillsOf(3, turn).length, 6, `turn ${turn}: an open frame's two posts`);
        assert.equal(fillsOf(5, turn).length, 7, `turn ${turn}: a window's posts and its pane`);
      }
    } finally {
      g.DOMMatrix = had;
    }
  });
});
