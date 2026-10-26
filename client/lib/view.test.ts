import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Konva from "konva";
import { CHUNK_CELLS, MAX_HEIGHT_FT, MIN_HEIGHT_FT, type BuildChunk, type RoomState } from "#shared/model.ts";
import type { CellRange } from "#shared/rules/footprint.ts";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { reveal, rng, room, scene } from "#shared/testutil.ts";
import { groundSource } from "../features/builder/heights/ground.ts";
import { screenToView, viewToScreen, type Camera, type Point } from "./camera.ts";
import {
  arrowStep,
  depth,
  drawnBase,
  drawnFootprintGround,
  drawnGround,
  drawnHeights,
  FACE_NUDGE,
  flatHeights,
  groundAtMiddle,
  groundGroups,
  heightsStand,
  isometric,
  K,
  liveOfStage,
  pickGround,
  pickWalk,
  seenFootprintGround,
  TOP_DOWN,
  toView,
  toWorld,
  turned,
  viewBox,
  type DrawnHeights,
  type DrawnSource,
  type Turn,
  type View,
  type ViewPoint,
} from "./view.ts";

const TURNS: readonly Turn[] = [0, 1, 2, 3];

/** The cells a footprint of w by h covers from x, y, as footprint.ts occupiedRange gives them. */
function rectRange(x: number, y: number, w: number, h: number): CellRange {
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}
const CAM: Camera = { x: 317.25, y: -41.5, scale: 40 };

function near(actual: number, expected: number, within: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);
}

/** The screen point where world point `p` at height `z` shows. */
function screenOf(view: View, p: Point, z: number, cam: Camera = CAM): Point {
  return viewToScreen(cam, toView(view, p, z));
}

describe("the projection (docs/design-v1-isometric-view.md 4.1)", () => {
  test("Top-down is the identity, every height drawn flat", () => {
    const p = { x: 12.375, y: -7.5 };
    assert.deepEqual(toView(TOP_DOWN, p, 40), { x: 12.375, y: -7.5 });
    assert.deepEqual(toWorld(TOP_DOWN, { x: 3.25, y: 9 } as ViewPoint, -3), { x: 3.25, y: 9 });
  });

  test("a point through each turn and back, over the model's coordinates and heights, within 1e-9 cells", () => {
    const random = rng(4101);
    for (const turn of TURNS) {
      const view = isometric(turn);
      for (let i = 0; i < 4000; i++) {
        const p = { x: random() * 2000 - 1000, y: random() * 2000 - 1000 };
        // A token's elevation at 1 ft a cell spans the protocol's feet, and every painted ground lies inside it.
        const z = i % 2 === 0 ? random() * 200_000 - 100_000 : MIN_HEIGHT_FT + random() * (MAX_HEIGHT_FT - MIN_HEIGHT_FT);
        const back = toWorld(view, toView(view, p, z), z);
        near(back.x, p.x, 1e-9, `turn ${turn} x`);
        near(back.y, p.y, 1e-9, `turn ${turn} y`);
      }
    }
  });

  test("hex centers of both orientations go round as any point does, so the projection needs no grid", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      for (const turn of TURNS) {
        const view = isometric(turn);
        for (let col = -3; col < 40; col += 7) {
          for (let row = -3; row < 40; row += 5) {
            const c = hexCenter(g, { col, row });
            const back = toWorld(view, toView(view, c, 2.5), 2.5);
            near(back.x, c.x, 1e-9, `${orient} x`);
            near(back.y, c.y, 1e-9, `${orient} y`);
          }
        }
      }
    }
  });

  test("the map's top edge faces up and right at turn 0, then turns clockwise", () => {
    // North on the map, from the cell (5, 5): the way its top edge faces.
    const faces = TURNS.map((turn) => {
      const view = isometric(turn);
      const a = toView(view, { x: 5, y: 5 });
      const b = toView(view, { x: 5, y: 4 });
      return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
    });
    assert.deepEqual(faces, [
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]);
    assert.equal(turned(0, 1), 1);
    assert.equal(turned(3, 1), 0);
    assert.equal(turned(0, -1), 3);
  });

  test("a cell is a diamond √2 wide and √2/2 tall, a ground circle an ellipse half as tall, and a height rises K a cell", () => {
    for (const turn of TURNS) {
      const view = isometric(turn);
      const corners = [
        { x: 2, y: 3 },
        { x: 3, y: 3 },
        { x: 3, y: 4 },
        { x: 2, y: 4 },
      ].map((p) => toView(view, p));
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      near(Math.max(...xs) - Math.min(...xs), Math.SQRT2, 1e-12, "diamond width");
      near(Math.max(...ys) - Math.min(...ys), Math.SQRT2 / 2, 1e-12, "diamond height");
      let wide = 0;
      let tall = 0;
      const middle = toView(view, { x: 10, y: 10 });
      for (let i = 0; i < 720; i++) {
        const p = toView(view, { x: 10 + 1.5 * Math.cos((i * Math.PI) / 360), y: 10 + 1.5 * Math.sin((i * Math.PI) / 360) });
        wide = Math.max(wide, Math.abs(p.x - middle.x));
        tall = Math.max(tall, Math.abs(p.y - middle.y));
      }
      near(wide, 1.5, 1e-4, "ellipse half width");
      near(tall, 0.75, 1e-4, "ellipse half height");
      const ground = toView(view, { x: 4, y: 1 });
      const raised = toView(view, { x: 4, y: 1 }, 2);
      near(raised.x, ground.x, 1e-12, "a height moves nothing across");
      near(ground.y - raised.y, 2 * K, 1e-12, "a height rises K a cell");
    }
    assert.equal(K, Math.sqrt(3) / 2);
  });

  test("depth grows toward the viewer, who looks from the bottom of the screen", () => {
    for (const turn of TURNS) {
      const view = isometric(turn);
      const random = rng(17 + turn);
      for (let i = 0; i < 200; i++) {
        const p = { x: random() * 100, y: random() * 100 };
        const v = toView(view, p);
        // One view unit further down the screen, at the same height, is nearer.
        const lower = toWorld(view, { x: v.x, y: v.y + 1 } as ViewPoint);
        assert.ok(depth(turn, lower.x, lower.y) > depth(turn, p.x, p.y));
        near(depth(turn, p.x, p.y), 2 * v.y, 1e-9, "depth is twice the ground's view y");
      }
    }
  });

  test("Konva's ground groups land every point where toView says, within 1e-9 px, and the upright group undoes them", () => {
    const random = rng(99);
    for (const turn of TURNS) {
      const view = isometric(turn);
      const attrs = groundGroups(turn);
      for (let i = 0; i < 200; i++) {
        const p = { x: random() * 400 - 200, y: random() * 400 - 200 };
        const z = random() * 40 - 10;
        const root = new Konva.Group({ x: CAM.x, y: CAM.y, scaleX: CAM.scale, scaleY: CAM.scale });
        const lift = new Konva.Group({ y: -K * z });
        const outer = new Konva.Group(attrs.outer);
        const inner = new Konva.Group(attrs.inner);
        const node = new Konva.Group({ x: p.x, y: p.y });
        const upright = new Konva.Group(attrs.upright);
        const art = new Konva.Group({ x: 0.25, y: -1.5 });
        root.add(lift);
        lift.add(outer);
        outer.add(inner);
        inner.add(node);
        node.add(upright);
        upright.add(art);
        const want = screenOf(view, p, z);
        const got = node.getAbsoluteTransform().point({ x: 0, y: 0 });
        near(got.x, want.x, 1e-9, "x px");
        near(got.y, want.y, 1e-9, "y px");
        // Inside the upright group a view unit is a view unit again: art 1.5 cells up shows 1.5 cells up.
        const artAt = art.getAbsoluteTransform().point({ x: 0, y: 0 });
        near(artAt.x - got.x, 0.25 * CAM.scale, 1e-9, "upright x");
        near(artAt.y - got.y, -1.5 * CAM.scale, 1e-9, "upright y");
      }
    }
  });

  test("a rectangle's view box holds its corners, raised by a lift, and is the rectangle in Top-down", () => {
    const rect = { x: 0, y: 0, width: 30, height: 20 };
    assert.deepEqual(viewBox(TOP_DOWN, rect, 4), rect);
    for (const turn of TURNS) {
      const view = isometric(turn);
      const box = viewBox(view, rect);
      for (const corner of [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 0, y: 20 },
        { x: 30, y: 20 },
      ]) {
        const v = toView(view, corner);
        assert.ok(v.x >= box.x - 1e-9 && v.x <= box.x + box.width + 1e-9 && v.y >= box.y - 1e-9 && v.y <= box.y + box.height + 1e-9);
      }
      near(box.width, 50 * Math.SQRT1_2, 1e-9, "width");
      near(box.height, 25 * Math.SQRT1_2, 1e-9, "height");
      const lifted = viewBox(view, rect, 4);
      near(lifted.y, box.y - 4 * K, 1e-12, "the top rises by the lift");
      near(lifted.y + lifted.height, box.y + box.height, 1e-12, "the bottom stays");
    }
  });
});

describe("arrow keys follow the screen (ISO-D11)", () => {
  test("Top-down's arrows are the shortcut table's, and Isometric's Up is north, west, south, east by turn", () => {
    assert.deepEqual(arrowStep(TOP_DOWN, "ArrowUp"), [0, -1]);
    assert.deepEqual(arrowStep(TOP_DOWN, "ArrowRight"), [1, 0]);
    assert.deepEqual(arrowStep(TOP_DOWN, "ArrowDown"), [0, 1]);
    assert.deepEqual(arrowStep(TOP_DOWN, "ArrowLeft"), [-1, 0]);
    assert.equal(arrowStep(TOP_DOWN, "Enter"), null);
    assert.deepEqual(
      TURNS.map((turn) => arrowStep(isometric(turn), "ArrowUp")),
      [
        [0, -1],
        [-1, 0],
        [0, 1],
        [1, 0],
      ],
    );
  });

  test("each arrow moves toward the screen's corner it names, at every turn", () => {
    const corner: Record<string, [number, number]> = { ArrowUp: [1, -1], ArrowRight: [1, 1], ArrowDown: [-1, 1], ArrowLeft: [-1, -1] };
    for (const turn of TURNS) {
      const view = isometric(turn);
      for (const [key, want] of Object.entries(corner)) {
        const [dx, dy] = arrowStep(view, key)!;
        const a = toView(view, { x: 5, y: 5 });
        const b = toView(view, { x: 5 + dx, y: 5 + dy });
        assert.deepEqual([Math.sign(b.x - a.x), Math.sign(b.y - a.y)], want, `${key} at turn ${turn}`);
      }
    }
  });
});

describe("the ground at the middle (section 4.1)", () => {
  test("in Top-down it is the canvas's middle through the camera, as the hand-written sites had it", () => {
    const random = rng(5);
    for (let i = 0; i < 500; i++) {
      const camera = { x: random() * 4000 - 2000, y: random() * 4000 - 2000, scale: 4 + random() * 396 };
      const viewport = { width: 200 + random() * 2000, height: 200 + random() * 2000 };
      const got = groundAtMiddle({ camera, viewport, view: TOP_DOWN });
      assert.equal(got.x, (viewport.width / 2 - camera.x) / camera.scale);
      assert.equal(got.y, (viewport.height / 2 - camera.y) / camera.scale);
    }
  });

  test("in Isometric it is the point at 0 that shows at the middle, or at the middle of the clear part", () => {
    const viewport = { width: 390, height: 844 };
    const insets = { top: 52, right: 0, bottom: 300, left: 0 };
    for (const turn of TURNS) {
      const view = isometric(turn);
      const at = groundAtMiddle({ camera: CAM, viewport, view });
      const s = screenOf(view, at, 0);
      near(s.x, 195, 1e-9, "x");
      near(s.y, 422, 1e-9, "y");
      const clear = screenOf(view, groundAtMiddle({ camera: CAM, viewport, view }, insets), 0);
      near(clear.y, 52 + (844 - 52 - 300) / 2, 1e-9, "the clear part's middle");
    }
  });

  test("a stage's own reading gives the same live camera, an unscaled stage reading as 1", () => {
    const stage = { x: () => 10, y: () => -4, scaleX: () => 0, width: () => 300, height: () => 200 };
    assert.deepEqual(liveOfStage(stage, TOP_DOWN), { camera: { x: 10, y: -4, scale: 1 }, viewport: { width: 300, height: 200 }, view: TOP_DOWN });
  });
});

// ---------------------------------------------------------------- drawn heights

/** One chunk of scene s1 with these cells raised or lowered, in feet. */
function chunkWith(heights: Record<string, number>): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[y * CHUNK_CELLS + x] = v;
  }
  return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
}

/** A 16 by 16 scene with fog on and these heights. */
function heightsRoom(heights: Record<string, number>): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 }, fogEnabled: true });
  state.buildChunks["s1:0,0"] = chunkWith(heights);
  return state;
}

function drawn(state: RoomState, role: "dm" | "player", stand = true): DrawnSource {
  return { ...groundSource(state, state.scenes.s1!, role), stand };
}

describe("drawn heights (section 4.3)", () => {
  test("a cell's drawn ground is its seen ground while heights stand, and 0 below the threshold or where unseen", () => {
    const state = heightsRoom({ "2,2": 10, "5,5": -10 });
    assert.equal(drawnGround(drawn(state, "dm"), { x: 2, y: 2 }), 10);
    assert.equal(drawnGround(drawn(state, "dm"), { x: 5, y: 5 }), -10);
    assert.equal(drawnGround(drawn(state, "dm", false), { x: 2, y: 2 }), 0, "below the threshold every height is 0");
    assert.equal(drawnGround(drawn(state, "player"), { x: 2, y: 2 }), 0, "a fully fogged cell draws flat");
    reveal(state, "s1", { x: 2.75, y: 2, w: 0.25, h: 1 });
    assert.equal(drawnGround(drawn(state, "player"), { x: 2, y: 2 }), 10, "one revealed sub-cell shows the cell's ground");
    assert.equal(drawnGround(drawn(state, "dm"), { x: 40, y: 2 }), 0, "outside the scene");
  });

  test("the threshold is 12 px a cell, 24 in Low power", () => {
    assert.equal(heightsStand(12, false), true);
    assert.equal(heightsStand(11.99, false), false);
    assert.equal(heightsStand(24, true), true);
    assert.equal(heightsStand(23.99, true), false);
  });

  test("a footprint's seen ground is its highest seen cell, unseen cells counting 0, and the drawn one the same through drawnGround", () => {
    const state = heightsRoom({ "2,2": 10, "3,2": 20, "2,3": -5, "3,3": -5, "8,8": -10, "9,8": -15 });
    const large = rectRange(2, 2, 2, 2);
    assert.equal(seenFootprintGround(drawn(state, "dm"), large), 20);
    assert.equal(seenFootprintGround(drawn(state, "player"), large), 0, "all four fogged: each counts 0");
    reveal(state, "s1", { x: 2, y: 2, w: 1, h: 1 });
    assert.equal(seenFootprintGround(drawn(state, "player"), large), 10, "the 20 ft cell is still fogged");
    assert.equal(drawnFootprintGround(drawn(state, "player"), large), 10);
    assert.equal(drawnFootprintGround(drawn(state, "player", false), large), 0);
    const pit = rectRange(8, 8, 2, 1);
    assert.equal(seenFootprintGround(drawn(state, "dm"), pit), -10, "a footprint wholly in a pit stands on its highest floor");
    assert.equal(seenFootprintGround(drawn(state, "dm"), rectRange(1, 1, 0, 0)), 0, "no cells");
  });

  test("a standee's base is its elevation above the threshold and its lift over the seen ground below it", () => {
    const state = heightsRoom({ "2,2": 10 });
    reveal(state, "s1", { x: 0, y: 0, w: 16, h: 16 });
    const cell = rectRange(2, 2, 1, 1);
    assert.equal(drawnBase(drawn(state, "player"), cell, 10), 10, "on the platform");
    assert.equal(drawnBase(drawn(state, "player"), cell, 30), 30, "flying 20 ft over it");
    assert.equal(drawnBase(drawn(state, "player", false), cell, 30), 20, "flat: its lift over the platform");
    assert.equal(drawnBase(drawn(state, "player"), cell, 0), 0, "inside seen ground");
  });

  test("security: a token at one stored elevation over fogged ground draws the same over hidden 0 ft and hidden 10 ft", () => {
    for (const stand of [true, false]) {
      const bases = [0, 10].map((hidden) => {
        const state = heightsRoom({ "2,2": hidden, "3,2": hidden });
        // The party token's own spot is fogged, as a party token on unrevealed ground is.
        return drawnBase(drawn(state, "player", stand), rectRange(2, 2, 2, 1), 10);
      });
      assert.equal(bases[0], bases[1], `stand ${stand}`);
      const range = [0, 10].map((hidden) => {
        const h = drawnHeights(drawn(heightsRoom({ "2,2": hidden }), "player", stand), 5);
        return [h.low, h.high, h.at(2, 2)];
      });
      assert.deepEqual(range[0], range[1], `drawn heights, stand ${stand}`);
    }
  });

  test("a scene's drawn heights span its seen ground in cells of height, 0 included", () => {
    const state = heightsRoom({ "2,2": 10, "5,5": -20, "9,9": 40 });
    const dm = drawnHeights(drawn(state, "dm"), 5);
    assert.deepEqual([dm.low, dm.high, dm.at(2, 2), dm.at(5, 5), dm.at(0, 0)], [-4, 8, 2, -4, 0]);
    reveal(state, "s1", { x: 2, y: 2, w: 1, h: 1 });
    const player = drawnHeights(drawn(state, "player"), 5);
    assert.deepEqual([player.low, player.high, player.at(9, 9)], [0, 2, 0], "the fogged pit and tower lie flat");
    const flat = drawnHeights(drawn(state, "dm", false), 5);
    assert.deepEqual([flat.low, flat.high, flat.at(2, 2)], [0, 0, 0]);
  });
});

// ---------------------------------------------------------------- picking

/** Drawn heights from a map of cells to cells of height, on a w by h scene. */
function heightsOf(w: number, h: number, cells: Record<string, number>): DrawnHeights {
  const values = Object.values(cells);
  return { bounds: { w, h }, low: Math.min(0, ...values), high: Math.max(0, ...values), at: (x, y) => cells[`${x},${y}`] ?? 0 };
}

function cellOf(p: Point): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)}`;
}

/** A cell's drawn ground, 0 outside the scene. */
function groundUnder(heights: DrawnHeights, p: Point): number {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  return cx < 0 || cy < 0 || cx >= heights.bounds.w || cy >= heights.bounds.h ? 0 : heights.at(cx, cy);
}

/**
 * The first drawn ground the ray at `screen` meets, by marching down its
 * height in small steps: the slow, plain reading of the rule a pick walks.
 * A step can pass over a cell the ray only grazes at a corner, so it can
 * meet ground later than the walk, never earlier.
 */
function marched(view: View, heights: DrawnHeights, screen: Point, step: number): number {
  const v = screenToView(CAM, screen);
  for (let z = Math.max(heights.high, 0); z >= Math.min(heights.low, 0) - step; z -= step) {
    if (z <= groundUnder(heights, toWorld(view, v, z))) return z;
  }
  throw new Error("the march found no ground");
}

describe("pickGround (section 4.3)", () => {
  const pick = (view: View, heights: DrawnHeights, screen: Point) => pickGround({ camera: CAM, view, grid: SQUARES, heights }, screen);

  test("in Top-down it is the point under the press, whatever the heights", () => {
    const heights = heightsOf(16, 16, { "3,3": 6 });
    const random = rng(8);
    for (let i = 0; i < 200; i++) {
      const screen = { x: random() * 1000, y: random() * 1000 };
      assert.deepEqual(pick(TOP_DOWN, heights, screen), { x: (screen.x - CAM.x) / CAM.scale, y: (screen.y - CAM.y) / CAM.scale });
    }
  });

  test("on flat ground, and on a hex scene before H3, it is the point at 0 under the press", () => {
    for (const turn of TURNS) {
      const view = isometric(turn);
      const screen = screenOf(view, { x: 7.3, y: 2.9 }, 0);
      for (const src of [
        { camera: CAM, view, grid: SQUARES, heights: flatHeights({ w: 16, h: 16 }) },
        { camera: CAM, view, grid: gridOfShape("hexRows"), heights: heightsOf(16, 16, { "7,2": 4 }) },
      ]) {
        const p = pickGround(src, screen);
        near(p.x, 7.3, 1e-9, "x");
        near(p.y, 2.9, 1e-9, "y");
      }
    }
  });

  test("a 10 ft platform's top and its near faces pick that cell, at every turn", () => {
    // 10 ft at 5 ft a cell is 2 cells of height, on the cell (5, 5).
    const heights = heightsOf(16, 16, { "5,5": 2 });
    for (const turn of TURNS) {
      const view = isometric(turn);
      const top = pick(view, heights, screenOf(view, { x: 5.3, y: 5.6 }, 2));
      near(top.x, 5.3, 1e-9, "top x");
      near(top.y, 5.6, 1e-9, "top y");
      // The faces toward the viewer: the cell's sides with the larger depth.
      const { c, s } = { c: [1, -1, -1, 1][turn]!, s: [1, 1, -1, -1][turn]! };
      const faceX = { x: s > 0 ? 6 : 5, y: 5.5 };
      const faceY = { x: 5.5, y: c > 0 ? 6 : 5 };
      for (const face of [faceX, faceY]) {
        const p = pick(view, heights, screenOf(view, face, 1));
        assert.equal(cellOf(p), "5,5", `turn ${turn}: a press on the near face at ${face.x},${face.y} names the platform's cell`);
        near(p.x, face.x, 2 * FACE_NUDGE, "on the face");
        near(p.y, face.y, 2 * FACE_NUDGE, "on the face");
      }
    }
  });

  test("over a pit it picks its floor where the floor shows, and its far side where the side covers it", () => {
    // A 4 by 4 pit 1 cell deep at (4..7, 4..7), and a 1 by 1 pit 3 deep at (12, 12).
    const cells: Record<string, number> = { "12,12": -3 };
    for (let x = 4; x < 8; x++) for (let y = 4; y < 8; y++) cells[`${x},${y}`] = -1;
    const heights = heightsOf(16, 16, cells);
    for (const turn of TURNS) {
      const view = isometric(turn);
      const floor = pick(view, heights, screenOf(view, { x: 5.4, y: 5.7 }, -1));
      near(floor.x, 5.4, 1e-9, "floor x");
      near(floor.y, 5.7, 1e-9, "floor y");
      // The narrow pit's opening shows only its far sides: the cells beyond it, entered below 0.
      const deep = pickWalk({ camera: CAM, view, grid: SQUARES, heights }, screenOf(view, { x: 12.5, y: 12.5 }, 0));
      assert.ok(deep.z < 0, "seen below the rim");
      assert.notEqual(cellOf(deep.point), "12,12", "not the floor");
      assert.equal(heights.at(...(cellOf(deep.point).split(",").map(Number) as [number, number])), 0, "a cell beside the pit, by its face");
    }
  });

  test("a player's press over a fogged platform finds the ground behind at 0", () => {
    const state = heightsRoom({ "5,5": 10 });
    for (const turn of TURNS) {
      const view = isometric(turn);
      const screen = screenOf(view, { x: 5.5, y: 5.5 }, 2);
      const dm = pick(view, drawnHeights(drawn(state, "dm"), 5), screen);
      assert.equal(cellOf(dm), "5,5");
      const player = pick(view, drawnHeights(drawn(state, "player"), 5), screen);
      const behind = toWorld(view, screenToView(CAM, screen), 0);
      near(player.x, behind.x, 1e-9, "x");
      near(player.y, behind.y, 1e-9, "y");
    }
  });

  test("at 12 px a cell a press behind a 30 ft platform picks its top, at 11 px the flat ground behind it", () => {
    const state = heightsRoom({ "5,5": 30 });
    for (const turn of TURNS) {
      const view = isometric(turn);
      // A point on the platform's top, 6 cells up, is the ray that would reach the ground well behind it.
      const camera = { ...CAM, scale: 12 };
      const screen = viewToScreen(camera, toView(view, { x: 5.5, y: 5.5 }, 6));
      const at = (scale: number) => pickGround({ camera: { ...camera, scale }, view, grid: SQUARES, heights: drawnHeights(drawn(state, "dm", heightsStand(scale, false)), 5) }, screen);
      assert.equal(cellOf(at(12)), "5,5");
      const flat = at(11);
      const behind = toWorld(view, screenToView({ ...camera, scale: 11 }, screen), 0);
      near(flat.x, behind.x, 1e-9, "x");
      near(flat.y, behind.y, 1e-9, "y");
      assert.notEqual(cellOf(flat), "5,5");
    }
  });

  test("random ground, every turn: the walk meets what a fine march down the ray meets", () => {
    const random = rng(2026);
    for (let round = 0; round < 30; round++) {
      const w = 6 + Math.floor(random() * 10);
      const h = 6 + Math.floor(random() * 10);
      const cells: Record<string, number> = {};
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (random() < 0.4) cells[`${x},${y}`] = Math.round((random() * 10 - 3) * 2) / 2;
      const heights = heightsOf(w, h, cells);
      for (const turn of TURNS) {
        const view = isometric(turn);
        for (let i = 0; i < 25; i++) {
          const screen = screenOf(view, { x: random() * (w + 6) - 3, y: random() * (h + 6) - 3 }, random() * 4 - 1);
          const got = pickWalk({ camera: CAM, view, grid: SQUARES, heights }, screen);
          assert.ok(marched(view, heights, screen, 1e-3) <= got.z + 2e-3, `turn ${turn} round ${round}: no ground before the walk's`);
          assert.ok(groundUnder(heights, got.point) >= got.z - 1e-9, `turn ${turn} round ${round}: the walk's point is in the ground`);
          const back = viewToScreen(CAM, toView(view, got.point, got.z));
          near(back.x, screen.x, 1e-3, "on the ray x");
          near(back.y, screen.y, 1e-3, "on the ray y");
        }
      }
    }
  });

  test("the walk visits at most 2√2·K·Δz + 3 cells and never more than the scene's w + h, at 1 and 5 ft a cell over −100 to 200 ft", () => {
    const random = rng(77);
    for (const feetPerCell of [1, 5]) {
      const w = 200;
      const h = 200;
      const cells: Record<string, number> = {};
      for (let i = 0; i < 4000; i++) cells[`${Math.floor(random() * w)},${Math.floor(random() * h)}`] = Math.round(MIN_HEIGHT_FT + random() * (MAX_HEIGHT_FT - MIN_HEIGHT_FT)) / feetPerCell;
      cells["0,0"] = MIN_HEIGHT_FT / feetPerCell;
      cells["1,0"] = MAX_HEIGHT_FT / feetPerCell;
      const heights = heightsOf(w, h, cells);
      const dz = heights.high - heights.low;
      const bound = Math.min(2 * Math.SQRT2 * K * dz + 3, w + h);
      let most = 0;
      for (const turn of TURNS) {
        const view = isometric(turn);
        const camera = { x: 0, y: 0, scale: 4 };
        for (let i = 0; i < 400; i++) {
          const screen = viewToScreen(camera, toView(view, { x: random() * w, y: random() * h }, (random() * dz + heights.low) * random()));
          const { visited } = pickWalk({ camera, view, grid: SQUARES, heights }, screen);
          assert.ok(visited <= bound, `${visited} cells at ${feetPerCell} ft a cell, over ${bound}`);
          most = Math.max(most, visited);
        }
      }
      assert.ok(most > 10, "the walk was exercised");
    }
  });
});
