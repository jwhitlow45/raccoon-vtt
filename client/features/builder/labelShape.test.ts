import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { estimateText, labelBox } from "#shared/rules/labels.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { isometric, toView, TOP_DOWN } from "../../lib/view.ts";
import { labelShape, splitLabels } from "./labelShape.ts";

const label = { x: 5, y: 4, text: "Crypt", size: 1 };

describe("labelShape", () => {
  test("in Top-down it is the flat box the text draws in", () => {
    const shape = labelShape(label, TOP_DOWN, { measure: estimateText, upright: true });
    const flat = labelBox(label, estimateText);
    assert.equal(shape.upright, false);
    assert.deepEqual({ x: shape.box.x, y: shape.box.y, w: shape.box.width, h: shape.box.height }, { x: flat.x0, y: flat.y0, w: flat.x1 - flat.x0, h: flat.y1 - flat.y0 });
  });

  test("upright in Isometric, the text block stands on its anchor at the ground under it, at every turn", () => {
    const flat = labelBox(label, estimateText);
    for (const turn of [0, 1, 2, 3] as const) {
      const shape = labelShape(label, isometric(turn), { measure: estimateText, upright: true, ground: 2 });
      const at = toView(isometric(turn), label, 2);
      assert.ok(shape.upright);
      assert.ok(Math.abs(shape.box.x + shape.box.width / 2 - at.x) < 1e-12);
      assert.ok(Math.abs(shape.box.y + shape.box.height - at.y) < 1e-12);
      assert.ok(Math.abs(shape.box.width - (flat.x1 - flat.x0)) < 1e-12);
    }
  });

  test("flat in Isometric, its corners are the flat box's through the projection", () => {
    const shape = labelShape(label, isometric(1), { measure: estimateText, upright: false });
    const flat = labelBox(label, estimateText);
    assert.deepEqual(shape.corners[0], toView(isometric(1), { x: flat.x0, y: flat.y0 }));
    for (const c of shape.corners) assert.ok(c.x >= shape.box.x - 1e-12 && c.x <= shape.box.x + shape.box.width + 1e-12);
  });

  test("security: a label with every cell under it partly revealed lies flat, and one wholly revealed stands", () => {
    // Revealed: every sub-cell of cells 0 to 9 on rows 0 to 9, but one sub-cell in each cell the label covers.
    const bits = new Uint8Array(TILE_BYTES);
    const flatBox = labelBox(label, estimateText);
    for (let sy = 0; sy < 10 * FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < 10 * FOG_SUBCELLS; sx++) {
        const cx = Math.floor(sx / FOG_SUBCELLS);
        const cy = Math.floor(sy / FOG_SUBCELLS);
        const under = cx + 1 > flatBox.x0 && cx < flatBox.x1 && cy + 1 > flatBox.y0 && cy < flatBox.y1;
        // In each covered cell, the sub-cell nearest the label's anchor stays fogged.
        if (under && sx % FOG_SUBCELLS === 1 && sy % FOG_SUBCELLS === 1) continue;
        const i = sy * TILE_SUB + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
    }
    const tiles: Record<string, FogTile> = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
    const fog = new FogView(tiles, "s1", { w: 16, h: 16 });
    const far = { x: 13, y: 13, text: "Far", size: 1 };
    const { upright, flat } = splitLabels(fog, [label, { ...label, x: 5.5 }], estimateText);
    assert.deepEqual(upright, []);
    assert.equal(flat.length, 2);
    // Wholly revealed elsewhere: reveal a second scene's fog everywhere.
    const all = encodeTile(new Uint8Array(TILE_BYTES).fill(0xff));
    const open = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: all } }, "s1", { w: 16, h: 16 });
    assert.deepEqual(splitLabels(open, [label, far], estimateText).upright.length, 2);
  });
});
