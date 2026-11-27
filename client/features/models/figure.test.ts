import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { ImageRef, ModelRef } from "#shared/model.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { actor, token } from "#shared/testutil.ts";
import { decorPlace, isoTokenBoxes } from "../../canvas/relief/isoText.ts";
import type { VBox } from "../../canvas/relief/pieces.ts";
import { ON_GROUND, standeeModel, standeeShape } from "../../canvas/relief/standee.ts";
import type { ViewToken } from "../../lib/scene.ts";
import { isometric, type Turn } from "../../lib/view.ts";
import { spotsOf, tokenBox, tokenSpots } from "../floors/linkMarks.ts";
import { frameFor } from "./frames.ts";

/*
 * What keeps off a creature standing as its 3D model: area and trap names
 * (canvas/relief/isoText.ts isoTokenBoxes) and a floor link's pills
 * (floors/linkMarks.ts tokenBox) keep off its figure, which reaches past
 * the frame its decor lays out on as the model is wide, tall or low
 * (docs/design/design-v1-token-models.md 6, D-261127-701, 702).
 */

const TURNS: Turn[] = [0, 1, 2, 3];
const SCALE = 40;
const inside = (a: VBox, b: VBox) => a.x0 >= b.x0 - 1e-9 && a.y0 >= b.y0 - 1e-9 && a.x1 <= b.x1 + 1e-9 && a.y1 <= b.y1 + 1e-9;

/** A model wide and low at its even frames and tall at its odd ones, so no frame's figure fits a picture's box. */
const MODEL: ModelRef = {
  assetId: "0198a1b2-0000-7000-8000-00000000f1a7",
  side: 2.4,
  anchorY: 0.95,
  boxes: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? [0, 70, 100, 100] : [20, 10, 80, 100]) as [number, number, number, number]),
};
const WEARING: ImageRef = { icon: "lorc/wolf-head", color: "#556b2f", model: MODEL };

describe("names keep off a model's figure", () => {
  test("a standee standing as its model gives the names its figure's drawn box, and a picture's boxes stay its frame and ring", () => {
    for (const turn of TURNS) {
      const view = isometric(turn);
      const t = token("wolf", { x: 6, y: 6, rotation: 90 * turn }) as ViewToken;
      for (const frame of [0, 1]) {
        const shape = standeeShape(turn, { x: t.x, y: t.y, w: 1, h: 1 }, 0, 0, SCALE, 900, ON_GROUND, standeeModel(MODEL, frame));
        const boxes = isoTokenBoxes([t], new Map(), SCALE, () => decorPlace(view, SQUARES, t, { frame: shape.frame, ring: shape.ring, figure: shape.drawnBox }));
        assert.ok(boxes.some((b) => inside(shape.drawnBox, b)), `turn ${turn}, frame ${frame}: the figure is kept off`);
      }
      const picture = standeeShape(turn, { x: t.x, y: t.y, w: 1, h: 1 }, 0, 0, SCALE, 900);
      const boxes = isoTokenBoxes([t], new Map(), SCALE, () => decorPlace(view, SQUARES, t, picture));
      assert.equal(boxes.length, 2, `turn ${turn}: a picture's frame and ring, and nothing counted twice`);
    }
  });
});

describe("a floor link's pills keep off a model's figure", () => {
  test("in Isometric a creature's spot carries its model, and its box holds the figure at every turn and facing", () => {
    const s = withOpening(tower({ tokens: { thorn: thornToken({ image: WEARING }) } }));
    const [spot] = spotsOf(tokenSpots(s, GROUND, true));
    assert.deepEqual(spot, { x: 3, y: 3, w: 1, h: 1, model: { side: 2.4, anchorY: 0.95, box: [0, 10, 100, 100] } });
    assert.equal(tokenSpots(s, GROUND), "3,3,1,1", "Top-down: the squares alone");
    for (const turn of TURNS) {
      const iso = { turn, ground: () => 0 };
      for (let facing = 0; facing < 360; facing += 45) {
        const figure = standeeShape(turn, { x: 3, y: 3, w: 1, h: 1 }, 0, 0, SCALE, 900, ON_GROUND, standeeModel(MODEL, frameFor(turn, facing))).drawnBox;
        assert.ok(inside(figure, tokenBox(spot!, iso)), `turn ${turn}, facing ${facing}`);
      }
    }
  });

  test("a creature that stands as its picture carries no model: one that wears none, and one wearing a model while it is dead", () => {
    const dead = { inline: actor({ life: "dead", hp: { cur: 0, max: 20, temp: 0 } }) };
    const s = withOpening(tower({ tokens: { thorn: thornToken({ image: WEARING, actor: dead }), plain: thornToken({ id: "plain", x: 5, y: 3 }) } }));
    assert.equal(tokenSpots(s, GROUND, true), "3,3,1,1 5,3,1,1");
  });
});
