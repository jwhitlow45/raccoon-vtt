import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Stamp } from "#shared/model.ts";
import { STAMP_ART } from "#shared/stamps.ts";
import {
  duplicateOf,
  handleAt,
  handlePositions,
  libraryFootprint,
  matchStamps,
  normalizeDegrees,
  placement,
  resizeFrom,
  rotationFrom,
  shippedChoice,
  shippedStamp,
  sizeBucket,
  stampAt,
  toInput,
  toLocal,
  topZ,
  toWorld,
} from "./rules.ts";

const BOUNDS = { w: 20, h: 12 };

function stamp(over: Partial<Stamp> = {}): Stamp {
  return { id: "s1", rev: 3, sceneId: "scene", art: { key: "barrel" }, x: 5, y: 5, w: 2, h: 1, rotation: 0, z: 0, visibility: "all", ...over };
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

describe("stamp placement", () => {
  test("a tap places the chosen stamp centered on it, snapped to half cells, at its catalog footprint", () => {
    const barrel = STAMP_ART.find((s) => s.key === "barrel");
    assert.ok(barrel);
    const input = placement(shippedChoice(barrel), { x: 3.2, y: 7.74 }, { id: "n1", z: 4, bounds: BOUNDS });
    assert.deepEqual(input, { id: "n1", art: { key: "barrel" }, x: 3, y: 7.5, w: barrel.w, h: barrel.h, rotation: 0, z: 4, visibility: "all" });
  });

  test("a tap past the scene's edge places the stamp on the edge", () => {
    const input = placement({ art: { key: "barrel" }, w: 1, h: 1, name: "Barrel" }, { x: -2, y: 30 }, { id: "n1", z: 0, bounds: BOUNDS });
    assert.equal(input.x, 0);
    assert.equal(input.y, 12);
  });

  test("a room image stamps one cell across on its long side, keeping its shape", () => {
    assert.deepEqual(libraryFootprint(400, 200), { w: 1, h: 0.5 });
    assert.deepEqual(libraryFootprint(300, 600), { w: 0.5, h: 1 });
    assert.deepEqual(libraryFootprint(1000, 100), { w: 1, h: 0.25 });
    assert.deepEqual(libraryFootprint(undefined, undefined), { w: 1, h: 1 });
  });

  test("a new stamp goes on top of the scene's stamps", () => {
    assert.equal(topZ([]), 0);
    assert.equal(topZ([{ z: 2 }, { z: -4 }, { z: 7 }]), 8);
    assert.equal(topZ([{ z: 1_000_000 }]), 1_000_000);
  });
});

describe("stamp frames and hits", () => {
  test("local and world points round-trip through any turn", () => {
    for (const rotation of [0, 30, 90, 215, -45]) {
      const pose = { x: 4, y: 6, w: 2, h: 1, rotation };
      const w = toWorld(pose, toLocal(pose, { x: 7.3, y: 2.1 }));
      near(w.x, 7.3);
      near(w.y, 2.1);
    }
  });

  test("a positive turn is clockwise on screen, with y pointing down", () => {
    const east = toWorld({ x: 0, y: 0, w: 1, h: 1, rotation: 90 }, { x: 1, y: 0 });
    near(east.x, 0);
    near(east.y, 1);
  });

  test("a tap hits the topmost stamp whose turned box holds it", () => {
    const low = stamp({ id: "low", z: 1 });
    const high = stamp({ id: "high", z: 2, x: 5.5 });
    assert.equal(stampAt([low, high], { x: 5.2, y: 5 }, 0)?.id, "high");
    assert.equal(stampAt([low, high], { x: 4.1, y: 5 }, 0)?.id, "low");
    // A 2 by 1 stamp turned upright no longer reaches 0.9 cells to its side.
    const upright = stamp({ id: "up", rotation: 90 });
    assert.equal(stampAt([upright], { x: 5.9, y: 5 }, 0), null);
    assert.equal(stampAt([upright], { x: 5, y: 5.9 }, 0)?.id, "up");
    assert.equal(stampAt([upright], { x: 5.6, y: 5 }, 0.2)?.id, "up");
  });

  test("equal z draws and hits by id, as the board draws them", () => {
    const a = stamp({ id: "a" });
    const b = stamp({ id: "b" });
    assert.equal(stampAt([b, a], { x: 5, y: 5 }, 0)?.id, "b");
  });
});

describe("stamp handles", () => {
  test("the rotate handle stands above the stamp and the resize handle off its corner, a fixed number of pixels out", () => {
    const h = handlePositions(stamp(), 50);
    near(h.rotate.x, 5);
    near(h.rotate.y, 4.5 - 36 / 50);
    near(h.resize.x, 6 + 16 / 50);
    near(h.resize.y, 5.5 + 16 / 50);
  });

  test("the handles turn with the stamp", () => {
    const h = handlePositions(stamp({ rotation: 90 }), 50);
    near(h.rotate.x, 5 + 0.5 + 36 / 50);
    near(h.rotate.y, 5);
  });

  test("a press within 22 px of a handle takes it", () => {
    const s = stamp();
    assert.equal(handleAt(s, { x: 5, y: 4.5 - 36 / 50 + 0.3 }, 50), "rotate");
    assert.equal(handleAt(s, { x: 6.5, y: 5.9 }, 50), "resize");
    assert.equal(handleAt(s, { x: 5, y: 5 }, 50), null);
  });

  test("a press on a small stamp's art moves it, even where a handle's reach would cover it", () => {
    // A barrel half a cell across on a phone's fitted 30-wide scene, about 11 px per cell.
    const scale = 11.4;
    for (const rotation of [0, 30, 90]) {
      const barrel = stamp({ w: 0.5, h: 0.5, rotation });
      const at = (x: number, y: number) => toWorld(barrel, { x, y });
      assert.equal(handleAt(barrel, at(0, 0), scale), null, `center at ${rotation} degrees`);
      for (const [x, y] of [[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]] as const) {
        assert.equal(handleAt(barrel, at(x, y), scale), null, `corner ${x}, ${y} at ${rotation} degrees`);
      }
      const h = handlePositions(barrel, scale);
      assert.equal(handleAt(barrel, h.resize, scale), "resize", `resize handle at ${rotation} degrees`);
      assert.equal(handleAt(barrel, h.rotate, scale), "rotate", `rotate handle at ${rotation} degrees`);
      // Just past the corner, toward the handle, still takes it.
      assert.equal(handleAt(barrel, at(0.25 + 2 / scale, 0.25 + 2 / scale), scale), "resize", `past the corner at ${rotation} degrees`);
    }
  });

  test("the resize handle's reach never touches the stamp's box, at any size", () => {
    for (const scale of [5, 11.4, 50]) {
      const h = handlePositions(stamp({ w: 0.25, h: 0.25, x: 0, y: 0 }), scale);
      // The nearest point of the box is its corner, at (0.125, 0.125).
      assert.ok(Math.hypot(h.resize.x - 0.125, h.resize.y - 0.125) > 22 / scale);
    }
  });

  test("the rotate handle snaps to 15 degrees, or follows the pointer with Snap off", () => {
    const c = { x: 0, y: 0 };
    assert.equal(rotationFrom(c, { x: 0, y: -1 }, true), 0);
    assert.equal(rotationFrom(c, { x: 1, y: 0 }, true), 90);
    assert.equal(rotationFrom(c, { x: -1, y: 0 }, true), 270);
    assert.equal(rotationFrom(c, { x: Math.sin(0.2), y: -Math.cos(0.2) }, true), 15);
    assert.equal(rotationFrom(c, { x: Math.sin(0.2), y: -Math.cos(0.2) }, false), 11.459);
    // Just short of a full turn snaps to 0, never to 360.
    assert.equal(rotationFrom(c, { x: -0.01, y: -1 }, true), 0);
  });

  test("angles normalize into 0 up to 360", () => {
    assert.equal(normalizeDegrees(-90), 270);
    assert.equal(normalizeDegrees(720), 0);
    assert.equal(normalizeDegrees(-0), 0);
  });

  test("the corner handle resizes about the center, keeping the shape", () => {
    const start = { w: 2, h: 1 };
    const grab = { x: 1.2, y: 0.7 };
    const bigger = resizeFrom(start, grab, { x: 2.4, y: 1.4 });
    assert.deepEqual(bigger, { w: 4, h: 2 });
    // A sideways wobble along the other diagonal changes nothing.
    assert.deepEqual(resizeFrom(start, grab, { x: grab.x + 0.1, y: grab.y - 0.2 }), start);
  });

  test("resizing stops where either side would leave 0.25 to 20 cells", () => {
    const grab = { x: 1, y: 0.25 };
    assert.deepEqual(resizeFrom({ w: 2, h: 0.5 }, grab, { x: 0.01, y: 0 }), { w: 1, h: 0.25 });
    assert.deepEqual(resizeFrom({ w: 2, h: 0.5 }, grab, { x: 100, y: 25 }), { w: 20, h: 5 });
    // Dragged through the center, the stamp stays at its smallest instead of turning inside out.
    assert.deepEqual(resizeFrom({ w: 2, h: 0.5 }, grab, { x: -3, y: -1 }), { w: 1, h: 0.25 });
  });
});

describe("stamp ops", () => {
  test("an op carries a stamp without its rev or scene, and optional fields only when set", () => {
    assert.deepEqual(toInput(stamp()), { id: "s1", art: { key: "barrel" }, x: 5, y: 5, w: 2, h: 1, rotation: 0, z: 0, visibility: "all" });
    const dressed = toInput(stamp({ tint: "#e8a048", flip: true, art: { assetId: "a1" } }));
    assert.equal(dressed.tint, "#e8a048");
    assert.equal(dressed.flip, true);
    assert.deepEqual(dressed.art, { assetId: "a1" });
    assert.equal("flip" in toInput(stamp({ flip: false })), false);
  });

  test("a duplicate lands half a cell right and down, on top, kept on the scene", () => {
    const copy = duplicateOf(stamp({ tint: "#5a4636", rotation: 30 }), "copy", 9, BOUNDS);
    assert.deepEqual(copy, { id: "copy", art: { key: "barrel" }, x: 5.5, y: 5.5, w: 2, h: 1, rotation: 30, z: 9, visibility: "all", tint: "#5a4636" });
    const edge = duplicateOf(stamp({ x: 20, y: 12 }), "copy", 1, BOUNDS);
    assert.equal(edge.x, 20);
    assert.equal(edge.y, 12);
  });
});

describe("the picker", () => {
  test("search keeps the stamps whose name holds every word typed", () => {
    assert.equal(matchStamps("").length, STAMP_ART.length);
    assert.deepEqual(
      matchStamps("camp").map((s) => s.key),
      ["campfire", "campfire-embers", "campfire-ashes"],
    );
    assert.deepEqual(
      matchStamps("  CAMPFIRE ash ").map((s) => s.key),
      ["campfire-ashes"],
    );
    assert.deepEqual(matchStamps("throne"), []);
  });

  test("a key this client does not ship has no catalog entry, so it draws as a dashed box", () => {
    assert.equal(shippedStamp("barrel")?.name, "Barrel");
    assert.equal(shippedStamp("throne"), null);
  });
});

describe("the drawing cache's size buckets", () => {
  test("a copy is the next power of two up from the stamp's size on screen, at least 16 and at most the image", () => {
    assert.equal(sizeBucket(3, 512), 16);
    assert.equal(sizeBucket(40, 512), 64);
    assert.equal(sizeBucket(64, 512), 64);
    assert.equal(sizeBucket(65, 512), 128);
    assert.equal(sizeBucket(900, 512), 512);
    assert.equal(sizeBucket(300, 61), 61);
  });
});
