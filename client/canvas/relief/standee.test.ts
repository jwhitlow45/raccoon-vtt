import assert from "node:assert/strict";
import { footprintCells } from "../../lib/groundCells.ts";
import { describe, test } from "node:test";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { drawnBase, drawnFootprintGround, heightsStand, isometric, K, toView, type DrawnSource, type Turn } from "../../lib/view.ts";
import { readFileSync } from "node:fs";
import { COVER_INSET } from "../../features/attach/groups.ts";
import { DECOR_REACH_PX, ellipseBox, ON_GROUND, seatRise, standeeModel, standeeParts, standeeShape, type StandeeModel } from "./standee.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { ReliefIndex, type StandeeIn } from "./buckets.ts";

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
  const cells = footprintCells(SQUARES, { ...token, size: "medium" });
  const base = drawnBase(src, cells, token.elevation) / FEET;
  const ground = drawnFootprintGround(src, cells) / FEET;
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
        const src: DrawnSource = { chunks: chunks({ "6,6": hidden, "2,2": 10 }), sceneId: "s1", bounds: { w: 16, h: 16 }, grid: SQUARES, fog: fogHiding("6,6"), stand: true };
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
    // The decor and the label layout both place a standee's decor by its frame (isoText.ts decorPlace).
    assert.match(board, /const at = decorPlace\(view, grid, t, s, s \? 0 : flatGround\(t\)\);/);
    const text = readFileSync(new URL("./isoText.ts", import.meta.url), "utf8");
    assert.match(text, /if \(standee\) return \{ x: standee\.frame\.x0, y: standee\.frame\.y0, ring: standee\.ring \};/);
    // Its box is the drawn one (stand.ts standeeFooting, docs/design/design-v1-snap-off.md 6.2).
    assert.match(board, /const \{ box, cells \} = standeeFooting\(grid, t\);/);
    assert.match(board, /standeeShape\(turn, box, base, ground, cam\.scale, size\.height, seat, shown\?\.shape \?\? null\)/);
    assert.match(board, /rise: seat\.rise,\n\s+inset: seat\.inset,/);
    const node = readFileSync(new URL("../TokenNode.tsx", import.meta.url), "utf8");
    assert.match(node, /standeeParts\(iso\.turn, iso\.drawn, iso\.ground, \{ w, h \}, iso, model\?\.shape \?\? null\)/);
  });

  test("the standee draws from the base the layout capped, never the logical one", () => {
    const node = readFileSync(new URL("../TokenNode.tsx", import.meta.url), "utf8");
    const standee = node.slice(node.indexOf("function Standee("), node.indexOf("\n}\n", node.indexOf("function Standee(")));
    assert.match(standee, /standeeParts\(iso\.turn, iso\.drawn, iso\.ground,/);
    assert.doesNotMatch(standee, /iso\.base/);
    const board = readFileSync(new URL("./IsoBoard.tsx", import.meta.url), "utf8");
    assert.equal(board.match(/drawn: shape\.drawnBase/g)?.length, 3, "standees, ghosts and a local drag's standees all carry the capped base");
  });

  test("at 12 px a cell a standee on a seen 10 ft platform stands 10 ft up, and at 11 px it stands on the flat ground", () => {
    const at = (scale: number) => {
      const src: DrawnSource = { chunks: chunks({ "6,6": 10 }), sceneId: "s1", bounds: { w: 16, h: 16 }, grid: SQUARES, fog: null, stand: heightsStand(scale, false) };
      return placed(src, { x: 6, y: 6, elevation: 10 });
    };
    const ground = toView(isometric(0), { x: 6.5, y: 6.5 });
    assert.ok(Math.abs(at(12).art.y1 - (ground.y - 2 * K)) < 1e-12);
    assert.ok(Math.abs(at(11).art.y1 - ground.y) < 1e-12);
  });
});

/** A model's frame as a sheet lays it out: a little over a footprint, anchored low, its figure in the middle. */
const KNIGHT: StandeeModel = { side: 1.5, anchorY: 0.75, box: [30, 10, 70, 80] };

describe("standing as a 3D model (docs/design/design-v1-token-models.md 4.4 and 6)", () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const sameBox = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => near(a.x0, b.x0) && near(a.y0, b.y0) && near(a.x1, b.x1) && near(a.y1, b.y1);

  test("its frame hangs from its anchor on the ring's middle at its footprint's longer side, and only its drawn box paints", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      // A custom 2 by 1 footprint draws the model at 2, centered (D-261127-383).
      const box = { x: 3, y: 4, w: 2, h: 1 };
      const s = standeeShape(turn, box, 1, 0, 40, 800, ON_GROUND, KNIGHT);
      const at = toView(isometric(turn), { x: 4, y: 4.5 }, 1);
      assert.ok(sameBox(s.art, { x0: at.x - 1.5, x1: at.x + 1.5, y0: at.y - 2.25, y1: at.y + 0.75 }), `art at turn ${turn}`);
      assert.ok(sameBox(s.drawnBox, { x0: at.x - 0.6, x1: at.x + 0.6, y0: at.y - 1.95, y1: at.y + 0.15 }), `drawn box at turn ${turn}`);
      // The ring is the footprint's, as a picture's is.
      assert.deepEqual(s.ring, standeeShape(turn, box, 1, 0, 40, 800).ring);
    }
  });

  test("its decor sits over its drawn top, and culling holds its drawn box, its decor and its ring", () => {
    const box = { x: 3, y: 4, w: 1, h: 1 };
    // A tall model, its drawn top high over a picture's.
    const tall: StandeeModel = { side: 3, anchorY: 0.9, box: [20, 5, 95, 92] };
    const s = standeeShape(0, box, 0, 0, 40, 800, ON_GROUND, tall);
    assert.ok(near(s.frame.y0, s.drawnBox.y0) && near(s.frame.y1 - s.frame.y0, 1) && near(s.frame.x1 - s.frame.x0, 1), "a footprint-sized frame from the drawn top");
    assert.ok(s.frame.y0 < standeeShape(0, box, 0, 0, 40, 800).frame.y0 - 1);
    const k = 1 / 40;
    assert.ok(s.bounds.y0 <= s.drawnBox.y0 - DECOR_REACH_PX.top * k + 1e-9, "its chips over the drawn top");
    assert.ok(s.bounds.x1 >= s.drawnBox.x1 + DECOR_REACH_PX.side * k - 1e-9, "a wing past the footprint");
    assert.ok(s.bounds.x0 <= s.ring.x0 && s.bounds.y1 >= s.ring.y1 + DECOR_REACH_PX.bottom * k - 1e-9);
    // A short one's decor frame reaches past its ring's bottom, and the bounds keep it.
    const flat = standeeShape(0, box, 0, 0, 40, 800, ON_GROUND, { side: 1, anchorY: 0.6, box: [10, 40, 90, 70] });
    assert.ok(flat.frame.y1 > flat.ring.y1 && flat.bounds.y1 >= flat.frame.y1 + DECOR_REACH_PX.bottom * k - 1e-9);
  });

  test("a picture keeps its shape, its drawn box its art", () => {
    for (const seat of [ON_GROUND, { rise: 0.5, inset: 1 }, { rise: 1, inset: COVER_INSET }]) {
      const s = standeeShape(2, { x: 3, y: 4, w: 2, h: 2 }, 2, 0, 40, 800, seat, null);
      assert.deepEqual(s.drawnBox, s.art);
      assert.deepEqual(s, standeeShape(2, { x: 3, y: 4, w: 2, h: 2 }, 2, 0, 40, 800, seat));
    }
  });

  test("the drawing's corner, the box it draws and takes presses on, and its decor's corner are the layout's art, drawn box and frame, at every turn and seat", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      for (const seat of [ON_GROUND, { rise: 0.7, inset: 1 }, { rise: 1, inset: COVER_INSET }]) {
        for (const [base, ground] of [[0, 0], [2, 0], [400, 10]] as const) {
          const box = { x: 3, y: 4, w: 2, h: 1 };
          const shape = standeeShape(turn, box, base, ground, 40, 800, seat, KNIGHT);
          const parts = standeeParts(turn, shape.drawnBase, ground, box, seat, KNIGHT);
          const m = parts.model!;
          const k = parts.art.scale;
          // The art's group stands at the ring's middle in view units (the upright group), scaled by the seat's inset.
          const corner = { x: shape.base.x + parts.art.x, y: shape.base.y + parts.art.y };
          assert.ok(near(corner.x, shape.art.x0) && near(corner.y, shape.art.y0), `art at turn ${turn}, seat ${JSON.stringify(seat)}, base ${base}`);
          const drawn = { x0: corner.x + m.drawn.x * k, y0: corner.y + m.drawn.y * k, x1: corner.x + (m.drawn.x + m.drawn.w) * k, y1: corner.y + (m.drawn.y + m.drawn.h) * k };
          assert.ok(sameBox(drawn, shape.drawnBox), "it draws, and takes a press, on the drawn box alone");
          assert.ok(near(shape.base.x + parts.decor.x, shape.frame.x0) && near(shape.base.y + parts.decor.y, shape.frame.y0), "a dragged model's decor on its frame");
        }
      }
    }
    // A picture's decor corner is its frame's too.
    const box = { x: 3, y: 4, w: 2, h: 1 };
    const seat = { rise: 0.7, inset: COVER_INSET };
    const shape = standeeShape(1, box, 0, 0, 40, 800, seat);
    const parts = standeeParts(1, shape.drawnBase, 0, box, seat);
    assert.equal(parts.model, null);
    assert.ok(near(shape.base.x + parts.decor.x, shape.frame.x0) && near(shape.base.y + parts.decor.y, shape.frame.y0));
  });

  test("a rider sits half its holder's picture up it, or at the middle of a model holder's drawn box, never under its ring", () => {
    assert.equal(seatRise({ w: 2, h: 2 }, null), 1);
    // Drawn from 0.1 to 0.8 of a 3 view unit frame anchored at 0.75: its middle 0.3 of the frame above the anchor.
    assert.ok(near(seatRise({ w: 2, h: 1 }, KNIGHT), 0.9));
    assert.equal(seatRise({ w: 1, h: 1 }, { side: 1, anchorY: 0.2, box: [0, 40, 100, 90] }), 0);
  });

  test("a model's frame is the one its turn and facing pick", () => {
    const ref = { side: 1.2, anchorY: 0.7, boxes: Array.from({ length: 8 }, (_, i) => [i, 10, 50 + i, 90] as [number, number, number, number]) };
    assert.deepEqual(standeeModel(ref, 5), { side: 1.2, anchorY: 0.7, box: [5, 10, 55, 90] });
  });

  test("a model takes a silhouette from what a later standee paints, never from its decor's reach, which the overlay draws over every piece", () => {
    const relief = new ReliefIndex();
    relief.sync({ sceneId: "s1", bounds: { w: 20, h: 20 }, chunks: {}, tiles: null, walls: new Map(), global: {}, grid: SQUARES, src: { ground: () => 0, terrain: () => null, look: () => ({ texture: null, color: "#808080" }), bounds: { w: 20, h: 20 }, grid: SQUARES } });
    const standing = (id: string, x: number, y: number, model: StandeeModel | null): StandeeIn => {
      const s = standeeShape(0, { x, y, w: 1, h: 1 }, 0, 0, 40, 800, ON_GROUND, model);
      return { id, x: x + 0.5, y: y + 0.5, cells: [{ col: x, row: y }], base: 0, holder: null, bounds: s.bounds, art: s.drawnBox, paints: s.paints };
    };
    const outlined = (front: { x: number; y: number }) => {
      const items = relief.layout(0, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, [standing("knight", 5, 5, KNIGHT), standing("front", front.x, front.y, null)]);
      const knight = items.find((i) => i.kind === "standee" && i.id === "knight");
      assert.ok(knight?.kind === "standee" && items.indexOf(knight) < items.findIndex((i) => i.kind === "standee" && i.id === "front"), "the knight draws first");
      return knight.silhouette;
    };
    // Two cells to the east and one south its name and chips would reach the knight, but nothing it paints does.
    assert.equal(outlined({ x: 8, y: 6 }), false);
    // Right in front, its picture covers the knight's feet.
    assert.equal(outlined({ x: 6, y: 6 }), true);
  });

  test("the board's every standee shape reads the model modelShown gave, and the drawing reads the layout's", () => {
    const board = readFileSync(new URL("./IsoBoard.tsx", import.meta.url), "utf8");
    // The layout, the bounds a waiting model asks by, a drag and a ghost.
    const calls = board.match(/standeeShape\([^)]*\)/g) ?? [];
    assert.equal(calls.length, 4);
    for (const call of calls) assert.match(call, /, (shown\?\.shape \?\? null|want|model)\)$/, call);
    assert.match(board, /const shown = modelShown\(t, actor, sheets\);/);
    assert.match(board, /model: s\.model \}/);
    assert.match(board, /model: shown \};/);
    // A covered model's outline goes round its drawn box.
    assert.match(board, /art: shape\.drawnBox,/);
    const node = readFileSync(new URL("../TokenNode.tsx", import.meta.url), "utf8");
    assert.match(node, /\{model && parts\.model \? <ModelArt model=\{model\} parts=\{parts\.model\} \/> : <TokenBody/);
    // The image is the drawn box itself, cropped to it, so its own hit is that box: no hitFunc may widen it.
    const art = node.slice(node.indexOf("function ModelArt("), node.indexOf("\n}\n", node.indexOf("function ModelArt(")));
    assert.match(art, /x=\{drawn\.x\} y=\{drawn\.y\} width=\{drawn\.w\} height=\{drawn\.h\} crop=\{crop\}/);
    assert.match(art, /drawnCrop\(frame, shape\.box, image\)/);
    assert.doesNotMatch(art, /hitFunc|sceneFunc/);
  });
});
