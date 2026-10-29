import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, StairMark, Token, Trap } from "../model.ts";
import type { Op } from "../protocol.ts";
import type { BuildState } from "../ruleHooks.ts";
import { applyOp } from "../reducer.ts";
import { apply, DM, env, P1, token } from "../testutil.ts";
import { occupiedHexes, placedOnHex } from "./footprint.ts";
import { oppositeFacing } from "./heights.ts";
import { hexCenter, hexKey, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { findRouteOn } from "./hexWalk.ts";
import { hexFitWall, hexPairWall, hexStandHexes, hexStandPlace, hexWallsOf, legStop, ownWalk, storedBuild, type HexStand } from "./movement.ts";
import { COLUMNS, hexWallRoom, ROWS, sideWall, wallsRound } from "./hexWalls.testkit.ts";
import { planTrapMove } from "./traps.ts";

/**
 * A stair band on hexes (live play LP25-A-ROUTE-1, D-261029-58): two stairs
 * side by side, facing the same way up from a sunken floor, leave a raised
 * side between them that neither faces through, since the band's edge
 * zigzags between hexes. A Large creature, or a Huge one squeezed onto
 * three hexes, stands across the band only on stands holding that side, so
 * the side counted as a wall kept every such creature off a stair a Medium
 * one walks. It is no wall inside a stand, as a square creature stands
 * across a stair's edge. A raised side no flight of the band runs beside
 * stays one, and so does a wall. Ops stored before version 30 read every
 * raised side between two hexes of a stand as a wall, and replay so.
 */

const same = (a: Hex, b: Hex) => a.col === b.col && a.row === b.row;

/**
 * The band on grid `g`: stairs P and Q facing `up` toward the hall, Q a step
 * round from P (`turn` 2 or 4 sides on from `up`), the sunken floor past
 * them, and the hexes either side of the zigzag's two odd sides: the hall's
 * hex up from Q beside P (`shoulder`), and the floor's hex down from P
 * beside Q (`foot`).
 */
function bandOf(g: HexGrid, up: number, turn: 2 | 4) {
  const down = oppositeFacing(g, up);
  const P: Hex = { col: 10, row: 7 };
  const Q = hexNeighbors(g, P)[(up + turn) % 6]!;
  const line = (from: Hex, n: number, d: number): Hex[] => {
    const out: Hex[] = [];
    let at = from;
    for (let k = 0; k < n; k++) out.push((at = hexNeighbors(g, at)[d]!));
    return out;
  };
  const shoulder = hexNeighbors(g, Q)[up]!;
  const foot = hexNeighbors(g, P)[down]!;
  const corridor = [P, Q, ...line(P, 6, up), ...line(P, 6, down), ...line(Q, 6, up), ...line(Q, 6, down)];
  const keys = new Set(corridor.map(hexKey));
  // How far down the stair a hex lies, in hex steps.
  const c0 = hexCenter(g, P);
  const c1 = hexCenter(g, hexNeighbors(g, P)[down]!);
  const along = (h: Hex) => {
    const c = hexCenter(g, h);
    return ((c.x - c0.x) * (c1.x - c0.x) + (c.y - c0.y) * (c1.y - c0.y)) / ((c1.x - c0.x) ** 2 + (c1.y - c0.y) ** 2);
  };
  /**
   * A scene sunk `depth` ft down the band from P, the stairs on `stairs` at
   * their own heights, and, with `rock`, a corridor two hexes wide walled
   * round the band. `floor` sinks the floor past the band deeper again.
   */
  const band = (stairs: readonly (readonly [Hex, number, StairMark?])[], opts: { rock?: boolean; floor?: number; walls?: Parameters<typeof hexWallRoom>[3] } = {}): RoomState => {
    const walls = opts.rock ? wallsRound(g, { w: 30, h: 22 }, (h) => Math.abs(along(h)) < 5.5 && !keys.has(hexKey(h))) : [];
    let s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 30, 22, [...walls, ...(opts.walls ?? [])]);
    const floor = [...line(P, 6, down), ...line(Q, 6, down)];
    s = apply(s, { t: "build.height", sceneId: "s1", cells: [P, Q, ...floor].map(hexKey), height: -5 } as Op);
    if (opts.floor !== undefined) s = apply(s, { t: "build.height", sceneId: "s1", cells: floor.map(hexKey), height: opts.floor } as Op);
    for (const [h, height, mark] of stairs) {
      s = apply(s, { t: "build.height", sceneId: "s1", cells: [hexKey(h)], height } as Op);
      s = apply(s, { t: "build.stairs", sceneId: "s1", cells: [hexKey(h)], up: mark ?? (String(up) as StairMark) } as Op);
    }
    return s;
  };
  /** The Large-sized stand holding both hexes of a side. */
  const holding = (a: Hex, b: Hex, squeezed = false): HexStand => {
    for (const ref of [a, ...hexNeighbors(g, a), ...hexNeighbors(g, b)]) {
      const s: HexStand = { size: "large", ref, squeezed };
      const on = hexStandHexes(g, s);
      if (on.some((h) => same(h, a)) && on.some((h) => same(h, b))) return s;
    }
    throw new Error("no stand holds the side");
  };
  /** The wall or ledge between two neighbors inside a stand, read from either of them. */
  const pair = (s: RoomState, a: Hex, b: Hex): [number, number] => {
    const t = hexWallsOf(s, { sceneId: "s1", size: "large", x: 0, y: 0, elevation: 0 })!;
    return [hexPairWall(t, a, hexNeighbors(g, a).findIndex((h) => same(h, b))), hexPairWall(t, b, hexNeighbors(g, b).findIndex((h) => same(h, a)))];
  };
  return { P, Q, up, down, shoulder, foot, line, band, holding, pair };
}

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: the zigzag side of a stair band is no wall inside a stand (LP25-A-ROUTE-1)`, () => {
    for (const up of [3, 0]) {
      for (const turn of [2, 4] as const) {
        const b = bandOf(g, up, turn);
        const { P, Q, shoulder, foot } = b;
        const label = `facing ${up}, Q ${turn} round`;

        test(`${label}: the side between P and the hall's hex Q's flight leads to, read from either hex, and a Large stand holding it fits`, () => {
          assert.ok(hexNeighbors(g, P).some((h) => same(h, shoulder)), "P and the shoulder are neighbors");
          const s = b.band([[P, -5], [Q, -5]]);
          assert.deepEqual(b.pair(s, P, shoulder), [-1, -1]);
          const t = hexWallsOf(s, { sceneId: "s1", size: "large", x: 0, y: 0, elevation: 0 })!;
          assert.equal(hexFitWall(t, b.holding(P, shoulder)), -1, "Large");
          assert.equal(hexFitWall(hexWallsOf(s, { sceneId: "s1", size: "huge", x: 0, y: 0, elevation: 0 })!, b.holding(P, shoulder, true)), -1, "a Huge creature squeezed onto three hexes");
        });

        test(`${label}: halfway down a deeper floor, the side between Q and the floor's hex P's flight leads down to is no wall either`, () => {
          const s = b.band([[P, -5], [Q, -5]], { floor: -10 });
          assert.ok(hexNeighbors(g, Q).some((h) => same(h, foot)), "Q and the foot are neighbors");
          assert.deepEqual(b.pair(s, Q, foot), [-1, -1]);
        });

        test(`${label}: a raised side no flight of the band runs beside stays a wall: one stair alone, a neighbor stair turned another way or at another height, the band's flank, a wall along the side`, () => {
          assert.ok(b.pair(b.band([[P, -5]]), P, shoulder).every((k) => k >= 0), "one stair alone");
          assert.ok(b.pair(b.band([]), P, shoulder).every((k) => k >= 0), "no stair");
          assert.ok(b.pair(b.band([[P, -5], [Q, -5, String((up + 1) % 6) as StairMark]]), P, shoulder).every((k) => k >= 0), "Q turned");
          assert.ok(b.pair(b.band([[P, -5], [Q, -10]]), P, shoulder).every((k) => k >= 0), "Q deeper");
          const s = b.band([[P, -5], [Q, -5]]);
          for (const flank of hexNeighbors(g, P).filter((h) => !same(h, Q) && !same(h, shoulder) && !same(h, b.foot) && !same(h, hexNeighbors(g, P)[up]!))) {
            assert.ok(b.pair(s, P, flank).every((k) => k >= 0), `the flank ${hexKey(flank)}`);
          }
          const d = hexNeighbors(g, P).findIndex((h) => same(h, shoulder));
          assert.ok(b.pair(b.band([[P, -5], [Q, -5]], { walls: [sideWall(g, P, d)] }), P, shoulder).every((k) => k >= 0), "a wall on the side");
        });
      }
    }
  });

  describe(`${name}: walking a stair band two hexes wide`, () => {
    const b = bandOf(g, 3, 4);
    const { P, Q, up, down, line } = b;
    const at = (size: Token["size"], stand: HexStand, elevation = 0): Token => {
      const base = token("big", { sceneId: "s1", name: "Mammoth", size, x: 0, y: 0, elevation });
      return { ...base, ...hexStandPlace(g, base, stand), ...(stand.squeezed ? { squeeze: true as const } : {}) };
    };
    const walk = (s: RoomState, t: Token, to: { x: number; y: number }) => findRouteOn({ build: s, token: ownWalk(t), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, to);
    const wallsOf = (s: BuildState) => hexWallsOf(s, { sceneId: "s1", size: "large", x: 0, y: 0, elevation: 0 })!;

    test("a Large creature steps from the hall onto the band and walks down it full size to the sunken floor", () => {
      const s = b.band([[P, -5], [Q, -5]], { rock: true });
      const big = at("large", { size: "large", ref: line(P, 2, up).at(-1)!, squeezed: false });
      assert.equal(legStop(s, ownWalk(big), { ...hexStandPlace(g, big, b.holding(P, b.shoulder)), elevation: -5, squeeze: false }), null, "onto the band");
      const found = walk(s, big, hexStandPlace(g, big, { size: "large", ref: line(P, 3, down).at(-1)!, squeezed: false }));
      assert.ok(found && found !== "none", "a way down the stair");
      assert.ok(found.pieces.every(([, , extra]) => extra === 0), "full size all the way, no squeeze paid");
    });

    test("a Huge creature squeezed onto three hexes in the corridor walks down its stair band", () => {
      const s = b.band([[P, -5], [Q, -5]], { rock: true });
      const big = at("huge", { size: "large", ref: line(P, 3, up).at(-1)!, squeezed: true });
      assert.equal(legStop(s, ownWalk(big), { ...hexStandPlace(g, big, b.holding(P, b.shoulder, true)), elevation: -5, squeeze: true }), null, "onto the band");
      const found = walk(s, big, hexStandPlace(g, big, { size: "large", ref: line(P, 3, down).at(-1)!, squeezed: true }));
      assert.ok(found && found !== "none", "a way down the stair, squeezed");
    });

    test("with one stair alone a Large creature is still stopped at the ledge beside it", () => {
      const s = b.band([[P, -5]]);
      const big = at("large", { size: "large", ref: line(P, 2, up).at(-1)!, squeezed: false });
      assert.equal(legStop(s, ownWalk(big), { ...hexStandPlace(g, big, b.holding(P, b.shoulder)), elevation: -5, squeeze: false })?.blocker, "ledge");
    });

    test("ops stored before version 30 read the side as a wall, later and live ones do not (storedBuild)", () => {
      const s = b.band([[P, -5], [Q, -5]]);
      assert.ok(hexFitWall(wallsOf(storedBuild(s, 29)), b.holding(P, b.shoulder)) >= 0, "op 29");
      for (const v of [30, undefined]) assert.equal(hexFitWall(wallsOf(storedBuild(s, v)), b.holding(P, b.shoulder)), -1, `op ${v ?? "live"}`);
      assert.equal(storedBuild(s, 30), s, "today's build is the room itself");
    });
  });

  describe(`${name}: the reducer reads the band by the op's version`, () => {
    const b = bandOf(g, 3, 4);
    const { P, Q, up, down, line } = b;
    const s0 = b.band([[P, -5], [Q, -5]]);
    const onFloor = (h: Hex) => same(h, P) || same(h, Q) || [...line(P, 6, down), ...line(Q, 6, down)].some((l) => same(l, h));
    const at = (id: string, size: Token["size"], stand: HexStand, over: Partial<Token> = {}): Token => {
      const base = token(id, { sceneId: "s1", name: id, size, x: 0, y: 0, ...over });
      return { ...base, ...hexStandPlace(g, base, stand) };
    };

    test("a creature some player cannot see, dragged across the band beside Pat's walk, follows down it, but stops at it on an op stored at version 29", () => {
      // Thorn walks the hall's level beside the band, the hidden ogre dragged beside him across it.
      const ogreFrom: HexStand = { size: "large", ref: line(P, 1, up).at(-1)!, squeezed: false };
      const ogreTo: HexStand = { size: "large", ref: line(P, 1, down).at(-1)!, squeezed: false };
      const taken = new Set(hexStandHexes(g, ogreFrom).map(hexKey));
      const thornAt = hexStandHexes(g, ogreFrom)
        .flatMap((h) => hexNeighbors(g, h))
        .find((h) => !taken.has(hexKey(h)) && !onFloor(h) && line(h, 2, down).every((n) => !onFloor(n)))!;
      const base = token("thorn", { sceneId: "s1", kind: "pc", name: "Thorn", x: 0, y: 0, ownerIds: ["p1"] });
      const thorn = { ...base, ...placedOnHex(g, base, thornAt) };
      const ogre = at("ogre", "large", ogreFrom, { visibility: "dm", attached: { to: "thorn", kind: "drag" } });
      const s: RoomState = { ...s0, tokens: { ...s0.tokens, thorn, ogre } };
      const to = placedOnHex(g, thorn, line(thornAt, 2, down).at(-1)!);
      const op: Op = { t: "token.move", tokenId: "thorn", x: to.x, y: to.y };
      const after = (opVersion?: number) => {
        const r = applyOp(s, op, P1, opVersion === undefined ? env(2) : { ...env(2), opVersion });
        assert.ok(r.ok, r.ok ? "" : r.message);
        return r.state.tokens.ogre!;
      };
      const there = hexStandPlace(g, ogre, ogreTo);
      for (const v of [30, undefined]) {
        const o = after(v);
        assert.deepEqual([o.x, o.y, o.elevation], [there.x, there.y, -5], `op ${v ?? "live"}: down the band beside Thorn`);
      }
      const old = after(29);
      assert.notDeepEqual(occupiedHexes(g, old).map(hexKey).sort(), hexStandHexes(g, ogreTo).map(hexKey).sort(), "op 29: held at the band");
      assert.equal(old.elevation, 0);
    });

    test("a stopping plate on the band's stair stops a Large walker on the stand across the band, which an op stored at version 29 walked past", () => {
      const ogre = at("ogre", "large", { size: "large", ref: line(P, 2, up).at(-1)!, squeezed: false });
      const plate: Trap = { id: "plate", rev: 0, sceneId: "s1", name: "Plate", zone: { cells: [{ x: P.col, y: P.row, w: 1, h: 1 }] }, state: "armed", found: false, grid: g.orient === "rows" ? "hexRows" : "hexColumns", rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } };
      const state = { ...s0, tokens: { ...s0.tokens, ogre }, traps: { plate } };
      const to = hexStandPlace(g, ogre, { size: "large", ref: line(P, 3, down).at(-1)!, squeezed: false });
      const op: Op = { t: "token.move", tokenId: "ogre", x: to.x, y: to.y };
      const stopped = (opVersion?: number) => {
        const plan = planTrapMove(op, state, DM, opVersion === undefined ? {} : { opVersion });
        assert.equal(plan.springings.length, 1, "the plate goes off");
        const cut = plan.op as Extract<Op, { t: "token.move" }>;
        return { x: cut.x, y: cut.y };
      };
      const onBand = hexStandPlace(g, ogre, b.holding(P, b.shoulder));
      for (const v of [30, undefined]) assert.deepEqual(stopped(v), onBand, `op ${v ?? "live"}: on the stand across the band`);
      assert.notDeepEqual(stopped(29), onBand, "op 29: no stand there");
    });
  });
}
