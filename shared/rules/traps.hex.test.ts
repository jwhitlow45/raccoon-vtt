import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, keys } from "../keys.ts";
import type { RoomState, Token, Trap, TrapRig } from "../model.ts";
import type { Op } from "../protocol.ts";
import { dependents, projectState } from "../project.ts";
import { DM, int, reveal, rng, room, scene, token } from "../testutil.ts";
import { occupiedHexes, placedOnHex } from "./footprint.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexKey, hexLine, hexNeighbors, hexSubcells, sceneHexes, type Hex, type HexGrid } from "./hex.ts";
import { planTrapMove, planTurn, rectHexes, trapHits, wireHexes, zoneHexes, zoneRanges, type Springing, type TrapRoom } from "./traps.ts";

/**
 * Traps on hexes (docs/design-v1-hex-grids.md phase H2): zones are
 * rectangles of hex keys, read for fog and reprojection by the sub-cells
 * inside their hexes, wires end on the 1/64 lattice and meet the hexes they
 * touch, and a walk sets a trap off by the hexes its footprint stands on.
 */
const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS = [ROWS, COLUMNS];
const shapeOf = (g: HexGrid) => (g.orient === "rows" ? "hexRows" : "hexColumns");

function rig(overrides: Partial<TrapRig> = {}): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...overrides };
}

function hexTrap(g: HexGrid, id: string, zone: Trap["zone"], overrides: Partial<TrapRig> = {}, extra: Partial<Trap> = {}): Trap {
  return { id, rev: 0, sceneId: "s1", name: id, zone, state: "armed", found: false, rig: rig(overrides), grid: shapeOf(g), ...extra };
}

function on(g: HexGrid, id: string, size: Token["size"], ref: Hex, over: Partial<Token> = {}): Token {
  const base = token(id, { name: id, size, x: 0, y: 0, ...over });
  return { ...base, ...placedOnHex(g, base, ref) };
}

function world(g: HexGrid, tokens: Token[], traps: Trap[], tweak: (s: RoomState) => void = () => {}): TrapRoom {
  const state = room({ scenes: { s1: scene("s1", { gridShape: shapeOf(g) }) } });
  for (const t of tokens) state.tokens[t.id] = t;
  tweak(state);
  return { ...state, traps: Object.fromEntries(traps.map((t) => [t.id, t])) };
}

function summary(springings: readonly Springing[]): string[] {
  return springings.map((s) => `${s.trap.id}:${s.how}:${s.by.join("+")}`);
}

const move = (t: Token, g: HexGrid, to: Hex): Op => ({ t: "token.move", tokenId: t.id, ...placedOnHex(g, t, to) });

describe("a zone's hexes", () => {
  test("a rectangle names hexes by key, a hex two share once", () => {
    assert.deepEqual(rectHexes([{ x: 2, y: 3, w: 2, h: 2 }, { x: 3, y: 4, w: 1, h: 1 }]).map(hexKey), ["2,3", "3,3", "2,4", "3,4"]);
  });

  test("a wire meets every hex a dense sample of it lies in, and only hexes it touches, on random 1/64 ends", () => {
    const r = rng(23);
    for (let i = 0; i < 400; i++) {
      const g = GRIDS[i % 2]!;
      const a: [number, number] = [int(r, 64, 1200) / 64, int(r, 64, 1200) / 64];
      const b: [number, number] = [Math.min(19, Math.max(0, a[0] + int(r, -500, 500) / 64)), Math.min(19, Math.max(0, a[1] + int(r, -500, 500) / 64))];
      const met = new Set(wireHexes(g, { a, b }).map(hexKey));
      for (let k = 0; k <= 400; k++) {
        const t = k / 400;
        const p = { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
        // The outlines' corners are rounded onto the 1/64 lattice, so a point within that of a side may lie in the hex across it.
        const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => hexKey(hexAt(g, { x: p.x + dx! / 64, y: p.y + dy! / 64 })));
        assert.ok(near.some((k) => met.has(k)), `${g.orient} ${a} ${b}: ${near[0]} at ${t}`);
      }
      // Each hex met has a corner within a hex's width of the wire's box.
      for (const key of met) {
        const [col, row] = key.split(",").map(Number) as [number, number];
        const corners = hexCorners(g, { col, row }).map((c) => cornerAt(g, c));
        assert.ok(corners.some((p) => p.x >= Math.min(a[0], b[0]) - 1 && p.x <= Math.max(a[0], b[0]) + 1 && p.y >= Math.min(a[1], b[1]) - 1 && p.y <= Math.max(a[1], b[1]) + 1), key);
      }
    }
  });

  test("a wire along a hex's side meets the hexes on both sides, and one wholly inside a hex meets that hex alone", () => {
    for (const g of GRIDS) {
      const h = { col: 5, row: 5 };
      const [c0, c1] = hexCorners(g, h).map((c) => cornerAt(g, c));
      const side = new Set(wireHexes(g, { a: [c0!.x, c0!.y], b: [c1!.x, c1!.y] }).map(hexKey));
      assert.ok(side.has("5,5") && side.size >= 2, `${g.orient}: ${[...side]}`);
      const lattice = (v: number) => Math.round(v * 64) / 64;
      const c = hexCenter(g, h);
      const p: [number, number] = [lattice(c.x - 0.25), lattice(c.y)];
      const q: [number, number] = [lattice(c.x + 0.25), lattice(c.y)];
      assert.deepEqual(wireHexes(g, { a: p, b: q }).map(hexKey), ["5,5"], g.orient);
    }
  });

  test("zoneRanges on hexes gives the cells each hex's sub-cells lie in, never the key read as a cell", () => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows" }) } });
    // Row 18's hexes stand around y 16.2: their sub-cells lie in cells 15 and 16, never in cell 18.
    const ranges = zoneRanges(state, "s1", { cells: [{ x: 3, y: 18, w: 1, h: 1 }] });
    assert.deepEqual(ranges, [{ x0: 3, y0: 15, x1: 4, y1: 17 }]);
  });
});

describe("found traps of hexes under the fog (section 9)", () => {
  function fogged(g: HexGrid, zone: Trap["zone"]): RoomState {
    const state = room({ scenes: { s1: scene("s1", { gridShape: shapeOf(g), fogEnabled: true }) } });
    state.traps.t1 = hexTrap(g, "t1", zone, {}, { found: true });
    return state;
  }
  const shown = (s: RoomState) => projectState(s, { memberId: "p1", role: "player" }, { sceneId: "s1" }).traps?.t1 !== undefined;

  test("revealing ground beside a fogged trap of hexes, in the very cells its hexes share, keeps it withheld", () => {
    const r = rng(7);
    for (let i = 0; i < 120; i++) {
      const g = GRIDS[i % 2]!;
      const zone = { cells: [{ x: int(r, 1, 12), y: int(r, 1, 12), w: int(r, 1, 3), h: int(r, 1, 3) }] };
      const base = fogged(g, zone);
      assert.equal(shown(base), false, "wholly under fog");
      const inside = new Set(zoneHexes(g, base, "s1", zone).flatMap((h) => hexSubcells(g, h)).map(([x, y]) => `${x},${y}`));
      // Every sub-cell of the cells its hexes touch but its own revealed.
      const around = structuredClone(base);
      for (const range of zoneRanges(base, "s1", zone)) {
        for (let sy = range.y0 * 4; sy < range.y1 * 4; sy++) for (let sx = range.x0 * 4; sx < range.x1 * 4; sx++) if (!inside.has(`${sx},${sy}`)) reveal(around, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
      }
      assert.equal(shown(around), false, `${g.orient}: ground beside it revealed`);
      // One sub-cell of one of its hexes revealed shows it.
      const subs = [...inside];
      const [sx, sy] = subs[int(r, 0, subs.length - 1)]!.split(",").map(Number) as [number, number];
      reveal(around, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
      assert.equal(shown(around), true, `${g.orient}: one of its hexes revealed`);
    }
  });

  test("an explored tile holding only a hex's sub-cells reprojects the trap, which its key read as a cell would miss", () => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }) } });
    state.traps.t1 = hexTrap(ROWS, "t1", { cells: [{ x: 3, y: 18, w: 1, h: 1 }] }, {}, { found: true });
    // Row 18 lies in cells 15 and 16, so in tiles 0,0 and 0,1, where cell 18 is in tile 0,1 alone.
    assert.ok(dependents(state, [keys.explored("s1", 0, 0)]).includes(keys.trap("t1")));
    assert.ok(dependents(state, [keys.explored("s1", 0, 1)]).includes(keys.trap("t1")));
    assert.ok(!dependents(state, [keys.explored("s1", 1, 0)]).includes(keys.trap("t1")));
  });
});

describe("walking onto a trap of hexes", () => {
  test("a walk sets off a trap by the hexes its footprint steps on, never by the key read as a cell", () => {
    for (const g of GRIDS) {
      const plate = hexTrap(g, "plate", { cells: [{ x: 6, y: 5, w: 1, h: 1 }] });
      const thorn = on(g, "thorn", "medium", { col: 2, row: 5 });
      const state = world(g, [thorn], [plate]);
      // A walk along the hexes' own line through 6,5.
      assert.deepEqual(summary(planTrapMove(move(thorn, g, { col: 9, row: 5 }), state, DM, {}).springings), ["plate:enter:thorn"], g.orient);
    }
  });

  test("a walk whose hexes pass beside a trap's hex sets nothing off, though the square under the key lies on its way", () => {
    // On hex rows the cell 6,5 holds parts of the hexes of row 5 and row 6, so a walk along row 6 passes over that cell's ground.
    const plate = hexTrap(ROWS, "plate", { cells: [{ x: 6, y: 5, w: 1, h: 1 }] });
    const thorn = on(ROWS, "thorn", "medium", { col: 2, row: 6 });
    const state = world(ROWS, [thorn], [plate]);
    assert.deepEqual(planTrapMove(move(thorn, ROWS, { col: 10, row: 6 }), state, DM, {}).springings, []);
  });

  test("a Large creature sets a trap off with any of its three hexes, and hits everyone on the zone's hexes", () => {
    for (const g of GRIDS) {
      const zone = { cells: [{ x: 8, y: 8, w: 2, h: 1 }] };
      const ogre = on(g, "ogre", "large", { col: 4, row: 7 });
      const imp = on(g, "imp", "tiny", { col: 9, row: 8 });
      const plate = hexTrap(g, "plate", zone, { hits: "zone" });
      const state = world(g, [ogre, imp], [plate]);
      const p = planTrapMove(move(ogre, g, { col: 9, row: 7 }), state, DM, {});
      assert.deepEqual(summary(p.springings), ["plate:enter:ogre"], g.orient);
      const landed = { ...state, tokens: { ...state.tokens, ogre: { ...ogre, ...placedOnHex(g, ogre, { col: 9, row: 7 }) } } };
      const onZone = occupiedHexes(g, landed.tokens.ogre!).some((h) => (h.row === 8 && (h.col === 8 || h.col === 9)));
      assert.deepEqual(trapHits(plate, landed, ["ogre"]).sort(), onZone ? ["imp", "ogre"] : ["imp"], g.orient);
    }
  });

  test("a wire ending on hex corners is crossed where the line between two anchors meets it", () => {
    for (const g of GRIDS) {
      // A wire across the walk, from a corner above the line to one below it.
      const top = cornerAt(g, hexCorners(g, { col: 6, row: 3 })[0]!);
      const bottom = cornerAt(g, hexCorners(g, { col: 6, row: 7 })[3]!);
      const wire = hexTrap(g, "wire", { wire: { a: [top.x, top.y], b: [bottom.x, bottom.y] } }, { on: [] });
      const thorn = on(g, "thorn", "medium", { col: 2, row: 5 });
      const state = world(g, [thorn], [wire]);
      assert.deepEqual(summary(planTrapMove(move(thorn, g, { col: 10, row: 5 }), state, DM, {}).springings), ["wire:cross:thorn"], g.orient);
      assert.deepEqual(planTrapMove(move(thorn, g, { col: 4, row: 5 }), state, DM, {}).springings, [], `${g.orient}: stops short`);
    }
  });

  test("a slanted walk sets off a trap on its hex line and none beside the line, on random walks", () => {
    const r = rng(41);
    let beside = 0;
    for (let i = 0; i < 150; i++) {
      const g = GRIDS[i % 2]!;
      const from = { col: int(r, 2, 8), row: int(r, 2, 8) };
      const to = { col: int(r, 10, 20), row: int(r, 10, 20) };
      const thorn = on(g, "thorn", "medium", from);
      const line = hexLine(g, from, to);
      const onLine = line[int(r, 1, line.length - 1)]!;
      const hit = world(g, [thorn], [hexTrap(g, "plate", { cells: [{ x: onLine.col, y: onLine.row, w: 1, h: 1 }] })]);
      assert.deepEqual(summary(planTrapMove(move(thorn, g, to), hit, DM, {}).springings), ["plate:enter:thorn"], `${g.orient} ${hexKey(from)} to ${hexKey(to)} over ${hexKey(onLine)}`);
      const keysOn = new Set(line.map(hexKey));
      const off = line.flatMap((h) => hexNeighbors(g, h)).find((h) => !keysOn.has(hexKey(h)))!;
      const miss = world(g, [thorn], [hexTrap(g, "plate", { cells: [{ x: off.col, y: off.row, w: 1, h: 1 }] })]);
      assert.deepEqual(planTrapMove(move(thorn, g, to), miss, DM, {}).springings, [], `${g.orient} ${hexKey(from)} to ${hexKey(to)} beside at ${hexKey(off)}`);
      beside++;
    }
    assert.ok(beside > 0);
  });

  test("a short wire across a row is crossed by the line between the hexes' centers", () => {
    // Row 5 on hex rows runs at y 4.907: a wire from 4.75 to 5.25 between two centers lies across it.
    const wire = hexTrap(ROWS, "wire", { wire: { a: [6.5, 4.75], b: [6.5, 5.25] } }, { on: [] });
    const thorn = on(ROWS, "thorn", "medium", { col: 2, row: 5 });
    const state = world(ROWS, [thorn], [wire]);
    assert.deepEqual(summary(planTrapMove(move(thorn, ROWS, { col: 10, row: 5 }), state, DM, {}).springings), ["wire:cross:thorn"]);
  });

  test("a stopping trap stops its walker on the trap's hex, which it may stand on, on both lattices", () => {
    for (const g of GRIDS) {
      const plate = hexTrap(g, "plate", { cells: [{ x: 6, y: 5, w: 1, h: 1 }] }, { stops: true });
      const thorn = on(g, "thorn", "medium", { col: 2, row: 5 });
      const plan = planTrapMove(move(thorn, g, { col: 10, row: 5 }), world(g, [thorn], [plate]), DM, {});
      assert.deepEqual(summary(plan.springings), ["plate:enter:thorn"], g.orient);
      const stop = plan.op as Extract<Op, { t: "token.move" }>;
      assert.deepEqual({ x: stop.x, y: stop.y }, placedOnHex(g, thorn, { col: 6, row: 5 }), `${g.orient}: stopped on the plate`);
    }
  });

  test("a turn starting on a trap's hex sets it off, one beside it does not", () => {
    for (const g of GRIDS) {
      const plate = hexTrap(g, "plate", { cells: [{ x: 5, y: 5, w: 1, h: 1 }] }, { on: ["turnStart"] });
      const onIt = world(g, [on(g, "thorn", "medium", { col: 5, row: 5 })], [plate]);
      assert.equal(planTurn(onIt, "thorn", "turnStart", {}).length, 1, g.orient);
      const beside = world(g, [on(g, "thorn", "medium", { col: 6, row: 5 })], [plate]);
      assert.equal(planTurn(beside, "thorn", "turnStart", {}).length, 0, g.orient);
    }
  });

  test("the index reads the last row of a 200 by 200 hex rows scene", () => {
    const g = ROWS;
    const last = sceneHexes(g, { w: 200, h: 200 }).at(-1)!;
    assert.equal(last.row, 229);
    const plate = hexTrap(g, "plate", { cells: [{ x: last.col - 1, y: last.row, w: 1, h: 1 }] });
    const thorn = on(g, "thorn", "medium", { col: last.col - 4, row: last.row });
    const state = world(g, [thorn], [plate], (s) => {
      s.scenes.s1!.bounds = { w: 200, h: 200 };
    });
    assert.deepEqual(summary(planTrapMove(move(thorn, g, { col: last.col, row: last.row }), state, DM, {}).springings), ["plate:enter:thorn"]);
  });
});

describe("a free door's trap on hexes", () => {
  test("its zone is the two hexes beside the door's middle", () => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows" }) } });
    const wall = { id: "d00000000001", a: [5.5, 4] as [number, number], b: [5.5, 6] as [number, number], f: { kind: "door" as const, state: "closed" as const, secret: false, discovered: false } };
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls: [wall] };
    const hexes = zoneHexes(ROWS, state, "s1", { door: { cx: 0, cy: 0, id: wall.id } }).map(hexKey);
    assert.equal(hexes.length, 2);
    assert.deepEqual(new Set(hexes), new Set([hexKey(hexAt(ROWS, { x: 5.5 + 1 / 256, y: 5 })), hexKey(hexAt(ROWS, { x: 5.5 - 1 / 256, y: 5 }))]));
  });
});
