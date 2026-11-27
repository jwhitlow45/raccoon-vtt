import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Turn } from "../../lib/view.ts";
import { cameraAzimuth, frameFor } from "./frames.ts";

/** frameFor over every turn and any facing the protocol takes, -360 to 360 (docs/design/design-v1-token-models.md 4.4). */

const turn = fc.constantFrom<Turn>(0, 1, 2, 3);
// Halves of a degree are exact in binary, so a facing moved by whole turns lands on the same number past any rounding.
const facing = fc.integer({ min: -720, max: 720 }).map((n) => n / 2);

/** The angle between two directions, in degrees, 0 to 180. */
function apart(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

test("a frame is a whole 0 to 7, the same a whole turn of facing on", () => {
  fc.assert(
    fc.property(turn, facing, fc.integer({ min: -2, max: 2 }), (t, f, k) => {
      const frame = frameFor(t, f);
      assert.ok(Number.isInteger(frame) && frame >= 0 && frame < 8);
      assert.equal(frameFor(t, f + 360 * k), frame);
    }),
  );
});

test("turning the view right shows the frame of a facing 90 degrees less", () => {
  fc.assert(fc.property(turn, facing, (t, f) => assert.equal(frameFor(((t + 1) % 4) as Turn, f - 90), frameFor(t, f))));
});

test("at a multiple of 45 degrees from the camera the frame is exact, and any other facing shows a frame within 22.5 degrees of it", () => {
  fc.assert(
    fc.property(turn, fc.integer({ min: -16, max: 16 }), (t, k) => {
      assert.equal(frameFor(t, cameraAzimuth(t) + 45 * k), (((k % 8) + 8) % 8));
    }),
  );
  fc.assert(
    fc.property(turn, facing, (t, f) => {
      // Frame i is the model turned 45 i degrees clockwise from facing the camera.
      assert.ok(apart(cameraAzimuth(t) + 45 * frameFor(t, f), f) <= 22.5);
    }),
  );
});
