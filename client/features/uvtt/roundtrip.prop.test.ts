import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { AutoWalls, BuildChunk, EdgeFeature, GridShape, Light, TerrainId, WallFeature } from "#shared/model.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { cornerAt, hexCorners, hexInScene, type HexGrid } from "#shared/rules/hex.ts";
import { effectiveEdges, indexBuild } from "#shared/rules/walls.ts";
import { exportContent } from "../mapexport/content.ts";
import { coveredBy } from "./compare.ts";
import { chunksOf, importBack, type BuildInput } from "./exportTestutil.ts";
import { checkExport } from "./steps.ts";
import { SHORT_LATTICE, uvttGeometry, type UvttHead } from "./write.ts";

/**
 * The export through this app's own import (docs/design/design-v1-uvtt-export.md
 * section 6): `uvttGeometry`, JSON, `readUvtt` and `convertUvtt` with the
 * dialog's defaults. A spaced build, whose ends keep a tenth of a square
 * from the grid's intersections and from every other piece, comes back
 * exactly and the check says so. A free build, ends anywhere on the
 * lattice, may change, and the check's flag says exactly when.
 */

const W = 20;
const H = 14;
const L = 64;
type Kind = "wall" | "door" | "window";
type Pt = { x: number; y: number };
type Seg = { a: Pt; b: Pt; kind: Kind };

const TERRAINS: TerrainId[] = ["stone", "wood", "water", "rubble", "pillar"];
const RULES: AutoWalls[] = ["all", "floor", "off"];

const featureArb: fc.Arbitrary<EdgeFeature> = fc.oneof(
  fc.constant<EdgeFeature>({ kind: "wall" }),
  fc.constant<EdgeFeature>({ kind: "window" }),
  fc.constant<EdgeFeature>({ kind: "none" }),
  fc.record({ state: fc.constantFrom("open" as const, "closed" as const, "locked" as const), secret: fc.boolean(), discovered: fc.boolean() }).map((d): EdgeFeature => ({ kind: "door", ...d })),
);
const wallFeatureArb = featureArb.filter((f): f is WallFeature => f.kind !== "none");

/** A spaced end in the cell (x, y): its corner, a grid intersection, or a lattice point at least 8/64 off every grid line. */
function spacedIn(x: number, y: number): fc.Arbitrary<[number, number]> {
  return fc.oneof(fc.constant<[number, number]>([x, y]), fc.tuple(fc.integer({ min: 8, max: 56 }), fc.integer({ min: 8, max: 56 })).map(([fx, fy]): [number, number] => [x + fx / L, y + fy / L]));
}
const cellIn = (w: number, h: number) => fc.tuple(fc.integer({ min: 0, max: w - 1 }), fc.integer({ min: 0, max: h - 1 }));
const near = fc.tuple(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }));

/** Spaced walls: both ends spaced, the second within a few cells of the first. */
const spacedWalls = fc
  .array(
    fc.tuple(cellIn(W, H), near).chain(([[x, y], [dx, dy]]) => {
      const bx = Math.max(0, Math.min(W - 1, x + dx));
      const by = Math.max(0, Math.min(H - 1, y + dy));
      return fc.record({ a: spacedIn(x, y), b: spacedIn(bx, by), f: wallFeatureArb });
    }),
    { maxLength: 8 },
  )
  .map((ws) => ws.filter((w) => fits(w, SHORT_LATTICE)));

/**
 * Free walls: any lattice ends, from 1/64 long. Ends cluster near quarter squares, with a few 64ths of jitter, so
 * they often fall within a weld of each other, of a grid intersection and of other walls, which is what the flag is about.
 */
const coord = fc.oneof(
  fc.tuple(fc.integer({ min: 0, max: 24 }), fc.integer({ min: -6, max: 6 })).map(([q, j]) => Math.max(0, q * 16 + j)),
  fc.integer({ min: 0, max: 6 * L }),
);
type Raw = { ax: number; ay: number; bx: number; by: number; f: WallFeature };
const anyWall = fc.record({ ax: coord, ay: coord, bx: coord, by: coord, f: wallFeatureArb }).map((w): Raw[] => [w]);
/** A short piece, 1/64 to 20/64 long. */
const shortWall = fc.record({ ax: coord, ay: coord, dx: fc.integer({ min: -20, max: 20 }), dy: fc.integer({ min: -20, max: 20 }), f: wallFeatureArb }).map((w): Raw[] => [{ ax: w.ax, ay: w.ay, bx: Math.max(0, w.ax + w.dx), by: Math.max(0, w.ay + w.dy), f: w.f }]);
/** A wall and a door or window beside it, along it or across it, a few 64ths off its line: the portal cut's case. */
const besideWall = fc
  .record({ x: coord, y: coord, len: fc.integer({ min: 64, max: 256 }), at: fc.integer({ min: 0, max: 192 }), dlen: fc.integer({ min: 16, max: 96 }), off: fc.integer({ min: -10, max: 10 }), down: fc.boolean(), f: wallFeatureArb })
  .map((w): Raw[] => {
    const wall: Raw = w.down ? { ax: w.x, ay: w.y, bx: w.x, by: w.y + w.len, f: { kind: "wall" } } : { ax: w.x, ay: w.y, bx: w.x + w.len, by: w.y, f: { kind: "wall" } };
    const s0 = w.at;
    const s1 = w.at + w.dlen;
    const portal: Raw = w.down ? { ax: Math.max(0, w.x + w.off), ay: w.y + s0, bx: Math.max(0, w.x + w.off), by: w.y + s1, f: w.f } : { ax: w.x + s0, ay: Math.max(0, w.y + w.off), bx: w.x + s1, by: Math.max(0, w.y + w.off), f: w.f };
    return [wall, portal];
  });
const freeWalls = fc
  .array(fc.oneof(anyWall, shortWall, besideWall), { maxLength: 8 })
  .map((groups) =>
    groups
      .flat()
      .map(({ ax, ay, bx, by, f }) => ({ a: [Math.min(ax, W * L) / L, Math.min(ay, H * L) / L] as [number, number], b: [Math.min(bx, W * L) / L, Math.min(by, H * L) / L] as [number, number], f }))
      .filter((w) => fits(w, 1)),
  );

function fits(w: { a: [number, number]; b: [number, number] }, min: number): boolean {
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  return len * L >= min && len <= 8;
}

const buildArb = () =>
  fc.record({
    rule: fc.constantFrom(...RULES),
    rects: fc.array(fc.record({ x: fc.integer({ min: 0, max: W - 1 }), y: fc.integer({ min: 0, max: H - 1 }), w: fc.integer({ min: 1, max: 6 }), h: fc.integer({ min: 1, max: 5 }), t: fc.constantFrom(...TERRAINS) }), { maxLength: 4 }),
    edges: fc.array(fc.record({ x: fc.integer({ min: 0, max: W - 1 }), y: fc.integer({ min: 0, max: H - 1 }), side: fc.constantFrom("n" as const, "w" as const), f: featureArb }), { maxLength: 12 }),
    walls: spacedWalls,
    lights: fc.array(fc.record({ x: fc.integer({ min: 1, max: W * L - 1 }), y: fc.integer({ min: 1, max: H * L - 1 }), bright: fc.integer({ min: 0, max: 60 }), dim: fc.integer({ min: 5, max: 60 }), color: fc.option(fc.constantFrom("#ffcc88", "#ffcc88aa", "#3366FF"), { nil: undefined }), walls: fc.boolean() }), { maxLength: 4 }),
  });

type Built = { input: BuildInput; rule: AutoWalls; lights: Light[] };

function built(b: fc.Arbitrary<{ rule: AutoWalls; rects: { x: number; y: number; w: number; h: number; t: TerrainId }[]; edges: { x: number; y: number; side: "n" | "w"; f: EdgeFeature }[]; walls: BuildInput["walls"]; lights: { x: number; y: number; bright: number; dim: number; color: string | undefined; walls: boolean }[] }>): fc.Arbitrary<Built> {
  return b.map((g) => {
    const cells: Record<string, TerrainId> = {};
    for (const r of g.rects) for (let y = r.y; y < Math.min(H, r.y + r.h); y++) for (let x = r.x; x < Math.min(W, r.x + r.w); x++) cells[`${x},${y}`] = r.t;
    const edges: Record<string, EdgeFeature> = {};
    for (const e of g.edges) edges[`${e.x},${e.y},${e.side}`] = e.f;
    const seen = new Set<string>();
    const walls = (g.walls ?? []).filter((w) => {
      const [p, q] = [w.a.join(), w.b.join()].sort();
      if (seen.has(`${p};${q}`)) return false;
      seen.add(`${p};${q}`);
      return true;
    });
    const lights = g.lights.map((l, i): Light => ({ id: `l${i}`, rev: 1, sceneId: "s", x: l.x / L, y: l.y / L, bright: l.bright, dim: l.dim, on: true, walls: l.walls, ...(l.color ? { color: l.color } : {}) }));
    return { input: { cells, edges, walls }, rule: g.rule, lights };
  });
}

function head(b: Built, view: "dm" | "player" = "dm", gridShape?: GridShape): UvttHead {
  return uvttGeometry({ scene: { bounds: { w: W, h: H }, ...(gridShape ? { gridShape } : {}) }, chunks: chunksOf(b.input), rule: b.rule, lights: b.lights, feetPerCell: 5, pxPerCell: 70 }, view);
}

/** Every 2-point piece the file holds, by kind: lines, each side of an object line, and portals. */
function piecesOf(json: Record<string, unknown>): Seg[] {
  const out: Seg[] = [];
  for (const line of [...(json.line_of_sight as Pt[][]), ...(json.objects_line_of_sight as Pt[][])]) for (let i = 0; i + 1 < line.length; i++) out.push({ a: line[i]!, b: line[i + 1]!, kind: "wall" });
  for (const p of json.portals as { bounds: [Pt, Pt]; closed: boolean }[]) out.push({ a: p.bounds[0], b: p.bounds[1], kind: p.closed ? "door" : "window" });
  return out;
}

const isInt = (v: number) => Number.isInteger(v);
const onGrid = (s: Seg) => isInt(s.a.x) && isInt(s.a.y) && isInt(s.b.x) && isInt(s.b.y) && (s.a.x === s.b.x) !== (s.a.y === s.b.y);
const same = (p: Pt, q: Pt) => p.x === q.x && p.y === q.y;
function dist(p: Pt, s: { a: Pt; b: Pt }): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(s.a.x + t * dx - p.x, s.a.y + t * dy - p.y);
}
function collinearOverlap(p: Seg, q: Seg): boolean {
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  if (cross(p.a, p.b, q.a) !== 0 || cross(p.a, p.b, q.b) !== 0) return false;
  const dx = p.b.x - p.a.x;
  const dy = p.b.y - p.a.y;
  const len2 = dx * dx + dy * dy;
  const t = (r: Pt) => ((r.x - p.a.x) * dx + (r.y - p.a.y) * dy) / len2;
  const [lo, hi] = [Math.min(t(q.a), t(q.b)), Math.max(t(q.a), t(q.b))];
  return Math.min(1, hi) - Math.max(0, lo) > 0;
}

/** The pairs that break the spaced rules: an end within a tenth of another piece it does not end on, or two kinds along one line. */
function crowded(pieces: readonly Seg[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = 0; j < pieces.length; j++) {
      if (i === j) continue;
      const p = pieces[i]!;
      const q = pieces[j]!;
      if (p.kind !== q.kind && collinearOverlap(p, q)) {
        out.push([i, j]);
        continue;
      }
      if (onGrid(p) && onGrid(q)) continue;
      for (const e of [p.a, p.b]) if (!same(e, q.a) && !same(e, q.b) && dist(e, q) < 0.1) out.push([i, j]);
    }
  }
  return out;
}

/** The build with every free wall that crowds another piece taken out, and every light within 0.05 of a piece, so what is left is spaced. */
function spaced(b: Built): Built {
  let current = b;
  for (;;) {
    const pieces = piecesOf(head(current).json);
    const key = (s: { a: Pt; b: Pt }) => [`${s.a.x},${s.a.y}`, `${s.b.x},${s.b.y}`].sort().join(";");
    const freeKeys = new Set((current.input.walls ?? []).map((w) => key({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] } })));
    const drop = new Set<string>();
    for (const [i, j] of crowded(pieces)) {
      const p = key(pieces[i]!);
      const q = key(pieces[j]!);
      if (freeKeys.has(p)) drop.add(p);
      else if (freeKeys.has(q)) drop.add(q);
      else throw new Error(`grid pieces crowd each other: ${p} ${q}`);
    }
    if (drop.size === 0) {
      const lights = current.lights.filter((l) => pieces.every((s) => dist(l, s) >= 0.05));
      return { ...current, lights };
    }
    current = { ...current, input: { ...current.input, walls: (current.input.walls ?? []).filter((w) => !drop.has(key({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] } }))) } };
  }
}

const kindOf = (f: WallFeature): Kind => (f.kind === "door" ? "door" : f.kind);

/** Unit edges by kind and free walls by kind, as text, so two sides compare as sets. */
function unitEdges(a: Pt, b: Pt): string[] {
  const out: string[] = [];
  if (a.y === b.y) for (let x = Math.min(a.x, b.x); x < Math.max(a.x, b.x); x++) out.push(`${x},${a.y},n`);
  else for (let y = Math.min(a.y, b.y); y < Math.max(a.y, b.y); y++) out.push(`${a.x},${y},w`);
  return out;
}

function expected(b: Built): { edges: Set<string>; free: Set<string> } {
  const build = indexBuild(chunksOf(b.input));
  const edges = new Set<string>();
  const free = new Set<string>();
  for (const e of effectiveEdges(build, b.rule)) edges.add(`${e.x},${e.y},${e.side}:${kindOf(e.feature)}`);
  const freeKey = (a: Pt, c: Pt, k: Kind) => `${[`${a.x},${a.y}`, `${c.x},${c.y}`].sort().join(";")}:${k}`;
  for (const w of b.input.walls ?? []) {
    const s: Seg = { a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, kind: kindOf(w.f) };
    if (onGrid(s)) for (const k of unitEdges(s.a, s.b)) edges.add(`${k}:${s.kind}`);
    else free.add(freeKey(s.a, s.b, s.kind));
  }
  const lo = 9 / 64;
  const hi = 1 - lo;
  for (const [key, t] of Object.entries(b.input.cells ?? {})) {
    if (t !== "pillar") continue;
    const [x, y] = key.split(",").map(Number) as [number, number];
    const c = [
      { x: x + lo, y: y + lo },
      { x: x + hi, y: y + lo },
      { x: x + hi, y: y + hi },
      { x: x + lo, y: y + hi },
    ];
    for (let i = 0; i < 4; i++) free.add(freeKey(c[i]!, c[(i + 1) % 4]!, "wall"));
  }
  return { edges, free };
}

describe("spaced square builds come back exactly", () => {
  test("the same effective walls, every door closed, lights at their places with their reach, Walls switch and color, and no note", () => {
    holds(
      fc.property(built(buildArb()), (raw) => {
        const b = spaced(raw);
        const h = head(b);
        assert.deepEqual(checkExport(h.json, 5), { changes: false, portalCut: false });
        assert.equal(h.counts.short, false);
        const plan = importBack(h);
        const want = expected(b);
        const gotEdges = new Set(plan.edges.map((e) => `${e.key}:${kindOf(e.feature)}`));
        assert.deepEqual([...gotEdges].sort(), [...want.edges].sort(), "grid edges by kind");
        const gotFree = new Set(plan.walls.map((w) => `${[`${w.a[0]},${w.a[1]}`, `${w.b[0]},${w.b[1]}`].sort().join(";")}:${kindOf(w.f)}`));
        assert.deepEqual([...gotFree].sort(), [...want.free].sort(), "free walls with the same ends");
        for (const f of [...plan.edges.map((e) => e.feature), ...plan.walls.map((w) => w.f)]) if (f.kind === "door") assert.equal(f.state, "closed");
        const lights = plan.lights.map((l) => `${l.x},${l.y},${l.bright + l.dim},${l.walls},${l.color}`).sort();
        const color = (c: string | undefined) => (c ? `#${c.slice(1, 7).toLowerCase()}` : "#ffffff");
        assert.deepEqual(lights, b.lights.map((l) => `${l.x},${l.y},${l.bright + l.dim},${l.walls},${color(l.color)}`).sort());
      }),
      150,
    );
  });
});

/** Within 0.2, sampled every 1/256 square, as the test's own reading of section 6's comparison: covered, not covered, or too close to call. */
function sampledCover(pieces: readonly Seg[], union: readonly Seg[]): "yes" | "no" | "close" {
  let close = false;
  for (const p of pieces) {
    const n = Math.max(1, Math.ceil(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) * 256));
    for (let k = 0; k <= n; k++) {
      const q = { x: p.a.x + ((p.b.x - p.a.x) * k) / n, y: p.a.y + ((p.b.y - p.a.y) * k) / n };
      const d = Math.min(Infinity, ...union.map((u) => dist(q, u)));
      if (d > 0.21) return "no";
      if (d > 0.19) close = true;
    }
  }
  return close ? "close" : "yes";
}

function oracle(h: UvttHead): boolean | null {
  const exported = piecesOf(h.json);
  const plan = importBack(h);
  const imported: Seg[] = [
    ...plan.edges.map((e): Seg => {
      const [x, y, side] = e.key.split(",");
      const a = { x: Number(x), y: Number(y) };
      return { a, b: side === "n" ? { x: a.x + 1, y: a.y } : { x: a.x, y: a.y + 1 }, kind: kindOf(e.feature) };
    }),
    ...plan.walls.map((w): Seg => ({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, kind: kindOf(w.f) })),
  ];
  const units = (list: Seg[]) => new Set(list.filter(onGrid).flatMap((s) => unitEdges(s.a, s.b).map((k) => `${k}:${s.kind}`)));
  const [ue, ui] = [units(exported), units(imported)];
  if (ue.size !== ui.size || [...ue].some((k) => !ui.has(k))) return true;
  let close = false;
  for (const kind of ["wall", "door", "window"] as const) {
    const e = exported.filter((s) => s.kind === kind && !onGrid(s));
    const i = imported.filter((s) => s.kind === kind && !onGrid(s));
    if (kind !== "wall" && e.length !== i.length) return true;
    for (const [from, to] of [
      [e, i],
      [i, e],
    ] as const) {
      if (from.length === 0) continue;
      if (to.length === 0) return true;
      const c = sampledCover(from, to);
      if (c === "no") return true;
      if (c === "close") close = true;
    }
  }
  return close ? null : false;
}

describe("free builds: the check's flags", () => {
  test("the note's flag is set exactly when the import's walls differ, and the loss line's exactly when a piece is under 14/64", () => {
    const freeBuild = built(
      fc.record({
        rule: fc.constantFrom(...RULES),
        rects: fc.constant([]),
        edges: fc.array(fc.record({ x: fc.integer({ min: 0, max: W - 1 }), y: fc.integer({ min: 0, max: H - 1 }), side: fc.constantFrom("n" as const, "w" as const), f: featureArb }), { maxLength: 4 }),
        walls: freeWalls,
        lights: fc.constant([]),
      }),
    );
    let differing = 0;
    holds(
      fc.property(freeBuild, (b) => {
        const h = head(b);
        const check = checkExport(h.json, 5);
        assert.ok("changes" in check, JSON.stringify(check));
        const differs = oracle(h);
        if (differs !== null) assert.equal(check.changes, differs);
        if (check.changes) differing++;
        const short = piecesOf(h.json).some((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * L < SHORT_LATTICE - 1e-9);
        assert.equal(h.counts.short, short);
      }),
      200,
    );
    assert.ok(differing > 0, "some builds change, or the generator is too tame to test the flag");
  });
});

describe("the player view", () => {
  test("no portal where an undiscovered secret door is, and no light", () => {
    holds(
      fc.property(built(buildArb()), (b) => {
        const chunks = chunksOf(b.input);
        const scene = { id: "s", fogEnabled: false, autoWalls: b.rule };
        const content = exportContent({ scene, buildChunks: Object.fromEntries(chunks.map((c) => [`s:${c.cx},${c.cy}`, c])), labels: {}, fogTiles: {}, stamps: {}, view: "player" });
        const h = uvttGeometry({ scene: { bounds: { w: W, h: H } }, chunks: content.chunks, rule: b.rule, lights: b.lights, feetPerCell: 5, pxPerCell: 70 }, "player");
        assert.deepEqual(h.json.lights, []);
        const hidden: { a: Pt; b: Pt }[] = [];
        for (const [key, f] of Object.entries(b.input.edges ?? {})) {
          if (f.kind !== "door" || !f.secret || f.discovered) continue;
          const [x, y, side] = key.split(",");
          const a = { x: Number(x), y: Number(y) };
          hidden.push({ a, b: side === "n" ? { x: a.x + 1, y: a.y } : { x: a.x, y: a.y + 1 } });
        }
        for (const w of b.input.walls ?? []) if (w.f.kind === "door" && w.f.secret && !w.f.discovered) hidden.push({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] } });
        for (const p of h.json.portals as { bounds: [Pt, Pt] }[]) {
          for (const s of hidden) assert.ok(!(same(p.bounds[0], s.a) && same(p.bounds[1], s.b)) && !(same(p.bounds[0], s.b) && same(p.bounds[1], s.a)), "a portal at a hidden door");
        }
      }),
      100,
    );
  });
});

describe("hex scenes", () => {
  for (const shape of ["hexRows", "hexColumns"] as const) {
    test(`${shape}: walls, doors and windows along hex sides come back within 0.2 of where they were`, () => {
      const g = gridOfShape(shape) as HexGrid;
      const hexes: { col: number; row: number }[] = [];
      for (let col = 0; col < 24; col++) for (let row = 0; row < 18; row++) if (hexInScene(g, { w: W, h: H }, { col, row })) hexes.push({ col, row });
      const side = fc.record({ hex: fc.constantFrom(...hexes), k: fc.integer({ min: 0, max: 5 }), f: wallFeatureArb });
      holds(
        fc.property(fc.array(side, { maxLength: 12 }), (sides) => {
          // A side two hexes share is one wall, so one of each.
          const byEnds = new Map<string, NonNullable<BuildInput["walls"]>[number]>();
          for (const s of sides) {
            const corners = hexCorners(g, s.hex);
            const a = cornerAt(g, corners[s.k]!);
            const c = cornerAt(g, corners[(s.k + 1) % 6]!);
            byEnds.set([`${a.x},${a.y}`, `${c.x},${c.y}`].sort().join(";"), { a: [a.x, a.y], b: [c.x, c.y], f: s.f });
          }
          const walls = [...byEnds.values()];
          const b: Built = { input: { walls }, rule: "all", lights: [] };
          const h = head(b, "dm", shape);
          const exported = piecesOf(h.json);
          const plan = importBack(h);
          const imported: Seg[] = [
            ...plan.edges.map((e): Seg => {
              const [x, y, sd] = e.key.split(",");
              const a = { x: Number(x), y: Number(y) };
              return { a, b: sd === "n" ? { x: a.x + 1, y: a.y } : { x: a.x, y: a.y + 1 }, kind: kindOf(e.feature) };
            }),
            ...plan.walls.map((w): Seg => ({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, kind: kindOf(w.f) })),
          ];
          for (const kind of ["wall", "door", "window"] as const) {
            const e = exported.filter((s) => s.kind === kind);
            const i = imported.filter((s) => s.kind === kind);
            assert.ok(coveredBy(e, i, 0.2) && coveredBy(i, e, 0.2), kind);
          }
        }),
        60,
      );
    });
  }
});

/** Kept so the chunk type stays in step with the model's. */
export type _Chunk = BuildChunk;
