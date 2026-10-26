import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AreaTemplate, LogEvent, RoomState } from "../model.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { computeCoverage, emanationFootprint } from "../rules/aoe.ts";
import { hexAnchor, placedOnHex, type SizeCategory } from "../rules/footprint.ts";
import { gridOfShape } from "../rules/grid.ts";
import { hexCenter, hexNeighbors, type Hex, type HexGrid } from "../rules/hex.ts";
import { DM, entry, env, room, scene, template, token } from "../testutil.ts";

/**
 * Area reminders on a hex scene (docs/design-v1-hex-grids.md 4.4 and
 * HX-D11): a leg is swept on its hex line with its height, and a stationary
 * emanation's hexes move with its origin.
 */

const ROWS = gridOfShape("hexRows") as HexGrid;

function at(size: SizeCategory, hex: Hex): { x: number; y: number } {
  return placedOnHex(ROWS, { size, x: 0, y: 0 }, hex);
}

/** A goblin's turn on a hex rows scene, with the given areas. */
function fight(areas: AreaTemplate[]): RoomState {
  const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows" }), s2: scene("s2") } });
  state.tokens.g1 = token("g1", { name: "Goblin", number: 1, ...at("medium", { col: 10, row: 10 }) });
  state.tokens.cleric = token("cleric", { kind: "pc", name: "Ayla", ownerIds: ["p1"], ...at("medium", { col: 4, row: 4 }) });
  for (const a of areas) state.templates[a.id] = a;
  state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-c", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
  return state;
}

let seq = 1;
function play(state: RoomState, op: Op): { state: RoomState; reminders: LogEvent[]; inverse: RestoreEntry[] } {
  const r = applyOp(state, opSchema.parse(op), DM, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, reminders: r.log.flatMap((e) => (e.data?.type === "area" ? [e.data] : [])), inverse: r.inverse ?? [] };
}

describe("a sweep on hexes keeps height (4.4)", () => {
  // A 5 ft sphere 40 ft up over the hex next to the goblin's: nowhere along the floor, only partway up.
  const sphere = template("s", { shape: "sphere", size: 5, origin: { ...hexCenter(ROWS, { col: 11, row: 10 }), z: 40 }, triggers: ["enter"], spell: "Orb" });

  test("a creature rising from 0 to 50 ft into the next hex enters the sphere on the way", () => {
    const { reminders } = play(fight([sphere]), { t: "token.move", tokenId: "g1", ...at("medium", { col: 11, row: 10 }), elevation: 50 });
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]),
      [["g1", "enter"]],
    );
  });

  test("and on a steep diagonal, two hexes across while it rises", () => {
    const high = { ...sphere, origin: { ...hexCenter(ROWS, { col: 12, row: 10 }), z: 40 } };
    const { reminders } = play(fight([high]), { t: "token.move", tokenId: "g1", ...at("medium", { col: 12, row: 10 }), elevation: 50 });
    assert.equal(reminders.length, 1);
  });

  test("a creature walking the floor under it does not", () => {
    const { reminders } = play(fight([sphere]), { t: "token.move", tokenId: "g1", ...at("medium", { col: 13, row: 10 }) });
    assert.deepEqual(reminders, []);
  });
});

describe("a stationary emanation moved one step across an odd row (section 9)", () => {
  test("takes its hexes with it, reminds a goblin it moved onto, and its undo puts them back", () => {
    // A 5 ft emanation left behind on hex 10,8, two steps north of the goblin on 10,10.
    const caster = { size: "medium" as const, ...at("medium", { col: 10, row: 8 }), elevation: 0 };
    const aura = template("e", {
      shape: "emanation",
      size: 5,
      origin: { ...hexAnchor(ROWS, caster), z: 3 },
      footprint: emanationFootprint(ROWS, caster, 5),
      includeOrigin: true,
      triggers: ["enter"],
      spell: "Aura",
    });
    const start = fight([aura]);
    const ctx = (s: RoomState) => ({ settings: s.meta.settings, bounds: s.scenes.s1!.bounds, grid: ROWS, tokens: s.tokens });
    const before = computeCoverage(start.templates.e!, ctx(start)).hexes;
    // One step south, into odd row 9.
    const step = hexNeighbors(ROWS, { col: 10, row: 8 })[1]!;
    assert.equal(step.row, 9);
    const moved = play(start, { t: "template.update", templateId: "e", patch: { origin: { ...hexCenter(ROWS, step), z: 3 } } });
    assert.deepEqual(
      moved.reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger, r.moved]),
      [["g1", "enter", true]],
    );
    const after = computeCoverage(moved.state.templates.e!, ctx(moved.state)).hexes;
    assert.notDeepEqual(after, before);
    const undone = play(moved.state, { t: "sys.restore", entries: moved.inverse, from: "undo", deps: true });
    assert.deepEqual(computeCoverage(undone.state.templates.e!, ctx(undone.state)).hexes, before);
  });
});
