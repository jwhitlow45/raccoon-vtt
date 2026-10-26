import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk } from "#shared/model.ts";
import { depth, type Turn } from "../../lib/view.ts";
import { groupWalls, meets, ReliefIndex, type Item, type StandeeIn } from "./buckets.ts";
import { boundsOf, facesOf, type PieceSource } from "./pieces.ts";
import type { WallPiece } from "./runs.ts";
import { standeeShape } from "./standee.ts";

/** Drawn ground in cells, keyed "x,y". */
function source(ground: Record<string, number>, bounds = { w: 40, h: 40 }): PieceSource {
  return {
    ground: (x, y) => ground[`${x},${y}`] ?? 0,
    terrain: () => null,
    look: () => ({ texture: null, color: "#777" }),
    bounds,
  };
}

function index(ground: Record<string, number>, walls: WallPiece[] = [], bounds = { w: 40, h: 40 }): ReliefIndex {
  const relief = new ReliefIndex();
  relief.sync({ sceneId: "s1", bounds, chunks: {}, tiles: null, walls: groupWalls(walls, null, bounds), global: ground, src: source(ground, bounds) });
  return relief;
}

/** A standee of w by h cells with its top-left at x, y, standing at `base` cells. */
function standee(id: string, x: number, y: number, base = 0, w = 1, h = 1, extra: Partial<StandeeIn> = {}, turn: Turn = 0): StandeeIn {
  const shape = standeeShape(turn, { x, y, w, h }, base, 0, 40, 800);
  return { id, x: x + w / 2, y: y + h / 2, range: { x0: Math.floor(x), y0: Math.floor(y), x1: Math.ceil(x + w), y1: Math.ceil(y + h) }, base, holder: null, bounds: shape.bounds, art: shape.art, ...extra };
}

const EVERYTHING = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };

/** The drawing order as names: "c3,4" for a cell, "w..." for a wall, the id for a standee. */
function order(items: Item[]): string[] {
  return items.flatMap((i) => (i.kind === "run" ? i.pieces.map((p) => p.id) : [i.id]));
}

function wall(x0: number, y0: number, x1: number, y1: number): WallPiece {
  return { id: `e${x0},${y0}`, kind: "wall", ax: x0, ay: y0, bx: x1, by: y1, cx: Math.floor((x0 + x1) / 2), cy: Math.floor((y0 + y1) / 2), beside: y0 === y1 ? [x0, y0 - 1, x0, y0] : [x0 - 1, y0, x0, y0], auto: false };
}

describe("depth order", () => {
  test("a Medium behind a wall draws before it, and one in front of it after, at every turn", () => {
    // A wall along the north side of row 5, from x 3 to 4.
    const relief = index({}, [wall(3, 5, 4, 5)]);
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const names = order(relief.layout(turn, EVERYTHING, [standee("north", 3, 4, 0, 1, 1, {}, turn), standee("south", 3, 5, 0, 1, 1, {}, turn)]));
      // Whichever side is nearer the viewer at this turn draws after the wall.
      const southNearer = depth(turn, 3.5, 5.5) > depth(turn, 3.5, 4.5);
      const [behind, front] = southNearer ? ["north", "south"] : ["south", "north"];
      assert.ok(names.indexOf(behind) < names.indexOf("we3,5"), `turn ${turn}: ${names}`);
      assert.ok(names.indexOf(front) > names.indexOf("we3,5"), `turn ${turn}: ${names}`);
    }
  });

  test("a Large and a Huge on a platform draw after every cell of their footprints, so their rings stay whole", () => {
    const ground: Record<string, number> = {};
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) ground[`${x},${y}`] = 2;
    // Mixed heights under the Huge: one cell lower.
    ground["5,5"] = 1;
    const relief = index(ground);
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const names = order(relief.layout(turn, EVERYTHING, [standee("large", 2, 2, 2, 2, 2, {}, turn), standee("huge", 4, 4, 2, 3, 3, {}, turn)]));
      for (const [id, x0, y0, n] of [
        ["large", 2, 2, 2],
        ["huge", 4, 4, 3],
      ] as const) {
        for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) assert.ok(names.indexOf(`c${x},${y}`) < names.indexOf(id), `turn ${turn}: c${x},${y} after ${id}`);
      }
    }
  });

  test("a token at 0 on a 10 ft cell, and a buried Large, draw before their own cells, which then cover them, outline shown", () => {
    const relief = index({ "3,3": 2, "6,6": 2, "7,6": 2, "6,7": 2, "7,7": 2 });
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const items = relief.layout(turn, EVERYTHING, [standee("low", 3, 3, 0, 1, 1, {}, turn), standee("buried", 6, 6, 0, 2, 2, {}, turn)]);
      const names = order(items);
      for (const [id, cells] of [
        ["low", ["c3,3"]],
        ["buried", ["c6,6", "c7,6", "c6,7", "c7,7"]],
      ] as const) {
        for (const c of cells) assert.ok(names.lastIndexOf(c) > names.indexOf(id), `turn ${turn}: ${c} not over ${id}: ${names}`);
        const item = items.find((i) => i.kind === "standee" && i.id === id);
        assert.ok(item?.kind === "standee" && item.silhouette, `turn ${turn}: ${id} has no outline`);
      }
    }
  });

  test("a goblin in a pit is clipped to the pit's opening, and one beside it is not", () => {
    const relief = index({ "4,4": -2 });
    const items = relief.layout(0, EVERYTHING, [standee("in", 4, 4, -2), standee("beside", 6, 4, 0)]);
    const of = (id: string) => items.find((i) => i.kind === "standee" && i.id === id);
    const inPit = of("in");
    assert.ok(inPit?.kind === "standee" && inPit.pits.map((p) => p.id).join() === "c4,4");
    const beside = of("beside");
    assert.ok(beside?.kind === "standee" && beside.pits.length === 0);
    // A token standing at 0 over a pit cell is not in it.
    const over = relief.layout(0, EVERYTHING, [standee("over", 4, 4, 0)]).find((i) => i.kind === "standee");
    assert.ok(over?.kind === "standee" && over.pits.length === 0);
  });

  test("ties draw a column, then a pit, then a wall, then a standee, then a rider after its holder, then by id", () => {
    // At turn 0 a cell center x + y = k has one depth: these all sort at depth of 4.5 + 4.5.
    const relief = index({ "4,4": 1, "5,3": -1 }, [{ id: "free", kind: "wall", ax: 3.25, ay: 5.75, bx: 3.75, by: 5.25, cx: 3, cy: 5, beside: null, auto: false }]);
    const names = order(
      relief.layout(0, EVERYTHING, [
        standee("b-rider", 2.5, 6.5, 0, 0.5, 0.5, { holder: "a-holder" }),
        standee("a-holder", 2, 6, 0),
        standee("c", 6, 2, 0),
      ]),
    );
    assert.deepEqual(names, ["c4,4", "c5,3", "wfree", "a-holder", "c", "b-rider"]);
  });

  test("a rider sorts after its holder even when its own key is smaller, and a loop of holders ends", () => {
    const relief = index({});
    const names = order(relief.layout(0, EVERYTHING, [standee("rider", 2, 2, 0, 1, 1, { holder: "mount" }), standee("mount", 5, 5, 0), standee("x", 1, 1, 0, 1, 1, { holder: "y" }), standee("y", 1, 1, 0, 1, 1, { holder: "x" })]));
    assert.ok(names.indexOf("rider") > names.indexOf("mount"));
    assert.equal(names.length, 4);
  });
});

describe("faces", () => {
  test("a column draws the sides that face the viewer down to lower neighbors, and a pit its far sides", () => {
    const relief = index({ "3,3": 2, "4,3": 1, "6,6": -2 });
    const col = relief.cellAt(3, 3)!;
    const pit = relief.cellAt(6, 6)!;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      for (const f of facesOf(col, turn)) {
        // A face is on a side whose outward step is nearer the viewer.
        const mid = { x: (f.ax + f.bx) / 2, y: (f.ay + f.by) / 2 };
        assert.ok(depth(turn, mid.x, mid.y) > depth(turn, 3.5, 3.5));
        assert.equal(f.z1, 2);
        assert.equal(f.z0, f.side === 1 ? 1 : 0, "down to the lower neighbor's ground");
      }
      assert.equal(facesOf(col, turn).length, 2);
      for (const f of facesOf(pit, turn)) {
        const mid = { x: (f.ax + f.bx) / 2, y: (f.ay + f.by) / 2 };
        assert.ok(depth(turn, mid.x, mid.y) < depth(turn, 6.5, 6.5), "a far side");
        assert.deepEqual([f.z0, f.z1], [-2, 0]);
      }
      assert.equal(facesOf(pit, turn).length, 2);
    }
    // One face of each pair is the left one, lighter.
    assert.deepEqual(facesOf(col, 0).map((f) => f.left).sort(), [false, true]);
  });
});

describe("culling", () => {
  test("a bucket draws when any of its pieces' bounds meet the view, a tall column's top above its anchor included", () => {
    const relief = index({ "20,20": 30 });
    const col = relief.cellAt(20, 20)!;
    const b = boundsOf(col, 0);
    // A view box over the column's top only, far above its cell on the ground.
    const top = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y0 + 0.2 };
    assert.ok(order(relief.layout(0, top, [])).includes("c20,20"));
    // A view box beside it, past its left edge, misses it.
    assert.deepEqual(order(relief.layout(0, { x0: b.x0 - 5, y0: b.y0, x1: b.x0 - 0.01, y1: b.y1 }, [])), []);
    assert.ok(!order(relief.layout(0, { x0: b.x1 + 0.01, y0: b.y0, x1: b.x1 + 5, y1: b.y1 }, [])).includes("c20,20"), "the bucket's right edge is its pieces' right edge");
  });

  test("a high flier whose anchor lies below the canvas, and wide art past the left or right edge, still draw", () => {
    const relief = index({});
    const flier = standee("flier", 10, 30, 20);
    const ground = standeeShape(0, { x: 10, y: 30, w: 1, h: 1 }, 0, 0, 40, 800);
    // A view box over the flier's art, above where its anchor's ground lies.
    const view = { x0: flier.art.x0, y0: flier.art.y0, x1: flier.art.x1, y1: flier.art.y1 };
    assert.ok(view.y1 < ground.ground.y);
    assert.ok(order(relief.layout(0, view, [flier])).includes("flier"));
    const wide = standee("wide", 10, 10, 0, 6, 1);
    const centerU = (wide.art.x0 + wide.art.x1) / 2;
    assert.ok(order(relief.layout(0, { x0: wide.art.x1 - 0.1, y0: wide.art.y0, x1: wide.art.x1 + 3, y1: wide.art.y1 }, [wide])).includes("wide"), "art past the right edge");
    assert.ok(order(relief.layout(0, { x0: wide.art.x0 - 3, y0: wide.art.y0, x1: wide.art.x0 + 0.1, y1: wide.art.y1 }, [wide])).includes("wide"), "art past the left edge");
    assert.ok(centerU > wide.art.x0 + 0.1);
    // Off the view altogether it is culled, unless it must stay.
    const far = { x0: 1000, y0: 1000, x1: 1001, y1: 1001 };
    assert.deepEqual(order(relief.layout(0, far, [wide])), []);
    assert.deepEqual(order(relief.layout(0, far, [{ ...wide, keep: true }])), ["wide"]);
  });
});

describe("silhouettes", () => {
  test("a standee gets one only when something drawn after it covers its art", () => {
    // The column at 30, 30 draws after "open" but well below it on screen.
    const relief = index({ "5,6": 3, "30,30": 3 });
    const items = relief.layout(0, EVERYTHING, [standee("hidden", 5, 5, 0), standee("open", 20, 20, 0)]);
    const names = order(items);
    assert.ok(names.indexOf("c30,30") > names.indexOf("open"));
    const get = (id: string) => items.find((i) => i.kind === "standee" && i.id === id);
    assert.ok(get("hidden")?.kind === "standee" && (get("hidden") as { silhouette: boolean }).silhouette);
    assert.ok(get("open")?.kind === "standee" && !(get("open") as { silhouette: boolean }).silhouette);
  });
});

describe("buckets", () => {
  test("only buckets whose chunks, neighbors, fog, walls or global inputs changed are rebuilt", () => {
    const relief = new ReliefIndex();
    const chunk = (cx: number, cy: number): BuildChunk => ({ sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
    const chunks: Record<string, BuildChunk> = { "s1:0,0": chunk(0, 0), "s1:1,0": chunk(1, 0), "s1:2,0": chunk(2, 0), "s1:0,1": chunk(0, 1) };
    const global = {};
    const input = { sceneId: "s1", bounds: { w: 48, h: 32 }, chunks, tiles: null, walls: new Map(), global, src: source({}) };
    relief.sync(input);
    assert.equal(relief.rebuilt, 6);
    relief.sync(input);
    assert.equal(relief.rebuilt, 0);
    relief.sync({ ...input, chunks: { ...chunks, "s1:2,0": chunk(2, 0) } });
    // The chunk itself and its neighbors west and south (2,1), whose sides read its ground.
    assert.equal(relief.rebuilt, 3);
    relief.sync({ ...input, global: {} });
    assert.equal(relief.rebuilt, 6);
    relief.sync({ ...input, bounds: { w: 16, h: 16 } });
    assert.equal(relief.size, 1);
  });

  test("a resize rebuilds the buckets it straddles, with the chunks and the fog the same objects", () => {
    const ground = { "12,3": 2, "5,3": 2 };
    const sync = (relief: ReliefIndex, w: number) => {
      const bounds = { w, h: 16 };
      relief.sync({ sceneId: "s1", bounds, chunks: {}, tiles: null, walls: new Map(), global: ground, src: source(ground, bounds) });
    };
    const cells = (relief: ReliefIndex) => order(relief.layout(0, EVERYTHING, [])).filter((id) => id.startsWith("c"));
    const shrinking = new ReliefIndex();
    sync(shrinking, 16);
    assert.ok(shrinking.cellAt(12, 3) && cells(shrinking).includes("c12,3"));
    sync(shrinking, 8);
    assert.equal(shrinking.cellAt(12, 3), undefined, "a column past the new edge goes");
    assert.ok(!cells(shrinking).includes("c12,3") && cells(shrinking).includes("c5,3"), `${cells(shrinking)}`);
    const growing = new ReliefIndex();
    sync(growing, 8);
    assert.ok(!cells(growing).includes("c12,3"));
    sync(growing, 16);
    assert.ok(cells(growing).includes("c12,3"), "a column inside the grown scene comes back");
    // And down: a shorter scene drops the column below its new edge.
    const tall = { "3,12": 2 };
    const down = new ReliefIndex();
    for (const h of [16, 8]) down.sync({ sceneId: "s1", bounds: { w: 16, h }, chunks: {}, tiles: null, walls: new Map(), global: tall, src: source(tall, { w: 16, h }) });
    assert.equal(down.cellAt(3, 12), undefined);
  });

  test("groupWalls keeps a bucket's array while its pieces are the same", () => {
    const a = wall(3, 5, 4, 5);
    const b = wall(20, 5, 21, 5);
    const first = groupWalls([a, b], null, { w: 40, h: 40 });
    const second = groupWalls([{ ...a }, { ...b, ax: 20.25 }], first, { w: 40, h: 40 });
    assert.equal(second.get("0,0"), first.get("0,0"));
    assert.notEqual(second.get("1,0"), first.get("1,0"));
  });

  test("groupWalls gives a bucket a new array when the DM draws a wall over an automatic one, so it stands on the higher ground again", () => {
    const auto = { ...wall(3, 5, 4, 5), auto: true };
    const first = groupWalls([auto], null, { w: 40, h: 40 });
    const drawn = groupWalls([{ ...auto, auto: false }], first, { w: 40, h: 40 });
    assert.notEqual(drawn.get("0,0"), first.get("0,0"));
    assert.equal(drawn.get("0,0")![0]!.auto, false);
  });

  test("walls on the east and south edges of a scene whose size is a multiple of 16 lay out, as do walls between buckets", () => {
    const pieces = (items: Item[]) => items.flatMap((i) => (i.kind === "run" ? i.pieces.map((p) => p.id) : []));
    for (const bounds of [
      { w: 16, h: 16 },
      { w: 32, h: 48 },
    ]) {
      const east = wall(bounds.w, 3, bounds.w, 4);
      const south = wall(3, bounds.h, 4, bounds.h);
      const corner = wall(bounds.w, bounds.h - 1, bounds.w, bounds.h);
      const inner = wall(16, 5, 16, 6);
      const relief = index({}, [east, south, corner, inner], bounds);
      const laid = pieces(relief.layout(0, EVERYTHING, []));
      for (const w of [east, south, corner, inner]) assert.ok(laid.includes(`w${w.id}`), `${w.id} on a ${bounds.w} by ${bounds.h} scene: ${laid}`);
    }
  });

  test("meets is inclusive at the edges", () => {
    assert.ok(meets({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 1, x1: 2, y1: 2 }));
    assert.ok(!meets({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1.01, y0: 0, x1: 2, y1: 1 }));
  });
});
