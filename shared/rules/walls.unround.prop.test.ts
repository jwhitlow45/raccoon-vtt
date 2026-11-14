import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { lift, wall } from "../discoveryTestutil.ts";
import type { FreeWall, RoomState, Token, WallFeature } from "../model.ts";
import { projectState } from "../project.ts";
import { holds } from "../propertyTestutil.ts";
import { P1, room, scene, token } from "../testutil.ts";
import { legStop, ownWalk, previewChunks } from "./movement.ts";
import { contact, CROSS, EXACT_PIECE, LATTICE, PIECE } from "./segments.ts";
import { sceneWalls, unroundedPiece } from "./walls.ts";

/*
 * A player's copy of a square scene cut from held ground holds its free
 * walls as pieces: cut at held cells and at the split lines x or y = 4m,
 * the chunk edges among them, each end on a cell side moved 1/10000 cell
 * outward (decision 2). The device puts a piece back on its stored wall
 * where that can be undone exactly (walls.ts unroundedPiece, D-261113-040)
 * and reads it as the server reads the wall: so a walk on a copy that holds
 * every wall is judged as on the stored build (e2e fu44b-1).
 */

const W = 24;
const H = 20;
type Seg = [number, number, number, number];

function stored(walls: readonly { a: [number, number]; b: [number, number]; f?: WallFeature }[], fog: false | { x: number; y: number; w: number; h: number }): RoomState {
  const s = room({ scenes: { s1: scene("s1", { bounds: { w: W, h: H }, blockMovement: true, fogEnabled: fog !== false }) } });
  s.buildChunks = {};
  walls.forEach((w, i) => wall(s, `wc${String(i).padStart(10, "0")}`, w.a, w.b, w.f ?? { kind: "wall" }));
  if (fog) lift(s, "dm", fog);
  return s;
}

const copyOf = (s: RoomState) => projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
const piecesOf = (copy: RoomState): FreeWall[] => Object.values(copy.buildChunks).flatMap((c) => c?.walls ?? []);
const sorted = (segs: Seg[]) => segs.map((s) => s.join(",")).sort();

describe("pieces put back on their stored walls, cut at chunk edges (table)", () => {
  const cases: { name: string; wall: { a: [number, number]; b: [number, number]; f?: WallFeature }; back: Seg[] | null }[] = [
    { name: "along a grid line across the chunk edge x = 16", wall: { a: [14, 3], b: [18, 3] }, back: [[14, 3, 16, 3], [16, 3, 18, 3]] },
    { name: "on the chunk edge x = 16, across y = 4 and 8", wall: { a: [16, 2], b: [16, 9.5] }, back: [[16, 2, 16, 4], [16, 4, 16, 8], [16, 8, 16, 9.5]] },
    { name: "off the grid, across the chunk edge y = 16", wall: { a: [3.5, 14.25], b: [3.5, 17.75] }, back: [[3.5, 14.25, 3.5, 16], [3.5, 16, 3.5, 17.75]] },
    { name: "on the chunk edge y = 16, across x = 16", wall: { a: [12, 16], b: [20, 16] }, back: [[12, 16, 16, 16], [16, 16, 20, 16]] },
    { name: "on the scene's west side, its end clamped", wall: { a: [0, 2], b: [0, 9] }, back: [[0, 2, 0, 4], [0, 4, 0, 8], [0, 8, 0, 9]] },
    { name: "a stub inside one cell", wall: { a: [2.25, 5.625], b: [2.625, 5.25] }, back: [[2.25, 5.625, 2.625, 5.25]] },
    { name: "a diagonal inside one band, its ends inside cells", wall: { a: [16.25, 1.5], b: [19.75, 2.375] }, back: [[16.25, 1.5, 19.75, 2.375]] },
    { name: "a visible door across the chunk edge, whole", wall: { a: [15.5, 3.5], b: [16.5, 4.5], f: { kind: "door", state: "closed", secret: false, discovered: false } }, back: [[15.5, 3.5, 16.5, 4.5]] },
    { name: "a diagonal cut at the chunk edge keeps its band", wall: { a: [14.5, 3.25], b: [17.5, 4.75] }, back: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const s = stored([c.wall], false);
      const copy = copyOf(s);
      const pieces = piecesOf(copy);
      const back = pieces.map(unroundedPiece);
      if (c.back === null) {
        assert.ok(pieces.length >= 2 && back.every((b) => b === null), JSON.stringify(pieces.map((p) => [p.a, p.b])));
      } else {
        assert.deepEqual(sorted(back.map((b) => b!)), sorted(c.back), JSON.stringify(pieces.map((p) => [p.a, p.b])));
      }
      // The device's wall set holds each as it was put back, or as the piece where it was not.
      const set = sceneWalls(copy.scenes.s1!, copy.buildChunks);
      const kinds = [...set.stored.free];
      assert.equal(kinds.filter((f) => f === EXACT_PIECE).length, back.filter((b) => b !== null).length);
      assert.equal(kinds.filter((f) => f === PIECE).length, back.filter((b) => b === null).length);
    });
  }
});

test("walls put back that cross are split where they cross, as pieces are, and the split's count leaves them out", () => {
  const copy = copyOf(stored([{ a: [3.5, 0.25], b: [3.5, 3.75] }, { a: [1.25, 2.5], b: [6.75, 2.5] }], false));
  const set = sceneWalls(copy.scenes.s1!, copy.buildChunks);
  assert.deepEqual([...set.stored.free].filter((f) => f !== 0), [EXACT_PIECE, EXACT_PIECE, EXACT_PIECE]);
  assert.equal(set.count.pairs, 0, "the count leaves them out, so a copy that holds a long wall as several pieces never passes the caps its stored build is under");
  const p = set.pieces;
  for (let i = 0; i < p.n; i++) {
    for (let j = i + 1; j < p.n; j++) {
      const c = contact(p.xy[4 * i]!, p.xy[4 * i + 1]!, p.xy[4 * i + 2]!, p.xy[4 * i + 3]!, p.xy[4 * j]!, p.xy[4 * j + 1]!, p.xy[4 * j + 2]!, p.xy[4 * j + 3]!);
      assert.notEqual(c, CROSS, `pieces ${i} and ${j} cross`);
    }
  }
});

/** A lattice coordinate along an axis: a grid line most often, else a quarter or a 1/64 step off one. */
const coord = (max: number) => fc.oneof(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: max * 4 }).map((q) => q / 4), fc.integer({ min: 0, max: max * LATTICE }).map((q) => q / LATTICE));

/** A wall along an axis, at most 8 cells, inside the scene. */
const axisWall = fc.tuple(fc.boolean(), coord(W), coord(W), fc.integer({ min: 1, max: 32 })).map(([across, line, from, quarters]) => {
  const [lineMax, alongMax] = across ? [H, W] : [W, H];
  const l = Math.min(line, lineMax);
  const a = Math.min(from, alongMax - 0.25);
  const b = Math.min(a + quarters / 4, alongMax);
  return across ? { a: [a, l] as [number, number], b: [b, l] as [number, number] } : { a: [l, a] as [number, number], b: [l, b] as [number, number] };
});

/** A diagonal inside one band of 4 by 4 cells, its ends strictly inside cells, which no split cuts. */
const bandDiagonal = fc
  .tuple(fc.integer({ min: 0, max: W / 4 - 1 }), fc.integer({ min: 0, max: H / 4 - 1 }), fc.array(fc.integer({ min: 1, max: 63 }), { minLength: 2, maxLength: 2 }), fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 4, maxLength: 4 }))
  .map(([bx, by, [fx, fy], [ci, cj, ck, cl]]) => ({ a: [bx * 4 + ci! + fx! / 64, by * 4 + cj! + fy! / 64] as [number, number], b: [bx * 4 + ck! + fy! / 64, by * 4 + cl! + fx! / 64] as [number, number] }))
  .filter((w) => w.a[0] !== w.b[0] && w.a[1] !== w.b[1]);

/** Any wall on the lattice, at most 8 cells long. */
const anyWall = fc.tuple(coord(W), coord(H), fc.integer({ min: -22, max: 22 }), fc.integer({ min: -22, max: 22 })).map(([x, y, dx, dy]) => {
  const bx = Math.min(Math.max(x + dx / 4, 0), W);
  const by = Math.min(Math.max(y + dy / 4, 0), H);
  return { a: [x, Math.min(y, H)] as [number, number], b: [bx, by] as [number, number] };
});

const nonZero = (w: { a: [number, number]; b: [number, number] }) => w.a[0] !== w.b[0] || w.a[1] !== w.b[1];

/** Whether a segment lies on stored wall `w`: on its line, between its ends. */
function along(w: { a: [number, number]; b: [number, number] }, [ax, ay, bx, by]: Seg): boolean {
  const ex = w.b[0] - w.a[0];
  const ey = w.b[1] - w.a[1];
  // In lattice units every product here is a whole number below 2^53, so the test is exact.
  const L = LATTICE;
  const on = (x: number, y: number) => ex * L * ((y - w.a[1]) * L) - ey * L * ((x - w.a[0]) * L) === 0;
  const t = (x: number, y: number) => ((x - w.a[0]) * ex + (y - w.a[1]) * ey) / (ex * ex + ey * ey);
  return on(ax, ay) && on(bx, by) && t(ax, ay) >= 0 && t(ax, ay) <= 1 && t(bx, by) >= 0 && t(bx, by) <= 1;
}

/** A union of intervals, merged where they touch or overlap. */
function union(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo, hi] of [...spans].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

describe("pieces put back on their stored walls (property)", () => {
  test("a piece put back lies on the lattice and on a stored wall, every piece along an axis is put back, and with fog off they cover each line as its walls do", () => {
    const reveal = fc.oneof(fc.constant(false as const), fc.record({ x: fc.integer({ min: 0, max: W - 1 }), y: fc.integer({ min: 0, max: H - 1 }), w: fc.integer({ min: 1, max: W }), h: fc.integer({ min: 1, max: H }) }));
    holds(
      fc.property(fc.array(fc.oneof(axisWall, anyWall, bandDiagonal).filter(nonZero), { minLength: 1, maxLength: 10 }), reveal, (walls, fog) => {
        const pieces = piecesOf(copyOf(stored(walls, fog)));
        const back: Seg[] = [];
        for (const p of pieces) {
          const r = unroundedPiece(p);
          const axis = p.a[0] === p.b[0] || p.a[1] === p.b[1];
          if (axis) assert.ok(r, `an axis piece is put back: ${JSON.stringify([p.a, p.b])}`);
          if (!r) continue;
          assert.ok(r.every((v) => Number.isInteger(v * LATTICE)), `on the lattice: ${r}`);
          assert.ok(walls.some((w) => along(w, r)), `on a stored wall: ${r} from ${JSON.stringify([p.a, p.b])}`);
          back.push(r);
        }
        if (fog !== false) return;
        // Every square is held, so the pieces of the walls along one axis line, put back, cover what the walls do.
        const lines = new Map<string, { walls: [number, number][]; back: [number, number][] }>();
        const file = (seg: Seg, into: "walls" | "back") => {
          const [ax, ay, bx, by] = seg;
          if (ax !== bx && ay !== by) return;
          const key = ax === bx ? `x${ax}` : `y${ay}`;
          const span: [number, number] = ax === bx ? [Math.min(ay, by), Math.max(ay, by)] : [Math.min(ax, bx), Math.max(ax, bx)];
          let line = lines.get(key);
          if (!line) lines.set(key, (line = { walls: [], back: [] }));
          line[into].push(span);
        };
        for (const w of walls) file([w.a[0], w.a[1], w.b[0], w.b[1]], "walls");
        for (const r of back) file(r, "back");
        for (const [key, line] of lines) assert.deepEqual(union(line.back), union(line.walls), key);
      }),
      200,
    );
  });

  test("on a copy that holds every wall, each one along an axis or inside one band, a leg is stopped as on the stored build, for the gate and a preview alike", () => {
    const size = fc.constantFrom<Token["size"]>("small", "medium", "large", "huge");
    const half = (max: number) => fc.integer({ min: 0, max: max * 2 }).map((v) => v / 2);
    const leg = fc.record({ size, x: half(W - 4), y: half(H - 4), dx: fc.integer({ min: -8, max: 8 }), dy: fc.integer({ min: -8, max: 8 }) });
    holds(
      fc.property(fc.array(fc.oneof(axisWall, bandDiagonal).filter(nonZero), { minLength: 1, maxLength: 12 }), fc.array(leg, { minLength: 1, maxLength: 8 }), (walls, legs) => {
        const s = stored(walls, false);
        const copy = copyOf(s);
        for (const g of legs) {
          const walker = ownWalk(token("t", { sceneId: "s1", size: g.size, x: g.x, y: g.y }));
          const to = { x: Math.min(Math.max(g.x + g.dx / 2, 0), W - 4), y: Math.min(Math.max(g.y + g.dy / 2, 0), H - 4), elevation: 0 };
          const exact = legStop(s, walker, to) === null;
          const at = `${g.size} from ${g.x}, ${g.y} to ${to.x}, ${to.y}`;
          assert.equal(legStop(copy, walker, to) === null, exact, `the gate, ${at}`);
          assert.equal(legStop({ ...copy, buildChunks: previewChunks(copy.buildChunks) }, walker, to) === null, exact, `a preview, ${at}`);
        }
      }),
      150,
    );
  });
});
