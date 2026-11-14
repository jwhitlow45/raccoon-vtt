import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { hexCenter, type Hex } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { actor, apply, P1, room, scene, token } from "#shared/testutil.ts";
import { displayName } from "../../lib/scene.ts";
import { labelsOf } from "../../state/labels.ts";
import { dragOf } from "./dragTesting.ts";
import { holdLabel, stopText } from "./drop.ts";

/*
 * A creature a player's walk cannot pass that closes the only way
 * (docs/design/design-v1-movement.md 4.3) is named in the drop's note, as
 * the board shows it to that player, where the note named a wall that is
 * not there (live play 40, LP40-MOVE-2): a hostile goblin standing in a
 * corridor one square wide stopped Thorn's drag round its bend with
 * "Stopped at a wall. There is no way around it that you have seen."
 */

const NAMED = "Stopped at a wall. There is no way around it that you have seen.";

/** Two rooms joined by a corridor one square wide along row 4, walled by the build, and Thorn in the west room. */
function hall(extra: Record<string, Token> = {}): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 10 }, blockMovement: true }) } });
  for (const [x, y, w, h] of [[1, 1, 6, 8], [7, 4, 8, 1], [15, 1, 6, 8]] as const) s = apply(s, { t: "build.rect", sceneId: "s1", terrain: "stone", x, y, w, h });
  s.tokens = { thorn: token("thorn", { x: 3, y: 4, name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor() } }), ...extra };
  return s;
}

const goblin = (id: string, x: number, y: number, over: Partial<Token> = {}): Token => token(id, { x, y, name: "Goblin", kind: "monster", disposition: "hostile", actor: { inline: actor() }, ...over });

/** Pat's drag of Thorn onto the east room's corner square, a way that bends at the corridor's far end, as Pat's board plans and words it. */
function dropThorn(stored: RoomState, at = { x: 18, y: 1 }) {
  const copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
  const drag = dragOf(copy, "player", "thorn", at);
  return { copy, drag, note: drag.plan.stop && stopText(drag.plan.stop) };
}

describe("squares: a creature that closes the only way is named (LP40-MOVE-2)", () => {
  test("a hostile goblin in the corridor: the note names it as Pat's board labels it, and the drag's mark reads No way through", () => {
    const { copy, drag, note } = dropThorn(hall({ gob: goblin("gob", 10, 4) }));
    assert.equal(note, `${displayName(copy.tokens.gob!, labelsOf({ view: copy, you: null }))} is in the way.`);
    assert.equal(note, "Goblin is in the way.");
    assert.deepEqual(drag.plan.moves.map((m) => [m.x, m.y]), [[6, 3]], "held where the straight walk meets the wall, as before");
    assert.equal(drag.hold && holdLabel(drag.hold.blocker, drag.hold.noWay === true), "No way through");
  });

  test("one whose name the DM hid is named as players see it", () => {
    const { note } = dropThorn(hall({ gob: goblin("gob", 10, 4, { nameHidden: true, publicName: "Hooded figure" }) }));
    assert.equal(note, "Hooded figure is in the way.");
  });

  test("with the corridor clear, or an ally in it, the drag goes round; with a wall across it, the note still names the wall", () => {
    assert.equal(dropThorn(hall()).note, null);
    assert.equal(dropThorn(hall({ gob: goblin("gob", 10, 4, { disposition: "ally" }) })).note, null, "an ally's space costs nothing");
    const walled = hall();
    walled.buildChunks = Object.fromEntries(Object.entries(walled.buildChunks).map(([k, c]) => [k, c && { ...c, cells: Object.fromEntries(Object.entries(c.cells).filter(([cell]) => cell !== "10,4")) }]));
    assert.equal(dropThorn(walled).note, NAMED, "the corridor cut by the rock at 10, 4");
  });

  test("the warhorse squeezing into the corridor, a goblin in tow, past a hostile orc standing in it: the orc is named", () => {
    const s = hall({
      horse: token("horse", { size: "large", x: 3, y: 3, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      gob: goblin("gob", 2, 3, { actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "horse", kind: "drag" } }),
      orc: goblin("orc", 10, 4, { name: "Orc" }),
    });
    delete s.tokens.thorn;
    const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
    const drag = dragOf(copy, "player", "horse", { x: 12.5, y: 3.5 });
    assert.equal(drag.plan.stop && stopText(drag.plan.stop), "Orc is in the way.");
  });
});

describe("squares: the creature named is the one that closes the way (LP41-MOVE-1)", () => {
  test("a hostile goblin in the west room on Thorn's line, the orc in the corridor: the note names the orc, since the walk goes round the goblin", () => {
    const s = hall({ gob: goblin("gob", 4, 4), orc: goblin("orc", 10, 4, { name: "Orc" }) });
    s.tokens.thorn = { ...s.tokens.thorn!, x: 2 };
    assert.equal(dropThorn(s, { x: 18, y: 7 }).note, "Orc is in the way.");
    assert.equal(dropThorn(s).note, "Orc is in the way.", "onto the corner square too");
  });

  test("two goblins, one in the corridor and one beyond it in the east room's doorway: the first, which closes the way, is named", () => {
    const s = hall({ gob: goblin("gob", 10, 4), orc: goblin("orc", 15, 4, { name: "Orc" }) });
    assert.equal(dropThorn(s, { x: 18, y: 7 }).note, "Goblin is in the way.");
  });
});

describe("squares: the walk stops before the creature the note names (LP41-MOVE-2, D-261114-007)", () => {
  /** Thorn in the corridor on 8, 4, a hostile goblin beside him on 9, 4. */
  const blocked = () => {
    const s = hall({ gob: goblin("gob", 9, 4) });
    s.tokens.thorn = { ...s.tokens.thorn!, x: 8 };
    return s;
  };

  test("onto the east room, where the straight walk went on through the goblin to 12, 4 or 10, 4, Thorn stays on 8, 4, and the board held him there too", () => {
    for (const to of [{ x: 16, y: 3 }, { x: 19, y: 2 }]) {
      const { drag, note } = dropThorn(blocked(), to);
      assert.equal(note, "Goblin is in the way.", `onto ${to.x}, ${to.y}`);
      assert.deepEqual(drag.plan.moves, [], `onto ${to.x}, ${to.y}: no move`);
      assert.deepEqual(drag.plan.stop?.at, { x: 8, y: 4 });
      assert.deepEqual(drag.hold && [drag.hold.at.x, drag.hold.at.y], [8, 4], "the preview held on 8, 4");
    }
  });

  test("along the corridor to 12, 4, a walk with no wall in its way: held on 8, 4 with the note, where it went through the goblin with none", () => {
    const { drag, note } = dropThorn(blocked(), { x: 12, y: 4 });
    assert.equal(note, "Goblin is in the way.");
    assert.deepEqual(drag.plan.moves, []);
  });

  test("from 6, 4 in the west room's doorway, past the goblin on 9, 4: Thorn walks on to 8, 4, the square before it", () => {
    const s = hall({ gob: goblin("gob", 9, 4) });
    s.tokens.thorn = { ...s.tokens.thorn!, x: 6 };
    const { drag, note } = dropThorn(s, { x: 12, y: 4 });
    assert.equal(note, "Goblin is in the way.");
    assert.deepEqual(drag.plan.moves.map((m) => [m.x, m.y]), [[8, 4]]);
  });

  test("the DM's drag still goes straight through", () => {
    const s = blocked();
    const drag = dragOf(s, "dm", "thorn", { x: 12, y: 4 });
    assert.deepEqual(drag.plan.moves.map((m) => [m.x, m.y]), [[12, 4]]);
  });
});

describe("squares: the creature named is the one the squeezed walker meets", () => {
  test("the warhorse squeezing along the corridor meets the orc in it, not the goblin the DM set in the rock beside it, which its full space overlaps there too", () => {
    const s = hall({
      horse: token("horse", { size: "large", x: 3, y: 3, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      gob: goblin("gob", 9, 3),
      orc: goblin("orc", 10, 4, { name: "Orc" }),
    });
    delete s.tokens.thorn;
    const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
    const drag = dragOf(copy, "player", "horse", { x: 17, y: 1 });
    assert.equal(drag.plan.stop && stopText(drag.plan.stop), "Orc is in the way.");
  });
});

describe("squares: the creature named is the one under the footprint the search reads (review LP40FIX-SOL-02)", () => {
  test("a Huge walker squeezing along a corridor two squares wide meets the Large orc in it, not the Large goblin the DM set in the rock beside it, which its full space overlaps there too", () => {
    let s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 10 }, blockMovement: true }) } });
    for (const [x, y, w, h] of [[1, 1, 6, 8], [7, 4, 8, 2], [15, 1, 6, 8]] as const) s = apply(s, { t: "build.rect", sceneId: "s1", terrain: "stone", x, y, w, h });
    s.tokens = {
      giant: token("giant", { size: "huge", x: 2, y: 3, name: "Giant", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor() } }),
      gob: goblin("gob", 10, 2, { size: "large" }),
      orc: goblin("orc", 10, 4, { name: "Orc", size: "large" }),
    };
    const copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
    const drag = dragOf(copy, "player", "giant", { x: 17, y: 1 });
    assert.equal(drag.plan.stop && stopText(drag.plan.stop), "Orc is in the way.");
  });
});

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 7 && along <= 12 && across !== 6;
  };
  const wide = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };

  test(`${name}: a hostile goblin in a corridor one hex wide is named (LP40-MOVE-2)`, () => {
    for (const hostile of [true, false]) {
      const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", wide.w, wide.h, wallsRound(g, wide, solid));
      s.tokens.thorn = onHex(g, "thorn", "medium", at(3, 6), { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor() } });
      s.tokens.gob = onHex(g, "gob", "medium", at(10, 6), { name: "Goblin", kind: "monster", disposition: hostile ? "hostile" : "ally", actor: { inline: actor() } });
      const c = hexCenter(g, at(16, 3));
      const { note } = dropThorn(s, { x: c.x - 0.5, y: c.y - 0.5 });
      assert.equal(note, hostile ? "Goblin is in the way." : null);
    }
  });

  /** The corridor one hex wide, Thorn on `thorn` along it and the creatures `others` by where they stand along line 6. */
  const corridor = (thorn: number, others: Record<string, [number, string]>): RoomState => {
    const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", wide.w, wide.h, wallsRound(g, wide, solid));
    s.tokens.thorn = onHex(g, "thorn", "medium", at(thorn, 6), { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor() } });
    for (const [id, [along, label]] of Object.entries(others)) s.tokens[id] = onHex(g, id, "medium", at(along, 6), { name: label, kind: "monster", disposition: "hostile", actor: { inline: actor() } });
    return s;
  };
  const onto = (h: Hex) => {
    const c = hexCenter(g, h);
    return { x: c.x - 0.5, y: c.y - 0.5 };
  };

  test(`${name}: a goblin in the west room on Thorn's way, the orc in the corridor: the orc is named (LP41-MOVE-1)`, () => {
    assert.equal(dropThorn(corridor(2, { gob: [4, "Goblin"], orc: [10, "Orc"] }), onto(at(16, 3))).note, "Orc is in the way.");
  });

  test(`${name}: Thorn in the corridor beside the goblin stays there, where the straight walk went on through it (LP41-MOVE-2)`, () => {
    const { drag, note } = dropThorn(corridor(8, { gob: [9, "Goblin"] }), onto(at(16, 3)));
    assert.equal(note, "Goblin is in the way.");
    assert.deepEqual(drag.plan.moves, []);
  });
}
