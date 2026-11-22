import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, onThornsTurn, run, thornToken, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { viewPointOf } from "../../canvas/isoPlace.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import type { Box } from "../../lib/boardText.ts";
import { theme } from "../../lib/theme.ts";
import { isometric, toView, toWorld, type Turn, type ViewPoint } from "../../lib/view.ts";
import { pillGeometry, pillPlace, pillReach } from "../measure/pillPlace.ts";
import { boxCoversOutline, clearOfMarkers, cornersOf, drawnBox, linkLabel, notReachedLinks, outlineBox, outlineOf, placeEnds, quietLinks, spotsOf, tokenSpots, type DrawSpace, type EndPills } from "./linkMarks.ts";

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

describe("a hole's pills keep off the other holes and their pills (LP47B-ISO-1)", () => {
  const SCALE = 40;
  const grid: Grid = { shape: "squares" } as Grid;
  const flat = (turn: Turn) => ({ turn, ground: () => 0 });
  const meet = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
  // A 2 by 2 hole and a 1 by 1 hole, each named and with its height chip.
  const hole = (id: string, rect: { x: number; y: number; w: number; h: number }, on: Grid = grid): EndPills => {
    const o = outlineOf(on, rect);
    return {
      id,
      o,
      hole: true,
      first: { name: "Down to Ground floor", x: o.x + o.w / 2, y: o.y + o.h, below: true, size: "map", small: true, maxLines: 1, stack: true },
      dropPill: { value: "10 ft down", x: o.x + o.w / 2, y: o.y, above: true, size: "map", small: true },
    };
  };
  const pillBoxes = (iso: DrawSpace, placed: ReturnType<typeof placeEnds>, id: string, scale: number, view: Box | null = null) => [placed.get(id)!.pill!, placed.get(id)!.chip!].map((p) => drawnBox(p, scale, iso, true, true, view));
  /** A pill's body without its pointer, which always meets the rim it points at: what hides its own hole. */
  const bodies = (iso: DrawSpace, placed: ReturnType<typeof placeEnds>, id: string, scale: number, view: Box | null = null) =>
    [placed.get(id)!.pill!, placed.get(id)!.chip!].map((p) => {
      const b = drawnBox(p, scale, iso, true, true, view);
      const tip = iso ? pillGeometry({ ...p, scale }).pointer / scale : 0;
      return p.above ? { ...b, y1: b.y1 - tip } : { ...b, y0: b.y0 + tip };
    });

  /** The covers among two ends' pills and squares, each pill against the other end's pills and squares as they draw, and against its own hole. */
  const coversOf = (ends: readonly EndPills[], placed: ReturnType<typeof placeEnds>, iso: DrawSpace, scale: number, view: Box | null = null): { others: number; own: number; pills: number; cost: number } => {
    const boxes = ends.map((e) => pillBoxes(iso, placed, e.id, scale, view));
    let pills = 0;
    let squares = 0;
    let own = 0;
    ends.forEach((e, i) => {
      for (const x of bodies(iso, placed, e.id, scale, view)) if (boxCoversOutline(x, cornersOf(e.o), iso)) own++;
      ends.forEach((__, j) => {
        if (j <= i) return;
        for (const x of boxes[i]!) for (const y of boxes[j]!) if (meet(x, y)) pills++;
        for (const x of boxes[i]!) if (boxCoversOutline(x, cornersOf(ends[j]!.o), iso)) squares++;
        for (const y of boxes[j]!) if (boxCoversOutline(y, cornersOf(e.o), iso)) squares++;
      });
    });
    // The search's order of costs (D-261122-112): a pill over a pill, then over its own hole, then over another end's squares.
    return { others: pills + squares, own, pills, cost: pills * 100 + own * 10 + squares };
  };
  const alone = (ends: readonly EndPills[], iso: DrawSpace, scale: number) => new Map(ends.flatMap((e) => [...placeEnds([e], [], scale, iso, () => true)]));

  test("where the pills can be placed clear, no pill meets another end's squares or pills or covers its own hole, at every turn", () => {
    const scale = 40;
    const ends = [hole("a", { x: 8, y: 4, w: 2, h: 2 }), hole("b", { x: 12, y: 8, w: 1, h: 1 })];
    for (const turn of [0, 1, 2, 3] as const) {
      const iso = flat(turn);
      assert.equal(coversOf(ends, placeEnds(ends, [], scale, iso, () => true), iso, scale).cost, 0, `turn ${turn}: a pill covers another end's squares or pills, or its own hole`);
    }
  });

  test("holes whose corners touch, and lp47's layout with a DM's two-line name, cover fewer pills than the default corners, at every turn, on a desk and a phone, on squares and both hex grids (LP48-ISO-1)", () => {
    const named = (e: EndPills): EndPills => ({ ...e, first: { ...e.first!, name: "Down to Undercroft", value: "Not reached yet" } });
    const layouts = [grid, sceneGrid({ gridShape: "hexRows" }), sceneGrid({ gridShape: "hexColumns" })].flatMap((g) => [
      [hole("a", { x: 6, y: 4, w: 2, h: 2 }, g), hole("b", { x: 8, y: 6, w: 1, h: 1 }, g)],
      [named(hole("a", { x: 8, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 10, y: 7, w: 1, h: 1 }, g))],
      [named(hole("a", { x: 6, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 8, y: 6, w: 1, h: 1 }, g))],
    ]);
    for (const ends of layouts) {
      for (const scale of [40, 21.375]) {
        for (const turn of [0, 1, 2, 3] as const) {
          const iso = flat(turn);
          const together = coversOf(ends, placeEnds(ends, [], scale, iso, () => true), iso, scale);
          const apart = coversOf(ends, alone(ends, iso, scale), iso, scale);
          const at = `${ends[0]!.o.loop ? "hexes" : "squares"} ${ends[0]!.o.x.toFixed(2)},${ends[0]!.o.y.toFixed(2)} at ${scale}, turn ${turn}`;
          assert.ok(together.cost <= apart.cost, `${at}: ${JSON.stringify(together)} together, ${JSON.stringify(apart)} at the default corners`);
          assert.ok(apart.pills === 0 || together.pills < apart.pills, `${at}: ${together.pills} pill-on-pill covers together, ${apart.pills} at the default corners`);
          // Here every pill finds a spot off its own hole, the outward ones beside a side corner among them, whose pointer alone meets the rim.
          assert.equal(together.own, 0, `${at}: a pill's words over its own hole`);
        }
      }
    }
  });

  test("a standing pill's box past the screen's edge slides back inside it as Pill.tsx draws it, in Top-down and Isometric, and a flat one keeps its point (ISO-1-PHONE-EDGE)", () => {
    const name = { name: "Down to Undercroft", value: "Not reached yet", x: 15, y: 6, below: true, size: "map" as const, small: true, maxLines: 1 as const, stack: true, side: "right" as const };
    const scale = 21.375;
    for (const iso of [null, flat(0), flat(2)]) {
      const at = viewPointOf(iso, name);
      const view = { x0: at.x - 6, y0: at.y - 20, x1: at.x + 2, y1: at.y + 20 };
      const free = drawnBox(name, scale, iso, true, true);
      const slid = drawnBox(name, scale, iso, true, true, view);
      assert.ok(free.x1 > view.x1, `${iso ? `turn ${iso.turn}` : "Top-down"}: unslid it crosses the edge`);
      assert.ok(slid.x1 <= view.x1 && slid.x0 < free.x0, `${iso ? `turn ${iso.turn}` : "Top-down"}: slid back inside`);
      assert.deepEqual(slid, pillPlace({ ...name, ...at, scale }, view).box);
      if (iso) assert.deepEqual(drawnBox(name, scale, iso, false, true, view), drawnBox(name, scale, iso, false, true), `turn ${iso.turn}: flat`);
    }
  });

  test("on a phone at fit, each pill is judged where the screen's edge slides it, so the pills cover no more than judged unslid and fewer somewhere, in both views on squares and both hex grids (ISO-1-PHONE-EDGE)", () => {
    const named = (e: EndPills): EndPills => ({ ...e, first: { ...e.first!, name: "Down to Undercroft", value: "Not reached yet" } });
    // A 390 px phone's clear part round a 16 by 12 floor at fit, centered on the floor as it draws.
    const phone = (iso: DrawSpace, scale: number): Box => {
      const seen = [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 0, y: 12 }, { x: 16, y: 12 }].map((c) => viewPointOf(iso, c));
      const mx = (Math.min(...seen.map((c) => c.x)) + Math.max(...seen.map((c) => c.x))) / 2;
      const my = (Math.min(...seen.map((c) => c.y)) + Math.max(...seen.map((c) => c.y))) / 2;
      return { x0: mx - 195 / scale, x1: mx + 195 / scale, y0: my - 330 / scale, y1: my + 330 / scale };
    };
    let fewer = 0;
    for (const g of [grid, sceneGrid({ gridShape: "hexRows" }), sceneGrid({ gridShape: "hexColumns" })]) {
      for (const ends of [
        [hole("a", { x: 6, y: 4, w: 2, h: 2 }, g), hole("b", { x: 8, y: 6, w: 1, h: 1 }, g)],
        [named(hole("a", { x: 8, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 10, y: 7, w: 1, h: 1 }, g))],
        [named(hole("a", { x: 12, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 14, y: 6, w: 1, h: 1 }, g))],
      ]) {
        for (const iso of [null, flat(0), flat(1), flat(2), flat(3)]) {
          const scale = 21.375;
          const view = phone(iso, scale);
          const stands = () => iso !== null;
          const slid = coversOf(ends, placeEnds(ends, [], scale, iso, stands, [], { view }), iso, scale, view);
          const unslid = coversOf(ends, placeEnds(ends, [], scale, iso, stands), iso, scale, view);
          const at = `${ends[0]!.o.loop ? "hexes" : "squares"} ${ends[0]!.o.x.toFixed(2)}, ${iso ? `turn ${iso.turn}` : "Top-down"}`;
          assert.ok(slid.cost <= unslid.cost, `${at}: ${JSON.stringify(slid)} judged slid, ${JSON.stringify(unslid)} judged unslid`);
          if (slid.cost < unslid.cost) fewer++;
        }
      }
    }
    assert.ok(fewer > 0, "somewhere the slide changes the choice");
  });

  test("a pill over its own hole beats one over another pill, and loses to one over another end's squares (D-261122-112)", () => {
    // Turn 0: a's lowest corner is 8,6, and its name hung there meets b's squares, and b's chip where b keeps one.
    const iso = flat(0);
    const a = hole("a", { x: 6, y: 4, w: 2, h: 2 });
    const b = hole("b", { x: 9, y: 7, w: 1, h: 1 });
    const spot = (p: PillSpec, x: number, y: number) => p.x === x && p.y === y && p.side === undefined;
    // a's name may hang only under its lowest corner (over b) or under its highest (over its own hole), and b's pills only at their own corners.
    const stands = (p: PillSpec) => (p.name !== undefined ? spot(p, 8, 6) || spot(p, 6, 4) || spot(p, 10, 8) : spot(p, 6, 4) || spot(p, 9, 7));
    const nameOf = (ends: EndPills[]) => placeEnds(ends, [], SCALE, iso, stands).get("a")!.pill!;
    const bare = { ...b, dropPill: null };
    assert.ok(spot(nameOf([a, bare]), 8, 6), "over another end's squares, not its own hole");
    assert.ok(spot(nameOf([a, b]), 6, 4), "over its own hole, not another pill");
  });

  test("a lone hole's name hangs under its lowest corner on the screen and its chip sits over its highest, at every turn, and the next corner serves where the first is no place a pill stands", () => {
    const one = hole("a", { x: 4, y: 4, w: 2, h: 2 });
    const screenY = (iso: ReturnType<typeof flat>, c: { x: number; y: number }) => viewPointOf(iso, c).y;
    for (const turn of [0, 1, 2, 3] as const) {
      const iso = flat(turn);
      const ys = cornersOf(one.o).map((c) => screenY(iso, c));
      const placed = placeEnds([one], [], 40, iso, () => true).get("a")!;
      assert.equal(placed.pill!.below, true);
      assert.equal(placed.chip!.above, true);
      assert.equal(screenY(iso, placed.pill!), Math.max(...ys), `turn ${turn}: the name's corner is the lowest`);
      assert.equal(screenY(iso, placed.chip!), Math.min(...ys), `turn ${turn}: the chip's corner is the highest`);
      const lowest = placed.pill!;
      const next = placeEnds([one], [], 40, iso, (p) => p.x !== lowest.x || p.y !== lowest.y).get("a")!;
      assert.ok(next.pill!.x !== lowest.x || next.pill!.y !== lowest.y, `turn ${turn}: the name moved off the first corner`);
    }
  });

  test("sixteen holes on a hex grid with the turn's marker up finish, and cover no more than each hole's own corners would", () => {
    const hex = sceneGrid({ gridShape: "hexRows" });
    const many = Array.from({ length: 16 }, (_, k) => {
      const o = outlineOf(hex, { x: 3 + (k % 4) * 3, y: 3 + Math.floor(k / 4) * 3, w: 1, h: 1 });
      return { ...hole(`h${String(k).padStart(2, "0")}`, { x: 0, y: 0, w: 1, h: 1 }), o, first: { name: "Down to Ground floor", x: o.x + o.w / 2, y: o.y + o.h, below: true, size: "map" as const, small: true, maxLines: 1 as const, stack: true }, dropPill: { value: "10 ft down", x: o.x + o.w / 2, y: o.y, above: true, size: "map" as const, small: true } };
    });
    const marker = { x: 8, y: 7, value: "Moved 15 ft\n15 ft left", size: "screen" as const, small: true, below: true };
    const scale = 30;
    for (const turn of [0, 1, 2, 3] as const) {
      const iso = flat(turn);
      const started = Date.now();
      const together = placeEnds(many, [marker], scale, iso, () => true);
      assert.ok(Date.now() - started < 2000, `turn ${turn}: the placement took ${Date.now() - started} ms`);
      const apart = new Map(many.flatMap((e) => [...placeEnds([e], [marker], scale, iso, () => true)]));
      const covers = (placed: ReturnType<typeof placeEnds>) => {
        let n = 0;
        const boxes = many.map((e) => pillBoxes(iso, placed, e.id, scale));
        many.forEach((e, i) => {
          for (const x of bodies(iso, placed, e.id, scale)) if (boxCoversOutline(x, cornersOf(e.o), iso)) n += 10;
          for (let j = i + 1; j < many.length; j++) {
            for (const x of boxes[i]!) for (const y of boxes[j]!) if (meet(x, y)) n += 100;
            for (const x of boxes[i]!) if (boxCoversOutline(x, cornersOf(many[j]!.o), iso)) n++;
            for (const y of boxes[j]!) if (boxCoversOutline(y, cornersOf(e.o), iso)) n++;
          }
        });
        return n;
      };
      assert.ok(covers(together) <= covers(apart), `turn ${turn}: ${covers(together)} covers together, ${covers(apart)} apart`);
    }
  });

  test("in Top-down the holes' pills are placed together too: a lone hole's hang from its edges' middles, and two holes' pills keep off each other (LP47-POLISH)", () => {
    const one = hole("a", { x: 4, y: 4, w: 2, h: 2 });
    assert.deepEqual(placeEnds([one], [], 21.375, null, () => false).get("a"), { pill: one.first, chip: one.dropPill }, "a lone hole keeps its edges' middles, standing or not");
    const named = (e: EndPills): EndPills => ({ ...e, first: { ...e.first!, name: "Down to Undercroft", value: "Not reached yet" } });
    let fewer = 0;
    for (const ends of [
      [hole("a", { x: 6, y: 4, w: 2, h: 2 }), hole("b", { x: 8, y: 6, w: 1, h: 1 })],
      [named(hole("a", { x: 8, y: 4, w: 2, h: 2 })), named(hole("b", { x: 10, y: 7, w: 1, h: 1 }))],
      [named(hole("a", { x: 6, y: 4, w: 2, h: 2 })), named(hole("b", { x: 8, y: 6, w: 1, h: 1 }))],
    ]) {
      for (const scale of [40, 21.375]) {
        const together = coversOf(ends, placeEnds(ends, [], scale, null, () => false), null, scale);
        const apart = coversOf(ends, alone(ends, null, scale), null, scale);
        assert.ok(together.cost <= apart.cost, `${JSON.stringify(together)} together, ${JSON.stringify(apart)} at the edges' middles`);
        if (together.pills < apart.pills) fewer++;
      }
    }
    assert.ok(fewer > 0, "some layout covers fewer pills than at the edges' middles");
  });

  test("a hole's pills keep off a token beside the hole, in Top-down and in Isometric (LP47-POLISH)", () => {
    const small = hole("a", { x: 8, y: 6, w: 1, h: 1 });
    const name = (placed: ReturnType<typeof placeEnds>) => placed.get("a")!.pill!;
    const chip = (placed: ReturnType<typeof placeEnds>) => placed.get("a")!.chip!;
    // Top-down on a phone: a creature just under the hole, where its name hangs from the bottom edge's middle.
    const under = { x: 8, y: 7, w: 1, h: 1 };
    const scale = 21.375;
    assert.deepEqual(name(placeEnds([small], [], scale, null, () => false)), small.first);
    const moved = placeEnds([small], [], scale, null, () => false, [under]);
    assert.notDeepEqual(name(moved), small.first, "the name moves off the creature");
    assert.equal(coversOf([small], moved, null, scale).own, 0, "and not onto its own hole");
    // At most the sliver a pointer's end reaches past its corner, where every spot off the hole meets the creature.
    const box = drawnBox(name(moved), scale, null, true, true);
    const sliver = Math.max(0, Math.min(box.x1, 9) - Math.max(box.x0, 8)) * Math.max(0, Math.min(box.y1, 8) - Math.max(box.y0, 7));
    assert.ok(sliver <= theme.radius.sm / scale + 1e-9, `the name still covers ${sliver} of the creature's square`);
    // Isometric: a creature where the chip stands over the highest corner.
    const iso = flat(0);
    const lone = chip(placeEnds([small], [], 40, iso, () => true));
    const top = { x: 7, y: 5, w: 1, h: 1 };
    const off = chip(placeEnds([small], [], 40, iso, () => true, [top]));
    assert.ok(off.x !== lone.x || off.y !== lone.y || off.side !== lone.side, "the chip moves off the creature");
    const token = outlineBox(cornersOf({ ...top, loop: null }), iso);
    const over = (p: PillSpec) => {
      const b = drawnBox(p, 40, iso, true, true);
      return Math.max(0, Math.min(b.x1, token.x1) - Math.max(b.x0, token.x0)) * Math.max(0, Math.min(b.y1, token.y1) - Math.max(b.y0, token.y0));
    };
    assert.ok(over(off) < over(lone) / 4, `and covers ${over(off)} of it, against ${over(lone)} over the highest corner`);
  });

  test("on hex rows and hex columns too, a hole's name moves off a creature under it in Top-down and its chip off one over it in Isometric (LP48FIXA-R1)", () => {
    const over = (p: PillSpec, scale: number, iso: DrawSpace, rect: FloorLink["rect"]) => {
      const b = drawnBox(p, scale, iso, true, true);
      const t = outlineBox(cornersOf({ ...rect, loop: null }), iso);
      return Math.max(0, Math.min(b.x1, t.x1) - Math.max(b.x0, t.x0)) * Math.max(0, Math.min(b.y1, t.y1) - Math.max(b.y0, t.y0));
    };
    for (const shape of ["hexRows", "hexColumns"] as const) {
      const g = sceneGrid({ gridShape: shape });
      const small = hole("a", { x: 8, y: 6, w: 1, h: 1 }, g);
      // Top-down on a phone: a Medium creature's box just under the bottom edge's middle, where the name hangs.
      const scale = 21.375;
      const under = { x: small.first!.x - 0.5, y: small.o.y + small.o.h, w: 1, h: 1 };
      const lone = placeEnds([small], [], scale, null, () => false).get("a")!.pill!;
      const moved = placeEnds([small], [], scale, null, () => false, [under]).get("a")!.pill!;
      assert.ok(over(lone, scale, null, under) > 0, `${shape}: the name alone covers the creature`);
      // A hex's side corner lies inside the creature's width, so the name hung outward from it keeps a strip of the creature.
      assert.ok(over(moved, scale, null, under) < over(lone, scale, null, under) / 2, `${shape}: and moves off most of it, covering ${over(moved, scale, null, under)}`);
      // Isometric turn 0: a creature's box just up the screen from the highest corner, where the chip stands.
      const iso = flat(0);
      const chip = placeEnds([small], [], 40, iso, () => true).get("a")!.chip!;
      const top = { x: chip.x - 1, y: chip.y - 1, w: 1, h: 1 };
      const off = placeEnds([small], [], 40, iso, () => true, [top]).get("a")!.chip!;
      assert.ok(over(chip, 40, iso, top) > 0, `${shape}: the chip alone covers the creature`);
      assert.ok(over(off, 40, iso, top) < over(chip, 40, iso, top) / 4, `${shape}: and moves off it, covering ${over(off, 40, iso, top)} against ${over(chip, 40, iso, top)}`);
    }
  });

  test("the search's lower bound changes no placement on lp48's layouts, in either view, on squares and both hex grids (LP48FIXA-R1)", () => {
    const named = (e: EndPills): EndPills => ({ ...e, first: { ...e.first!, name: "Down to Undercroft", value: "Not reached yet" } });
    const creatures = [{ x: 7, y: 7, w: 1, h: 1 }, { x: 9, y: 3, w: 2, h: 2 }];
    let ran = 0;
    for (const g of [grid, sceneGrid({ gridShape: "hexRows" }), sceneGrid({ gridShape: "hexColumns" })]) {
      for (const ends of [
        [hole("a", { x: 6, y: 4, w: 2, h: 2 }, g), hole("b", { x: 8, y: 6, w: 1, h: 1 }, g)],
        [named(hole("a", { x: 8, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 10, y: 7, w: 1, h: 1 }, g))],
        [named(hole("a", { x: 6, y: 4, w: 2, h: 2 }, g)), named(hole("b", { x: 8, y: 6, w: 1, h: 1 }, g))],
      ]) {
        for (const scale of [40, 21.375]) {
          for (const iso of [null, flat(0), flat(1), flat(2), flat(3)]) {
            for (const tokens of [[], creatures]) {
              const stands = () => iso !== null;
              assert.deepEqual(placeEnds(ends, [], scale, iso, stands, tokens), placeEnds(ends, [], scale, iso, stands, tokens, { prune: false }), `${ends[0]!.o.loop ? "hexes" : "squares"} at ${scale}, ${iso ? `turn ${iso.turn}` : "Top-down"}`);
              ran++;
            }
          }
        }
      }
    }
    assert.equal(ran, 180);
  });

  test("the tokens a hole's pills keep off are each token's squares on the floor shown, and only there", () => {
    const placed = tower({ tokens: { thorn: thornToken(), up: thornToken({ id: "up", sceneId: UPPER, x: 6, y: 2 }), at: thornToken({ id: "at", sceneId: ATTIC, x: 1, y: 1 }) } });
    // A hole in Upper floor and one in Attic, each floor with its creature.
    const s = withOpening(withOpening(placed), { id: "o3", pairId: "o4", upper: ATTIC, lower: UPPER, rect: { x: 2, y: 2, w: 1, h: 1 } });
    assert.deepEqual(spotsOf(tokenSpots(s, UPPER)), [{ x: 6, y: 2, w: 1, h: 1 }]);
    assert.deepEqual(spotsOf(tokenSpots(s, ATTIC)), [{ x: 1, y: 1, w: 1, h: 1 }]);
    assert.deepEqual(spotsOf(tokenSpots(s, "nowhere")), []);
    assert.deepEqual(spotsOf(tokenSpots(null, UPPER)), []);
  });

  test("a floor with no hole gives no tokens, so a move there walks none: its lower ends and its stairs keep their own edges (LP48FIXA-R1)", () => {
    const placed = tower({ tokens: { thorn: thornToken(), up: thornToken({ id: "up", sceneId: UPPER, x: 6, y: 2 }) } });
    assert.equal(tokenSpots(placed, GROUND), "", "no ends at all");
    assert.equal(tokenSpots(withStairs(placed), GROUND), "", "stairs up");
    assert.equal(tokenSpots(withStairs(placed), UPPER), "", "stairs down");
    assert.equal(tokenSpots(withOpening(placed), GROUND), "", "an opening's lower end");
    assert.equal(tokenSpots(withOpening(placed), UPPER), "6,2,1,1", "the hole's floor");
  });

  test("an end whose pills fit no corner keeps its own edge, and Top-down keeps each end's own edge where nothing is covered", () => {
    const ends = [hole("a", { x: 8, y: 4, w: 2, h: 2 }), hole("b", { x: 12, y: 8, w: 1, h: 1 })];
    const blocked = placeEnds(ends, [], SCALE, flat(0), () => false);
    for (const e of ends) assert.deepEqual(blocked.get(e.id), { pill: e.first, chip: e.dropPill });
    assert.deepEqual(placeEnds(ends, [], SCALE, null, () => true).get("b"), { pill: ends[1]!.first, chip: ends[1]!.dropPill });
  });
});
