import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { estimateText, labelBox } from "#shared/rules/labels.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { isometric, toView, TOP_DOWN } from "../../lib/view.ts";
import { labelShape, labelSplitter, labelStands, splitLabels } from "./labelShape.ts";

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

  test("security: a label whose descenders reach a fogged row just under its anchor, or whose accents reach one just over it, lies flat (ISO2-FV-7)", () => {
    // Revealed: every sub-cell of cells 0 to 9 on rows 0 to 4. Row 5 is fogged.
    const bits = new Uint8Array(TILE_BYTES);
    for (let sy = 0; sy < 5 * FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < 10 * FOG_SUBCELLS; sx++) {
        const i = sy * TILE_SUB + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
    }
    const above = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
    // "jig" anchored at 4.4: its shared box ends at 4.9, inside the revealed rows, but its descenders and halo reach 5.1.
    const low = { x: 5, y: 4.4, text: "jig", size: 1 };
    const box = labelBox(low, estimateText);
    assert.ok(box.y1 < 5, "the shared box alone would stand");
    assert.equal(labelStands(above, low, estimateText), false);
    assert.equal(labelStands(above, { ...low, y: 4.2 }, estimateText), true, "set higher, every sub-cell its ink touches is revealed");
    // Column 10 is fogged: "Crypt" anchored at 8.4 has a box to 9.98, but a letter's ink and halo reach 10.02.
    assert.equal(labelStands(above, { x: 8.4, y: 2, text: "Crypt", size: 1 }, estimateText), false);
    assert.equal(labelStands(above, { x: 8.3, y: 2, text: "Crypt", size: 1 }, estimateText), true);
    // Rows 5 to 9 revealed and row 4 fogged: "Åla" anchored at 5.6 has a box from 5.1, but its ring and halo reach 4.8.
    const under = new Uint8Array(TILE_BYTES);
    for (let sy = 5 * FOG_SUBCELLS; sy < 10 * FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < 10 * FOG_SUBCELLS; sx++) {
        const i = sy * TILE_SUB + sx;
        under[i >> 3] = under[i >> 3]! | (1 << (i & 7));
      }
    }
    const below = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(under) } }, "s1", { w: 16, h: 16 });
    assert.equal(labelStands(below, { x: 5, y: 5.6, text: "Åla", size: 1 }, estimateText), false);
    assert.equal(labelStands(below, { x: 5, y: 5.9, text: "Åla", size: 1 }, estimateText), true);
  });

  test("security: labels split in the fallback font split again when Inter's wider widths arrive, with the labels and fog the same (ISO2-ASTRA-09)", () => {
    // Revealed: every sub-cell of cells 0 to 5 on rows 0 to 9. Cell 6 is fogged.
    const bits = new Uint8Array(TILE_BYTES);
    for (let sy = 0; sy < 10 * FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < 6 * FOG_SUBCELLS; sx++) {
        const i = sy * TILE_SUB + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
    }
    const fog = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
    const labels = [label];
    // The fallback font is narrower: "Crypt" spans x 4.17 to 5.83, then 3.42 to 6.58 in Inter.
    let perChar = 0.3;
    const split = labelSplitter((text) => text.length * perChar);
    assert.equal(split(fog, labels, 0).upright.length, 1, "it stands in the fallback's widths");
    perChar = 0.6;
    assert.equal(split(fog, labels, 0).upright.length, 1, "kept while the font is the same");
    assert.deepEqual(split(fog, labels, 1).upright, [], "Inter's widths reach the fogged cell 6: it lies flat");
    assert.equal(split(fog, labels, 1).flat.length, 1);
  });
});
