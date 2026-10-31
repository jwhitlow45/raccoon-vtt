import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CULL_STEP_PX, cullFit, cullOf } from "./cull.ts";

/*
 * The isometric board's cull box (docs/design-v1-relief-pan.md 5.6), one
 * implementation for the board (128 px steps) and the kept picture's rig
 * (24 px), so the two cannot drift (review HXPERF2B-OPUS-01).
 */

const SIZE = { width: 390, height: 844 };

describe("the cull box and how a camera stands to it", () => {
  for (const step of [CULL_STEP_PX, 24]) {
    test(`in steps of ${step} px: a step to spare on every side, the key changing only across a step, and inside, step and out at the box's edges`, () => {
      const cam = { x: -1000.25, y: -2000.5, scale: 12 };
      const rendered = cullOf(cam, SIZE, step);
      const s = step / cam.scale;
      const { box, view } = rendered;
      // A step past the view on every side, at least, and snapped to the steps.
      for (const [edge, gap] of [["x0", view.x0 - box.x0], ["y0", view.y0 - box.y0], ["x1", box.x1 - view.x1], ["y1", box.y1 - view.y1]] as const) {
        assert.ok(gap >= s - 1e-9 && gap < 2 * s + 1e-9, `${edge} spares ${gap / s} steps`);
        assert.ok(Math.abs(box[edge] / s - Math.round(box[edge] / s)) < 1e-9, `${edge} lies on a step`);
      }
      assert.equal(cullFit(rendered, cam, SIZE, step), "inside");
      // The view moves right (the camera left) up to the first step either of its sides reaches: still inside.
      const next = (v: number) => {
        const d = Math.ceil(v / s) * s - v;
        return d > 1e-9 ? d : s;
      };
      const toStep = Math.min(next(view.x0), next(view.x1));
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
  }
});
