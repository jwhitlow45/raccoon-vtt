import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "#shared/discoveryTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { hexCenter, hexKey, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { P1, room as baseRoom, scene, token } from "#shared/testutil.ts";
import { copyFor } from "../attach/testing.ts";
import { dragOf } from "../movement/dragTesting.ts";
import { measureWalk, type WalkMeasure } from "./walkRuler.ts";
import type { RulerStop } from "./ruler.ts";

/**
 * The walking ruler from a holder that drags a creature into a corridor
 * one wide (RULER-SINGLE-FILE, D-261107-174): a leg that ends squeezed
 * searches the holder alone, then takes that way where what it drags
 * follows in single file, as the drag does (routeDrag.ts inFile), so it
 * reads the way and cost the drag will take. Where one cannot follow so,
 * it finds no way, as the drag does. The holder-alone
 * search and a leg that ends squeezed each keep a cache entry of their
 * own (DR-A4).
 */

/** Rock from x 8 to 16 but for a corridor along row 10, a Large warhorse west of it dragging a goblin, on a scene the players have seen. */
function squares(second = false, gx = 3, gy = 8): RoomState {
  const s = baseRoom({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [
    ...[8, 16].flatMap((x): [[number, number], [number, number]][] => [[[x, 0], [x, 5]], [[x, 5], [x, 10]], [[x, 11], [x, 16]], [[x, 16], [x, 20]]]),
    [[8, 10], [16, 10]],
    [[8, 11], [16, 11]],
  ];
  runs.forEach(([a, b], i) => wall(s, `rulesa${String(i).padStart(6, "0")}`, a, b));
  s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.gob = token("gob", { x: 1, y: 10, name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
  if (second) s.tokens.grik = token("grik", { x: gx, y: gy, name: "Grik", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
  return s;
}

/** Rock but for a corridor one hex wide along `across` 6, from 6 to 12 along, the warhorse west of it dragging a goblin. */
function hexes(g: HexGrid): { s: RoomState; at: (along: number, across: number) => Hex; solid: (h: Hex) => boolean } {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 6 && along <= 12 && across !== 6;
  };
  const wide = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
  const s = hexWallRoom(shape, wide.w, wide.h, wallsRound(g, wide, solid));
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
  s.tokens.horse = onHex(g, "horse", "large", at(3, 6), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  // Beside the warhorse off the corridor's line, so by its place it would walk into the rock.
  const own = new Set(occupiedHexes(g, s.tokens.horse).map(hexKey));
  const beside = occupiedHexes(g, s.tokens.horse)
    .flatMap((h) => hexNeighbors(g, h))
    .filter((h) => !own.has(hexKey(h)) && (g.orient === "rows" ? h.row : h.col) !== 6)
    .sort((a, b) => (g.orient === "rows" ? b.row - a.row || a.col - b.col : b.col - a.col || a.row - b.row))[0]!;
  s.tokens.gob = onHex(g, "gob", "medium", beside, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
  return { s, at, solid };
}

function measured(s: RoomState, stops: readonly RulerStop[]): WalkMeasure {
  return measureWalk({ view: copyFor(s, P1), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
}

describe("the walking ruler into a corridor one wide with a creature in tow", () => {
  test("on squares it reads the drag's own way in, squeezed with the goblin behind, and what squeezing and dragging cost", () => {
    const s = squares();
    const stops: RulerStop[] = [{ x: 0, y: 0, tokenId: "horse" }, { x: 12.5, y: 10.5 }];
    const m = measured(s, stops);
    const leg = m.legs[0]!;
    assert.equal(leg.none, false, "a way through");
    const drag = dragOf(copyFor(s, P1), "player", "horse", { x: 11.5, y: 9.5 });
    const op = drag.op as { t: string; x: number; y: number; squeeze?: boolean } | null;
    assert.ok(op && op.squeeze === true, "the drag goes in squeezed");
    assert.deepEqual([leg.to.x, leg.to.y], [op.x, op.y], "where the drag lands");
    assert.ok(leg.to.y === 9.5 && leg.to.x > 8, `${leg.to.x}, ${leg.to.y}: in the corridor`);
    assert.match(m.extra ?? "", /squeezing and dragging/);
  });

  test("on squares, where the second creature in tow would end out of reach, it finds no way in, as the drag does", () => {
    const m = measured(squares(true), [{ x: 0, y: 0, tokenId: "horse" }, { x: 12.5, y: 10.5 }]);
    assert.equal(m.legs[0]!.none, true, "no way into the corridor");
  });

  // The places search finds a way to the corridor's mouth here, so only the named follower makes it none (RULES-OPUS-2).
  test("on squares, a follower that cannot follow in file gives no way even where a search by places finds one", () => {
    const m = measured(squares(true, 0, 0), [{ x: 0, y: 0, tokenId: "horse" }, { x: 8.5, y: 10.5 }]);
    assert.equal(m.legs[0]!.none, true, "no way into the corridor's mouth");
  });

  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`on ${name} it reads the drag's own way in, the warhorse squeezed on the corridor's hex, and the cost of squeezing and dragging`, () => {
      const { s, at, solid } = hexes(g);
      const m = measured(s, [{ x: 0, y: 0, tokenId: "horse" }, hexCenter(g, at(10, 6))]);
      const leg = m.legs[0]!;
      assert.equal(leg.none, false, "a way through");
      const end = occupiedHexes(g, { size: "large", ...leg.to, squeeze: true });
      assert.deepEqual(end.map(hexKey), [hexKey(at(10, 6))], "squeezed on the corridor's hex");
      for (const p of [leg.from, ...leg.corners]) assert.ok(!occupiedHexes(g, { size: "large", ...p }).some(solid) || occupiedHexes(g, { size: "large", ...p, squeeze: true }).every((h) => !solid(h)), "never in the rock");
      assert.match(m.extra ?? "", /squeezing and dragging/);
      const drag = dragOf(copyFor(s, P1), "player", "horse", { x: leg.to.x, y: leg.to.y });
      const op = drag.op as { x: number; y: number; squeeze?: boolean } | null;
      assert.ok(op && op.squeeze === true, "the drag goes in squeezed too");
      assert.deepEqual([leg.to.x, leg.to.y], [op.x, op.y], "where the drag lands");
    });
  }

  for (const [name, g] of [
    ["hex rows", ROWS],
    ["hex columns", COLUMNS],
  ] as const) {
    test(`on ${name}, a second creature in tow that cannot follow in file stops the warhorse at the corridor's mouth, the drag and the ruler alike (LP33-B-HEX-1)`, () => {
      const { s, at, solid } = hexes(g);
      // Below the warhorse's hex at its east, a second one that squares would also leave behind in file.
      s.tokens.hob = onHex(g, "hob", "medium", g.orient === "rows" ? { col: 4, row: 7 } : { col: 7, row: 4 }, { name: "Hobgoblin", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" } });
      const view = copyFor(s, P1);
      const aim = hexCenter(g, at(10, 6));
      const drag = dragOf(view, "player", "horse", { x: aim.x, y: aim.y });
      const op = drag.op as { t: string; x: number; y: number } | null;
      assert.ok(op && op.t === "token.move", "the warhorse moves");
      assert.notDeepEqual([op.x, op.y], [view.tokens.horse!.x, view.tokens.horse!.y], "off where it started");
      assert.ok(!occupiedHexes(g, { size: "large", x: op.x, y: op.y }).some(solid), "clear of the rock");
      const m = measured(s, [{ x: 0, y: 0, tokenId: "horse" }, aim]);
      assert.ok(m.legs[0]!.ft > 0, "the ruler reads a walk, not 0 ft");
      assert.deepEqual([m.legs[0]!.to.x, m.legs[0]!.to.y], [op.x, op.y], "the ruler ends where the drag lands");
    });
  }

  test("a leg into the corridor and one beside it, measured in either order, read as each does alone", () => {
    const fresh = (stops: readonly RulerStop[]) => measured(squares(), stops);
    const into: RulerStop[] = [{ x: 0, y: 0, tokenId: "horse" }, { x: 12.5, y: 10.5 }];
    const beside: RulerStop[] = [{ x: 0, y: 0, tokenId: "horse" }, { x: 6.5, y: 10.5 }];
    const alone = [fresh(into), fresh(beside)].map((m) => JSON.stringify(m.legs));
    // One view for all three, so the second and third read what the first kept.
    const view = copyFor(squares(), P1);
    const read = (stops: readonly RulerStop[]) => JSON.stringify(measureWalk({ view, sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!.legs);
    assert.deepEqual([read(beside), read(into), read(beside)], [alone[1], alone[0], alone[1]]);
  });
});
