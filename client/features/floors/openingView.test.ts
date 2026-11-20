import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, OPENING_RECT, UPPER, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { WAITS } from "./openings.testing.ts";
import { farChunks, farEnd, farTokensIn, holeDrop, holeDrops, holeOutline, holesOn, windowPxPerCell, WINDOW_MAX_PX } from "./openingView.ts";
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
  test("the floor's height plus the ground under the hole less the ground below, where the copy holds the far floor and its end", { skip: WAITS.fallDrop }, () => {
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
