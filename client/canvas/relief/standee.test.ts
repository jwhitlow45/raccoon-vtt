import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { occupiedRange } from "#shared/rules/footprint.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { drawnBase, drawnFootprintGround, heightsStand, isometric, K, toView, type DrawnSource, type Turn } from "../../lib/view.ts";
import { readFileSync } from "node:fs";
import { COVER_INSET } from "../../features/attach/groups.ts";
import { DECOR_REACH_PX, ellipseBox, standeeParts, standeeShape } from "./standee.ts";

const FEET = 5;

/** A scene "s1" whose first chunk has these heights in feet, keyed "x,y". */
function chunks(heights: Record<string, number>): Record<string, BuildChunk> {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number);
    feet[y! * CHUNK_CELLS + x!] = v;
  }
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } };
}

/** Fog revealing every cell but those listed, keyed "x,y". */
function fogHiding(...hidden: string[]): Record<string, FogTile> {
  const bits = new Uint8Array(TILE_BYTES).fill(0xff);
  for (const key of hidden) {
    const [x, y] = key.split(",").map(Number);
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < FOG_SUBCELLS; sx++) {
        const i = (y! * FOG_SUBCELLS + sy) * TILE_SUB + x! * FOG_SUBCELLS + sx;
        bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
      }
    }
  }
  return { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
}

/** A standee's shape as the board places it: base and ground from the drawn heights, in cells. */
function placed(src: DrawnSource, token: { x: number; y: number; elevation: number }, turn: Turn = 0) {
  const range = occupiedRange({ ...token, size: "medium" });
  const base = drawnBase(src, range, token.elevation) / FEET;
  const ground = drawnFootprintGround(src, range) / FEET;
  return standeeShape(turn, { x: token.x, y: token.y, w: 1, h: 1 }, base, ground, 40, 800);
}

describe("standees", () => {
  test("the art box stands on the footprint's center at its base, its ring the footprint's ellipse there, at every turn", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const s = standeeShape(turn, { x: 3, y: 4, w: 2, h: 2 }, 1, 0, 40, 800);
      const at = toView(isometric(turn), { x: 4, y: 5 }, 1);
      assert.ok(Math.abs(s.art.x0 - (at.x - 1)) < 1e-12 && Math.abs(s.art.x1 - (at.x + 1)) < 1e-12);
      assert.ok(Math.abs(s.art.y1 - at.y) < 1e-12 && Math.abs(s.art.y0 - (at.y - 2)) < 1e-12);
      // A circle d across on the ground is an ellipse d by d/2.
      assert.ok(Math.abs(s.ring.x1 - s.ring.x0 - 2) < 1e-12 && Math.abs(s.ring.y1 - s.ring.y0 - 1) < 1e-12);
      // Its shadow lies on the ground, K a cell below the base.
      assert.ok(s.shadow && Math.abs((s.shadow.y0 + s.shadow.y1) / 2 - (at.y + K)) < 1e-12);
    }
    assert.equal(standeeShape(0, { x: 3, y: 4, w: 1, h: 1 }, 0, 0, 40, 800).shadow, null, "no shadow on the ground");
  });

  test("a non-square footprint's ellipse is the turned ellipse's box", () => {
    const box = ellipseBox(1, 3, 1, { x: 0, y: 0 });
    const r = Math.SQRT1_2;
    assert.ok(Math.abs(box.x1 - Math.sqrt(1.5 * 1.5 * r * r + 0.5 * 0.5 * r * r)) < 1e-12);
  });

  test("a lift past one canvas height is capped, and says so", () => {
    const high = standeeShape(0, { x: 3, y: 4, w: 1, h: 1 }, 100, 0, 40, 800);
    assert.ok(high.capped);
    assert.ok(Math.abs(high.ground.y - high.base.y - 800 / 40) < 1e-9);
    assert.ok(!standeeShape(0, { x: 3, y: 4, w: 1, h: 1 }, 5, 0, 40, 800).capped);
  });

  test("security: a party token at one stored elevation on fogged ground draws the same over hidden 0 ft and hidden 10 ft", () => {
    for (const elevation of [0, 10, 25, -5]) {
      const shapes = [0, 10, 30].map((hidden) => {
        const src: DrawnSource = { chunks: chunks({ "6,6": hidden, "2,2": 10 }), sceneId: "s1", bounds: { w: 16, h: 16 }, fog: fogHiding("6,6"), stand: true };
        return placed(src, { x: 6, y: 6, elevation });
      });
      assert.deepEqual(shapes[1], shapes[0], `at ${elevation} ft`);
      assert.deepEqual(shapes[2], shapes[0], `at ${elevation} ft`);
    }
  });

  test("the ring, shadow and stem draw where the layout puts them, capped or not, at every turn", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      for (const [base, ground] of [
        [1, 0],
        [3, 2],
        [100, 0],
        [400, 10],
        [0, 0],
      ] as const) {
        const box = { x: 3, y: 4, w: 2, h: 2 };
        const shape = standeeShape(turn, box, base, ground, 40, 800);
        const parts = standeeParts(turn, shape.drawnBase, ground, box);
        const view = isometric(turn);
        const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        // The ring's group and the shadow sit at these world shifts inside the ground group, whose own lift is 0.
        const ring = toView(view, { x: middle.x + parts.base.x, y: middle.y + parts.base.y });
        const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
        assert.ok(near(ring.x, shape.base.x) && near(ring.y, shape.base.y), `ring at turn ${turn}, base ${base}`);
        assert.ok(near(shape.art.y1, ring.y), "the art stands on the ring");
        if (parts.shadow) {
          const shadow = toView(view, { x: middle.x + parts.shadow.x, y: middle.y + parts.shadow.y });
          assert.ok(near(shadow.y, shape.ground.y) && near(shadow.x, shape.ground.x), "the shadow on the ground");
          assert.ok(near(ring.y + parts.stem, shape.ground.y), "the stem from the ring down to the shadow");
        } else assert.equal(parts.stem, 0);
        if (shape.capped) assert.ok(shape.drawnBase < base && near(shape.ground.y - shape.base.y, 800 / 40), "a capped lift draws one canvas height up");
        else assert.equal(shape.drawnBase, base);
      }
    }
  });

  test("a rider's art draws, culls and casts its silhouette from one box, up its holder and inset where it covers it", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      for (const seat of [
        { rise: 0, inset: 1 },
        { rise: 0.5, inset: 1 },
        { rise: 1, inset: COVER_INSET },
      ]) {
        const box = { x: 3, y: 4, w: 2, h: 2 };
        const shape = standeeShape(turn, box, 2, 0, 40, 800, seat);
        const parts = standeeParts(turn, shape.drawnBase, 0, box, seat);
        const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
        // The drawing's art corner, from the ring's middle in the upright group, is the layout's art box.
        assert.ok(near(shape.base.x + parts.art.x, shape.art.x0) && near(shape.base.y + parts.art.y, shape.art.y0), `art corner at ${JSON.stringify(seat)}`);
        assert.ok(near(box.w * parts.art.scale, shape.art.x1 - shape.art.x0) && near(box.h * parts.art.scale, shape.art.y1 - shape.art.y0), "art size");
        assert.ok(near(shape.art.y1, shape.base.y - seat.rise), "it stands up its holder");
        // The decor's frame is the footprint's size, standing where the art stands, around it.
        assert.ok(near(shape.frame.y1, shape.art.y1) && near(shape.frame.x1 - shape.frame.x0, box.w) && shape.frame.x0 <= shape.art.x0 && shape.frame.y0 <= shape.art.y0);
        // Culling keeps all of it.
        assert.ok(shape.bounds.y0 <= shape.frame.y0 - DECOR_REACH_PX.top / 40 + 1e-9, "its chips over the raised frame");
        assert.ok(shape.bounds.x0 < shape.frame.x0 && shape.bounds.x1 > shape.frame.x1);
      }
    }
  });

  test("the board lays decor out on the frame and draws silhouettes from the seated art", () => {
    const board = readFileSync(new URL("./IsoBoard.tsx", import.meta.url), "utf8");
    assert.match(board, /return \{ x: s\.frame\.x0, y: s\.frame\.y0 \};/);
    assert.match(board, /standeeShape\(turn, \{ x: t\.x, y: t\.y, w: fp\.w, h: fp\.h \}, base, ground, cam\.scale, size\.height, seat\)/);
    assert.match(board, /rise: seat\.rise,\n\s+inset: seat\.inset,/);
    const node = readFileSync(new URL("../TokenNode.tsx", import.meta.url), "utf8");
    assert.match(node, /standeeParts\(iso\.turn, iso\.drawn, iso\.ground, \{ w, h \}, iso\)/);
  });

  test("the standee draws from the base the layout capped, never the logical one", () => {
    const node = readFileSync(new URL("../TokenNode.tsx", import.meta.url), "utf8");
    const standee = node.slice(node.indexOf("function Standee("), node.indexOf("\n}\n", node.indexOf("function Standee(")));
    assert.match(standee, /standeeParts\(iso\.turn, iso\.drawn, iso\.ground,/);
    assert.doesNotMatch(standee, /iso\.base/);
    const board = readFileSync(new URL("./IsoBoard.tsx", import.meta.url), "utf8");
    assert.equal(board.match(/drawn: shape\.drawnBase/g)?.length, 2, "standees and ghosts both carry the capped base");
  });

  test("at 12 px a cell a standee on a seen 10 ft platform stands 10 ft up, and at 11 px it stands on the flat ground", () => {
    const at = (scale: number) => {
      const src: DrawnSource = { chunks: chunks({ "6,6": 10 }), sceneId: "s1", bounds: { w: 16, h: 16 }, fog: null, stand: heightsStand(scale, false) };
      return placed(src, { x: 6, y: 6, elevation: 10 });
    };
    const ground = toView(isometric(0), { x: 6.5, y: 6.5 });
    assert.ok(Math.abs(at(12).art.y1 - (ground.y - 2 * K)) < 1e-12);
    assert.ok(Math.abs(at(11).art.y1 - ground.y) < 1e-12);
  });
});
