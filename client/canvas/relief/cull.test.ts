import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CULL_STEP_PX, cullFit, cullOf } from "./cull.ts";

/*
 * The isometric board's cull box (docs/design/design-v1-relief-pan.md 5.6), one
 * implementation for the board (256 px steps) and the kept picture's rig
 * (24 px), so the two cannot drift (review HXPERF2B-OPUS-01).
 */

const SIZE = { width: 390, height: 844 };

describe("the cull box and how a camera stands to it", () => {
  test("a steady pan across a computer's canvas relays out, and so repaints the relief whole, at most once per 256 px it crosses on each axis, wherever it starts in its steps", () => {
    // ISOPAN: at 128 px a steady pan on a 100 by 100 dungeon dropped a frame about every 16. Steps are screen px, so one zoom stands for all.
    const size = { width: 1440, height: 900 };
    const scale = 32;
    for (let ox = 0; ox < 256; ox += 16) {
      for (let oy = 0; oy < 256; oy += 64) {
        let relayouts = 0;
        let last = cullOf({ x: -5000 - ox, y: -3000 - oy, scale }, size).key;
        // 1,536 px across and 768 px down at 8 and 4 px a frame, as a mouse drags.
        for (let m = 1; m <= 192; m++) {
          const key = cullOf({ x: -5000 - ox - m * 8, y: -3000 - oy - m * 4, scale }, size).key;
          if (key !== last) relayouts++;
          last = key;
        }
        // One for each 256 px on each axis, and one more on each for where the start lies in its step.
        assert.ok(relayouts <= 1536 / 256 + 768 / 256 + 2, `from ${ox}, ${oy} px into the step: ${relayouts} relayouts`);
      }
    }
  });

  for (const step of [CULL_STEP_PX, 24]) {
    test(`in steps of ${step} px: a step to spare on every side, one size at a zoom, the key changing only across the top-left's step, and inside, step and out at the box's edges`, () => {
      const cam = { x: -1025.25, y: -2000.5, scale: 12 };
      const rendered = cullOf(cam, SIZE, step);
      const s = step / cam.scale;
      const { box, view } = rendered;
      // A step before the view and at least one past it, snapped to the steps.
      for (const [edge, gap, most] of [["x0", view.x0 - box.x0, 2], ["y0", view.y0 - box.y0, 2], ["x1", box.x1 - view.x1, 3], ["y1", box.y1 - view.y1, 3]] as const) {
        assert.ok(gap >= s - 1e-9 && gap < most * s + 1e-9, `${edge} spares ${gap / s} steps`);
        assert.ok(Math.abs(box[edge] / s - Math.round(box[edge] / s)) < 1e-9, `${edge} lies on a step`);
      }
      assert.equal(cullFit(rendered, cam, SIZE, step), "inside");
      // The view moves right (the camera left): the bottom-right's own steps change nothing, up to the step the top-left reaches.
      const next = (v: number) => {
        const d = Math.ceil(v / s) * s - v;
        return d > 1e-9 ? d : s;
      };
      const toStep = next(view.x0);
      assert.ok(next(view.x1) < toStep, "the fixture's right edge crosses a step first");
      assert.equal(cullOf({ ...cam, x: cam.x - (next(view.x1) + 1e-6) * cam.scale }, SIZE, step).key, rendered.key, "past the right edge's step");
      const within = { ...cam, x: cam.x - (toStep - 1e-6) * cam.scale };
      assert.equal(cullFit(rendered, within, SIZE, step), "inside", "a hair short of the step");
      // Across it the key changes, and the view still lies inside the rendered box: a step.
      const across = { ...cam, x: cam.x - (toStep + 1e-6) * cam.scale };
      assert.notEqual(cullOf(across, SIZE, step).key, rendered.key);
      assert.equal(cullFit(rendered, across, SIZE, step), "step");
      // Past the rendered box's own edge the view has left the layout: out.
      const toEdge = box.x1 - view.x1;
      assert.equal(cullFit(rendered, { ...cam, x: cam.x - (toEdge - 1e-6) * cam.scale }, SIZE, step), "step", "a hair short of the box's edge");
      assert.equal(cullFit(rendered, { ...cam, x: cam.x - (toEdge + 1e-6) * cam.scale }, SIZE, step), "out", "past the box's edge");
      assert.equal(cullFit(rendered, { ...cam, y: cam.y + (view.y0 - box.y0 + 1e-6) * cam.scale }, SIZE, step), "out", "past the top");
    });

    test(`in steps of ${step} px: a pan changes the key once for each step its top-left crosses, wherever the view lies in its steps`, () => {
      for (let i = 0; i < 200; i++) {
        const cam = { x: -1000 - i * 7.37, y: -2000 - i * 3.11, scale: 12 + (i % 5) * 7 };
        const s = step / cam.scale;
        const { box, view } = cullOf(cam, SIZE, step);
        assert.ok(Math.abs(box.x1 - box.x0 - (Math.ceil(SIZE.width / step) + 3) * s) < 1e-6, "one width at a zoom");
        assert.ok(Math.abs(box.y1 - box.y0 - (Math.ceil(SIZE.height / step) + 3) * s) < 1e-6, "one height at a zoom");
        assert.ok(box.x1 - view.x1 >= s - 1e-9 && box.y1 - view.y1 >= s - 1e-9, "a step to spare past the view");
        // A diagonal pan of 16 moves by 9 and 4 px, as the bench's: one key for each step the top-left starts in.
        const keys = new Set<string>();
        const steps = new Set<string>();
        for (let m = 0; m <= 16; m++) {
          const at = { ...cam, x: cam.x - m * 9, y: cam.y - m * 4 };
          const tl = { x: (0 - at.x) / at.scale, y: (0 - at.y) / at.scale };
          keys.add(cullOf(at, SIZE, step).key);
          steps.add(`${Math.floor(tl.x / s)},${Math.floor(tl.y / s)}`);
        }
        assert.equal(keys.size, steps.size);
      }
    });
  }
});
