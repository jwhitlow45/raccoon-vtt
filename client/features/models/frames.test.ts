import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isometric, K, toView, turnAxes, type Turn } from "../../lib/view.ts";
import { cameraAzimuth, frameCrop, frameFor, modelArtBox, modelDrawnBox } from "./frames.ts";
import { frameYaw } from "./normalize.ts";

/** Which of a model's 8 pictures Isometric shows, and where it draws (docs/design/design-v1-token-models.md 4.4, D-261127-167). */

const TURNS: Turn[] = [0, 1, 2, 3];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("the frame a creature shows", () => {
  test("the camera's azimuth is the side the view's depth grows toward, south east at turn 0", () => {
    assert.deepEqual(TURNS.map(cameraAzimuth), [135, 45, -45, -135]);
    for (const turn of TURNS) {
      // lib/view.ts depth grows along (s, c), toward the viewer. North is -y, so an azimuth θ points along (sin θ, -cos θ).
      const { c, s } = turnAxes(turn);
      const a = (cameraAzimuth(turn) * Math.PI) / 180;
      assert.ok(near(Math.sin(a), s) && near(-Math.cos(a), c), `turn ${turn}`);
    }
  });

  test("every facing the stepper reaches, at every turn, is the frame of its angle from the camera", () => {
    for (const turn of TURNS) {
      for (let facing = -360; facing <= 360; facing += 45) {
        const expected = (((Math.round((facing - 135 + 90 * turn) / 45)) % 8) + 8) % 8;
        assert.equal(frameFor(turn, facing), expected, `facing ${facing} at turn ${turn}`);
      }
      // Facing the camera shows frame 0, a quarter turn clockwise from it frame 2, and its back frame 4.
      assert.equal(frameFor(turn, cameraAzimuth(turn)), 0);
      assert.equal(frameFor(turn, cameraAzimuth(turn) + 90), 2);
      assert.equal(frameFor(turn, cameraAzimuth(turn) + 180), 4);
    }
    // At turn 0 the camera stands south east: a creature facing south shows the frame turned 45 degrees clockwise from facing it.
    assert.equal(frameFor(0, 180), 1);
    assert.equal(frameFor(0, 315), 4);
    assert.equal(frameFor(0, 0), 5);
  });

  test("a turn right with the facing 90 degrees less shows the same frame", () => {
    for (const turn of TURNS) {
      for (let facing = -270; facing <= 360; facing += 45) assert.equal(frameFor(((turn + 1) % 4) as Turn, facing - 90), frameFor(turn, facing));
    }
  });

  test("a typed or imported facing shows the nearest frame, and one that is no number faces north", () => {
    // 100 degrees lies 10 from the frame at 90 and 35 from the one at 135.
    assert.equal(frameFor(0, 100), frameFor(0, 90));
    assert.equal(frameFor(0, 10), frameFor(0, 0));
    assert.equal(frameFor(2, -350), frameFor(2, 0));
    for (const bad of [Number.NaN, Infinity, -Infinity]) assert.equal(frameFor(1, bad), frameFor(1, 0));
  });

  test("the frame drawn is the creature as the board's own projection sees it, at every turn and facing", () => {
    // A lopsided figure in the drawing's axes (lane B's renderer): Y up, front toward +Z, so the creature's left is +X.
    const points: [number, number, number][] = [
      [0.3, 0, 0.1],
      [-0.2, 1.1, 0.4],
      [0.05, 0.6, -0.45],
      [0.4, 0.2, 0.3],
    ];
    for (const turn of TURNS) {
      for (let facing = 0; facing < 360; facing += 45) {
        const f = (facing * Math.PI) / 180;
        const frame = frameFor(turn, facing);
        for (const [x, y, z] of points) {
          // In the world the front points along the facing, clockwise from north, and the left a quarter turn before it.
          const world = { x: z * Math.sin(f) - x * Math.cos(f), y: -z * Math.cos(f) - x * Math.sin(f) };
          const board = toView(isometric(turn), world, y);
          // The frame turns the model and looks at it from +Z, 30 degrees up: across is x', up is y' cos 30 - z' sin 30.
          const yaw = frameYaw(frame);
          const tx = x * Math.cos(yaw) + z * Math.sin(yaw);
          const tz = -x * Math.sin(yaw) + z * Math.cos(yaw);
          const up = y * K - tz * 0.5;
          assert.ok(near(board.x, tx) && near(board.y, -up), `turn ${turn}, facing ${facing}, point ${[x, y, z]}`);
        }
      }
    }
  });
});

describe("where a frame draws", () => {
  test("the art box is the frame's square hung from its anchor on the ring's middle, the drawn box its share of it", () => {
    const art = modelArtBox({ side: 1.5, anchorY: 0.8 }, 2, { x: 10, y: 20 });
    assert.ok(near(art.x0, 8.5) && near(art.x1, 11.5) && near(art.y0, 17.6) && near(art.y1, 20.6));
    const drawn = modelDrawnBox(art, [25, 10, 75, 90]);
    assert.ok(near(drawn.x0, 9.25) && near(drawn.x1, 10.75) && near(drawn.y0, 17.9) && near(drawn.y1, 20.3));
    // The whole frame is the whole art box.
    assert.deepEqual(modelDrawnBox(art, [0, 0, 100, 100]), art);
  });

  test("frames crop the sheet in 4 by 2 squares at either copy's size", () => {
    assert.deepEqual(frameCrop(0, { width: 2048, height: 1024 }), { x: 0, y: 0, width: 512, height: 512 });
    assert.deepEqual(frameCrop(3, { width: 2048, height: 1024 }), { x: 1536, y: 0, width: 512, height: 512 });
    assert.deepEqual(frameCrop(5, { width: 2048, height: 1024 }), { x: 512, y: 512, width: 512, height: 512 });
    assert.deepEqual(frameCrop(7, { width: 1024, height: 512 }), { x: 768, y: 256, width: 256, height: 256 });
  });
});
