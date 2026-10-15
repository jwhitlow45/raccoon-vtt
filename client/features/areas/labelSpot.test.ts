import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reveal, room, token } from "#shared/testutil.ts";
import { areaLabelSpot, foggedCells, tokenBoxes } from "./labelSpot.ts";

const measure = (text: string, px: number) => text.length * px * 0.58;
/** A 100 px wide name pill with its pointer. */
const size = { width: 108, height: 30 };

describe("where a placed area's name goes", () => {
  test("above the area in open ground", () => {
    const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, size, scale: 30, avoid: tokenBoxes([token("far", { x: 20, y: 20 })], 30, measure) });
    assert.deepEqual(spot, { x: 5, y: 2, place: "above", oneLine: false });
  });

  test("below the area when a token's name label sits where the name would go", () => {
    // A goblin whose label hangs just above the area's top edge.
    const avoid = tokenBoxes([token("gob", { x: 4, y: 0, number: 2 })], 30, measure);
    const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, size, scale: 30, avoid });
    assert.deepEqual(spot, { x: 5, y: 8, place: "below", oneLine: false });
  });

  test("stays above when below is more crowded", () => {
    const avoid = tokenBoxes([token("a", { x: 4, y: 0 }), token("b", { x: 4, y: 8 }), token("c", { x: 5, y: 8 })], 30, measure);
    assert.equal(areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, size, scale: 30, avoid }).place, "above");
  });

  test("a token too small on screen for marks only takes its own body, a bigger one its chips and its label's band too", () => {
    assert.equal(tokenBoxes([token("gob")], 5, measure).length, 1);
    assert.equal(tokenBoxes([token("gob")], 30, measure).length, 3);
  });

  // Spirit Guardians around a PC in melee: a body over the middle of each edge, with room further along them.
  const melee = () => tokenBoxes([token("over", { x: 4.5, y: 1 }), token("under", { x: 4.5, y: 7 })], 30, measure);
  const edge = (dx: number, side: "top" | "bottom") => ({ x: 5 + dx, y: side === "top" ? 2 : 8 });

  test("slides along an edge before it covers a token", () => {
    const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, reach: 3, edge, size, scale: 30, avoid: melee() });
    assert.notEqual(spot.x, 5, "moved off the middle");
    assert.equal(spot.oneLine, false);
    const half = size.width / 2 / 30;
    const tall = size.height / 30;
    const box = spot.place === "above" ? { x0: spot.x - half, y0: spot.y - tall, x1: spot.x + half, y1: spot.y } : { x0: spot.x - half, y0: spot.y, x1: spot.x + half, y1: spot.y + tall };
    for (const b of melee()) assert.ok(!(box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1), "clear of every token");
  });

  test("falls back to one cut line when the whole name has nowhere clear to go", () => {
    // Bodies all along both edges: the whole name has nowhere clear to go, so the smaller pill takes the least covered spot.
    const row = (y: number) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => token(`t${x}-${y}`, { x, y }));
    const avoid = tokenBoxes([...row(0.6), ...row(8.4)], 30, measure);
    const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, reach: 3, edge, size: { width: 108, height: 44 }, oneLineSize: { width: 108, height: 26 }, scale: 30, avoid });
    assert.equal(spot.oneLine, true);
  });

  test("keeps off the move marker too, when the cleric moved and then cast", () => {
    // "Moved 20 ft" over "10 ft left" hangs from the ring where the turn began, across the area's top middle.
    const marker = { x0: 4, y0: 0.8, x1: 6.5, y1: 2.1 };
    const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, reach: 3, edge, size, scale: 30, avoid: [marker] });
    const half = size.width / 2 / 30;
    const tall = size.height / 30;
    const box = spot.place === "above" ? { x0: spot.x - half, y0: spot.y - tall, x1: spot.x + half, y1: spot.y } : { x0: spot.x - half, y0: spot.y, x1: spot.x + half, y1: spot.y + tall };
    assert.ok(!(box.x0 < marker.x1 && marker.x0 < box.x1 && box.y0 < marker.y1 && marker.y0 < box.y1), "clear of the marker");
  });

  describe("on a player's screen, the opaque fog counts as taken", () => {
    // Revealed from row 2 down: the area's top edge sits on the fog's edge, as Spirit Guardians did beside a revealed room.
    const fog = () => {
      const state = room();
      reveal(state, "s1", { x: 0, y: 2, w: 12, h: 12 });
      return foggedCells(state.fogTiles, "s1", state.scenes.s1!.bounds);
    };

    test("a cell is fogged unless the fog players get reveals part of it, and the ground off the scene is not fog", () => {
      const fogged = fog();
      assert.equal(fogged(5, 1), true);
      assert.equal(fogged(5, 2), false);
      assert.equal(fogged(30, 20), true, "a tile nobody revealed is fog");
      assert.equal(fogged(5, -1), false, "above the scene");
      assert.equal(fogged(40, 5), false, "past its east edge");
    });

    test("the name moves below the area, off the fog, and the DM's stays above", () => {
      const input = { top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, size, scale: 30, avoid: [] };
      assert.deepEqual(areaLabelSpot({ ...input, fogged: fog() }), { x: 5, y: 8, place: "below", oneLine: false });
      assert.deepEqual(areaLabelSpot(input), { x: 5, y: 2, place: "above", oneLine: false });
    });

    test("with fog over both edges, the name falls back to one cut line", () => {
      const state = room();
      reveal(state, "s1", { x: 0, y: 3, w: 12, h: 4 });
      const spot = areaLabelSpot({
        top: { x: 5, y: 3 },
        bottom: { x: 5, y: 7 },
        size: { width: 108, height: 44 },
        oneLineSize: { width: 108, height: 26 },
        scale: 30,
        avoid: [],
        fogged: foggedCells(state.fogTiles, "s1", state.scenes.s1!.bounds),
      });
      assert.equal(spot.oneLine, true);
    });

    test("an area at the top of the scene keeps its name above it, over the plain ground off the map", () => {
      const state = room();
      reveal(state, "s1", { x: 0, y: 0, w: 12, h: 12 });
      const spot = areaLabelSpot({ top: { x: 5, y: 0 }, bottom: { x: 5, y: 6 }, size, scale: 30, avoid: [], fogged: foggedCells(state.fogTiles, "s1", state.scenes.s1!.bounds) });
      assert.equal(spot.place, "above");
    });
  });
});
