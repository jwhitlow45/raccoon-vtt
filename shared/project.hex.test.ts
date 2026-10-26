import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState, Token, Viewer } from "./model.ts";
import { dependents, projectState, withheldWhereItStands } from "./project.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { footprintRect, footprintSubcells, occupiedRange, placedOnHex } from "./rules/footprint.ts";
import { gridOfShape, SQUARES } from "./rules/grid.ts";
import type { HexGrid } from "./rules/hex.ts";
import { clearVisionCache, sightRect } from "./rules/vision.ts";
import { actor, env, int, P1, reveal, rng, room, scene, token } from "./testutil.ts";

/**
 * What players get of a creature on a hex scene (docs/design-v1-hex-grids.md
 * HX-D10): it is read by the fog sub-cells inside its hexes, by its sight
 * there, and a sight or explored tile holding any of them reprojects it.
 */

const ROWS = gridOfShape("hexRows") as HexGrid;

let seq = 1;
function run(state: RoomState, op: Op, who: Viewer = { memberId: "dm1", role: "dm" }): { state: RoomState; inverse: RestoreEntry[] } {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });
const redo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "redo", deps: true });
const toShape = (shape: "hexRows" | "hexColumns" | "squares"): Op => ({ t: "scene.update", sceneId: "s1", patch: { gridShape: shape } });

function shown(state: RoomState, viewer: Viewer = P1): boolean {
  return projectState(state, viewer, { sceneId: "s1" }).tokens.gob !== undefined;
}

describe("a goblin under fog on hexes", () => {
  test("is withheld while every sub-cell of its hexes is fogged, and back when one of them is revealed, not when only its box is", () => {
    const r = rng(91);
    for (let i = 0; i < 200; i++) {
      const hex = { col: int(r, 2, 30), row: int(r, 2, 20) };
      const size = (["medium", "large", "huge", "gargantuan"] as const)[i % 4]!;
      const gob = token("gob", { size, ...placedOnHex(ROWS, { size, x: 0, y: 0 }, hex) });
      const base = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }) }, tokens: { gob } });
      assert.ok(!shown(base), "wholly under fog");
      const subs = footprintSubcells(ROWS, gob);
      const [sx, sy] = subs[int(r, 0, subs.length - 1)]!;
      const one = structuredClone(base);
      reveal(one, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
      assert.ok(shown(one), "one of its sub-cells revealed");
      // Its box revealed, all but the sub-cells of its hexes.
      const inside = new Set(subs.map(([x, y]) => `${x},${y}`));
      const box = footprintRect(ROWS, gob);
      const around = structuredClone(base);
      for (let y = Math.floor(box.y * 4); y < Math.ceil((box.y + box.h) * 4); y++) {
        for (let x = Math.floor(box.x * 4); x < Math.ceil((box.x + box.w) * 4); x++) if (!inside.has(`${x},${y}`)) reveal(around, "s1", { x: x / 4, y: y / 4, w: 0.25, h: 0.25 });
      }
      assert.ok(!shown(around), "its box revealed around its hexes");
    }
  });
});

describe("a switch under a token half in a revealed corner follows its hexes without a move (section 9)", () => {
  /** The switch, its undo and its redo, with what P1 sees after each. */
  function through(state: RoomState, viewer: Viewer = P1): boolean[] {
    const out = [shown(state, viewer)];
    const switched = run(state, toShape("hexRows"));
    out.push(shown(switched.state, viewer));
    const undone = run(switched.state, undo(switched.inverse));
    out.push(shown(undone.state, viewer));
    out.push(shown(run(undone.state, redo(undone.inverse)).state, viewer));
    return out;
  }

  test("with fog: the cell it stands in is revealed above its hex", () => {
    // A Medium at 5,5 stands in cell 5,5 on squares and in hex 5,6 on hex rows, whose top point is at y 5.196.
    const s = room({ scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2") }, tokens: { gob: token("gob", { x: 5, y: 5 }) } });
    reveal(s, "s1", { x: 5, y: 5, w: 1, h: 0.25 });
    assert.deepEqual(through(s), [true, false, true, false]);
  });

  /** A dark scene where Thorn, P1's, sees by darkvision, and a goblin at a spot its box and its hexes read differently. */
  function sightRoom(perPlayer: boolean): RoomState {
    clearVisionCache();
    const s = room({
      scenes: { s1: scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", ...(perPlayer ? { perPlayer: true } : {}) } }), s2: scene("s2") },
      tokens: { thorn: token("thorn", { kind: "pc", ownerIds: ["p1"], x: 10.4, y: 10.2, actor: { inline: actor({ senses: "darkvision 30 ft" }) } }) },
      holders: perPlayer ? { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } } : {},
    });
    const sight = perPlayer ? visionRules.holderSight(s, "s1", "p1") : visionRules.partySight(s, "s1");
    for (let y = 2; y < 20; y += 0.125) {
      for (let x = 2; x < 20; x += 0.125) {
        const probe = { size: "medium" as const, x, y };
        if (sight.seesToken(probe, SQUARES) && !sight.seesToken(probe, ROWS)) {
          s.tokens.gob = token("gob", probe);
          return s;
        }
      }
    }
    throw new Error("no such spot");
  }

  test("with party vision", () => {
    assert.deepEqual(through(sightRoom(false)), [true, false, true, false]);
  });

  test("with per-player vision, for the holder and for a player who reads the shared sight", () => {
    const s = sightRoom(true);
    assert.deepEqual(through(s, P1), [true, false, true, false]);
    assert.deepEqual(through(s, { memberId: "p2", role: "player" }), [false, false, false, false], "the shared sight lends Thorn's to nobody");
  });
});

describe("a sight tile holding only an edge hex of a Large footprint reprojects it (section 9)", () => {
  test("for a Large stored off its anchor, and the square range would miss the tile", () => {
    const r = rng(92);
    let checked = 0;
    for (let i = 0; i < 5000 && checked < 20; i++) {
      // Near a tile's west or north border, off its anchor.
      const x = 14 + r() * 3;
      const y = 14 + r() * 3;
      const gob: Token = token("gob", { size: "large", x, y });
      const s = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", vision: { on: true, light: "bright" } }), s2: scene("s2") }, tokens: { gob } });
      const hexRange = occupiedRange(ROWS, gob);
      const cells = occupiedRange(SQUARES, gob);
      const seen = sightRect(gob);
      const square = { x0: Math.min(cells.x0, Math.floor(seen.x0)), y0: Math.min(cells.y0, Math.floor(seen.y0)) };
      // A tile only the hexes reach: the one west of x = 16 or north of y = 16.
      const tile = hexRange.x0 < 16 && square.x0 >= 16 ? [0, 1] : hexRange.y0 < 16 && square.y0 >= 16 ? [1, 0] : null;
      if (!tile) continue;
      const [tx, ty] = tile as [number, number];
      const touched = dependents(s, [keys.sight("s1", tx, ty)]);
      assert.ok(touched.includes(keys.token("gob")), `${x}, ${y}: the tile ${tx},${ty} holds one of its hexes`);
      checked++;
    }
    assert.ok(checked > 0, "some spot puts an edge hex past the square range");
  });

  test("withheldWhereItStands reads the hexes too", () => {
    const gob = token("gob", { size: "large", ...placedOnHex(ROWS, { size: "large", x: 0, y: 0 }, { col: 6, row: 6 }) });
    const s = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }), s2: scene("s2") }, tokens: { gob } });
    assert.equal(withheldWhereItStands(s, gob), true);
    const [sx, sy] = footprintSubcells(ROWS, gob).at(-1)!;
    reveal(s, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
    assert.equal(withheldWhereItStands(s, gob), false);
  });
});
