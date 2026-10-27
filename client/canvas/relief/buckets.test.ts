import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk } from "#shared/model.ts";
import { depth, type Turn } from "../../lib/view.ts";
import { resolveArea, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { buildVolume } from "../../features/areas/volume.ts";
import { ctxOf } from "../../features/areas/volumeTesting.ts";
import { groupWalls, meets, ReliefIndex, stretches, type Item, type StandeeIn, type VolumePiece } from "./buckets.ts";
import { boundsOf, facesOf, keyOf, sortKey, type PieceSource } from "./pieces.ts";
import { bandPieces, pitsUnder, sideOf } from "./volumes.ts";
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

// ---------------------------------------------------------------- areas standing as their real shapes

const TURNS: readonly Turn[] = [0, 1, 2, 3];
const LOOK = { color: "#3fa7ff", dm: false, selected: false, preview: false };

/** An area's bands at a turn, from its real volume over this drawn ground (in cells), as the board lays them out. */
function bandsOf(t: Pick<AreaTemplateInput, "shape" | "size" | "origin"> & Partial<AreaTemplateInput>, ground: Record<string, number>, turn: Turn, id = "a"): VolumePiece[] {
  const bounds = { w: 40, h: 40 };
  const area = resolveArea({ id, rev: 1, yaw: 0, includeOrigin: true, ...t }, ctxOf(bounds, null));
  assert.ok(area);
  const at = (x: number, y: number) => ground[`${x},${y}`] ?? 0;
  const vol = buildVolume({ area, bounds, ground: at, px: 40 });
  vol.ensureAll();
  for (const key of vol.keys) assert.ok(vol.drawn(key, turn));
  return bandPieces(vol, turn, vol.keys, id, LOOK, pitsUnder(vol, { at }));
}

/** A band made up for a case: its key at its middle, over everything. */
function band(area: string, b: number): VolumePiece {
  return { kind: "volume", id: `v${area}:${b}`, area, band: b, key: b + 0.5, draws: [], bounds: EVERYTHING, look: LOOK, pits: [] };
}

type Entry = { kind: "standee"; id: string } | { kind: "band"; area: string; band: number } | { kind: "cell"; id: string; key: number };

function entries(items: Item[], turn: Turn): Entry[] {
  return items.flatMap((i): Entry[] =>
    i.kind === "standee" ? [{ kind: "standee", id: i.id }] : i.pieces.map((p): Entry => (p.kind === "volume" ? { kind: "band", area: p.area, band: p.band } : { kind: "cell", id: p.id, key: keyOf(p, turn) })),
  );
}

/** A standee's raise as the code computes it (buckets.ts placeStandees): its key raised to its own cells at or below its base, then to its holders'. */
function raiseOf(s: StandeeIn, all: readonly StandeeIn[], ground: Record<string, number>, turn: Turn): number {
  const own = (t: StandeeIn) => {
    let key = sortKey(turn, t.x, t.y);
    for (let y = t.range.y0; y < t.range.y1; y++) {
      for (let x = t.range.x0; x < t.range.x1; x++) {
        const z = ground[`${x},${y}`] ?? 0;
        if (z !== 0 && z <= t.base) key = Math.max(key, sortKey(turn, x + 0.5, y + 0.5));
      }
    }
    return key;
  };
  let key = own(s);
  for (let at = s, guard = 0; at.holder && guard < 10; guard++) {
    const holder = all.find((h) => h.id === at.holder);
    if (!holder) break;
    key = Math.max(key, own(holder));
    at = holder;
  }
  return key - sortKey(turn, s.x, s.y);
}

/**
 * The precedence rule (design 4.3), with every key worked out here: a band
 * at its middle, band + 0.5, draws after the last placed standee whose
 * natural key, its footprint's middle, is below it and before every one
 * placed after that. And its error: a piece drawn before a band though
 * nearer than it, a column or a standee, is nearer by at most the raise of
 * the standee the band follows.
 */
function checkPrecedence(items: Item[], turn: Turn, standees: readonly StandeeIn[], ground: Record<string, number>, label: string): void {
  const order = entries(items, turn);
  const placed = order.flatMap((e) => (e.kind === "standee" ? [e.id] : []));
  const byId = new Map(standees.map((s) => [s.id, s]));
  const natural = (id: string) => sortKey(turn, byId.get(id)!.x, byId.get(id)!.y);
  const at = (id: string) => order.findIndex((e) => e.kind === "standee" && e.id === id);
  order.forEach((e, i) => {
    if (e.kind !== "band") return;
    const key = e.band + 0.5;
    let last = -1;
    placed.forEach((id, k) => {
      if (natural(id) < key) last = k;
    });
    placed.forEach((id, k) => assert.ok(k <= last ? at(id) < i : at(id) > i, `${label}: band ${e.band} of ${e.area} ${k <= last ? "before" : "after"} ${id}`));
    const raise = last >= 0 ? raiseOf(byId.get(placed[last]!)!, standees, ground, turn) : 0;
    for (const before of order.slice(0, i)) {
      const nearer = before.kind === "cell" ? before.key - key : before.kind === "standee" ? natural(before.id) - key : -1;
      assert.ok(nearer <= raise + 1e-9, `${label}: ${before.kind === "band" ? "" : before.id} drawn before band ${e.band} though ${nearer} nearer, past the raise ${raise}`);
    }
  });
}

/** Standees on the scene in front of and behind a point at this turn, `d` cells along the way to the viewer. */
function along(turn: Turn, x: number, y: number, d: number): { x: number; y: number } {
  const dx = depth(turn, 1, 0);
  const dy = depth(turn, 0, 1);
  return { x: x + d * dx, y: y + d * dy };
}

describe("areas standing as their real shapes in the depth list (docs/design-v1-iso-area-shapes.md 4.3)", () => {
  test("a 20 ft sphere 10 ft up: a flier inside between its far and near bands, one above, one in front after every band under its art, one behind before them, at each turn", () => {
    const relief = index({});
    for (const turn of TURNS) {
      const sphere = { shape: "sphere" as const, size: 20, origin: { x: 20.5, y: 20.5, z: 10 } };
      const pieces = bandsOf(sphere, {}, turn);
      assert.ok(pieces.length >= 8, `turn ${turn}: ${pieces.length} bands`);
      const front = along(turn, 20, 20, 7);
      const behind = along(turn, 20, 20, -7);
      const standees = [standee("inside", 20, 20, 2, 1, 1, {}, turn), standee("above", 20, 20, 12, 1, 1, {}, turn), standee("front", front.x, front.y, 2, 1, 1, {}, turn), standee("behind", behind.x, behind.y, 2, 1, 1, {}, turn)];
      const items = relief.layout(turn, EVERYTHING, standees, pieces);
      checkPrecedence(items, turn, standees, {}, `turn ${turn}`);
      const order = entries(items, turn);
      const at = (id: string) => order.findIndex((e) => e.kind === "standee" && e.id === id);
      const bandAt = (p: VolumePiece) => order.findIndex((e) => e.kind === "band" && e.band === p.band);
      const art = (id: string) => standees.find((s) => s.id === id)!.art;
      const under = (id: string) => pieces.filter((p) => meets(p.bounds, art(id)));
      // Inside: far bands under its art before it, near ones after.
      assert.ok(under("inside").some((p) => bandAt(p) < at("inside")) && under("inside").some((p) => bandAt(p) > at("inside")), `turn ${turn}: inside`);
      assert.ok(under("front").length > 0 && under("front").every((p) => bandAt(p) < at("front")), `turn ${turn}: in front`);
      assert.ok(under("behind").length > 0 && under("behind").every((p) => bandAt(p) > at("behind")), `turn ${turn}: behind`);
    }
  });

  test("a Gargantuan, a 6 by 6, a Tiny and a 1.5 by 1.5 flier over a 10 ft platform, in a sphere and just outside it: read by their natural keys, a tint on the platform within each one's raise", () => {
    const ground: Record<string, number> = {};
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) ground[`${x},${y}`] = 2;
    const relief = index(ground);
    const sizes: [string, number][] = [
      ["gargantuan", 4],
      ["six", 6],
      ["tiny", 0.5],
      ["onehalf", 1.5],
    ];
    let cases = 0;
    for (const turn of TURNS) {
      const pieces = bandsOf({ shape: "sphere", size: 25, origin: { x: 20, y: 20, z: 25 } }, ground, turn);
      for (const [name, w] of sizes) {
        // Inside, then just outside on the near side.
        for (const d of [0, 6 + w / 2]) {
          const p = along(turn, 20 - w / 2, 20 - w / 2, d);
          const s = standee(name, p.x, p.y, 5, w, w, {}, turn);
          const items = relief.layout(turn, EVERYTHING, [s], pieces);
          checkPrecedence(items, turn, [s], ground, `turn ${turn} ${name} at ${d}`);
          cases++;
        }
      }
    }
    assert.equal(cases, 32);
  });

  test("astra's two fliers over a platform: A natural 14.142 raised to 16.263, B at 15.556, a band at 15.5 draws after A and so after B, which it tints, within A's raise", () => {
    // At turn 0 a point's key is (x + y) / sqrt 2. A Gargantuan from 8, 8 has its middle at 10, 10 and its own far cell's middle at 11.5, 11.5, on a platform under it.
    const ground: Record<string, number> = {};
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) ground[`${x},${y}`] = 2;
    const relief = index(ground);
    const a = standee("A", 8, 8, 3, 4, 4);
    const b = standee("B", 4.5, 16.5, 0);
    // A third standee far behind both, so "after the last" and "after the first" differ.
    const x = standee("X", 2, 4, 0);
    assert.equal(Math.round(sortKey(0, a.x, a.y) * 1e3) / 1e3, 14.142);
    assert.equal(Math.round(sortKey(0, b.x, b.y) * 1e3) / 1e3, 15.556);
    const items = relief.layout(0, EVERYTHING, [a, b, x], [band("v", 15)]);
    const order = entries(items, 0).filter((e) => e.kind !== "cell");
    assert.deepEqual(order, [{ kind: "standee", id: "X" }, { kind: "standee", id: "B" }, { kind: "standee", id: "A" }, { kind: "band", area: "v", band: 15 }]);
    checkPrecedence(items, 0, [a, b, x], ground, "astra");
    assert.ok(Math.abs(raiseOf(a, [a], ground, 0) - 2.121) < 1e-3);
  });

  test("a Tiny on a 10 ft cell, natural 14.496 raised to 14.849 by that cell: a band at 14.5 draws after it, past its cell and B at 14.637, nearer within its raise of 0.354, where the closed formula would give below 0", () => {
    // At turn 0 a point's key is (x + y) / sqrt 2. The Tiny's middle is 10.25, 10.25 and its cell's middle 10.5, 10.5.
    const ground: Record<string, number> = { "10,10": 2 };
    const relief = index(ground);
    const tiny = standee("tiny", 10, 10, 2, 0.5, 0.5);
    const b = standee("B", 3.6, 16.1, 0);
    assert.equal(Math.round(sortKey(0, tiny.x, tiny.y) * 1e3) / 1e3, 14.496);
    assert.equal(Math.round(sortKey(0, b.x, b.y) * 1e3) / 1e3, 14.637);
    const items = relief.layout(0, EVERYTHING, [tiny, b], [band("v", 14)]);
    const order = entries(items, 0);
    const at = (want: (e: Entry) => boolean) => order.findIndex(want);
    const bandAt = at((e) => e.kind === "band");
    assert.ok(at((e) => e.kind === "standee" && e.id === "B") < bandAt && at((e) => e.kind === "standee" && e.id === "tiny") < bandAt, "after both");
    assert.ok(at((e) => e.kind === "cell" && Math.abs(e.key - 21 / Math.SQRT2) < 1e-9) < bandAt, "after the Tiny's cell, nearer than the band by 0.349");
    checkPrecedence(items, 0, [tiny, b], ground, "tiny");
    assert.ok(Math.abs(raiseOf(tiny, [tiny], ground, 0) - 0.354) < 1e-3);
  });

  test("a creature carried by a flying mount inside an aura: after its holder, and among the aura's bands by its own natural key, its raise from its holder's", () => {
    for (const turn of TURNS) {
      const pieces = bandsOf({ shape: "emanation", size: 15, origin: { x: 20, y: 20, z: 20 } }, {}, turn);
      const mount = standee("mount", 19, 19, 4, 2, 2, {}, turn);
      const rider = standee("rider", 19, 19, 4, 1, 1, { holder: "mount" }, turn);
      const items = index({}).layout(turn, EVERYTHING, [rider, mount], pieces);
      const order = entries(items, turn);
      const at = (id: string) => order.findIndex((e) => e.kind === "standee" && e.id === id);
      assert.ok(at("rider") > at("mount"), `turn ${turn}`);
      checkPrecedence(items, turn, [rider, mount], {}, `turn ${turn}`);
    }
  });

  test("a volume with no standee in its depth range is one run, and a flier inside it makes two", () => {
    const runs = (items: Item[]) => {
      let count = 0;
      let open = false;
      for (const item of items) {
        if (item.kind === "standee") {
          open = false;
          continue;
        }
        for (const p of item.pieces) {
          if (p.kind === "volume") {
            if (!open) count++;
            open = true;
          } else open = false;
        }
      }
      return count;
    };
    for (const turn of TURNS) {
      const pieces = bandsOf({ shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 10 } }, {}, turn);
      const far = along(turn, 20, 20, -12);
      assert.equal(runs(index({}).layout(turn, EVERYTHING, [standee("far", far.x, far.y, 0, 1, 1, {}, turn)], pieces)), 1, `turn ${turn}`);
      assert.equal(runs(index({}).layout(turn, EVERYTHING, [standee("in", 19.5, 19.5, 2, 1, 1, {}, turn)], pieces)), 2, `turn ${turn}`);
    }
  });

  test("two volumes interleave band by band, and ties draw a column, a pit, a wall, a volume, then a standee", () => {
    for (const turn of TURNS) {
      const a = bandsOf({ shape: "sphere", size: 20, origin: { x: 18, y: 18, z: 10 } }, {}, turn, "a");
      const b = bandsOf({ shape: "cube", size: 20, origin: { x: 22, y: 22, z: 5 } }, {}, turn, "b");
      const order = entries(index({}).layout(turn, EVERYTHING, [], [...b, ...a]), turn).flatMap((e) => (e.kind === "band" ? [e] : []));
      for (let i = 1; i < order.length; i++) {
        const [p, q] = [order[i - 1]!, order[i]!];
        assert.ok(p.band < q.band || (p.band === q.band && p.area < q.area), `turn ${turn}: ${JSON.stringify(p)} then ${JSON.stringify(q)}`);
      }
      assert.ok(new Set(order.map((e) => e.area)).size === 2);
    }
    // At turn 0 a cell's middle and a band's can tie only by rounding, so the ties are made: a band at the column's key, and a standee whose natural key is the band's.
    const relief = index({ "4,4": 1, "5,3": -1 }, [{ id: "free", kind: "wall", ax: 3.25, ay: 5.75, bx: 3.75, by: 5.25, cx: 3, cy: 5, beside: null, auto: false }]);
    const key = sortKey(0, 4.5, 4.5);
    const tied: VolumePiece = { ...band("v", 0), key };
    // Its middle is half a cell in from its corner each way.
    const s = standee("s", key * Math.SQRT2 - 11, 10, 0);
    assert.equal(sortKey(0, s.x, s.y), key);
    const names = entries(relief.layout(0, EVERYTHING, [s], [tied]), 0).map((e) => (e.kind === "band" ? "band" : e.id));
    assert.deepEqual(names, ["c4,4", "c5,3", "wfree", "band", "s"]);
  });

  test("a standee inside a volume takes no silhouette from its bands, and one from a column drawn after it", () => {
    const pieces = bandsOf({ shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 10 } }, {}, 0);
    const s = standee("in", 19.5, 19.5, 2);
    const items = index({}).layout(0, EVERYTHING, [s], pieces);
    const item = items.find((i) => i.kind === "standee");
    assert.ok(item?.kind === "standee" && !item.silhouette);
    assert.ok(entries(items, 0).findIndex((e) => e.kind === "band") < entries(items, 0).findIndex((e) => e.kind === "standee"));
    const covered = index({ "21,21": 3 }).layout(0, EVERYTHING, [s], pieces).find((i) => i.kind === "standee");
    assert.ok(covered?.kind === "standee" && covered.silhouette);
  });

  test("a 5 ft sphere at -10 ft over a 20 ft pit: its bands carry the pit's cells for their clip, inside the opening down to the floor, and a flier in the pit draws between them", () => {
    const ground: Record<string, number> = {};
    for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) ground[`${x},${y}`] = -4;
    const relief = index(ground);
    for (const turn of TURNS) {
      const pieces = bandsOf({ shape: "sphere", size: 5, origin: { x: 12, y: 12, z: -10 } }, ground, turn);
      assert.ok(pieces.length >= 2);
      for (const p of pieces) {
        const pits = p.pits.map((c) => `${c.x},${c.y}`);
        // The cells under its plan, every one a pit's.
        assert.ok(["11,11", "12,11", "11,12", "12,12"].every((c) => pits.includes(c)) && pits.every((c) => ground[c] === -4), `turn ${turn}: ${pits}`);
        for (const d of p.draws) assert.ok(d.high.far.length + d.high.near.length === 0, `turn ${turn}: all of it lies inside the opening`);
      }
      assert.ok(pieces.some((p) => p.draws.some((d) => d.low.near.length > 0)));
      const flier = standee("flier", 11.5, 11.5, -2, 1, 1, {}, turn);
      const items = relief.layout(turn, EVERYTHING, [flier], pieces);
      const item = items.find((i) => i.kind === "standee");
      assert.ok(item?.kind === "standee" && item.pits.length > 0, "the flier is clipped by the pit too");
      checkPrecedence(items, turn, [flier], ground, `turn ${turn}`);
      const order = entries(items, turn);
      const at = order.findIndex((e) => e.kind === "standee");
      assert.ok(order.slice(0, at).some((e) => e.kind === "band") && order.slice(at).some((e) => e.kind === "band"), `turn ${turn}: between its bands`);
    }
  });

  test("bands with no box in view are left out, and the stretch a band draws in is found by halving", () => {
    const far = { ...band("v", 3), bounds: { x0: 1e5, y0: 1e5, x1: 1e5 + 1, y1: 1e5 + 1 } };
    assert.equal(entries(index({}).layout(0, { x0: 0, y0: 0, x1: 10, y1: 10 }, [], [far, band("v", 4)]), 0).length, 1);
    // Natural keys in placed order: the last below 5 is the third, though the second is placed before it with a larger key.
    const at = stretches([1, 9, 4, 7]);
    assert.equal(at(0.5), 0);
    assert.equal(at(1), 0, "a tie is not below");
    assert.equal(at(2), 1);
    assert.equal(at(5), 3);
    assert.equal(at(8), 4);
    assert.equal(at(10), 4);
  });

  test("an aura dragged here draws its bands behind its standee's key under it, and those at or in front of it over it", () => {
    const pieces = [band("v", 1), band("v", 2), band("v", 3)];
    assert.deepEqual(sideOf(pieces, 2.5, "behind").map((p) => p.band), [1]);
    assert.deepEqual(sideOf(pieces, 2.5, "front").map((p) => p.band), [2, 3]);
  });
});
