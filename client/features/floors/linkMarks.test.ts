import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, onThornsTurn, run, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { viewPointOf } from "../../canvas/isoPlace.ts";
import type { Grid } from "#shared/rules/grid.ts";
import type { Box } from "../../lib/boardText.ts";
import { isometric, toView, toWorld, type Turn, type ViewPoint } from "../../lib/view.ts";
import { pillReach } from "../measure/pillPlace.ts";
import { boxCoversOutline, clearOfMarkers, cornerPill, cornersOf, drawnBox, linkLabel, notReachedLinks, outlineOf, placeEnds, quietLinks, type EndPills } from "./linkMarks.ts";

/*
 * The board's marks of stairs and ladders (docs/design/design-v1-floors.md
 * phase 2, 10, 11): each end's name by what the viewer holds, the DM's
 * "Not reached yet", and the name giving way to the turn's marker.
 */

const end = (s: RoomState, id: string): FloorLink => s.floorLinks![id]!;
/** A player's cut of an end (4): `to` only where they hold that floor, and its way. */
const cut = (link: FloorLink, dir: "up" | "down", holds: boolean) => {
  const { pair: _p, to, ground: _g, made: _m, ...rest } = link;
  return { ...rest, ...(holds ? { to } : {}), dir };
};

describe("an end's name (11)", () => {
  test("names the far floor where the copy holds it, else the kind and the way", () => {
    const s = withStairs();
    assert.equal(linkLabel(s, end(s, "l1")), "Up to Upper floor");
    assert.equal(linkLabel(s, end(s, "l2")), "Down to Ground floor");
    assert.equal(linkLabel(s, cut(end(s, "l1"), "up", false)), "Stairs up");
    const ladder = withStairs(tower(), { kind: "ladder" });
    assert.equal(linkLabel(ladder, cut(end(ladder, "l2"), "down", false)), "Ladder down");
    // A player's `to` of a floor their copy holds names it.
    assert.equal(linkLabel(s, cut(end(s, "l1"), "up", true)), "Up to Upper floor");
  });
});

describe("the DM's Not reached yet (10)", () => {
  test("marks an end whose far floor players have not reached, and not once a party member stands there or the DM opens it", () => {
    const s = withStairs(withStairs(tower(), { id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 8, y: 8, w: 1, h: 1 } }));
    assert.deepEqual(notReachedLinks(s, GROUND), ["l1"]);
    assert.deepEqual(notReachedLinks(s, UPPER), ["l3"], "Upper's stairs down to Ground lead where players are");
    const opened = run(s, { t: "floor.open", sceneId: UPPER, open: true });
    assert.deepEqual(notReachedLinks(opened, GROUND), []);
  });
});

describe("the name gives way to the turn's marker (6.4, picture 07)", () => {
  test("while the turn's creature stands where its moves on this floor began, on the end, and not once it walks off", () => {
    const s = onThornsTurn(withStairs());
    assert.deepEqual(quietLinks(s, GROUND, "dm"), [], "no moves yet: no marker");
    const climbed = run(s, { t: "token.climb", tokenId: "thorn", linkId: "l1" });
    assert.deepEqual(quietLinks(climbed, UPPER, "dm"), ["l2"]);
    assert.deepEqual(quietLinks(climbed, GROUND, "dm"), [], "the floor it left");
    const off = run(climbed, { t: "token.move", tokenId: "thorn", x: 8, y: 8 });
    assert.deepEqual(quietLinks(off, UPPER, "dm"), [], "walked off the stairs");
    // Off its turn there is no marker, so the name shows.
    const after = run(climbed, { t: "encounter.end" });
    assert.deepEqual(quietLinks(after, UPPER, "dm"), []);
  });
});

describe("an end's name beside the turn's marker (FL2-POLISH)", () => {
  const pill = { name: "Up to Upper floor", x: 10, y: 5, above: true, size: "map" as const, small: true, maxLines: 1 as const };
  const bottom = { x: 10, y: 6 };
  test("hangs under the end where the marker would meet it, and stays over it where they are apart", () => {
    // The marker's reading hangs over the same top edge, so the two boxes meet.
    const marker = { x: 10.5, y: 5, value: "Moved 20 ft\n10 ft left", size: "screen" as const, small: true, above: true };
    assert.deepEqual(clearOfMarkers(pill, bottom, [marker], 40), { ...pill, x: 10, y: 6, above: false, below: true });
    assert.equal(clearOfMarkers(pill, bottom, [{ ...marker, x: 30, y: 12 }], 40), pill);
    assert.equal(clearOfMarkers(pill, bottom, [], 40), pill);
  });
});

describe("an end's name and the turn's marker meet where they draw (B53-SOL-02)", () => {
  const SCALE = 40;
  // Stairs at (6,6) two squares wide: the name over the top edge's middle, or under the bottom edge's.
  const name = { name: "Up to Upper floor", x: 7, y: 6, above: true, size: "map" as const, small: true, maxLines: 1 as const, stack: true };
  const bottom = { x: 7, y: 7 };
  const under = { ...name, x: 7, y: 7, above: false, below: true };
  // A creature that moved from (6,3) to (9,3): its marker hangs under the ring where it began.
  const marker = { x: 6.5, y: 4, value: "Moved 15 ft\n15 ft left", size: "screen" as const, small: true, below: true };
  const flat = (turn: Turn) => ({ turn, ground: () => 0 });
  const TURNS: readonly Turn[] = [0, 1, 2, 3];
  const meet = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
  const onMap = (p: typeof name | typeof marker) => pillReach({ ...p, scale: SCALE });

  test("apart on the map, the marker stands over the name in Isometric turn 0, so the name hangs under the stairs, and stays over them in Top-down", () => {
    assert.ok(!meet(onMap(name), onMap(marker)), "apart on the map");
    assert.equal(clearOfMarkers(name, bottom, [marker], SCALE), name);
    assert.deepEqual(clearOfMarkers(name, bottom, [marker], SCALE, flat(0)), under);
  });

  test("at every turn, a marker that stands over the name on screen but lies apart on the map moves the name, and a far one leaves it", () => {
    for (const turn of TURNS) {
      const view = isometric(turn);
      const at = toView(view, name);
      // The marker's point straight up the screen from the name's, as far as still meets: its reading hangs down over the name.
      let found = false;
      for (let d = 0.1; d < 4 && !found; d += 0.1) {
        const world = toWorld(view, { x: at.x, y: at.y - d } as ViewPoint);
        const m = { ...marker, ...world };
        const drawn = (p: typeof name | typeof marker) => pillReach({ ...p, ...viewPointOf(flat(turn), p), scale: SCALE });
        if (meet(onMap(name), onMap(m)) || !meet(drawn(name), drawn(m)) || meet(drawn(under), drawn(m))) continue;
        found = true;
        assert.deepEqual(clearOfMarkers(name, bottom, [m], SCALE, flat(turn)), under, `turn ${turn}`);
      }
      assert.ok(found, `turn ${turn} has such a marker`);
      const far = { ...marker, ...toWorld(view, { x: at.x + 20, y: at.y + 20 } as ViewPoint) };
      assert.equal(clearOfMarkers(name, bottom, [far], SCALE, flat(turn)), name, `turn ${turn}, far`);
    }
  });

  test("a marker over the spot under the end too leaves the name over it", () => {
    // One marker over the top spot and one over the bottom spot: moving would only trade covers.
    const overTop = marker;
    const overBottom = { ...marker, y: marker.y + 1 };
    assert.deepEqual(clearOfMarkers(name, bottom, [overTop], SCALE, flat(0)), under, "one marker moves it");
    assert.equal(clearOfMarkers(name, bottom, [overTop, overBottom], SCALE, flat(0)), name);
  });

  test("drawn heights count: ground raising the marker's point lifts its reading off the name", () => {
    assert.deepEqual(clearOfMarkers(name, bottom, [marker], SCALE, flat(0)), under);
    const raised = { turn: 0 as const, ground: (x: number, y: number) => (Math.abs(x - marker.x) < 0.01 && Math.abs(y - marker.y) < 0.01 ? 3 : 0) };
    assert.equal(clearOfMarkers(name, bottom, [marker], SCALE, raised), name);
  });

  test("a name lying flat under the fog is judged by the box the ground plane turns it into", () => {
    // Flat, the name's box turns with the ground and reaches further up the screen than standing.
    const view = isometric(0);
    const reach = onMap(name);
    const corners = [toView(view, { x: reach.x0, y: reach.y0 }), toView(view, { x: reach.x1, y: reach.y0 })];
    const top = Math.min(...corners.map((c) => c.y));
    const standing = pillReach({ ...name, ...viewPointOf(flat(0), name), scale: SCALE });
    assert.ok(top < standing.y0, "flat reaches higher up the screen");
    // A marker whose reading ends between the two tops meets only the flat name.
    const m = { ...marker, above: true, below: false, ...toWorld(view, { x: toView(view, name).x, y: (top + standing.y0) / 2 } as ViewPoint) };
    assert.equal(clearOfMarkers(name, bottom, [m], SCALE, flat(0), true), name, "standing, apart");
    assert.deepEqual(clearOfMarkers(name, bottom, [m], SCALE, flat(0), false), under, "flat, they meet");
  });
});

describe("a hole's pills stand clear of the hole in Isometric", () => {
  const corners = [
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 4, y: 6 },
    { x: 6, y: 6 },
  ];
  const flat = (turn: Turn) => ({ turn, ground: () => 0 });
  const name = { name: "Opening down", x: 5, y: 6, below: true, size: "map" as const, small: true };
  const screenY = (turn: Turn, c: { x: number; y: number }) => viewPointOf(flat(turn), c).y;

  test("a name hangs under the hole's lowest corner on the screen and a chip sits over its highest, at every turn", () => {
    for (const turn of [0, 1, 2, 3] as const) {
      const under = cornerPill(name, corners, flat(turn), "under", () => true)!;
      const over = cornerPill({ ...name, name: undefined, value: "10 ft down", below: undefined }, corners, flat(turn), "over", () => true)!;
      assert.equal(under.below, true);
      assert.equal(over.above, true);
      assert.equal(screenY(turn, under), Math.max(...corners.map((c) => screenY(turn, c))), `turn ${turn}: the name's corner is the lowest`);
      assert.equal(screenY(turn, over), Math.min(...corners.map((c) => screenY(turn, c))), `turn ${turn}: the chip's corner is the highest`);
    }
  });

  test("the next corner is tried where the first is not a place the pill stands, and none gives null", () => {
    const lowest = cornerPill(name, corners, flat(0), "under", () => true)!;
    const second = cornerPill(name, corners, flat(0), "under", (p) => p.x !== lowest.x || p.y !== lowest.y)!;
    assert.ok(second.x !== lowest.x || second.y !== lowest.y);
    assert.ok(screenY(0, second) <= screenY(0, lowest));
    assert.equal(cornerPill(name, corners, flat(0), "under", () => false), null);
  });
});

describe("a hole's pills keep off the other holes and their pills (LP47B-ISO-1)", () => {
  const SCALE = 40;
  const grid: Grid = { shape: "squares" } as Grid;
  const flat = (turn: Turn) => ({ turn, ground: () => 0 });
  const meet = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
  // A 2 by 2 hole and a 1 by 1 hole, each named and with its height chip.
  const hole = (id: string, rect: { x: number; y: number; w: number; h: number }): EndPills => {
    const o = outlineOf(grid, rect);
    return {
      id,
      o,
      hole: true,
      first: { name: "Down to Ground floor", x: o.x + o.w / 2, y: o.y + o.h, below: true, size: "map", small: true, maxLines: 1, stack: true },
      dropPill: { value: "10 ft down", x: o.x + o.w / 2, y: o.y, above: true, size: "map", small: true },
    };
  };
  const pillBoxes = (iso: ReturnType<typeof flat>, placed: ReturnType<typeof placeEnds>, id: string, scale: number) => [placed.get(id)!.pill!, placed.get(id)!.chip!].map((p) => drawnBox(p, scale, iso, true, true));

  /** The covers among two ends' pills and squares, each pill against the other end's pills and squares as they draw, and against its own hole. */
  const coversOf = (ends: readonly EndPills[], placed: ReturnType<typeof placeEnds>, iso: ReturnType<typeof flat>, scale: number): { others: number; own: number } => {
    const boxes = ends.map((e) => pillBoxes(iso, placed, e.id, scale));
    let others = 0;
    let own = 0;
    ends.forEach((e, i) => {
      for (const x of boxes[i]!) if (boxCoversOutline(x, cornersOf(e.o), iso)) own++;
      ends.forEach((__, j) => {
        if (j <= i) return;
        for (const x of boxes[i]!) for (const y of boxes[j]!) if (meet(x, y)) others++;
        for (const x of boxes[i]!) if (boxCoversOutline(x, cornersOf(ends[j]!.o), iso)) others++;
        for (const y of boxes[j]!) if (boxCoversOutline(y, cornersOf(e.o), iso)) others++;
      });
    });
    return { others, own };
  };
  const alone = (ends: readonly EndPills[], iso: ReturnType<typeof flat>, scale: number) => new Map(ends.flatMap((e) => [...placeEnds([e], [], scale, iso, () => true)]));

  test("where the pills can be placed clear, no pill meets another end's squares or pills or covers its own hole, at every turn", () => {
    const scale = 40;
    const ends = [hole("a", { x: 8, y: 4, w: 2, h: 2 }), hole("b", { x: 12, y: 8, w: 1, h: 1 })];
    for (const turn of [0, 1, 2, 3] as const) {
      const iso = flat(turn);
      assert.deepEqual(coversOf(ends, placeEnds(ends, [], scale, iso, () => true), iso, scale), { others: 0, own: 0 }, `turn ${turn}: a pill covers another end's squares or pills, or its own hole`);
    }
  });

  test("where a phone's scale leaves no clear set, no pill hangs over its own hole and the holes' pills cover no more than each hole's own corners would", () => {
    const scale = 21.375;
    const ends = [hole("a", { x: 8, y: 4, w: 2, h: 2 }), hole("b", { x: 10, y: 7, w: 1, h: 1 })];
    for (const turn of [0, 1, 2, 3] as const) {
      const iso = flat(turn);
      const together = coversOf(ends, placeEnds(ends, [], scale, iso, () => true), iso, scale);
      const apart = coversOf(ends, alone(ends, iso, scale), iso, scale);
      assert.equal(together.own, 0, `turn ${turn}: a pill hangs over its own hole`);
      assert.ok(together.others <= apart.others, `turn ${turn}: ${together.others} covers together, ${apart.others} apart`);
    }
  });

  test("an end whose pills fit no corner keeps its own edge, and Top-down keeps each end's own edge", () => {
    const ends = [hole("a", { x: 8, y: 4, w: 2, h: 2 }), hole("b", { x: 12, y: 8, w: 1, h: 1 })];
    const blocked = placeEnds(ends, [], SCALE, flat(0), () => false);
    for (const e of ends) assert.deepEqual(blocked.get(e.id), { pill: e.first, chip: e.dropPill });
    assert.deepEqual(placeEnds(ends, [], SCALE, null, () => true).get("b"), { pill: ends[1]!.first, chip: ends[1]!.dropPill });
  });
});
