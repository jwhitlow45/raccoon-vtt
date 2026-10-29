import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "../protocol.ts";
import type { LogEntry, PathStop, RoomState, Viewer } from "../model.ts";
import { applyOp } from "../reducer.ts";
import { placedOnHex } from "../rules/footprint.ts";
import { hexCenter, hexNeighbors, type Hex } from "../rules/hex.ts";
import { findRouteOn } from "../rules/hexWalk.ts";
import { hexStandAt, hexStandPlace, onSqueezedLattice, ownWalk } from "../rules/movement.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "../rules/hexWalls.testkit.ts";
import { legGeometry } from "../rules/path.ts";
import { DM, env, template } from "../testutil.ts";

/**
 * A walk on hexes as the reducer records it (docs/design-v1-hex-grids.md
 * phase H2): a route's feet are its hex steps, each squeezed step paying
 * its extra foot, and an area along a route's pieces is met on their hex
 * lines.
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const W = 22;
  const H = 16;
  const bounds = g.orient === "rows" ? { w: W, h: H } : { w: H, h: W };

  /** A one-row corridor through rock, and an ogre's turn west of it. */
  function fight(): RoomState {
    const solid = (h: Hex) => {
      const along = g.orient === "rows" ? h.col : h.row;
      const across = g.orient === "rows" ? h.row : h.col;
      return along >= 6 && along <= 12 && across !== 6;
    };
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
    s.tokens.ogre = onHex(g, "ogre", "large", at(2, 5), { name: "Ogre" });
    s.tokens.gob = onHex(g, "gob", "medium", at(18, 2), { name: "Goblin" });
    let state = s;
    for (const op of [{ t: "encounter.start", entries: [{ id: "n1", tokenId: "ogre", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] }, { t: "encounter.next" }] as Op[]) state = run(state, op).state;
    return state;
  }

  let seq = 0;
  function run(s: RoomState, op: Op, who: Viewer = DM): { state: RoomState; log: LogEntry[] } {
    const r = applyOp(s, op, who, env(++seq));
    assert.ok(r.ok, r.ok ? "" : r.message);
    return { state: r.state, log: r.log };
  }

  function routeTo(s: RoomState, to: { x: number; y: number }): [number, number, number, 0 | 1][] {
    const found = findRouteOn({ build: s, token: ownWalk(s.tokens.ogre!), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, to);
    assert.ok(found && found !== "none");
    return found.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim]);
  }

  describe(`${name}: a walk through a corridor on the turn's path`, () => {
    test("moves its hex steps and costs one more foot a foot for each squeezed step", () => {
      const s = fight();
      const out = placedOnHex(g, s.tokens.ogre!, at(16, 6));
      const route = routeTo(s, out);
      const { state } = run(s, { t: "token.move", tokenId: "ogre", ...out, route });
      const stop = state.tokens.ogre!.path!.stops.at(-1) as PathStop;
      const squeezedSteps = route.filter(([, , extra]) => extra === 1).length;
      assert.ok(squeezedSteps > 0, "the corridor is walked squeezed");
      assert.equal(stop.moved, 70, "fourteen hexes from the start's reference hex to the end's");
      assert.ok(stop.cost! > stop.moved, "the squeeze costs extra");
      assert.equal(stop.cost! % 5, 0);
      assert.equal(state.tokens.ogre!.squeeze, undefined, "the walk stands up where it ends");
    });

    test("one that ends inside squeezes there, its last step's extra paid", () => {
      const s = fight();
      const inside = hexStandPlace(g, s.tokens.ogre!, { size: "medium", ref: at(9, 6), squeezed: true });
      const route = routeTo(s, inside);
      const { state } = run(s, { t: "token.move", tokenId: "ogre", ...inside, squeeze: true, route });
      assert.equal(state.tokens.ogre!.squeeze, true);
      const stop = state.tokens.ogre!.path!.stops.at(-1) as PathStop;
      assert.ok(stop.cost! > stop.moved!);
      const moved = state.tokens.ogre!;
      const start = moved.path!.stops[0]!;
      assert.equal(legGeometry(g, moved, start, stop, state.meta.settings, { h: 0, v: 0 }).moved, stop.moved, "a non-owner reads the same moved feet from the stored route");
    });

    test("an area in the corridor is met along the route's hex lines", () => {
      const s = fight();
      const mid = placedOnHex(g, { size: "medium", x: 0, y: 0 }, at(9, 6));
      s.templates.grease = template("grease", { shape: "sphere", size: 1, origin: { x: mid.x + 0.5, y: mid.y + 0.5, z: 0 }, spell: "Grease", triggers: ["enter"] });
      const out = placedOnHex(g, s.tokens.ogre!, at(16, 6));
      const { log } = run(s, { t: "token.move", tokenId: "ogre", ...out, route: routeTo(s, out) });
      assert.ok(log.some((e) => e.data?.type === "area"), "the walk entered the grease on its way");
    });

    test("an area beside a squeezed stop of the route, across the corridor's wall, never meets it there (review H2-ASTRA-03)", () => {
      const s = fight();
      const out = placedOnHex(g, s.tokens.ogre!, at(16, 6));
      const route = routeTo(s, out);
      const squeezedStops = route.slice(0, -1).filter(([x, y]) => onSqueezedLattice(g, s.tokens.ogre!, { x, y }));
      assert.ok(squeezedStops.length > 0, "the route stops inside the corridor");
      for (const [x, y] of squeezedStops) {
        const ref = hexStandAt(g, s.tokens.ogre!, { x, y }, true).ref;
        for (const d of [1, 2, 4, 5]) {
          const beside = hexNeighbors(g, ref)[d]!;
          const c = hexCenter(g, beside);
          s.templates[`b${beside.col}-${beside.row}`] = template(`b${beside.col}-${beside.row}`, { shape: "sphere", size: 1, origin: { x: c.x, y: c.y, z: 0 }, spell: "Grease", triggers: ["enter"] });
        }
      }
      const { log } = run(s, { t: "token.move", tokenId: "ogre", ...out, route });
      assert.equal(log.filter((e) => e.data?.type === "area").length, 0, "squeezed onto one hex at each of its stops");
    });

    test("a straight walk into the corridor squeezes along its hex line, beside an area it never meets", () => {
      const s = fight();
      s.tokens.ogre = onHex(g, "ogre", "large", at(5, 6), { name: "Ogre" });
      const c = hexCenter(g, at(8, 7));
      s.templates.grease = template("grease", { shape: "sphere", size: 1, origin: { x: c.x, y: c.y, z: 0 }, spell: "Grease", triggers: ["enter"] });
      const inside = hexStandPlace(g, s.tokens.ogre, { size: "medium", ref: at(10, 6), squeezed: true });
      const { log } = run(s, { t: "token.move", tokenId: "ogre", ...inside, squeeze: true });
      assert.equal(log.filter((e) => e.data?.type === "area").length, 0);
    });

    test("an area in the rock beside the corridor never meets the creature squeezed along it", () => {
      const s = fight();
      for (const across of [5, 7]) {
        const mid = placedOnHex(g, { size: "medium", x: 0, y: 0 }, at(9, across));
        s.templates[`g${across}`] = template(`g${across}`, { shape: "sphere", size: 1, origin: { x: mid.x + 0.5, y: mid.y + 0.5, z: 0 }, spell: "Grease", triggers: ["enter"] });
      }
      const out = placedOnHex(g, s.tokens.ogre!, at(16, 6));
      const { log } = run(s, { t: "token.move", tokenId: "ogre", ...out, route: routeTo(s, out) });
      assert.equal(log.filter((e) => e.data?.type === "area").length, 0, "squeezed onto one hex, it passes beside them");
    });
  });
}
