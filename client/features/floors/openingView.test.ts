import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, OPENING_RECT, UPPER, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState, Scene } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { cropKey, farChunks, farEnd, farTokensIn, holeDrop, holeDrops, holeOutline, holesOn, paintFloorRaster, pastFloorEdge, windowPxPerCell, WINDOW_MAX_PX, type RasterPainter } from "./openingView.ts";
import { SQUARES } from "#shared/rules/grid.ts";

/*
 * What an opening shows of the floor below (docs/design/design-v1-floors.md
 * phase 4, 7.4), on the shared tower's opening from Upper floor (o1, the
 * hole, 2 by 2 at 6, 6) down to Ground floor (o2), 10 ft a floor.
 */

/** A player's cut of an end (project.ts): no pair, ground or seq, `to` and `rise` only where they hold the far floor, and its way. */
function cut(link: FloorLink, dir: "up" | "down", holdsFar: boolean, rise = 10): FloorLink {
  const { pair: _pair, to, ground: _ground, made: _made, ...rest } = link;
  return { ...rest, ...(holdsFar ? { to, rise } : {}), dir } as unknown as FloorLink;
}

/** Ana's copy holding Upper floor, and Ground floor where `ground`, with the ends on the floors she holds and the far end only where it is projected. */
function anaCopy(s: RoomState, held: { ground: boolean; farEnd: boolean }): RoomState {
  const scenes = { [UPPER]: s.scenes[UPPER]!, ...(held.ground ? { [GROUND]: s.scenes[GROUND]! } : {}) };
  const links: Record<string, FloorLink> = { o1: cut(s.floorLinks!.o1!, "down", held.ground) };
  if (held.ground && held.farEnd) links.o2 = cut(s.floorLinks!.o2!, "up", true);
  return { ...s, scenes, floorLinks: links };
}

describe("the holes on a floor", () => {
  test("only an opening's upper end is a hole, with the floor below where the copy holds it", () => {
    const s = withOpening(withStairs(tower()));
    assert.deepEqual(holesOn(s, UPPER).map((h) => [h.link.id, h.far?.id ?? null]), [["o1", GROUND]]);
    assert.deepEqual(holesOn(s, GROUND), [], "the lower end leads up and is no hole, and stairs are none");
    assert.deepEqual(holesOn(anaCopy(s, { ground: false, farEnd: false }), UPPER).map((h) => [h.link.id, h.far]), [["o1", null]], "a floor not held: a black drop");
    assert.deepEqual(holesOn(anaCopy(s, { ground: true, farEnd: false }), UPPER).map((h) => h.far?.id), [GROUND]);
  });

  test("the far end: the end over the same squares on the floor below that leads back, as the copy holds it", () => {
    const s = withOpening(tower());
    assert.equal(farEnd(s, s.floorLinks!.o1!)?.id, "o2");
    assert.equal(farEnd(anaCopy(s, { ground: true, farEnd: true }), anaCopy(s, { ground: true, farEnd: true }).floorLinks!.o1!)?.id, "o2");
    assert.equal(farEnd(anaCopy(s, { ground: true, farEnd: false }), anaCopy(s, { ground: true, farEnd: false }).floorLinks!.o1!), null, "not projected to her");
    // A second opening elsewhere on Ground floor is not this one's end.
    const two = withOpening(withOpening(tower(), { id: "o3", pairId: "o4", rect: { x: 12, y: 12, w: 1, h: 1 } }));
    assert.equal(farEnd(two, two.floorLinks!.o3!)?.id, "o4");
    assert.equal(farEnd(two, two.floorLinks!.o1!)?.id, "o2");
  });
});

describe("the height chip", () => {
  test("the floor's height plus the ground under the hole less the ground below, where the copy holds the far floor and its end", () => {
    const s = withOpening(tower());
    assert.equal(holeDrop(s, s.floorLinks!.o1!), 10);
    assert.equal(holeDrops(s, UPPER), "o1=10");
    const both = anaCopy(s, { ground: true, farEnd: true });
    assert.equal(holeDrop(both, both.floorLinks!.o1!), 10, "the player's end carries its rise");
    const tall = anaCopy(s, { ground: true, farEnd: true });
    tall.floorLinks!.o1 = cut(s.floorLinks!.o1!, "down", true, 20);
    assert.equal(holeDrop(tall, tall.floorLinks!.o1!), 20);
  });

  test("no chip without the floor below or its end, and none on stairs", () => {
    const s = withOpening(withStairs(tower()));
    const none = anaCopy(s, { ground: false, farEnd: false });
    assert.equal(holeDrop(none, none.floorLinks!.o1!), null);
    const noEnd = anaCopy(s, { ground: true, farEnd: false });
    assert.equal(holeDrop(noEnd, noEnd.floorLinks!.o1!), null);
    assert.equal(holeDrops(noEnd, UPPER), "");
    assert.equal(holeDrops(s, GROUND), "", "the lower end and the stairs make no chip");
  });
});

describe("what a window draws of the floor below", () => {
  test("the creatures whose space meets the hole's squares, on the floor below only, lowest first", () => {
    const s = withOpening(tower());
    const at = (id: string, sceneId: string, x: number, y: number, elevation = 0) => token(id, { sceneId, x, y, elevation });
    const room: RoomState = {
      ...s,
      tokens: {
        under: at("under", GROUND, OPENING_RECT.x + 1, OPENING_RECT.y + 1),
        flier: at("flier", GROUND, OPENING_RECT.x, OPENING_RECT.y, 5),
        edge: at("edge", GROUND, OPENING_RECT.x + 2, OPENING_RECT.y),
        upstairs: at("upstairs", UPPER, OPENING_RECT.x, OPENING_RECT.y),
        attic: at("attic", ATTIC, OPENING_RECT.x, OPENING_RECT.y),
      },
    };
    assert.deepEqual(
      farTokensIn(room, GROUND, OPENING_RECT).map((t) => t.id),
      ["under", "flier"],
      "the one beside the hole and those on other floors are left out",
    );
    assert.deepEqual(farTokensIn(room, "gone", OPENING_RECT), []);
  });

  test("the floor below's build only", () => {
    const chunks = { a: { sceneId: GROUND, cx: 0, cy: 0 }, b: { sceneId: UPPER, cx: 0, cy: 0 } } as unknown as RoomState["buildChunks"];
    assert.deepEqual(farChunks({ buildChunks: chunks }, GROUND).map((c) => c.sceneId), [GROUND]);
  });

  test("a crop takes at most 512 pixels a side, 64 a cell where that fits", () => {
    assert.equal(windowPxPerCell({ w: 2, h: 2 }), 64);
    assert.equal(windowPxPerCell({ w: 8, h: 8 }), 64);
    assert.equal(windowPxPerCell({ w: 8, h: 8 }) * 8 <= WINDOW_MAX_PX, true);
    assert.equal(windowPxPerCell({ w: 9, h: 3 }), 56);
    assert.equal(windowPxPerCell({ w: 9, h: 3 }) * 9 <= WINDOW_MAX_PX, true);
  });

  test("a hole's outline is its squares, the box round its hexes on hexes", () => {
    assert.deepEqual(holeOutline(SQUARES, OPENING_RECT), { ...OPENING_RECT, loop: null });
  });
});

describe("a far floor's crops are drawn again on every change they read (FLR4INT-ASTRA-02)", () => {
  const MAP = { assetId: "a1", widthPx: 1920, heightPx: 1120, cellPx: 80, originPx: { x: 0, y: 0 } };
  const far = { ...tower().scenes[GROUND]!, map: MAP, background: "#202020" } as Scene;
  const outlines = [{ id: "o1", o: holeOutline(SQUARES, OPENING_RECT) }];
  const URLS = ["/m/a1", "/f/a1"];
  const key = (over: Partial<Scene>, urls: readonly string[] = URLS, holes = outlines) => cropKey({ ...far, ...over }, urls, holes);

  test("a map calibrated anew, the same image on the same bounds, is a new crop: its scale, its origin and its size each", () => {
    const calibrated: Partial<Scene["map"] & object>[] = [{ cellPx: 70 }, { originPx: { x: -160, y: 0 } }, { originPx: { x: 0, y: 40 } }, { widthPx: 1600 }, { heightPx: 900 }];
    for (const patch of calibrated) assert.notEqual(key({ map: { ...MAP, ...patch } }), key({}), JSON.stringify(patch));
    assert.notEqual(key({ map: undefined }, []), key({}), "the map taken away");
    assert.equal(key({ map: { ...MAP } }), key({}), "the same calibration, a new object, draws nothing again");
  });

  test("so is every other input the crop reads but the build: the addresses, the background, the bounds, the grid, its shape, the walls' rule and the holes", () => {
    assert.notEqual(key({}, ["/m/a2", "/f/a2"]), key({}));
    assert.notEqual(key({ background: "#303030" }), key({}));
    assert.notEqual(key({ bounds: { w: 30, h: 20 } }), key({}));
    assert.notEqual(key({ grid: { ...far.grid, show: !far.grid.show } }), key({}));
    assert.notEqual(key({ grid: { ...far.grid, opacity: 0.6 } }), key({}));
    assert.notEqual(key({ gridShape: "hexRows" }), key({}));
    assert.notEqual(key({ autoWalls: "off" }), key({}));
    assert.notEqual(key({}, URLS, [{ id: "o1", o: holeOutline(SQUARES, { ...OPENING_RECT, x: 7 }) }]), key({}));
  });
});

describe("the far floor's fog in a window composites over what the window drew, and clears none of it (FLR4INT-ASTRA-01)", () => {
  type Call = { op: string; args: number[]; fill?: string };
  /** A context that keeps every call, with no clearRect: a clear would throw. */
  function recorder(): RasterPainter & { calls: Call[] } {
    const calls: Call[] = [];
    const g = {
      calls,
      imageSmoothingEnabled: true,
      fillStyle: "" as RasterPainter["fillStyle"],
      save: () => void calls.push({ op: "save", args: [] }),
      restore: () => void calls.push({ op: "restore", args: [] }),
      fillRect: (...args: number[]) => void calls.push({ op: "fillRect", args, fill: String(g.fillStyle) }),
      drawImage: (_image: unknown, ...args: number[]) => void calls.push({ op: "drawImage", args }),
    };
    return g as unknown as RasterPainter & { calls: Call[] };
  }
  const RASTER = { width: 40, height: 28 } as unknown as HTMLCanvasElement;
  const BOUNDS = { w: 20, h: 14 };
  const area = (r: { w: number; h: number }) => r.w * r.h;
  const meets = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  test("a hole wholly on the floor below: its fog is drawn once over the window, with no fill and no clear", () => {
    const g = recorder();
    paintFloorRaster(g, RASTER, BOUNDS, { x: 6, y: 6, w: 2, h: 2 }, false, "#101418");
    assert.deepEqual(g.calls.map((c) => c.op), ["save", "drawImage", "restore"]);
    assert.deepEqual(g.calls[1]!.args, [12, 12, 4, 4, 6, 6, 2, 2], "the raster's own part under the hole, two pixels a cell");
  });

  test("a hole past the floor's edge: fog fills only what lies past it, and the raster draws the rest over the window", () => {
    for (const o of [{ x: 18, y: 5, w: 4, h: 2 }, { x: -1, y: -1, w: 3, h: 3 }, { x: 17, y: 12, w: 4, h: 4 }]) {
      const g = recorder();
      paintFloorRaster(g, RASTER, BOUNDS, o, false, "#101418");
      const fills = g.calls.filter((c) => c.op === "fillRect").map((c) => ({ x: c.args[0]!, y: c.args[1]!, w: c.args[2]!, h: c.args[3]! }));
      assert.ok(fills.every((f) => !meets(f, { x: 0, y: 0, ...BOUNDS })), `${JSON.stringify(o)}: no fill on the floor itself`);
      assert.ok(g.calls.every((c) => c.op !== "fillRect" || c.fill === "#101418"), "in the fog's color");
      const inside = { w: Math.min(BOUNDS.w, o.x + o.w) - Math.max(0, o.x), h: Math.min(BOUNDS.h, o.y + o.h) - Math.max(0, o.y) };
      assert.equal(fills.reduce((n, f) => n + area(f), 0), area(o) - area(inside), `${JSON.stringify(o)}: the fills cover all the rest of the box`);
      assert.equal(g.calls.filter((c) => c.op === "drawImage").length, 1);
    }
  });

  test("sight fills nothing past the edge, and a hole wholly off the floor is all fog", () => {
    const sight = recorder();
    paintFloorRaster(sight, RASTER, BOUNDS, { x: 18, y: 5, w: 4, h: 2 }, true, null);
    assert.deepEqual(sight.calls.map((c) => c.op), ["save", "drawImage", "restore"]);
    assert.deepEqual(pastFloorEdge({ x: 30, y: 2, w: 2, h: 2 }, BOUNDS), [{ x: 30, y: 2, w: 2, h: 2 }]);
    const off = recorder();
    paintFloorRaster(off, RASTER, BOUNDS, { x: 30, y: 2, w: 2, h: 2 }, false, "#101418");
    assert.deepEqual(off.calls.map((c) => c.op), ["save", "fillRect", "restore"]);
  });
});
